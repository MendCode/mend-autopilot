---
description: Check that mend-autopilot can run here on a Claude subscription and print the steps the user applies (recipe, skills, guard hook). Changes nothing.
argument-hint: "[pro|max]  your Claude plan, if you know it"
---

Run the mend-autopilot setup check for a Claude subscription. You only read and print. Do not apply a recipe, change a role, model, flag, tier, permission, trust or setting, install or enable a plugin, copy anything, or edit any file, including `~/.claude/settings.json`. Every change below is a command for the user to run.

The user's Claude plan, if given: $ARGUMENTS

Why this differs from other harnesses: a MendCode session on a Claude model runs on the Claude Code engine, which uses Claude Code's own skills, hooks and CLAUDE.md. This package's MendCode skills do not load there, so the package is also a Claude Code plugin (`mend-autopilot`) that brings the skills, this command and the guard to Claude Code. The guard runs with `--mend-only`: it acts only in folders inside a repository that has a `.mend/` folder, so other Claude Code work is left alone.

Do these steps in order. For each, print one line: `PASS`, `FAIL`, `SKIP` or `UNTESTED`, what you checked, and what you saw. Stop at the first `FAIL` of steps 1 to 5 and print only what the user must do to fix it.

1. **Engine.** Say which model and engine this session runs on. A Claude model (`claude-haiku`, `claude-sonnet`, `claude-opus`, `claude-fable`) on the Claude Code engine passes. If no Claude model is offered at all, MendCode cannot find `claude` on its PATH: tell the user to make `claude --version` work for the daemon.
2. **Tools on PATH.** Run `python3 --version`, `node --version`, `git --version` and `claude --version`. Python 3.9 or newer, Node 20 or newer, git 2.x and any `claude` pass.
3. **Package.** Run `mendcode package list --json` and print the `dir` of `mend-autopilot-claude`: the plugin is installed from there and the workflows take it as `pkg`.
4. **Plugin enabled.** Run `claude plugin list` and check that `mend-autopilot@mend-autopilot-local` is listed and enabled. If not, `FAIL` with the install commands below.
5. **Guard fires.** Only in a repository with a `.mend/` folder (otherwise `SKIP` and say so): run exactly `cat ./.env.mend-guard-probe`. This is a `PASS` only if the call is refused by a PreToolUse hook whose message names the rule `secret-read`. If the command runs at all (even with "No such file"), the guard is not active: `FAIL`.
6. **Recipes visible.** Run `mendcode recipe list`. `mend-autopilot-claude-pro` and `mend-autopilot-claude-max` should be listed from this package. If they are missing, tell the user to copy them from the package's `recipes/` folder to `~/.mendcode/recipes/`.
7. **Workflows.** The `mend-quality` and `mend-pr` workflows run their agents on the Claude Code engine, which MendCode allows only on the full tier. Print `UNTESTED` and ask the user to confirm the tier with `/tier`. Without it, the lead dispatches owners with the other options of mend-mode §7.
8. **Current roles.** Run `mendcode control-plane models status` and print it.

Then print the steps for the user, filled in with the package `dir` from step 3:

**Pick a recipe.** The strong model only plans, advises and critiques; the other roles run on the cheap model. Applying a recipe replaces only `main`, `subagent`, `workflow`, `plan` and `advisor`.

| Plan | Recipe | Cheap model |
|---|---|---|
| Pro | `mend-autopilot-claude-pro` | claude-haiku |
| Max | `mend-autopilot-claude-max` | claude-sonnet-5-5 |

The model names follow the newest model of each family. Usage counts against the subscription's 5-hour and 7-day windows (`/usage`); MendCode shows no cost for it. On Pro, keep one owner at a time.

**Before applying, keep a copy of the roles:** `mendcode control-plane models status > ~/mend-roles-before.txt`

**Apply:** `mendcode recipe apply <recipe>`. **Undo:** apply the recipe that was active before (`mendcode recipe list` marks it with `*`), or set each role back with `/model`.

**Claude Code plugin** (skills, `/mend-setup` and the guard):

```sh
claude plugin marketplace add <dir>
claude plugin install mend-autopilot@mend-autopilot-local
```

Start a new Claude Code session afterwards. **Off for a while:** `claude plugin disable mend-autopilot@mend-autopilot-local`. **Remove:** `claude plugin uninstall mend-autopilot@mend-autopilot-local` and `claude plugin marketplace remove mend-autopilot-local`. After rebuilding or reinstalling the package, run `claude plugin marketplace update mend-autopilot-local` and `claude plugin update mend-autopilot@mend-autopilot-local`.

**Advisor (optional, spends Opus usage):** `/advisor claude-opus#medium`; `/advisor off` turns it off.

**Flags:** none are needed. Leave `plan_tools` and `git_actions` as they are.

**Safety:** the deny rules and sandbox settings to add yourself are in `<dir>/docs/safety-setup.md`; print its section headings.

**Approvals:** explain that package reads outside the project and some commands may request approval. After reviewing a trusted request, the user can choose **For this session** if offered, or add a narrowly scoped read-only allow rule for `<dir>` in the active harness. The user applies permissions; do not change them. The guard and deny rules still apply; approval options depend on the harness.

**Per repository, before the first item:** `.mend/` in `.gitignore`; a grant at `<repo>/.mend/grants.json` such as `{ "rung": "draft", "queue": false, "maxOwners": 1, "disposable": false }`; a project verification skill at `<repo>/.claude/skills/verify-<repo>/SKILL.md`, created with the `create-verification` skill, committed so the item worktrees have it, and run once with `PASS`.

End with one line: `ready`, or `not ready: <first failing step>`.
