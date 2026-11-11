---
description: Check that mend-autopilot can run here on an OpenCode Go subscription and print the steps the user applies (provider login, recipe, safety). Changes nothing.
argument-hint: "[go|carbon]  all on Go, or Go with Gemini Carbon from OpenCode Zen"
---

Run the mend-autopilot setup check for OpenCode Go. You only read and print. Do not log in, apply a recipe, change a role, model, flag, tier, permission, trust or setting, install anything, or edit any file. Every change below is a command for the user to run.

The user's choice, if given: $ARGUMENTS

Why this matters: OpenCode is reachable in MendCode two ways. Through the ACP agent (`acp:opencode/...`) package hooks do not fire and workflows refuse the agents, so mend-autopilot cannot run there. Through MendCode's native providers `opencode-go` (the Go subscription) and `opencode` (OpenCode Zen, pay per use) the session runs on the native engine, the guard fires and the workflows work. This package uses only the native providers.

Do these steps in order. For each, print one line: `PASS`, `FAIL` or `SKIP`, what you checked, and what you saw. Stop at the first `FAIL` of steps 1 to 5 and print only what the user must do to fix it.

1. **Engine.** Say which model and engine this session runs on. A model whose id starts with `opencode-go/` or `opencode/` on the native engine passes. A model starting with `acp:` is a `FAIL`: tell the user to start a new session on `opencode-go/deepseek-v4.1-flash` and run `/mend-setup` again.
2. **Tools on PATH.** Run `python3 --version`, `node --version` and `git --version`. Python 3.9 or newer, Node 20 or newer and any git 2.x pass.
3. **Providers.** Run `mendcode providers list`. `opencode-go` must be `ready`. For the Carbon recipe, `opencode` must be `ready` too. If one is missing, `FAIL` with the login lines below.
4. **Models listed.** Run `mendcode models opencode-go` and, for the Carbon recipe, `mendcode models opencode`. `deepseek-v4.1-flash` and `gemini-4-argon` must be listed for `opencode-go`, and `gemini-4-carbon` for `opencode`. If a model is missing, run the same command with `--refresh` once. If it is still missing, `FAIL` and print the closest names the list does show: the recipe names a model this account cannot reach.
5. **Package and guard.** Run `mendcode package list --json`. `mend-autopilot-opencode-go` must be enabled in user scope; print its `dir`, which the workflows take as `pkg`. Then run exactly `cat ./.env.mend-guard-probe`. This is a `PASS` only if the call is refused by a PreToolUse hook whose message names the rule `secret-read`. If the command runs at all (even with "No such file"), the guard is not active: `FAIL`.
6. **Recipes visible.** Run `mendcode recipe list`. `mend-autopilot-opencode-go` and `mend-autopilot-opencode-go-carbon` should be listed from this package.
7. **Current roles.** Run `mendcode control-plane models status` and print it, so the user can see what a recipe would replace.

Then print the steps for the user, filled in from what you saw:

**Log in** (once; the key stays in MendCode's credential store):

```sh
mendcode providers login --provider opencode-go --api-key-env OPENCODE_GO_API_KEY
mendcode providers login --provider opencode --api-key-env OPENCODE_API_KEY   # only for the Carbon recipe
```

Each line reads the key from the named environment variable. `/connect` in the TUI does the same.

**Pick a recipe.** The strong model only plans, advises and critiques; the other roles run on the cheap model. Applying a recipe replaces only the roles it names: `main`, `subagent`, `workflow`, `plan` and `advisor`.

| Choice | Recipe | Cheap model | Strong model |
|---|---|---|---|
| carbon | `mend-autopilot-opencode-go-carbon` | `opencode-go/deepseek-v4.1-flash` | `opencode/gemini-4-carbon` (Zen, billed per use) |
| go | `mend-autopilot-opencode-go` | `opencode-go/deepseek-v4.1-flash` | `opencode-go/gemini-4-argon` (Go) |

If the user gave a choice, mark that row. Otherwise ask nothing; the table is enough. The Go subscription has usage limits and Zen bills per token; MendCode shows the usage it can read.

**Before applying, keep a copy of the roles:** `mendcode control-plane models status > ~/mend-roles-before.txt`

**Apply:** `mendcode recipe apply <recipe>`. **Undo:** apply the recipe that was active before (`mendcode recipe list` marks it with `*`), or set each role back with `/model`.

**Workflows:** pass the same ids the recipe uses, for example `critic=opencode/gemini-4-carbon model=opencode-go/deepseek-v4.1-flash` for `mend-lite` and `auditor=opencode/gemini-4-carbon` for `mend-lite-pr`. Never pass an `acp:` model or engine.

**Advisor (optional, spends the strong model):** `/advisor <strong model>`; `/advisor off` turns it off.

**Flags:** none are needed. Leave `plan_tools` and `git_actions` as they are.

**Safety:** the deny rules and sandbox settings to add yourself are in `<dir>/docs/safety-setup.md`; print its section headings.

**Per repository, before the first item:** `.mend/` in `.gitignore`; a grant at `<repo>/.mend/grants.json` such as `{ "rung": "draft", "queue": false, "maxOwners": 1, "disposable": false }`; a project verification skill at `<repo>/.mendcode/skills/verify-<repo>/SKILL.md`, created with the `create-verification` skill and run once with `PASS`.

End with one line: `ready`, or `not ready: <first failing step>`.
