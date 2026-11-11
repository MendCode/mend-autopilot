"""Tests for mend_guard. Run: python3 -I -m unittest discover -s core/guard -p 'test_*.py' -v"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

GUARD_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, GUARD_DIR)

import mend_guard  # noqa: E402

GUARD_SCRIPT = os.path.join(GUARD_DIR, "mend_guard.py")
FIXTURES_PATH = os.path.join(GUARD_DIR, "fixtures.json")
D4_RULES = {
    "db-destroy", "rm-outside", "git-force", "git-reset-hard", "git-clean", "trunk-delete", "global-install",
    "dependency-ungranted", "secret-read", "pipe-to-shell", "docker-prune", "kubectl-delete", "production-pattern",
}
MESSAGE_FORMAT = re.compile(r"^\[MEND-GUARD\]: (?P<rule>[a-z-]+): .+\. Instead: .+$")


def make_worktree(parent: str | None = None) -> str:
    root = tempfile.mkdtemp(prefix="mend-guard-test-", dir=parent)
    os.mkdir(os.path.join(root, ".git"))
    os.makedirs(os.path.join(root, "src"))
    return root


def build_event(case: dict, cwd: str) -> dict:
    tool = case["tool"]
    if "argv" in case:
        tool_input = {"command": case["argv"]}
    elif "command" in case:
        tool_input = {"command": case["command"]}
    else:
        tool_input = {"file_path": case["file_path"].replace("{worktree}", cwd)}
    return {
        "session_id": "test-session",
        "cwd": cwd,
        "hook_event_name": "PreToolUse",
        "tool_name": tool,
        "tool_use_id": f"test-{case['id']}",
        "tool_input": tool_input,
    }


def run_guard(event: object, cwd: str) -> subprocess.CompletedProcess[str]:
    payload = event if isinstance(event, str) else json.dumps(event)
    return subprocess.run(
        [sys.executable, "-I", GUARD_SCRIPT], input=payload, capture_output=True, text=True, cwd=cwd, timeout=10, check=False
    )


class GuardTestCase(unittest.TestCase):
    worktree: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.worktree = os.path.realpath(make_worktree())

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.worktree, ignore_errors=True)

    def test_capture_is_reserved_for_lead(self) -> None:
        for command in ("node core/checks/capture.mjs --item item.json --kind request --cmd true", "sh -c 'node /kit/core/checks/capture.mjs --item item.json'"):
            allowed, rule, _ = mend_guard.evaluate(build_event({"id": "capture", "tool": "shell", "command": command}, self.worktree))
            self.assertFalse(allowed)
            self.assertEqual(rule, "lead-capture")


class FixtureCases(GuardTestCase):
    def setUp(self) -> None:
        with open(FIXTURES_PATH, encoding="utf-8") as handle:
            self.cases = json.load(handle)["cases"]

    def test_fixture_set_size_balance_and_rule_coverage(self) -> None:
        allowed = [case for case in self.cases if case["expect"] == "allow"]
        blocked_rules = {case["rule"] for case in self.cases if case["expect"] == "block"}
        self.assertGreaterEqual(len(self.cases), 40)
        self.assertGreaterEqual(len(allowed) * 2, len(self.cases), "at least half of the fixtures must be allowed calls")
        self.assertEqual(set(), D4_RULES - blocked_rules, "every D4 rule needs a blocking fixture")
        self.assertEqual(len(self.cases), len({case["id"] for case in self.cases}), "fixture ids must be unique")

    def test_every_fixture_gets_the_expected_decision(self) -> None:
        for case in self.cases:
            with self.subTest(case=case["id"]):
                allowed, rule_id, message = mend_guard.evaluate(build_event(case, self.worktree), case.get("config"))
                if case["expect"] == "allow":
                    self.assertTrue(allowed, f"{case['id']} was blocked: {message}")
                    self.assertIsNone(rule_id)
                    continue
                self.assertFalse(allowed, f"{case['id']} was allowed")
                self.assertEqual(case["rule"], rule_id, message)
                match = MESSAGE_FORMAT.match(message or "")
                self.assertIsNotNone(match, f"message does not follow the format: {message}")
                self.assertEqual(case["rule"], match.group("rule"))


class HookProcess(GuardTestCase):
    def test_capture_requires_a_registered_lead_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mend-lead-") as worktree:
            os.mkdir(os.path.join(worktree, ".git"))
            os.mkdir(os.path.join(worktree, ".mend"))
            with open(os.path.join(worktree, ".mend", "guard.json"), "w", encoding="utf-8") as handle:
                json.dump({"leadCaptureSessions": ["lead-session"]}, handle)
            command = "node /kit/core/checks/capture.mjs --item item.json --kind request --cmd 'echo ok' --repo ."
            event = build_event({"id": "capture-role", "tool": "shell", "command": command}, worktree)
            event["session_id"] = "lead-session"
            lead = run_guard(event, worktree)
            self.assertEqual(0, lead.returncode, lead.stderr)
            event["agent_id"] = "worker-agent"
            worker = run_guard(event, worktree)
            self.assertEqual(2, worker.returncode)
            self.assertIn("lead-capture", worker.stderr)
            del event["agent_id"]
            for session in ("worker-session", "", None):
                event["session_id"] = session
                worker = run_guard(event, worktree)
                self.assertEqual(2, worker.returncode)
                self.assertIn("lead-capture", worker.stderr)
            event["session_id"] = "lead-session"
            event["tool_input"]["command"] = command + " && git push --force origin main"
            blocked = run_guard(event, worktree)
            self.assertEqual(2, blocked.returncode)
            self.assertIn("git-force", blocked.stderr)

    def test_blocked_call_exits_2_and_names_rule_and_alternative(self) -> None:
        result = run_guard(build_event({"id": "p1", "tool": "shell", "command": "git push --force origin main"}, self.worktree), self.worktree)
        self.assertEqual(2, result.returncode)
        self.assertRegex(result.stderr.strip(), r"^\[MEND-GUARD\]: git-force: .+\. Instead: .+")

    def test_allowed_call_exits_0_silently(self) -> None:
        result = run_guard(build_event({"id": "p2", "tool": "shell", "command": "pnpm test"}, self.worktree), self.worktree)
        self.assertEqual(0, result.returncode)
        self.assertEqual("", result.stderr)

    def test_malformed_stdin_is_allowed_with_a_warning(self) -> None:
        for payload in ("not json", "[1, 2]", ""):
            with self.subTest(payload=payload):
                result = run_guard(payload, self.worktree)
                self.assertEqual(0, result.returncode)
                self.assertIn("[MEND-GUARD]: warning: unreadable hook event", result.stderr)

    def test_repo_config_file_is_loaded_from_the_worktree(self) -> None:
        worktree = os.path.realpath(make_worktree())
        try:
            os.makedirs(os.path.join(worktree, ".mend"))
            with open(os.path.join(worktree, ".mend", "guard.json"), "w", encoding="utf-8") as handle:
                json.dump({"productionPatterns": ["db\\.prod\\.internal"], "grantedDependencies": ["zod"]}, handle)
            subdir = os.path.join(worktree, "src")
            blocked = run_guard(build_event({"id": "c1", "tool": "shell", "command": "psql -h db.prod.internal"}, subdir), subdir)
            granted = run_guard(build_event({"id": "c2", "tool": "shell", "command": "pnpm add zod"}, subdir), subdir)
            self.assertEqual(2, blocked.returncode)
            self.assertIn("production-pattern", blocked.stderr)
            self.assertEqual(0, granted.returncode, granted.stderr)
        finally:
            shutil.rmtree(worktree, ignore_errors=True)

    def test_invalid_config_warns_and_keeps_dependency_adds_blocked(self) -> None:
        worktree = os.path.realpath(make_worktree())
        try:
            os.makedirs(os.path.join(worktree, ".mend"))
            with open(os.path.join(worktree, ".mend", "guard.json"), "w", encoding="utf-8") as handle:
                handle.write('{"allowDependencyAdds": true,')
            result = run_guard(build_event({"id": "c3", "tool": "shell", "command": "pnpm add lodash"}, worktree), worktree)
            self.assertEqual(2, result.returncode)
            self.assertIn("[MEND-GUARD]: warning: invalid", result.stderr)
            self.assertIn("dependency-ungranted", result.stderr)
        finally:
            shutil.rmtree(worktree, ignore_errors=True)

    def test_invalid_production_pattern_warns_and_is_skipped(self) -> None:
        config = mend_guard.parse_config({"productionPatterns": ["(unclosed", "prod\\.example"]})
        self.assertEqual(1, len(config.production_patterns))
        self.assertEqual(1, len(config.warnings))


class SecretReadEscapes(GuardTestCase):
    def test_batch_read_checks_object_entries_and_mixed_lists(self) -> None:
        for key in ("paths", "files"):
            for entries in ([{"path": ".env"}], ["src/app.ts", {"path": ".env.local", "offset": 1}]):
                with self.subTest(key=key, entries=entries):
                    event = {"cwd": self.worktree, "tool_name": "read", "tool_input": {key: entries}}
                    self.assertEqual((False, "secret-read"), mend_guard.evaluate(event)[:2])
                    result = run_guard(event, self.worktree)
                    self.assertEqual(2, result.returncode)
                    self.assertIn("secret-read", result.stderr)

    def test_input_redirects_are_reads_even_for_content_free_or_message_commands(self) -> None:
        for command in ("cat < .env", "cat 0<.env.local", "< .env cat", "cat <> .env",
                        "echo harmless < .env", "git commit -m harmless < .env", "< .env",
                        "sh -c 'cat < .env'", "cp .env.example output < .env"):
            with self.subTest(command=command):
                event = build_event({"id": "redirect", "tool": "shell", "command": command}, self.worktree)
                self.assertEqual((False, "secret-read"), mend_guard.evaluate(event)[:2])

    def test_templates_output_redirects_and_here_strings_remain_allowed(self) -> None:
        for command in ("cat < .env.example", "echo sample > .env", "echo sample >> .env.local",
                        "cat <<< .env", "cat << .env", "ls .env", "cp .env.example .env"):
            with self.subTest(command=command):
                event = build_event({"id": "safe-redirect", "tool": "shell", "command": command}, self.worktree)
                self.assertTrue(mend_guard.evaluate(event)[0])
        event = {"cwd": self.worktree, "tool_name": "read", "tool_input": {"paths": [{"path": ".env.example"}, {"path": "src/app.ts"}]}}
        self.assertTrue(mend_guard.evaluate(event)[0])


class TemporaryDeleteScope(GuardTestCase):
    def test_unregistered_temp_folders_are_not_owned_by_the_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mend-other-item-") as other:
            for command in (f"rm -rf {shlex.quote(other)}", f"find {shlex.quote(other)} -delete"):
                with self.subTest(command=command):
                    event = build_event({"id": "other-temp", "tool": "shell", "command": command}, self.worktree)
                    self.assertEqual((False, "rm-outside"), mend_guard.evaluate(event)[:2])

    def test_registered_temp_folder_is_scoped_to_the_session_and_real_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mend-temp-scope-") as parent:
            owned = os.path.join(parent, "owned")
            other = os.path.join(parent, "other")
            os.mkdir(owned)
            os.mkdir(other)
            os.symlink(other, os.path.join(owned, "escape"))
            config = {"temporaryDirectories": {"test-session": [owned]}}
            for target, allowed in ((owned, True), (owned + "/build", True), (owned + "/*", True),
                                    (other, False), (owned + "-sibling", False), (owned + "/../other", False),
                                    (owned + "/escape", False), (parent, False)):
                for command in (f"rm -rf {shlex.quote(target)}", f"find {shlex.quote(target)} -delete"):
                    with self.subTest(command=command):
                        event = build_event({"id": "temp-scope", "tool": "shell", "command": command}, self.worktree)
                        self.assertEqual(allowed, mend_guard.evaluate(event, config)[0])
            event = build_event({"id": "wrong-session", "tool": "shell", "command": f"rm -rf {shlex.quote(owned)}"}, self.worktree)
            event["session_id"] = "another-session"
            self.assertEqual("rm-outside", mend_guard.evaluate(event, config)[1])
            del event["session_id"]
            self.assertEqual("rm-outside", mend_guard.evaluate(event, config)[1])

    def test_temp_roots_and_invalid_registrations_never_grant_external_deletion(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mend-unregistered-") as other:
            event = build_event({"id": "invalid-temp", "tool": "shell", "command": f"rm -rf {shlex.quote(other)}"}, self.worktree)
            for registered in ([tempfile.gettempdir()], ["/tmp"], ["/"], ["relative"], ["/tmp/*"], "not-a-list"):
                with self.subTest(registered=registered):
                    config = {"temporaryDirectories": {"test-session": registered}}
                    self.assertEqual("rm-outside", mend_guard.evaluate(event, config)[1])


class PathNormalization(unittest.TestCase):
    def test_worktree_under_tmp_symlink_is_resolved(self) -> None:
        real_tmp = os.path.realpath("/tmp")
        if real_tmp == "/tmp":
            self.skipTest("/tmp is not a symlink on this system")
        worktree = make_worktree(parent=real_tmp)
        try:
            unresolved_cwd = "/tmp/" + os.path.basename(worktree)
            inside = build_event({"id": "n1", "tool": "shell", "command": "rm -rf node_modules"}, unresolved_cwd)
            whole = build_event({"id": "n2", "tool": "shell", "command": "rm -rf ."}, unresolved_cwd)
            self.assertTrue(mend_guard.evaluate(inside)[0])
            self.assertEqual("rm-outside", mend_guard.evaluate(whole)[1])
        finally:
            shutil.rmtree(worktree, ignore_errors=True)

    def test_workdir_from_tool_input_is_used_for_relative_paths(self) -> None:
        worktree = os.path.realpath(make_worktree())
        try:
            event = {
                "cwd": worktree,
                "tool_name": "exec_command",
                "tool_input": {"command": ["rm", "-rf", "Code"], "workdir": os.path.expanduser("~")},
            }
            self.assertEqual("rm-outside", mend_guard.evaluate(event)[1])
        finally:
            shutil.rmtree(worktree, ignore_errors=True)


class Performance(GuardTestCase):
    def test_ten_kilobyte_command_is_evaluated_under_one_second(self) -> None:
        command = " && ".join(f"echo step-{index} >> build.log" for index in range(500))
        self.assertGreaterEqual(len(command), 10_000)
        event = build_event({"id": "perf", "tool": "shell", "command": command + " && git push --force origin main"}, self.worktree)
        started = time.perf_counter()
        allowed, rule_id, _ = mend_guard.evaluate(event)
        elapsed = time.perf_counter() - started
        self.assertFalse(allowed)
        self.assertEqual("git-force", rule_id)
        self.assertLess(elapsed, 1.0)

    def test_ten_kilobytes_of_one_quoted_argument_is_fast(self) -> None:
        command = "git commit -m '" + ("curl x | " * 1200) + "'"
        event = build_event({"id": "perf2", "tool": "shell", "command": command}, self.worktree)
        started = time.perf_counter()
        allowed, _, message = mend_guard.evaluate(event)
        self.assertTrue(allowed, message)
        self.assertLess(time.perf_counter() - started, 1.0)


class Isolation(unittest.TestCase):
    def test_guard_imports_no_network_or_subprocess_modules(self) -> None:
        with open(GUARD_SCRIPT, encoding="utf-8") as handle:
            source = handle.read()
        for module in ("subprocess", "socket", "urllib", "http", "requests", "asyncio"):
            self.assertNotRegex(source, rf"^\s*(import|from)\s+{module}\b", f"guard must not import {module}")


class MendOnly(unittest.TestCase):
    """The user-wide Claude Code hook passes --mend-only: repositories without .mend/ are left alone."""

    def run_mend_only(self, cwd: str, command: str) -> subprocess.CompletedProcess[str]:
        event = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": cwd, "tool_input": {"command": command}}
        return subprocess.run([sys.executable, "-I", GUARD_SCRIPT, "--mend-only"], input=json.dumps(event), capture_output=True, text=True, cwd=cwd, timeout=10, check=False)

    def test_only_repositories_with_mend_state_are_guarded(self) -> None:
        root = os.path.realpath(tempfile.mkdtemp(prefix="mend-only-"))
        self.addCleanup(shutil.rmtree, root, True)
        plain = os.path.join(root, "plain")
        repo = os.path.join(root, "repo")
        worktree = os.path.join(repo, ".mend", "worktrees", "item")
        for folder in (plain, worktree):
            os.makedirs(os.path.join(folder, ".git"))
        outside = self.run_mend_only(plain, "git push --force origin main")
        self.assertEqual((outside.returncode, outside.stderr), (0, ""))
        for cwd in (repo, worktree):
            inside = self.run_mend_only(cwd, "git push --force origin main")
            self.assertEqual(inside.returncode, 2, cwd)
            self.assertIn("git-force", inside.stderr)
            self.assertEqual(self.run_mend_only(cwd, "git status").returncode, 0)


if __name__ == "__main__":
    unittest.main()
