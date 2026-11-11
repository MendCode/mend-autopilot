# MAPPING: MendCode with an OpenCode Go subscription

The core skills use neutral names for roles, tools and paths. This file says what each one is in MendCode when the models come from OpenCode Go, optionally with Gemini Carbon from OpenCode Zen. Where MendCode cannot do something, the row says so and what happens instead.

> [!NOTE]
> This adapter is configured but has not run against a live OpenCode account. The model ids come from OpenCode's model list on 2026-11-11; `/mend-setup` checks that the account can reach each one before anything is dispatched.

## Engine

Run every mend-autopilot session on the **native engine** with a model of MendCode's native providers: `opencode-go/<model>` for the Go subscription and `opencode/<model>` for OpenCode Zen. Package hooks, and with them the guard, fire only on the native engine.

The OpenCode ACP agent (`acp:opencode/...`) is not usable: package hooks do not fire there and MendCode workflows refuse ACP agents ("ACP agents cannot enforce workflow task policies"). The two routes list the same model names, so check the prefix.

## Roles

| Core name | In MendCode | Notes |
|---|---|---|
| lead | The session the user works in: the `main` role of the applied recipe. | Cheap model. It never implements multi-file changes. |
| owner | A `work` agent of a workflow (the `workflow` role), or a sub-agent (`subagent` role). | Cheap model. Its working directory is the item worktree. |
| auditor | A `read` agent of `mend-lite-pr` or `mend-pr`, in its own session. | Never the owner's session. |
| plan role | A read-only sub-agent (`task`) on the recipe's `plan` model. | Plan mode is not used. |
| advisor | The native `advisor` tool. | Only after the user runs `/advisor`. |
| critic | The review agent of `mend-lite`, or the `critique` agent of `mend-quality`, on the `critic` argument. | The strong model. |

Recipes set `main`, `subagent`, `workflow`, `plan` and `advisor`, and nothing else. The user applies one with `mendcode recipe apply <name>`; nothing in the package applies it.

| Recipe | Cheap model | Strong model | Billing |
|---|---|---|---|
| `mend-autopilot-opencode-go-carbon` | `opencode-go/deepseek-v4.1-flash` | `opencode/gemini-4-carbon` | Go subscription, plus Zen per use for the strong model |
| `mend-autopilot-opencode-go` | `opencode-go/deepseek-v4.1-flash` | `opencode-go/gemini-4-argon` | Go subscription only |

Gemini Carbon was on OpenCode Zen but not yet on the Go list when this adapter was written. If it reaches Go, change the two strong roles to `opencode-go/gemini-4-carbon`. The recipes set no effort: these providers do not publish the levels MendCode would offer for them, so each model runs at its default.

## Steps

| Core step | In MendCode |
|---|---|
| Ask for a change | Plain words in a session: the `mend-autopilot` skill loads by itself, prepares the repo with `checks/setup-light.mjs`, writes the items and starts `mend` per item with the models in `autopilot.json`. `mend` = `mend-lite`, `mend-lite-pr`, then push and pull request (`publish=no` keeps it local). Not yet run on this harness. |
| Light path, build and review | `/workflows run mend-lite repo=<absolute repo path> item=.mend/items/<id>.json pkg=<package dir> critic=opencode/gemini-4-carbon model=opencode-go/deepseek-v4.1-flash` |
| Light path, evidence card | `/workflows run mend-lite-pr repo=<absolute repo path> item=.mend/items/<id>.json pkg=<package dir> auditor=opencode/gemini-4-carbon` |
| Full path | `mend-quality` and `mend-pr`, with the same `critic` and `model` arguments, as in the Codex adapter. |
| Rubric, integrity, red-green, critic reply, climb | As in the core: `node <package dir>/checks/<tool>.mjs`, the same as for any harness. |
| Human approval, countersign | `ask()` inside the workflow; the run waits in `/workflows` until the user answers. |
| Open, update and merge the PR | The lead, with the `mend-ship` skill and `git`/`gh` in the worktree. The workflows never push. |

With the all-Go recipe, pass `opencode-go/gemini-4-argon` wherever Carbon appears above. `<package dir>` is the `dir` that `mendcode package list --json` prints for `mend-autopilot-opencode-go`.

## Paths

As in the Codex adapter: items in `<repo>/.mend/items/<id>.json`, the grant in `<repo>/.mend/grants.json`, evidence under `<worktree>/.mend/evidence/`, the project verification skill at `<repo>/.mendcode/skills/verify-<repo>/SKILL.md`, and the guard config in `<repo>/.mend/guard.json`.

## What runs outside the guard

Commands passed to `check()` in a workflow run outside MendCode's permission system, so the package hook does not see them. Internal repository-check and regression/setup runners preflight the guard before running shell commands; a failed preflight blocks execution.

## Not verified yet

- that both providers log in and serve these models to the user's account;
- how well deepseek-v4.1-flash follows the owner briefs and how strict Carbon is as a reviewer: the Codex pilot's results do not carry over to other models.

Until they are seen working, record the item's first runs as a pilot and keep a person reviewing every card.

## Not used

| Feature | Why |
|---|---|
| The OpenCode ACP agent | No package hooks and no workflows there. |
| Plan mode, goals, `git_actions`, loops, the PR reviewer | Not needed, as for the Codex adapter. |
