# Harness capability matrix

Measured on 2026-11-03 against MendCode `0.0.1-dev` (local build). Only the Codex column has been measured so far, by decision: Codex is the first pilot.

## How it was measured

- **Model and engine.** `mendcode run --model openai/gpt-6-luna --effort low --permission smart --format json`. Every run reported `provider chatgpt`, `model gpt-6-luna`, and the roles output reported engine `native`. Hook events only fire on the native engine, so every cell below applies to native sessions and not to the Codex CLI engine.
- **Isolation.** `--isolated` exists only for the TUI (see follow-up F1). Instead, every probe used `--dir <temporary data dir>`. That starts a separate private daemon, which still uses the operator's ChatGPT login, and leaves the operator's daemon, settings, roles and tiers untouched.
- **Probe repo.** A scratch git repo under `/tmp`, with a probe package holding:
  - one skill that answers with a marker string;
  - one command that echoes a marker plus `$ARGUMENTS`;
  - one `PreToolUse` hook (`matcher: "*"`) that appends stdin to a log and exits 2 when the payload contains a block token.
- **Images.** Synthetic PNGs with four horizontal colour bands (red, green, blue, yellow), attached with `--file`.
- **Cell values.**
  - **WORKS**: observed working.
  - **NOT_APPLIED**: the feature exists but did not take effect.
  - **BLOCKED_CAPABILITY**: unavailable in the measured setup.
  - **UNTESTED**: not measured; the reason is given.
  - **DOCS**: known only from `mendcode docs`, never observed.

## Matrix

| Capability | codex (gpt-6-luna, native) | claude | opencode-go |
|---|---|---|---|
| Model selection on `run` | **WORKS**. `--model openai/gpt-6-luna` is honoured and usage reports `chatgpt/gpt-6-luna`. Roles stay untouched. | UNTESTED: Codex first | UNTESTED: Codex first |
| `run --isolated` | **NOT_APPLIED**. `run` exits 64 with "--isolated … require the TUI". `--dir <tmp data dir>` is the working substitute. | UNTESTED | UNTESTED |
| Package skills | **WORKS** in user scope. The skill is listed, loaded, and answers with its marker. Behaviour: luna loads a skill whose description is broad even when the task is unrelated, and in two runs it abandoned the task to follow the skill (F5). | UNTESTED | UNTESTED |
| Package commands | **WORKS**. `--command <name> hola` returns the marker followed by `hola`. | UNTESTED | UNTESTED |
| Package hooks (PreToolUse) | **WORKS** in user scope (`<data dir>/packages/<name>/hooks.json`). **NOT_APPLIED** in project scope (`<repo>/.mendcode/packages/`) until the directory is trusted (F2). With exit 2 the call is blocked and the model receives `blocked by a PreToolUse hook: <stderr>`, so it can see the rule and the allowed alternative. The payload shape is below. | UNTESTED | UNTESTED |
| `agents/*.md` | UNTESTED. DOCS: the `task` tool takes `agent`, and the subagent docs list `agents/: none` on this machine. | UNTESTED | UNTESTED |
| Advisor | UNTESTED: the operator keeps it off on purpose. A read-only attempt from the session found no advisor status tool. `ai_config get ["advisor"]` returned `{}`, while `mendcode control-plane models status` lists an `advisor` role (gpt-6-astra, medium). So the session cannot tell "role assigned, feature off" from "not configured" (F3). | UNTESTED | UNTESTED |
| Plan role | UNTESTED: the operator asked not to use plan mode for now. DOCS: the operator's `plan` role is gpt-6-astra. | UNTESTED | UNTESTED |
| Goal tools | UNTESTED. DOCS: they need `/tier plan_tools`, and tiers and flags were out of scope for this probe. | UNTESTED | UNTESTED |
| `workflow_script` / `workflow_start` | `workflow_script {help:true}` **WORKS** and returns the script API (see the workflow API section). `workflow_start` UNTESTED, to avoid spawning agents during the probe. | UNTESTED | UNTESTED |
| Task isolation (`isolation: "worktree"`) | **BLOCKED_CAPABILITY** on a daemon with no tier set. The `task` call carried no `isolation` field, no `mend/task-*` branch or worktree was created, and the docs print "Sub-agent worktrees: off (no tier set)". DOCS: the operator's daemon (tier full) reports it on. Two side findings: `task` rejects `openai/gpt-6-luna` and wants the bare id `gpt-6-luna`; and the child loaded the probe skill instead of doing its task (F5). | UNTESTED | UNTESTED |
| `delegate_task` / thread tools | **BLOCKED_CAPABILITY** on a daemon with no tier set. Luna's tool list has `shell_session`, `sessions`, `tell` and `task`, but no `thread_*` or `delegate_task`. DOCS: they need the full tier. | UNTESTED | UNTESTED |
| `mendcode run --bg` from another repo | **WORKS**. It prints the session id at once; `logs <id>` streams the events and the final text. `ps` lists only running sessions. `session list --dir /tmp/...` shows nothing, while `--dir /private/tmp/...` shows the session, because the symlinked path is not normalised (F4). | UNTESTED | UNTESTED |
| Parent-folder sessions | **WORKS** for the file tools: a session with its cwd in the parent folder read `child/a.txt` and created `child/parent-wrote.txt`. `git -C child log` is outside the smart allow-list, so a headless run denies it with exit 5. Workers should `cd` into their repo, or run with their cwd set to it. `session list` on the parent folder does not include the child's sessions. | UNTESTED | UNTESTED |
| Image input, worker | **WORKS** at 1600×1000 and 2400×1500: the bands and size are correct. 1440×9000 is accepted and all four bands are named in order, but the model reported 1440×4320, which suggests a downscale (unverified). Approximate cost, measured as input plus cacheRead minus a no-image turn of about 16.6k: +5.6k tokens (1600), +8k (2400), +19k (1440×9000). Rule for critique crops: long side at most 1600 px. | UNTESTED | UNTESTED |
| Image input, advisor | UNTESTED: advisor off. | UNTESTED | UNTESTED |

