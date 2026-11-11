# MAPPING: MendCode with a Claude subscription

The core skills use neutral names for roles, tools and paths. This file says what each one is in MendCode when the models are Claude models on the user's Claude subscription. Where something cannot be done, the row says so and what happens instead.

## Engine

A MendCode session on a Claude model runs on the **Claude Code engine**: MendCode starts `claude` with the user's own login, and the turn uses Claude Code's tools, skills, hooks, CLAUDE.md and MCP servers. MendCode's native tools, and this package's skills and MendCode hook, are not in play there. So:

- the package folder is also a **Claude Code plugin**, `mend-autopilot`, with its own local marketplace (`.claude-plugin/`). The user installs it once with `claude plugin marketplace add <package dir>` and `claude plugin install mend-autopilot@mend-autopilot-local`; it brings the skills, `/mend-setup` and the guard, and nothing is copied into `~/.claude/`;
- the guard runs as the plugin's `PreToolUse` hook with `--mend-only`: it acts only in a folder inside a repository that has a `.mend/` folder (the repository itself and its item worktrees) and lets every other Claude Code session through untouched;
- `/mend-setup` checks the plugin and makes the guard refuse a probe before anything is dispatched.

The guard reads the same JSON event either way: Claude Code sends `tool_name` `Bash`, `Read`, `Grep`, `Edit` and so on, with `tool_input.command` or `tool_input.file_path`, and exit 2 refuses the call with the guard's message.

If `/mend-setup` is not offered in a Claude session, open `<package dir>/commands/mend-setup.md` and send its text as the prompt.

## Roles

| Core name | In MendCode with Claude | Notes |
|---|---|---|
| lead | The user's session: the recipe's `main` role. | Cheap model. |
| owner | A `work` agent of `mend-quality` with `engine: "claude"`, or a sub-agent. | Cheap model; its working directory is the item worktree. |
| auditor | A `read` agent of `mend-pr` in its own session, on the same engine. | Defaults to the owners' model; never the owner's session. |
| plan role | A read-only sub-agent on the recipe's `plan` model (`claude-opus`). | Plan mode is not used. |
| advisor | MendCode's advisor, which runs a Claude model through headless `claude -p` on the subscription. | Only after the user runs `/advisor`. |
| critic | The `critique` agent of `mend-quality`, a fresh session every round. | Pass `critic=claude-opus`. |

Recipes set `main`, `subagent`, `workflow`, `plan` and `advisor`, and nothing else; the user applies one with `mendcode recipe apply <name>`.

| Recipe | Cheap model | Strong model |
|---|---|---|
| `mend-autopilot-claude-pro` | claude-haiku (the catalog lists no effort levels for it, so none is set) | claude-opus, medium |
| `mend-autopilot-claude-max` | claude-sonnet-5-5, medium (pinned: the bare alias `claude-sonnet` trips MendCode finding F10) | claude-opus, medium |

The names are the catalog's family aliases and follow the newest model of each family. Usage counts against the 5-hour and 7-day windows; MendCode shows no cost for it. The number of owners at once is the grant's `maxOwners`; on Pro keep it at 1.

## Steps

| Core step | In MendCode with Claude |
|---|---|
| Light path, build and review | `/workflows run mend-lite repo=<absolute repo path> item=.mend/items/<id>.json pkg=<package dir> critic=claude-opus engine=claude model=<cheap model>`. Every agent of the run, the critic included, runs on the Claude Code engine. |
| Light path, evidence card | `/workflows run mend-lite-pr repo=<absolute repo path> item=.mend/items/<id>.json pkg=<package dir> engine=claude auditor=claude-opus`. On a non-native engine the auditor model is required. |
| Dispatch an owner (mend-mode §7) | `/workflows run mend-quality repo=<absolute repo path> item=.mend/items/<id>.json pkg=<package dir> critic=claude-opus engine=claude model=<cheap model>`. Agents on the Claude Code engine need the full tier and an exact model. Without it, use the other rows of §7. |
| Verify and write the card | `/workflows run mend-pr repo=<absolute repo path> item=.mend/items/<id>.json pkg=<package dir>`; the auditor runs on the engine and model `mend-quality` recorded. |
| Owner worktree, restatement, rubric, integrity, red-green, critic reply, climb | As in the core: the workflows and `node <package dir>/checks/<tool>.mjs`, the same as for any harness. |
| Human approval, countersign | `ask()` inside the workflow; the run waits in `/workflows`. |
| Open, update and merge the PR | The lead, with the `mend-ship` skill and `git`/`gh` in the worktree. The workflows never push. |

`<package dir>` is the `dir` that `mendcode package list --json` prints for `mend-autopilot-claude`.

`repo` is required and must be the absolute path of the user's repository containing `.mend/`, not the workflow's scratch checkout. Relative `item` and `pkg` paths resolve against `repo`; prefer the absolute installed package directory. Host checks may run in an unrelated clean worktree.

## Paths

| Core name | Path |
|---|---|
| Skills, `/mend-setup` | The `mend-autopilot` Claude Code plugin, installed from `<package dir>`. |
| Guard | `<package dir>/guard/mend_guard.py --mend-only`, wired by the plugin's `claude-hooks.json`. |
| Project verification skill | `<repo>/.claude/skills/verify-<repo>/SKILL.md`, committed, so item worktrees have it. |
| Work item, grant, evidence, guard config, quality config | As for every harness: `<repo>/.mend/items/<id>.json`, `<repo>/.mend/grants.json`, `<worktree>/.mend/evidence/`, `<repo>/.mend/guard.json`, `<repo>/.mend/quality.json`. |

## What runs outside the guard

Commands passed to `check()` in a workflow run outside MendCode's permission system and outside Claude Code, so no hook sees them. Internal repository-check and regression/setup runners preflight the guard before running shell commands; a failed preflight blocks execution.

## Not verified yet

These come from MendCode's documentation and its maintainers, not from a run with this package:

- that the plugin's hook fires for owners and auditors started by a workflow on the Claude Code engine (MendCode starts `claude` with the user's own configuration, plugins included);
- that a workflow accepts `engine: "claude"` with these model names on this machine's tier;
- that MendCode offers this package's `/mend-setup` command inside a Claude session.

`/mend-setup` checks the first one directly with its probe. Until the others are seen working, a Claude item that depends on them stays `notVerified` on its card.

## Not used

| Feature | Why |
|---|---|
| MendCode package skills and hooks inside Claude sessions | The Claude Code engine does not load them, so this package ships no MendCode `hooks.json`; the Claude Code plugin carries the skills and the guard instead. In native MendCode sessions the package's skills would repeat the Codex package's, so turn them off there if both are installed (`mendcode package config mend-autopilot-claude disable skills/<name>`). |
| Plan mode, `/tier plan_tools`, goals, `/experimental git_actions`, loops, the PR reviewer | Not needed, as for the Codex adapter. |
| ACP engines | Workflows refuse ACP agents, and package hooks do not fire there. |
