---
name: mend-autopilot
description: Turns a request to change code into small pull requests that a cheap model writes and a strong model reviews, then pushes them and opens the pull requests. Load whenever the user asks for a feature, a fix, a refactor, tests or docs in a git repository that has a .mend/ folder, and in any git repository when the user asks for a pull request or PR. Not for questions, explanations or reviews, and not when you are an owner, critic or auditor inside a mend workflow.
---

# mend-autopilot

The user asked for a change. Do not write it yourself: turn it into work items and start the `mend` workflow for each one. A cheap model implements, a strong model specs and reviews, programs and an auditor prove it, and the workflow pushes the branch and opens the pull request. The user only reads your short plan, clicks the approval MendCode shows before a workflow starts, and later merges.

Do the whole thing in this turn, in the order below, without asking. The only reasons to stop are the ones a step names; anything else is yours to decide. Report in the user's language, in plain words: what will become a pull request, and what you need from them.

## 1. Find the package

This file is `<pkg>/skills/mend-autopilot/SKILL.md`; `<pkg>` is two folders up. Read `<pkg>/autopilot.json` for the models: `critic`, `auditor`, `model` (the cheap owner) and `engine`. Use them as given unless the user named other models.

## 2. Prepare the repository (always first)

Do this before reading the code for the change or judging its risk. The repository root is `git rev-parse --show-toplevel`. It is ready when `.mend/evidence/verify.json` has `"result": "PASS"` and its `sha` is an ancestor of `HEAD`. Otherwise:

1. Find the commands that prove the repository works, from what it already has: `package.json` scripts (`typecheck`, `lint`, `test`), a `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, the CI workflow. Prefer the commands CI runs. Each must run without a browser, a login or a production service.
2. Run `node <pkg>/checks/setup-light.mjs --repo <root> --command "<cmd>" [--command "<cmd>" ...]`. It ignores `.mend/` through `.git/info/exclude` (no tracked file changes), writes the verification skill, runs every command and records the result.
3. If it reports `FAIL`, stop: tell the user which command fails on their current code, with the last lines of its log. Items cannot be proven on a red baseline.
4. If the repository has no check commands at all, stop and say so: suggest the smallest test setup for its language, as its own first request.

Tell the user in one line what you found, e.g. "your repo is checked with `bun run typecheck` and `bun test`".

## 3. Write the items

One item is one pull request: one observable outcome a reviewer can judge in a few minutes. Split a bigger request into several items, each independent and each leaving the repository working. Read the code first; never guess file names.

Write each as `.mend/items/<id>.json` (`id`: lowercase words with hyphens):

```json
{
  "id": "login-email-case",
  "type": "change",
  "goal": "Sign-in accepts an email in any letter case",
  "acceptance": ["USER@x.com and user@x.com sign in to the same account", "other sign-in errors are unchanged"],
  "profiles": ["bugfix"],
  "editSet": ["src/auth/login.ts", "tests/auth/login-email-case.test.ts"],
  "checks": ["bun test tests/auth/login-email-case.test.ts"],
  "regression": "bun test tests/auth/login-email-case.test.ts",
  "risk": "low"
}
```

- `editSet`: every file the change and its tests need, and nothing else. Too narrow stops the item as a draft; too wide weakens the review.
- **Tests go in a new file** named after the item, next to the existing tests and matching their naming so the runner finds it (`login-email-case.test.ts` beside `login.test.ts`). Never put an existing test file in `editSet`: the integrity scan blocks every change to one, even an added test, so a weaker test can never slip in.
- `regression`: for a bug, the command that runs only that new test file; it must fail before the change and pass after it. The owner writes that test. Leave it out for features and docs.
- `profiles`: `bugfix`, `api-backend`, `ui`, `refactor`, `docs` or `generic`.
- `risk`: `high` only when the change edits sign-in or session code, permission checks, payment processing (charging or refunding money), a database migration, or deletes data or files, or changes a public API other code depends on. Fixing how amounts, totals, prices or dates are calculated is not high risk by itself; neither is a bug fix with a regression test. `medium` for code many modules share; otherwise `low`. The workflow also judges risk from the paths that actually change; yours only decides whether to ask.

## 4. Stop only for high risk

If any item is `high`, list those items in one short message and ask once whether to go ahead. Start the low and medium ones first, without waiting. Never ask about a `low` or `medium` item.

## 5. Start the workflows

For each item, call the `workflow_script` tool (find it with `tool_search` if it is not loaded) with `name: "mend"` and these `args`:

```json
{ "repo": "<root>", "item": ".mend/items/<id>.json", "pkg": "<pkg>", "critic": "<critic>", "model": "<model>", "auditor": "<auditor>" }
```

Add `"engine": "<engine>"` when `autopilot.json` sets one. Add `"publish": "no"` only when the user said not to push. MendCode asks the user to approve every start; that click is theirs.

Start items that touch different files together, up to the owners the user's plan allows (one on the smallest plans). Start an item that depends on another only after that one's pull request is merged.

## 6. Report

After starting, say in a few lines: the items, that each ends as a pull request with its evidence card, that they can follow it in `/workflows`, and that nothing is merged for them. Do not poll. When the user asks how it went, read it with `workflow_status` and report each item's result:

- `merge-ready` with a pull request link: ready to merge.
- `draft` with a link: opened as a draft; say its reason in plain words.
- `blocked`: nothing was pushed; say why and what would unblock it.
- `published: false`: the branch stayed local; say why (no remote, GitHub CLI not logged in, the item had no commits).

## Never

- Write the change yourself, or edit a file in `.mend/worktrees/`.
- Merge, force-push, or push any branch but `mend/<id>`.
- Change the user's models, permission mode, trust or tier.
- Commit `.mend/`.
