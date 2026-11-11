---
name: create-verification
description: Writes a repo's own verification skill (how to launch the app, check its health, drive each feature, keep evidence, clean up) plus the exemplar set for every work profile the repo uses, then runs it once end to end and records PASS or FAIL. Load only when a mend-autopilot lead finds no verification skill with a recorded PASS in the repo, or when the user asks for one.
---

# create-verification

No owner is dispatched into a repo until that repo has its own verification skill. This skill writes it. The generated skill is what owners and auditors use to prove a change works in the running product, not just in the tests.

## 1. Eligibility rule

A repo is ready for dispatch only when all of these hold:

1. `<repo>/.mendcode/skills/verify-<repo>/SKILL.md` exists. For Claude Code the same skill lives at `<repo>/.claude/skills/verify-<repo>/SKILL.md`; the adapter's `MAPPING.md` says which directory the harness reads.
2. `<repo>/.mend/evidence/verify.json` records a run of that skill with `result: "PASS"`.
3. `<repo>/.mend/exemplars/index.json` has an exemplar set for every profile the run will use, and none of those profiles is `BLOCKED` in `verify.json`.

An item whose profile is `BLOCKED` is not dispatched. Items on the other profiles may go ahead.

The executable workflow checks this contract before creating a worktree or calling any agent,
including the implicit `generic` profile. It refuses investigate items or an effective investigate
grant; these implementation workflows are not the read-only investigation entrypoint. Missing
grants retain the documented draft default; invalid grants block rather than falling back.

### Worktree setup and precedence

The source repository's operator-owned setup is authoritative at dispatch. Before the first agent,
the workflow copies only `.mend/{quality,guard,integrity,grants}.json` when present, the verification
record, the verification skill and its feature maps, `.mend/verify/` helpers, and artifacts indexed for the applied
profiles under `.mend/exemplars/<profile>/`. The worktree index contains those selected entries.
It does not recursively copy `.mend/`: other items, run data, unrelated logs, credentials, `.env` files and
unindexed exemplars stay behind. Setup files must contain no secrets. Symlinks, escaping paths and
credential-like filenames are refused. Skill helpers retain executable permission.

On a reused worktree, conflicting copies or settings absent from the source block dispatch; the
workflow never silently overwrites them. The operator must reconcile the copies before retrying.
Integrity adds local rules to the base-commit rules and built-in rules, never replaces those floors.
Delivery rereads the source grant, caps autonomy at the dispatched rung and raises risk for actual
changed paths/deletions. Queue permission alone cannot promote a draft item to autonomous ready.

Every agent call carries the authorized worktree as `cwd`. The workflow harness tests the argument;
the adapter still needs a live host check that the runtime honors it for tools and hooks.

## 2. Inputs and limits

- **Use what the repo already has.** Commands come from the repo's scripts, task runners, compose files, CI config, README and existing tests. Never invent a command. A step with no command in the repo is written down as a gap and reported to the user.
- **No installs.** Adding a dependency (a browser driver, a test runner, a database) needs the user's grant. Without it, the step that needs it is `BLOCKED`.
- **No secrets.** Read variable names from example env files only. Never open `.env`, credential files or auth stores. The test account comes from the repo's seed or fixtures, never from a real account.
- **Local data only.** The first run and every later run use a local or throwaway database. If there is none, the run is `BLOCKED`. A shared, staging or production database is never an option.
- **Verification migrations.** Running existing migrations against a disposable local database created for verification inside the repo (including a temporary directory inside it) is allowed without asking. Running migrations against any other database, or adding a migration, requires a human stop; other mandatory stops still apply.
- **Image size.** Every image sent to a model has a long side of at most 1600 px. Downscale it, or split a tall page into several crops. Never send a full-page capture.

## 3. Steps

1. **Inspect the repo.** List how it starts, how it is checked, how data is seeded and reset, which browser or API tooling it already has, which test commands exist, how migrations run, and which work profiles it needs. For representative repo paths and intents, use `node <pkg>/checks/run-rubric.mjs plan --item <item.json>` and its `suggested` output; suggestions do not assign profiles and the user confirms the list.
2. **Write the skill** from `template.md`, filling every section with the repo's real commands. Write the feature map: a `features/<feature>.md` file for each feature, listed in `features/README.md`. Create `.mend/verify/verify.mjs` and any helpers alongside it; ensure `.mend/` is gitignored. The skill's verification command is `node .mend/verify/verify.mjs` from the repo root. Implement orchestration and logging there, preserving failures and full evidence; inspect helpers before running because the guard cannot inspect code inside scripts. The script itself writes the section 5 record on every run, including failures and blocked runs, without a manual stamp.
3. **Record the repo's settings for the other skills:**
   - `ui.locale` in `<repo>/.mend/quality.json`, taken from the language of the repo's existing user-facing text. Docs checks also use this locale unless `docs.locale` overrides it. If the text is mixed, ask the user; there is no default. Put profile-specific options under their profile kind (for example `docs` or `api-backend`).
   - Path rules that raise a risk tier (shared modules, generated clients, billing folders) in the skill's Risk paths section. They can raise a tier, never lower one.
   - Production hosts, databases and buckets the repo talks to, as `productionPatterns` in `<repo>/.mend/guard.json`. Never add `grantedDependencies` there; only the user grants dependencies.
