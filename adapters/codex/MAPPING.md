# MAPPING: MendCode with a ChatGPT (Codex) subscription

The core skills use neutral names for roles, tools and paths. This file says what each one is in MendCode when the models come from a ChatGPT plan. Where MendCode cannot do something, the row says so and what happens instead.

## Engine

Run every mend-autopilot session on the **native engine** with a ChatGPT model: `gpt-6-luna`, `gpt-6.1-terra` or `gpt-6-astra`. Package hooks, and with them the guard, fire only on the native engine. On the Codex app-server, Claude Code, pi or ACP engines they do not fire, and nothing reports it. `/mend-setup` checks the engine and makes the guard block a probe before anything is dispatched.

## Roles

| Core name | In MendCode | Notes |
|---|---|---|
| lead | The session the user works in: the `main` role of the applied recipe. | Cheap model. It never implements multi-file changes. |
| owner | A `work` agent of the `mend-quality` workflow (the `workflow` role), or a sub-agent (`subagent` role). | Cheap model. Its working directory is the item worktree. |
| auditor | A `read` agent of the `mend-pr` workflow, in its own session. | Never the owner's session. Optional `auditor` argument for another model. |
| plan role | A read-only sub-agent (`task`) on the recipe's `plan` model (`gpt-6-astra`). | Plan mode is not used. |
| advisor | The native `advisor` tool. | Only after the user runs `/advisor`. Off means the lead does without it; it is never replaced by another model. |
| critic | The `critique` agent of `mend-quality`, a fresh session for every round, on the `critic` argument. | Pass the recipe's `plan` model as the bare catalog id (`gpt-6-astra`), the form `agent()` takes. |

Recipes set `main`, `subagent`, `workflow`, `plan` and `advisor`, and nothing else. The user applies one with `mendcode recipe apply <name>`; nothing in the package applies it.

| Recipe | Cheap model | Owners at once |
|---|---|---|
| `mend-autopilot-chatgpt-20` | gpt-6-luna | 1 |
| `mend-autopilot-chatgpt-100` | gpt-6.1-terra | 2 |
| `mend-autopilot-chatgpt-200` | gpt-6.1-terra | 4 |

"Owners at once" is the grant's `maxOwners`. A workflow runs one item; for several items at once the lead starts several runs, up to that number.

## Steps