### PreToolUse payload (observed, native engine)

```json
{
  "session_id": "ses_…",
  "cwd": "/private/tmp/<repo>",
  "hook_event_name": "PreToolUse",
  "turn_id": "…",
  "tool_name": "shell",
  "tool_use_id": "…",
  "tool_input": { "command": "echo <token>" }
}
```

`cwd` is the resolved real path (`/private/tmp`, not `/tmp`). The guard must normalise paths before comparing them with the worktree root.

### Workflow API (from `workflow_script` help)

```text
export const meta = { name, description, phases, budget { agents, tokens, usd, minutes }, contract, permission, maxConcurrent 1..16 }
```

The body runs in an isolated process.

### Base cost per turn

A luna turn sends about 16.6k input tokens before any task text. Of those, roughly 20k (estimated) are the schemas of 59 tools; caching cuts the billed input to between 3.7k and 20k cache reads. A worker's cost floor is therefore set by the tool surface, not by the brief.

## Consequences for the design

- **Codex is viable.** Package skills and hooks both work on the native engine.
- **Guard.** Install the guard in user scope (`<data dir>/packages/`). Otherwise the setup must tell the operator to trust each pilot repo; without trust, the project-scope hooks silently do nothing. The setup check must verify that a test block fires before any dispatch.
- **Skills.** Skill descriptions need narrow triggers that name the exact intent. Cheap models load broad skills and follow them over the task.
- **Dispatch.**
  - Worktree isolation and `delegate_task` depend on the tier, so the coordinator must read the live capability lines before choosing a dispatch mode.
  - `mendcode run --bg` with `--cwd <repo>` works without any tier, so it is the fallback.
  - Pass bare model ids to `task`.
- **Workers.** Run every worker with its cwd set to its own repo or worktree. Do not rely on `git -C` under smart permission.
- **Critique crops.** Long side at most 1600 px. Split tall pages into several crops instead of sending one tall image.

## MendCode follow-ups

- **F1.** `mendcode run` rejects `--isolated` (exit 64, TUI only). Headless probes need `--dir <tmp>`. Either support `--isolated` on `run`, or document the `--dir` substitute in the error message.
- **F2.** Project-scope package hooks do not fire in an untrusted directory, and nothing tells the user. A one-line notice in the session ("project hooks skipped: directory not trusted") would avoid silent gaps in guards.
- **F3.** No advisor status is readable from inside a session. `ai_config get advisor` returns `{}`, even though the control plane has an advisor role assigned. A read-only status (off, on, model) would let a coordinator plan without guessing.
- **F4.** `session list --dir /tmp/x` and `--dir /private/tmp/x` disagree on macOS. Normalise symlinked project paths.
- **F5.** Cheap models (luna) load skills whose description matches loosely, even when told not to, and sub-agents do it too. This is partly package hygiene (narrow descriptions). A per-run option to hide package skills would also help probes and workers.
- **F6.** About 20k tokens of tool schemas go out per turn. A slimmer tool surface for workers (`--tools`, or a worker preset) would lower the cost floor.
- **F7.** `task` accepts only bare model ids, while `run --model` accepts `provider/model`. The two inputs should be accepted the same way.
- **F8.** `mendcode package check` warns about the `hooks` folder of a package whose hooks work. The warning should say what it expects.

## Update from the MendCode maintainers (2026-11-03, main 11507823 installed)

Answers to seven questions, reported by the maintainer session as checked against the MendCode source. Not re-measured here.

- **`--isolated`** starts a private daemon on a temporary data dir and stops it when the TUI exits. It does not create a worktree and is untested with `run --bg`. `daemon start --dir <dir>` works. File isolation is our job: the workflows create the item worktree.
- **Hooks.** PreToolUse package hooks fire only in the native engine, including with OpenAI models such as gpt-6-luna. They do not fire in the Codex app-server engine, the Claude Code engine or ACP engines. The payload has not changed since 2026-10-27.
- **Flags.** Design the workflows with `plan_tools` and `git_actions` off. Plan mode had a regression in read-only internal sessions on external engines, fixed in an uninstalled batch. `git_actions` is still experimental.
- **Loaders.** No loader for `checks/`, `profiles/` or `guard/` is planned; they stay data read by the skills, and the `package check` warning about them is expected.
- **Recipes and workflow scripts:** unchanged. Advisor: three commits since 2026-10-30 (off for this operator). Loops: changing in the uninstalled batch.
- **Do not rely on yet:** plan mode on external engines, the PR reviewer, context figures, loops, and how sent comments render.
- **Temp dirs (F9 below):** confirmed and filed upstream.

