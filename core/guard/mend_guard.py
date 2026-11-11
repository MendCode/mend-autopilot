#!/usr/bin/env python3
"""PreToolUse safety guard for mend-autopilot sessions.

Reads one hook event as JSON on stdin. Exits 2 (block) when the tool call
matches a safety rule and prints the rule id, the reason and an allowed
alternative on stderr; exits 0 otherwise. Standard library only, no network,
no subprocesses. Run it with `python3 -I`.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
import tempfile
from dataclasses import dataclass, field

BLOCK_EXIT = 2
ALLOW_EXIT = 0
CONFIG_RELATIVE_PATH = os.path.join(".mend", "guard.json")
TRUNK_BRANCHES = {"main", "master", "trunk", "develop", "production", "prod", "release"}
SHELL_TOOL_NAMES = {"shell", "bash", "exec_command", "run_shell_command", "shell_session", "terminal", "run"}
READ_TOOL_HINTS = ("read", "view", "open", "grep", "search", "cat")
PATH_KEYS = ("path", "file_path", "filePath", "filename", "file", "paths", "files")
COMMAND_WRAPPERS = {"env", "command", "nohup", "time", "exec", "nice", "builtin", "stdbuf", "timeout"}
NESTED_SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish"}
CONTENT_FREE_PROGRAMS = {"ls", "stat", "test", "[", "file", "touch", "mkdir", "which", "basename", "dirname", "realpath", "echo", "printf"}
COPY_PROGRAMS = {"cp", "mv", "install", "ln", "rsync"}
VALUE_FLAGS = {"-r", "--requirement", "-c", "--constraint", "-e", "--editable", "--filter", "-F", "-w", "--workspace", "--cwd", "--prefix", "-C", "--dir"}

DB_CLIENTS = {
    "psql", "pg_restore", "mysql", "mariadb", "sqlite3", "sqlcmd", "mongosh", "mongo", "cqlsh", "clickhouse",
    "clickhouse-client", "duckdb", "redis-cli", "prisma", "knex", "sequelize", "typeorm", "drizzle-kit",
    "supabase", "rails", "rake", "manage.py", "flask", "alembic", "turso", "wrangler",
}
DESTRUCTIVE_DATA_PATTERN = re.compile(
    r"\b(drop\s+(table|database|schema|collection|index|view)\b|truncate\s+(table\s+)?[\w.\"`]|"
    r"delete\s+from\s+[\w.\"`]+\s*(;|$|['\")])|dropDatabase\s*\(|\.drop\s*\(\s*\)|flush(all|db)\b)",
    re.IGNORECASE,
)
DESTRUCTIVE_DB_COMMANDS = [
    re.compile(r"(^|\s)dropdb\b"),
    re.compile(r"\bprisma\s+migrate\s+reset\b"),
    re.compile(r"\bprisma\s+db\s+push\b.*--force-reset\b"),
    re.compile(r"\b(rails|rake)\s+db:(drop|reset|schema:load|purge)\b"),
    re.compile(r"\bmanage\.py\s+(flush|reset_db)\b"),
    re.compile(r"\bsupabase\s+db\s+reset\b"),
]
PIPE_TO_SHELL_PATTERNS = [
    re.compile(r"\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b"),
    re.compile(r"\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(python3?|node|ruby|perl|bun|deno)\b"),
    re.compile(r"\b(ba|z)?sh\s+<\(\s*(curl|wget)\b"),
    re.compile(r"\b(ba|z)?sh\s+-c\s+[\"']?\$\(\s*(curl|wget)\b"),
    re.compile(r"\b(source|\.)\s+<\(\s*(curl|wget)\b"),
]
INFRA_DESTROY_PATTERNS = [
    (re.compile(r"\bdocker\s+(system|volume|image|container|network|builder)\s+prune\b"), "docker-prune",
     "docker prune deletes data shared with other projects", "remove the one container or image this task created, by name"),
    (re.compile(r"\bdocker(-compose|\s+compose)\b.*\bdown\b.*(\s-v\b|--volumes\b)"), "docker-prune",
     "compose down with volumes deletes their data", "run `docker compose down` without volumes"),
    (re.compile(r"\bkubectl\s+delete\b"), "kubectl-delete",
     "kubectl delete removes cluster resources", "describe the change and ask the operator to apply it"),
    (re.compile(r"\bhelm\s+(uninstall|delete)\b"), "kubectl-delete",
     "helm uninstall removes cluster resources", "ask the operator to remove the release"),
    (re.compile(r"\bterraform\s+(destroy\b|apply\b.*\s-destroy\b)"), "infra-destroy",
     "terraform destroy removes infrastructure", "run `terraform plan` and hand the plan to the operator"),
]
SECRET_PATH_PATTERN = re.compile(
    r"(^|/)(\.env(\.[\w-]+)?|\.envrc|\.netrc|\.pgpass|\.npmrc|\.pypirc|id_(rsa|ed25519|ecdsa|dsa)|"
    r"credentials(\.json)?|secrets?\.(json|ya?ml|toml|env)|service[-_]account[\w-]*\.json|"
    r"[\w.-]+\.(pem|key|p12|pfx|keystore|jks))$|(^|/)\.(ssh|aws|gnupg|docker)(/|$)",
    re.IGNORECASE,
)
SECRET_PATH_ALLOWED_SUFFIXES = (".example", ".sample", ".template", ".dist", ".defaults")
SECRET_ALTERNATIVE = "use the example file (.env.example) or ask the operator for the one non-secret value you need"

DEPENDENCY_ADD_COMMANDS = {
    ("npm", "install"), ("npm", "i"), ("npm", "add"), ("npm", "in"),
    ("pnpm", "add"), ("pnpm", "install"), ("pnpm", "i"),
    ("yarn", "add"), ("bun", "add"), ("bun", "install"), ("bun", "i"),
    ("pip", "install"), ("pip3", "install"), ("uv", "add"), ("poetry", "add"), ("pipenv", "install"),
    ("cargo", "add"), ("go", "get"), ("bundle", "add"), ("composer", "require"), ("deno", "add"),
}
SYSTEM_PACKAGE_MANAGERS = {"brew", "apt", "apt-get", "yum", "dnf", "pacman", "zypper", "apk", "port", "snap", "choco", "winget"}
SYSTEM_CHANGE_SUBCOMMANDS = {"install", "upgrade", "uninstall", "remove", "reinstall", "add", "update", "erase", "purge", "-S", "-Syu"}
MESSAGE_SUBCOMMANDS = {"git": {"commit", "tag", "notes", "merge", "stash"}, "gh": {"pr", "issue", "release", "api"}}


@dataclass
class GuardConfig:
    production_patterns: list[re.Pattern[str]] = field(default_factory=list)
    allow_dependency_adds: bool = False
    granted_dependencies: set[str] = field(default_factory=set)
    temporary_directories: dict[str, list[str]] = field(default_factory=dict)
    lead_capture_sessions: set[str] = field(default_factory=set)
    warnings: list[str] = field(default_factory=list)


@dataclass
class Decision:
    allowed: bool
    rule_id: str | None = None
    message: str | None = None


ALLOW = Decision(True)


def block(rule_id: str, reason: str, alternative: str) -> Decision:
    return Decision(False, rule_id, f"[MEND-GUARD]: {rule_id}: {reason}. Instead: {alternative}")


def parse_config(raw: object) -> GuardConfig:
    config = GuardConfig()
    if raw is None:
        return config
    if not isinstance(raw, dict):
        config.warnings.append("guard config is not a JSON object; dependency adds blocked, no production patterns")
        return config
    patterns = raw.get("productionPatterns") or []
    for pattern in patterns if isinstance(patterns, list) else []:
        try:
            config.production_patterns.append(re.compile(str(pattern), re.IGNORECASE))
        except re.error as error:
            config.warnings.append(f"invalid production pattern {pattern!r}: {error}")
    config.allow_dependency_adds = raw.get("allowDependencyAdds") is True
    granted = raw.get("grantedDependencies") or []
    config.granted_dependencies = {str(name).lower() for name in granted} if isinstance(granted, list) else set()
    sessions = raw.get("leadCaptureSessions")
    if isinstance(sessions, list):
        config.lead_capture_sessions = {session for session in sessions if isinstance(session, str) and session}
    registered = raw.get("temporaryDirectories")
    if isinstance(registered, dict):
        for session, paths in registered.items():
            if not isinstance(session, str) or not session or not isinstance(paths, list):
                continue
            owned = []
            for candidate in paths:
                if not isinstance(candidate, str) or not os.path.isabs(candidate) or any(char in candidate for char in "*?[$`"):
                    continue
                resolved = os.path.realpath(candidate)
                roots = temp_roots()
                if resolved not in roots and any(is_inside(resolved, root) for root in roots):
                    owned.append(resolved)
            config.temporary_directories[session] = owned
    return config


def find_worktree_root(start: str) -> str:
    origin = os.path.realpath(start)
    current = origin
    while True:
        if os.path.exists(os.path.join(current, ".git")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return origin
        current = parent


def inside_mend_repository(start: str) -> bool:
    """True when start or a parent folder holds a .mend directory (the repository or one of its item worktrees)."""
    current = os.path.realpath(start)
    while True:
        if os.path.isdir(os.path.join(current, ".mend")):
            return True
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def load_config_for(cwd: str) -> GuardConfig:
    config_path = os.path.join(find_worktree_root(cwd), CONFIG_RELATIVE_PATH)
    if not os.path.isfile(config_path):
        return GuardConfig()
    try:
        with open(config_path, encoding="utf-8") as handle:
            return parse_config(json.load(handle))
    except (OSError, ValueError) as error:
        config = GuardConfig()
        config.warnings.append(f"invalid {CONFIG_RELATIVE_PATH} ({error}); dependency adds blocked, no production patterns")
        return config


@dataclass
class ToolCall:
    kind: str
    tool_name: str
    cwd: str
    workdir: str
    command: str = ""
    paths: list[str] = field(default_factory=list)


def is_shell_tool(tool_name: str) -> bool:
    lowered = tool_name.lower()
    return lowered in SHELL_TOOL_NAMES or "shell" in lowered or "bash" in lowered


def normalize_event(event: dict) -> ToolCall:
    tool_name = str(event.get("tool_name") or event.get("toolName") or "")
    tool_input = event.get("tool_input") or event.get("toolInput") or {}
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except ValueError:
            tool_input = {"command": tool_input}
    cwd = os.path.realpath(str(event.get("cwd") or os.getcwd()))
    if not isinstance(tool_input, dict):
        return ToolCall("other", tool_name, cwd, cwd)
    workdir = str(tool_input.get("workdir") or tool_input.get("cwd") or cwd)
    workdir = os.path.realpath(workdir if os.path.isabs(workdir) else os.path.join(cwd, workdir))
    call = ToolCall("other", tool_name, cwd, workdir)
    command = tool_input.get("command") if "command" in tool_input else tool_input.get("cmd")
    if command is not None and is_shell_tool(tool_name):
        call.kind = "shell"
        call.command = " ".join(shlex.quote(str(part)) for part in command) if isinstance(command, list) else str(command)
        return call
    def collect_paths(value: object) -> None:
        if isinstance(value, str):
            call.paths.append(value)
        elif isinstance(value, list):
            for item in value:
                collect_paths(item)
        elif isinstance(value, dict):
            for key in PATH_KEYS:
                collect_paths(value.get(key))

    for key in PATH_KEYS:
        collect_paths(tool_input.get(key))
    if call.paths:
        call.kind = "file"
    return call


# Shell parsing ---------------------------------------------------------------

def tokenize(command: str) -> list[str]:
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()<>\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        return list(lexer)
    except ValueError:
        return re.findall(r"[;&|()<>\n]+|[^\s;&|()<>]+", command)


def is_operator(token: str) -> bool:
    return bool(token) and all(char in ";&|()<>\n" for char in token)


def is_control(token: str) -> bool:
    return is_operator(token) and "<" not in token and ">" not in token


def is_redirect(token: str) -> bool:
    return is_operator(token) and ("<" in token or ">" in token)


def split_segments(tokens: list[str]) -> list[list[str]]:
    segments: list[list[str]] = [[]]
    for token in tokens:
        if is_control(token):
            segments.append([])
        else:
            segments[-1].append(token)
    return [segment for segment in segments if segment]


def strip_wrappers(segment: list[str]) -> list[str]:
    index = 0
    while index < len(segment):
        token = segment[index]
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", token):
            index += 1
            continue
        if token in COMMAND_WRAPPERS:
            index += 1
            while index < len(segment) and segment[index].startswith("-"):
                index += 1
            if token == "timeout" and index < len(segment) and re.fullmatch(r"[\d.]+[smhd]?", segment[index]):
                index += 1
            continue
        break
    return segment[index:]


def program_name(token: str) -> str:
    return os.path.basename(token)


def is_message_segment(segment: list[str]) -> bool:
    """git commit/tag and gh pr/issue carry free text that must not trigger command rules."""
    if not segment:
        return False
    subcommands = MESSAGE_SUBCOMMANDS.get(program_name(segment[0]))
    if not subcommands:
        return False
    positional = [token for token in segment[1:] if not token.startswith("-")]
    return bool(positional) and positional[0] in subcommands


def scrubbed_text(tokens: list[str]) -> str:
    """The command with free-text message segments reduced to their program name."""
    parts: list[str] = []
    segment: list[str] = []

    def flush() -> None:
        stripped = strip_wrappers(segment)
        parts.extend(stripped[:1] if is_message_segment(stripped) else segment)

    for token in tokens:
        if is_control(token):
            flush()
            segment = []
            parts.append(token)
        else:
            segment.append(token)
    flush()
    return " ".join(parts)


def without_redirect_targets(arguments: list[str]) -> list[str]:
    kept: list[str] = []
    skip_next = False
    for argument in arguments:
        if skip_next:
            skip_next = False
            continue
        if is_redirect(argument):
            skip_next = True
            continue
        kept.append(argument)
    return kept


# Paths -----------------------------------------------------------------------

def expand_path(raw: str, base_dir: str | None) -> str | None:
    """Resolve a shell path argument; None when it depends on a variable, a substitution or an unknown cwd."""
    home = os.path.expanduser("~")
    value = re.sub(r"^\$\{?HOME\}?(?=/|$)", home, raw)
    value = os.path.expanduser(value)
    if "$" in value or "`" in value:
        return None
    if not os.path.isabs(value):
        if base_dir is None:
            return None
        value = os.path.join(base_dir, value)
    return os.path.realpath(value)


def split_glob(path_value: str) -> tuple[str, bool]:
    parts = path_value.split("/")
    for index, part in enumerate(parts):
        if any(char in part for char in "*?["):
            return os.path.realpath("/".join(parts[:index]) or "/"), True
    return path_value, False


def is_inside(path_value: str, root: str) -> bool:
    return path_value == root or path_value.startswith(root.rstrip("/") + "/")


def temp_roots() -> set[str]:
    return {os.path.realpath(tempfile.gettempdir()), os.path.realpath("/tmp")}


def check_delete_target(target: str, base_dir: str | None, worktree_root: str, root_is_scope: bool = False, temporary_directories: tuple[str, ...] = ()) -> Decision | None:
    """root_is_scope: the target is a search root (find), so naming the worktree root itself is fine."""
    alternative = f"delete only paths inside the session worktree ({worktree_root}) or ask the operator"
    resolved = expand_path(target, base_dir)
    if resolved is None:
        return block("rm-outside", f"recursive delete of {target} depends on a variable, substitution or unknown directory", alternative)
    base, is_glob = split_glob(resolved)
    if os.path.basename(base) == ".git" or "/.git/" in base + "/":
        return block("rm-outside", f"recursive delete of git metadata ({target})", "leave .git alone; change history with git commands")
    if base == worktree_root and not is_glob and not root_is_scope:
        return block("rm-outside", "recursive delete of the whole worktree", alternative)
    if is_inside(base, worktree_root):
        return None
    roots = temp_roots()
    if base in roots:
        return block("rm-outside", f"recursive delete of the shared temp folder ({target})", "delete only the temp folder registered for this session, by name")
    if any(is_inside(base, root) for root in temporary_directories):
        return None
    return block("rm-outside", f"recursive delete outside the session worktree: {target}", alternative)


def is_recursive_flag(argument: str) -> bool:
    return argument == "--recursive" or (argument.startswith("-") and not argument.startswith("--") and bool(re.search(r"[rR]", argument)))


def check_rm(arguments: list[str], base_dir: str | None, worktree_root: str, temporary_directories: tuple[str, ...] = ()) -> Decision | None:
    arguments = without_redirect_targets(arguments)
    if "--" in arguments:
        split_at = arguments.index("--")
        flags, targets = arguments[:split_at], arguments[split_at + 1:]
    else:
        flags = [argument for argument in arguments if argument.startswith("-")]
        targets = [argument for argument in arguments if not argument.startswith("-")]
    if not any(is_recursive_flag(flag) for flag in flags):
        return None
    for target in targets:
        decision = check_delete_target(target, base_dir, worktree_root, temporary_directories=temporary_directories)
        if decision:
            return decision
    return None


def check_find_delete(arguments: list[str], base_dir: str | None, worktree_root: str, temporary_directories: tuple[str, ...] = ()) -> Decision | None:
    deletes = "-delete" in arguments or any(
        arguments[index] in ("-exec", "-execdir") and index + 1 < len(arguments) and program_name(arguments[index + 1]) == "rm"
        for index in range(len(arguments))
    )
    if not deletes:
        return None
    start_paths = []
    for argument in arguments:
        if argument.startswith("-") or argument in ("(", "!"):
            break
        start_paths.append(argument)
    for target in start_paths or ["."]:
        decision = check_delete_target(target, base_dir, worktree_root, root_is_scope=True, temporary_directories=temporary_directories)
        if decision:
            return decision
    return None


# Rules -----------------------------------------------------------------------

def git_subcommand(arguments: list[str]) -> tuple[str, list[str]]:
    index = 0
    while index < len(arguments) and arguments[index].startswith("-"):
        index += 2 if arguments[index] in ("-C", "-c", "--git-dir", "--work-tree") else 1
    if index >= len(arguments):
        return "", []
    return arguments[index], arguments[index + 1:]


def has_short_flag(arguments: list[str], letter: str) -> bool:
    return any(argument.startswith("-") and not argument.startswith("--") and letter in argument for argument in arguments)


def check_git(arguments: list[str]) -> Decision | None:
    subcommand, rest = git_subcommand(arguments)
    if subcommand == "push":
        refs = [argument for argument in rest if not argument.startswith("-")][1:]
        deleting = "--delete" in rest or has_short_flag(rest, "d")
        if any(ref.startswith(":") and ref[1:] in TRUNK_BRANCHES for ref in refs) or (deleting and any(ref in TRUNK_BRANCHES for ref in refs)):
            return block("trunk-delete", "deleting the trunk branch on the remote", "never delete trunk; delete only your mend/* branch")
        if "--force" in rest or has_short_flag(rest, "f") or any(ref.startswith("+") for ref in refs):
            return block("git-force", "force push rewrites remote history", "push normally, or use --force-with-lease on your own mend/* branch")
        if any(argument.startswith(("--force-with-lease", "--force-if-includes")) for argument in rest):
            targets = [ref.split(":")[-1] for ref in refs]
            if not targets or any(target in TRUNK_BRANCHES or target == "HEAD" for target in targets):
                return block("git-force", "a lease push must name your own non-trunk branch", "git push --force-with-lease origin mend/<item>")
        return None
    if subcommand == "reset" and "--hard" in rest:
        return block("git-reset-hard", "reset --hard discards uncommitted work", "commit or `git stash` first, or `git restore <file>` for one file")
    if subcommand == "clean" and ("--force" in rest or has_short_flag(rest, "f")):
        if not ("--dry-run" in rest or has_short_flag(rest, "n")):
            return block("git-clean", "git clean -f deletes untracked files for good", "run `git clean -n` and remove the listed files by name")
    if subcommand == "branch" and ("--delete" in rest or has_short_flag(rest, "d") or has_short_flag(rest, "D")):
        if any(argument in TRUNK_BRANCHES for argument in rest if not argument.startswith("-")):
            return block("trunk-delete", "deleting the trunk branch", "never delete trunk; delete only your mend/* branch")
    return None


def check_global_install(program: str, arguments: list[str]) -> Decision | None:
    alternative = "install inside the project (devDependency, virtualenv) after a recorded grant, or ask the operator"
    if program in ("sudo", "doas"):
        return block("global-install", f"{program} runs with system privileges", alternative)
    if program in SYSTEM_PACKAGE_MANAGERS and any(argument in SYSTEM_CHANGE_SUBCOMMANDS for argument in arguments[:2]):
        return block("global-install", f"{program} changes the system", alternative)
    if program in ("npm", "pnpm", "bun") and any(argument in ("-g", "--global", "--location=global") for argument in arguments):
        return block("global-install", f"{program} global install changes the machine", alternative)
    if program == "yarn" and arguments[:1] == ["global"]:
        return block("global-install", "yarn global changes the machine", alternative)
    if program in ("pip", "pip3") and any(argument in ("--user", "--break-system-packages") for argument in arguments):
        return block("global-install", "pip outside a virtualenv changes the machine", alternative)
    if program in ("cargo", "go", "gem", "pipx") and arguments[:1] == ["install"]:
        return block("global-install", f"{program} install puts binaries on the machine", alternative)
    if program == "uv" and arguments[:2] == ["tool", "install"]:
        return block("global-install", "uv tool install puts binaries on the machine", alternative)
    return None


def first_positional(arguments: list[str]) -> int:
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument in VALUE_FLAGS:
            index += 2
        elif argument.startswith("-"):
            index += 1
        else:
            return index
    return len(arguments)


def dependency_names(arguments: list[str]) -> list[str]:
    names: list[str] = []
    skip_next = False
    for argument in arguments:
        if skip_next:
            skip_next = False
            continue
        if argument in VALUE_FLAGS:
            skip_next = True
            continue
        if argument.startswith("-") or argument in (".", "./"):
            continue
        if argument.startswith(("./", "../", "/")) or argument.endswith((".txt", ".whl", ".tar.gz")):
            continue
        names.append(argument)
    return names


VERSION_SEPARATOR = re.compile(r"[@=<>~^!\[]")


def base_dependency_name(spec: str) -> str:
    if spec.startswith("@"):
        scope, _, rest = spec.partition("/")
        return (scope + "/" + VERSION_SEPARATOR.split(rest, maxsplit=1)[0]).lower()
    return VERSION_SEPARATOR.split(spec, maxsplit=1)[0].lower()


def check_dependency_add(program: str, arguments: list[str], config: GuardConfig) -> Decision | None:
    if config.allow_dependency_adds:
        return None
    if program in ("python", "python3") and arguments[:2] == ["-m", "pip"]:
        program, arguments = "pip", arguments[2:]
    elif program == "uv" and arguments[:1] == ["pip"]:
        program, arguments = "pip", arguments[1:]
    start = first_positional(arguments)
    if start >= len(arguments) or (program, arguments[start]) not in DEPENDENCY_ADD_COMMANDS:
        return None
    names = dependency_names(arguments[:start] + arguments[start + 1:])
    ungranted = [name for name in names if base_dependency_name(name) not in config.granted_dependencies]
    if not ungranted:
        return None
    return block(
        "dependency-ungranted",
        f"adding {', '.join(ungranted)} has no recorded grant",
        "ask the operator; a granted name goes in .mend/guard.json grantedDependencies",
    )


def is_secret_path(raw: str) -> bool:
    candidate = raw.strip().strip("'\"").rstrip("/")
    if not candidate or candidate.lower().endswith(SECRET_PATH_ALLOWED_SUFFIXES):
        return False
    return bool(SECRET_PATH_PATTERN.search(candidate))


def secret_block(path_value: str) -> Decision:
    return block("secret-read", f"reading a secret file ({os.path.basename(path_value.rstrip('/')) or path_value})", SECRET_ALTERNATIVE)


def check_secret_read(program: str, arguments: list[str]) -> Decision | None:
    if program in CONTENT_FREE_PROGRAMS:
        return None
    readable = without_redirect_targets(arguments)
    if program in COPY_PROGRAMS:
        positional = [argument for argument in readable if not argument.startswith("-")]
        readable = positional[:-1]
    for argument in readable:
        value = argument.split("=", 1)[1] if argument.startswith("--") and "=" in argument else argument
        if is_secret_path(value):
            return secret_block(value)
    return None


def check_production(text: str, config: GuardConfig) -> Decision | None:
    for pattern in config.production_patterns:
        if pattern.search(text):
            return block("production-pattern", f"matches the repo production pattern /{pattern.pattern}/", "run against the local or ephemeral environment from the verification skill")
    return None


def check_command_patterns(text: str, segments: list[list[str]]) -> Decision | None:
    if any(program_name(segment[0]) in DB_CLIENTS for segment in segments) and DESTRUCTIVE_DATA_PATTERN.search(text):
        return block("db-destroy", "destructive statement sent to a database client", "write a migration for operator review, or use a local throwaway database")
    for pattern in DESTRUCTIVE_DB_COMMANDS:
        if pattern.search(text):
            return block("db-destroy", "the command drops or resets a database", "reset only the local ephemeral database through the verification skill, or ask the operator")
    for pattern in PIPE_TO_SHELL_PATTERNS:
        if pattern.search(text):
            return block("pipe-to-shell", "a downloaded script would run without review", "download it to a file, read it, then ask the operator before running it")
    for pattern, rule_id, reason, alternative in INFRA_DESTROY_PATTERNS:
        if pattern.search(text):
            return block(rule_id, reason, alternative)
    return None


def inline_script(arguments: list[str]) -> str | None:
    """The script given to `sh -c`, including combined flags such as `bash -lc`."""
    for index, argument in enumerate(arguments):
        if not argument.startswith("-"):
            return None
        if not argument.startswith("--") and "c" in argument[1:]:
            return arguments[index + 1] if index + 1 < len(arguments) else None
    return None


def next_directory(arguments: list[str], base_dir: str | None) -> str | None:
    if not arguments:
        return os.path.expanduser("~")
    if arguments[0] == "-":
        return None
    return expand_path(arguments[0], base_dir)


def evaluate_command(command: str, workdir: str, config: GuardConfig, worktree_root: str, depth: int = 0, temporary_directories: tuple[str, ...] = (), lead_capture: bool = False) -> Decision:
    tokens = tokenize(command)
    # Input redirections open files even for echo, message commands, or no command at all.
    # Heredoc delimiters and here-string text are not filenames; output-only targets are not reads.
    for index, token in enumerate(tokens[:-1]):
        if token in ("<", "<>") and is_secret_path(tokens[index + 1]):
            return secret_block(tokens[index + 1])
    segments = [strip_wrappers(segment) for segment in split_segments(tokens)]
    command_segments = [segment for segment in segments if segment and not is_message_segment(segment)]
    decision = check_command_patterns(scrubbed_text(tokens), command_segments)
    if decision:
        return decision

    base_dir: str | None = workdir
    for segment in command_segments:
        program = program_name(segment[0])
        arguments = segment[1:]
        if not lead_capture and any(re.search(r"(?:^|/)checks/capture\.mjs$", argument) for argument in [segment[0], *arguments]):
            return block("lead-capture", "evidence capture is reserved for the lead", "ask the lead to run the capture")
        if program in ("cd", "pushd"):
            base_dir = next_directory(arguments, base_dir)
            continue
        if program in NESTED_SHELLS and depth < 3:
            inline = inline_script(arguments)
            if inline is not None:
                nested = evaluate_command(inline, base_dir or workdir, config, worktree_root, depth + 1, temporary_directories, lead_capture)
                if not nested.allowed:
                    return nested
        if program == "xargs":
            inner = [argument for argument in arguments if not argument.startswith("-")]
            if inner and program_name(inner[0]) == "rm" and any(is_recursive_flag(argument) for argument in inner[1:]):
                return block("rm-outside", "recursive delete of paths read from stdin cannot be checked", "list the paths, then delete the ones inside the worktree by name")
        checks = []
        if program == "rm":
            checks.append(check_rm(arguments, base_dir, worktree_root, temporary_directories))
        elif program == "find":
            checks.append(check_find_delete(arguments, base_dir, worktree_root, temporary_directories))
        elif program == "git":
            checks.append(check_git(arguments))
        checks.append(check_global_install(program, arguments))
        checks.append(check_dependency_add(program, arguments, config))
        checks.append(check_secret_read(program, arguments))
        found = next((check for check in checks if check), None)
        if found:
            return found
    return check_production(command, config) or ALLOW


def evaluate(event: dict, config: dict | GuardConfig | None = None) -> tuple[bool, str | None, str | None]:
    """Return (allowed, rule_id, message); a blocked call carries the stderr message."""
    guard_config = config if isinstance(config, GuardConfig) else parse_config(config)
    call = normalize_event(event)
    worktree_root = find_worktree_root(call.cwd)
    decision = ALLOW
    if call.kind == "shell":
        session = event.get("session_id")
        temporary_directories = tuple(guard_config.temporary_directories.get(session, [])) if isinstance(session, str) else ()
        lead_capture = isinstance(session, str) and session in guard_config.lead_capture_sessions and not event.get("agent_id")
        decision = evaluate_command(call.command, call.workdir, guard_config, worktree_root, temporary_directories=temporary_directories, lead_capture=lead_capture)
    elif call.kind == "file":
        if any(hint in call.tool_name.lower() for hint in READ_TOOL_HINTS):
            secret = next((path_value for path_value in call.paths if is_secret_path(path_value)), None)
            if secret is not None:
                decision = secret_block(secret)
        if decision.allowed:
            decision = check_production(" ".join(call.paths), guard_config) or ALLOW
    return decision.allowed, decision.rule_id, decision.message


def main() -> int:
    raw = sys.stdin.read()
    try:
        event = json.loads(raw)
        if not isinstance(event, dict):
            raise ValueError("event is not a JSON object")
    except ValueError as error:
        print(f"[MEND-GUARD]: warning: unreadable hook event ({error}); call allowed", file=sys.stderr)
        return ALLOW_EXIT
    config_cwd = str(event.get("cwd") or os.getcwd())
    if len(sys.argv) == 3 and sys.argv[1] == "--config-cwd":
        config_cwd = sys.argv[2]
    elif len(sys.argv) == 2 and sys.argv[1] == "--mend-only":
        # A user-wide hook (Claude Code) guards only repositories that use mend-autopilot.
        if not inside_mend_repository(config_cwd):
            return ALLOW_EXIT
    elif len(sys.argv) != 1:
        print("[MEND-GUARD]: invalid guard arguments; call blocked", file=sys.stderr)
        return BLOCK_EXIT
    config = load_config_for(config_cwd)
    for warning in config.warnings:
        print(f"[MEND-GUARD]: warning: {warning}", file=sys.stderr)
    allowed, _, message = evaluate(event, config)
    if allowed:
        return ALLOW_EXIT
    print(message, file=sys.stderr)
    return BLOCK_EXIT


if __name__ == "__main__":
    sys.exit(main())