| Core step | In MendCode |
|---|---|
| Ask for a change | Plain words in a session: the `mend-autopilot` skill loads by itself, prepares the repo with `checks/setup-light.mjs`, writes the items and starts `mend` per item with the models in `autopilot.json`. `mend` = `mend-lite`, `mend-lite-pr`, then push and pull request (`publish=no` keeps it local). Run end to end with gpt-6-luna as the lead. |
| Light path, build and review | `mend-lite` workflow: `/workflows run mend-lite repo=<absolute repo path> item=.mend/items/<id>.json pkg=<package dir> critic=gpt-6-astra model=gpt-6.1-terra`. Optional `planner`, `fixRounds` (default 1, at most 3) and `engine`. Ends `reviewed`, `draft` or `blocked`. |
| Light path, evidence card | `mend-lite-pr` workflow: `/workflows run mend-lite-pr repo=<absolute repo path> item=.mend/items/<id>.json pkg=<package dir> auditor=gpt-6-astra`, after `mend-lite` reviewed the current head. Ends `merge-ready` or `blocked`. |
| Dispatch an owner (mend-mode §7) | `mend-quality` workflow: `/workflows run mend-quality repo=<absolute repo path> item=.mend/items/<id>.json pkg=<package dir> critic=gpt-6-astra`. Without workflow tools, use the other rows of §7. |
| Owner worktree | `mend-quality` runs `git worktree add -b mend/<id> <repo>/.mend/worktrees/<id> <trunk head>` with its cwd set to the repository root. The repo must ignore `.mend/`. |
| Owner restatement (§6) | A read-only agent answers first; files outside the edit set or above the file cap stop the run before any edit. |
| Rubric, integration diff | `node <pkg>/checks/run-rubric.mjs run --item <item> --base <sha> --head <sha> --repo <worktree> [--integration] [--without-card]`. `plan` instead of `run` lists the profiles and what each asks for. |
| Integrity scan | `node <pkg>/checks/integrity.mjs --base <sha> --head <sha> --item <item> --repo <worktree> --json` |
| Red-green | `node <pkg>/checks/red-green.mjs --base <sha> --head <sha> --cmd '<command>' --repo <worktree> --json`, run by `mend-pr` when the item has `regression` or `regressionCommand`; a nonblank `regressionCommand` wins, otherwise `regression` is used. Optional `regressionSetup`, `regressionExpect` and `regressionTimeoutMs` are forwarded to the runner and recorded in the evidence card. |
| Read a critic reply | `node <pkg>/checks/critic-reply.mjs <reply.md>` |
| Build a critique request | `node <pkg>/checks/critique-request.mjs --item <item> --repo <worktree> --base <sha> --head <sha>`; see `mend-quality` for material, log and later-round flags. |
| Climb step | `node <pkg>/checks/climb.mjs ...` (see `playbooks/climb.md`). |
| Human approval, countersign | `ask()` inside the workflow; the run waits in `/workflows` until the user answers. |
| Contract checks, auditor, card | `mend-pr` workflow: `/workflows run mend-pr repo=<absolute repo path> item=.mend/items/<id>.json pkg=<package dir>`. It writes `.mend/evidence/<id>.json` in the worktree. |
| Open, update and merge the PR | The lead, with the `mend-ship` skill and `git`/`gh` in the worktree. The workflows never push. |
| Background owner without workflows | `mendcode run --bg --cwd <worktree> --model openai/<model> --permission <mode>` (not `--isolated`: that is a separate daemon, not a worktree). |

`<package dir>` is the `dir` that `mendcode package list --json` prints for `mend-autopilot-codex`.

`repo` is required and must be the absolute path of the user's repository containing `.mend/`, not the workflow's scratch checkout. Relative `item` and `pkg` paths resolve against `repo`; prefer the absolute installed package directory. Host checks may run in an unrelated clean worktree.

## Paths

| Core name | Path |
|---|---|
| Work item | `<repo>/.mend/items/<id>.json`: the fields of mend-mode §5 as JSON, plus optional `problem`, `riskRule`, `regression` (alias `regressionCommand`), `regressionSetup`, `regressionExpect` and `regressionTimeoutMs`. |
| Grant | `<repo>/.mend/grants.json`: `{ "rung": "draft", "queue": false, "maxOwners": 1, "disposable": false }`, written by the user. |
| Evidence | `<worktree>/.mend/evidence/<id>/` and the card at `<worktree>/.mend/evidence/<id>.json`. |
| Project verification skill | `<repo>/.mendcode/skills/verify-<repo>/SKILL.md` |
| Guard config | `<repo>/.mend/guard.json` |
| Quality config | `<repo>/.mend/quality.json` |

## What runs outside the guard

Commands passed to `check()` in a workflow run outside MendCode's permission system, so the package hook does not see them. Internal repository-check and regression/setup runners preflight the guard before running shell commands; a failed preflight blocks execution. The core CLIs that `check()` calls are part of this package.

## Not used

| Feature | Why |
|---|---|
| Plan mode, `/tier plan_tools`, goals | Not needed; plan mode on external engines was still changing when this adapter was written. |
| `/experimental git_actions`, the Git page | The lead uses `git` and `gh` from the shell. |
| Loops, the PR reviewer | Changing at the time of writing; `mend-ship` §12 describes how to watch a PR instead. |
| `--isolated` | Starts a private daemon; it does not isolate files. |
| `merge()` from the workflow API | Items do not stack; each has its own branch from trunk. |