**Consequences.** The Codex recipes pin the native engine; on another engine the guard does not run, so the setup refuses or warns and the card records it. The Claude Code and OpenCode Go adapters cannot count on package hooks unless they also run on the native engine: each `MAPPING.md` must say where the guard actually runs, and an engine without it is recorded in `notVerified`. The workflows do not use plan mode, loops or the PR reviewer.

- **F9.** `$TMPDIR` holds about 27,000 leftover entries from tests and from the daemon (about 400 a day from host-mcp).
- **F10.** `mendcode package check` fails a package with `code appears to use "network" but capabilities does not declare it` when any JSON string value ends in `net`: a recipe naming the catalog model `claude-sonnet` fails, and so do the values `"magnet"` and `"net"`, while `"claude-sonnet-5-5"` and the word in a description pass. The capability scan should look for network APIs in code, not for the letters at the end of a string. Reported to the MendCode maintainers on 2026-11-03 and fixed in b226d17e, which ships with batch 5 (the installed check still fails until then). Maintainers confirm a recipe accepts both `claude-sonnet` (follows the newest Sonnet) and `claude-sonnet-5-5` (pins the version), and both run on Claude Code. The Max recipe pins to `claude-sonnet-5-5` until batch 5 is installed; the recipe itself has not been applied here.

## Claude column (2026-11-03)

The table above was measured for Codex only. For the Claude adapter these are the facts its `/mend-setup` and `MAPPING.md` rely on. Nothing here was observed in a MendCode session on a Claude model.

| Capability | claude | Source |
|---|---|---|
| Claude models offered | **WORKS** in the catalog: `claude-fable`, `claude-haiku`, `claude-opus`, `claude-sonnet`, shown only when `claude --version` answers on the daemon's PATH. | `mendcode models claude --verbose`; DOCS engines |
| Effort levels | **WORKS** in the catalog: low, medium, high, xhigh for fable, opus and sonnet; none listed for haiku. | `mendcode models claude --verbose` |
| Engine | DOCS: a Claude model runs on the Claude Code engine with its own login, CLAUDE.md, skills, hooks and MCP servers; MendCode's native tools are not in play. | DOCS engines |
| Package skills | **NOT_APPLIED** (DOCS): the engine loads Claude Code's skills, not MendCode's. Copy to `~/.claude/skills/`. | DOCS engines |
| Package hooks (MendCode `hooks.json`) | **NOT_APPLIED** (DOCS): package hooks fire only on the native engine. | maintainers; DOCS hooks |
| Guard script with Claude Code's PreToolUse payload | **WORKS** when the event is piped in: `Bash` with `git push --force` and `Read`/`Grep` of `.env` files exit 2 with the rule; `Bash git status` and `Edit` exit 0. | piped events |
| Guard as a Claude Code hook in `~/.claude/settings.json` | UNTESTED inside MendCode. `/mend-setup` probes it before any dispatch. | Claude Code hook format |
| Package commands (`/mend-setup`) in a Claude session | UNTESTED. Fallback: send the file's text as the prompt. | none |
| Workflow agents with `engine: "claude"` | DOCS: need the full tier and an exact model; no per-agent `allowedTools` or `budget`. UNTESTED live. | DOCS workflows; maintainers |
| Read-only workflow agents and the plan note | DOCS: since 73666e7c, read-only internal sessions on the Claude Code engine no longer get the "present the plan" note. | maintainers |
| Advisor | DOCS: a Claude advisor runs through headless `claude -p` on the subscription. | DOCS advisor |
| Usage and cost | DOCS: the 5-hour and 7-day windows show in `/usage`; no cost is shown. | DOCS engines |
| `check()` in workflows | DOCS: runs outside the permission system, so no hook sees it; `mend-pr` guards item commands itself. | DOCS workflows; maintainers |

**Claude is viable.** The guard can run on Claude, as a Claude Code hook. Safety on Claude stays unproven until `/mend-setup`'s probe passes in a real session.

**OpenCode Go.** Deferred by the user on 2026-11-03: there is no subscription to test with. Facts kept for later: the Go models are reachable here only through ACP (`acp:opencode/opencode-go/...`), where package hooks do not fire, package skills do not load and workflows refuse the agents; the native `opencode` provider lists the same model names but is not connected, and whether a Go subscription works through it is UNTESTED.

## Cleanup and recovery

- The probe package lived only in the temporary data dir and the scratch repo.
- The temporary daemon is stopped.
- The scratch repos, the temporary data dir, the images and the logs went to the Trash.
