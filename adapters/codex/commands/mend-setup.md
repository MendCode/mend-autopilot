---
description: Check that mend-autopilot can run here and print the steps the user applies (recipe, advisor, safety). Changes nothing.
argument-hint: "[20|100|200]  your ChatGPT plan, if you know it"
---

Run the mend-autopilot setup check. You only read and print. Do not apply a recipe, change a role, model, flag, tier, permission, trust or setting, install anything, or edit any file. Every change below is a command for the user to run.

The user's ChatGPT plan, if given: $ARGUMENTS

Do these steps in order. For each, print one line: `PASS`, `FAIL` or `SKIP`, what you checked, and what you saw. Stop at the first `FAIL` of steps 1 to 4 and print only what the user must do to fix it.

1. **Engine.** Say which model and engine this session runs on. The guard only runs on the native engine with a ChatGPT model (`gpt-6-luna`, `gpt-6.1-terra`, `gpt-6-astra`). On a Claude Code, Codex app-server, pi or ACP model the package hooks do not fire, so this is a `FAIL`: tell the user to start a new session on a native ChatGPT model and run `/mend-setup` again.
2. **Tools on PATH.** Run `python3 --version`, `node --version` and `git --version`. Python 3.9 or newer, Node 20 or newer and any git 2.x pass.
3. **Package.** Run `mendcode package list --json`. `mend-autopilot-codex` must be enabled in user scope. Project scope (`<repo>/.mendcode/packages/`) is a `FAIL`: its hooks only run after the user trusts the folder, and nothing reports when they are skipped, so tell the user to install it in user scope instead. Print its `dir`: the workflows take it as `pkg`.
4. **Guard fires.** Run exactly `cat ./.env.mend-guard-probe`. This is a `PASS` only if the call is refused by a PreToolUse hook whose message names the rule `secret-read`. If the command runs at all (even with "No such file"), the guard is not active: `FAIL`.
5. **Recipes visible.** Run `mendcode recipe list`. The three recipes `mend-autopilot-chatgpt-20`, `-100` and `-200` should be listed from this package. If they are missing, tell the user to copy them from the package's `recipes/` folder to `~/.mendcode/recipes/`.
6. **Current roles.** Run `mendcode control-plane models status` and print it, so the user can see what a recipe would replace.

Then print the steps for the user, filled in from what you saw:

**Pick a recipe** by ChatGPT plan. The strong model only plans, advises and critiques; the other roles run on the cheap model. Applying a recipe replaces only the roles it names: `main`, `subagent`, `workflow`, `plan` and `advisor`.

| Plan | Recipe | Owners at once |
|---|---|---|
| 20 | `mend-autopilot-chatgpt-20` (gpt-6-luna) | 1 |
| 100 | `mend-autopilot-chatgpt-100` (gpt-6.1-terra) | 2 |
| 200 | `mend-autopilot-chatgpt-200` (gpt-6.1-terra) | 4 |

If the user gave a plan, mark that row. Otherwise ask nothing; the table is enough.

**Before applying, keep a copy of the roles:** `mendcode control-plane models status > ~/mend-roles-before.txt`

**Apply:** `mendcode recipe apply <recipe>`. Roles apply to new sessions.

**Undo:** apply the recipe that was active before (`mendcode recipe list` marks it with `*`), or set each role back with `/model` from the saved copy.

**Advisor (optional, spends strong-model tokens):** `/advisor gpt-6-astra#medium` turns it on; `/advisor off` turns it off. Leave it off if you do not want that spend. If the model reference is refused, use the reference `/model` shows for gpt-6-astra.

**Flags:** none are needed. Leave `plan_tools` and `git_actions` as they are; mend-autopilot does not use goals, plan mode or the Git page.

**Safety:** the guard runs in every native session while this package is enabled, not only in mend-autopilot work. Disable the package to turn it off. The deny rules and sandbox settings to add yourself are in this package's `docs/safety-setup.md`; print that file's section headings and its path.

**Approvals:** explain that smart mode may ask for package reads outside the project and for other commands. After reviewing a trusted request, the user can choose **For this session** if offered, or add a narrowly scoped read-only allow rule for the package `dir`. The user applies permissions; do not change them. The guard and deny rules still apply.

**Per repository, before the first item:**

- `.mend/` in the repository's `.gitignore`: worktrees, evidence and cards live there, and the workflows refuse to start without it;
- a grant at `<repo>/.mend/grants.json`, for example `{ "rung": "draft", "queue": false, "maxOwners": 1, "disposable": false }`; without one the lead stays at rung `draft` with no merges;
- a project verification skill, created with the `create-verification` skill and run once with `PASS`;
- optional `<repo>/.mend/guard.json` for the repo's production patterns.

End with one line: `ready`, or `not ready: <first failing step>`.