4. **Capture the exemplar set** for each profile the repo uses, with tooling the repo already has (section 4). If the tooling for one profile is missing, mark that profile `BLOCKED` in `verify.json` with what is missing, ask for a dependency grant, and continue with the other profiles.
5. **Plan isolation.** Each owner runs in its own worktree with its own ports and its own data. Write in the skill how a slot gets them, for as many slots as the recipe's `maxConcurrent`: for example slot `n` uses port `<base> + n` and data directory `.mend/run/slot-<n>/`.
6. **Run the skill once, end to end,** in this session, against local data: launch from an empty data directory, run the doctor, sign in with the test account if the app needs it, drive one mapped feature, capture its evidence, clean up, then confirm the evidence is still at its path.
7. **Inspect the script's result** in `verify.json` (section 5). Then ask the user to mark golden exemplars: they set `approved: true` in the index. This skill never sets `approved` itself.

## 4. Exemplar set

The exemplar set is one entry of the feature map (`features/exemplars.md`) and is indexed in `<repo>/.mend/exemplars/index.json`:

```json
[
  { "profile": "ui", "id": "orders-table", "locator": "/orders [data-testid=orders-table]", "file": ".mend/exemplars/ui/orders-table.png", "approved": false },
  { "profile": "api-backend", "id": "list-orders", "locator": "src/routes/orders.ts:42", "file": ".mend/exemplars/api-backend/list-orders.json", "approved": false },
  { "profile": "bugfix", "none": "No earlier bugfix exists.", "search": { "paths": ["src", "tests"], "gitLogRange": "HEAD" } }
]
```

`locator` is a route plus selector, a `file:line`, or a command.

For each profile record either its exemplars or one `none` entry, never both; `none` is a one-sentence reason backed by the paths searched and the git log range searched. Missing tooling is blocked, not evidence of absence. Pass the identical reason as the critique request's exemplar material `{ "none": "..." }` and retain the generated request with each critique round.

| Profile | What to capture |
|---|---|
| ui | One element crop per existing component worth copying, long side at most 1600 px, at `.mend/exemplars/ui/<id>.png`. Crop the component, not the page. |
| api-backend | Two or three representative endpoints with `file:line`, and one recorded request and response from the local service. |
| schema-migration | The most recent migrations, and the commands that migrate, roll back and dry-run. |
| bugfix, refactor | The test command and its result at trunk, as the base record. |
| docs | The best existing pages, with why each is a good model. |
| generic and any other profile | What the plan's profile `exemplars.what` names, between its `min` and `max`. |

For each selected profile, include it in the item and consult the same `run-rubric plan` output for its exemplar requirements rather than opening profile files individually.

## 5. `verify.json`

```json
{
  "skill": ".mendcode/skills/verify-<repo>/SKILL.md",
  "sha": "<commit the run used>",
  "at": "<ISO 8601 time>",
  "result": "PASS",
  "steps": [
    { "name": "launch", "command": "<command>", "exit": 0, "log": ".mend/evidence/verify/launch.log", "integrationInputs": ["<relevant repository-relative path>"] }
  ],
  "feature": "<feature driven in this run>",
  "evidencePath": ".mend/evidence/verify/",
  "evidenceSurvivedCleanup": true,
  "profiles": { "ui": "PASS", "schema-migration": "BLOCKED: no local migration runner" }
}
```

`result` is `PASS` only when every step exited 0, the driven feature showed its expected outcome and the evidence survived cleanup. A run that stopped early, or a flow that was not driven to the end in this session, is `FAIL` or `BLOCKED`, never `PASS`.

The generated script writes this record itself, replacing any stale record at the start with a non-PASS result and updating it even on errors. Record each actual step command and exit code, the profile statuses and timestamp; return a nonzero process exit for anything other than PASS. Each step command must be independently rerunnable from the repo root, not the verification script itself (which would recurse when checks rerun).

For each check, record a short `integrationInputs` list of relevant repository-relative paths: callers, contracts, lockfiles and check configuration, as applicable, including inputs outside the item's diff. Identify the check each input affects. Before merging, compare these inputs against the trunk used by the green run as described in `mend-ship`; missing or uncertain coverage is not evidence that the inputs are unchanged. Existing records without this list must be supplemented before relying on their green result for merge.

## 6. Example

A web app with a REST API and SQL migrations:

- Launch on a spare port with an empty local database; ready means the sign-in page answers, not that the process started.
- Doctor: `GET /health` returns 200 and the database answers a read.
- Drive: sign in with the seeded test account, then drive two mapped features.
- Exemplars: 12 component crops, 3 endpoint exemplars and the last 2 migrations.
- The user marks 5 of them as golden.

## 7. When something is missing

| Missing | Result |
|---|---|
| A local or throwaway database | Run `BLOCKED`. Never point at a shared or production one. |
| Tooling for one profile | That profile `BLOCKED`; ask for a dependency grant; the others go on. |
| A command for a step | The step is a reported gap; the run is not `PASS` if the step is needed. |
| A precondition while driving (no seed data, a feature flag off) | A reported failure. Never shorten or weaken the journey so it passes. |
| A crop larger than 1600 px | Downscale or split it. |

## Counterexamples

- A skill that only says "run the tests".
- A full-page screenshot used as a reference.
- A screenshot from an old build used as evidence.
- Sign-in assumed to have happened, with no drive step for it.
- A journey trimmed so it passes when its seed data is missing.
- A first run against a shared staging database.
