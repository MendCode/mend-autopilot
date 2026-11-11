# Template: verify-<repo>

Copy this into `<repo>/.mendcode/skills/verify-<repo>/SKILL.md` (or `.claude/skills/verify-<repo>/SKILL.md`) and replace every `<...>` with the repo's real values. Delete a section only if it does not apply, and say why in **Known gaps**. A value you could not find stays as a gap; never guess it.

Create `.mend/verify/verify.mjs` and any helpers beside it, with `.mend/` gitignored. Copy the record helper below to `.mend/verify/record.mjs` and call `runVerification` from the script. Implement the real repo-specific steps, propagate failures and preserve logs; inspect helpers before running them, since the guard cannot inspect their code. The script writes `.mend/evidence/verify.json` itself on every run, including errors and blocked runs, following section 5 of create-verification. Record actual independently rerunnable step commands and exit codes, profiles and timestamp. Do not record the verification script itself as a step command.

## Record helper (`.mend/verify/record.mjs`)

Copy this block unchanged. Call `await runVerification({ skill, sha, profiles }, async record => { ... })` from the repo root. In the callback, append each completed step (including `name`, actual `command`, `exit`, `log` and `integrationInputs`) to `record.steps`, set `record.feature`, `record.evidencePath` and `record.evidenceSurvivedCleanup` after the real drive and cleanup, and update `record.profiles` with the observed statuses. Return `"PASS"` only after the complete drive; return `"BLOCKED"` for a missing prerequisite, or throw on failure. Ensure cleanup runs even on failure. The helper starts with a non-PASS record, persists it again on completion or error, and sets a nonzero exit status for non-PASS results. It cannot determine whether the feature actually worked: the callback must check that itself.

```js
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function runVerification({ skill, sha, profiles }, drive) {
  const file = path.join('.mend', 'evidence', 'verify.json');
  const record = { skill, sha, at: new Date().toISOString(), result: 'FAIL', steps: [], profiles: { ...profiles } };
  const save = async () => {
    record.at = new Date().toISOString();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record, null, 2) + '\n');
  };
  await save();
  try {
    const result = await drive(record);
    if (result === 'BLOCKED') record.result = 'BLOCKED';
    else if (result === 'PASS' && record.steps.length > 0 &&
      record.steps.every(step => typeof step.command === 'string' && step.command.trim() && step.exit === 0) &&
      record.feature && record.evidencePath && record.evidenceSurvivedCleanup === true) record.result = 'PASS';
  } catch (error) {
    record.error = String(error?.message ?? error);
  }
  if (record.result !== 'PASS') process.exitCode = 1;
  await save();
  return record;
}
```

---

```markdown
---
name: verify-<repo>
description: How to launch, check, drive and clean up <repo> to prove a change works in the running product. Load when you verify, audit or reproduce something in <repo>.
---

# verify-<repo>

## Slots

Each owner gets one slot. Slots run side by side, up to <maxConcurrent>.

| Slot item | Value for slot n |
|---|---|
| Worktree | `<path pattern, e.g. ../<repo>-wt/mend-<item>>` |
| Port(s) | `<base port> + n` (<what listens there>) |
| Data directory | `.mend/run/slot-<n>/` |
| Database | `<local database name or file per slot>` |

## Launch

Start from an empty data directory for the slot.

## Verification command

Run from the repo root; this performs launch, doctor, drive, evidence capture and cleanup and writes `.mend/evidence/verify.json`:

    node .mend/verify/verify.mjs

Ready means usable: `<what to check, e.g. the sign-in page answers on the slot's port>`, not just that the process started. Give up after `<seconds>` and report the last log lines.

## Doctor

Read-only health check. Run it before the first drive and after any failed drive.

Expected: `<what healthy looks like>`. If the doctor fails, stop and report; do not drive.

## Drive

Use stable handles: accessible names and roles, `data-*` attributes, routes, CLI flags, API paths. Never positions or generated class names.

1. **Sign in** (when the app needs it): seed the test account with `<seed command>`, then sign in as `<test account from the repo's fixtures>`. This is a step, not an assumption.
2. **Reach the feature:** see its file in `features/`.
3. **Act and observe:** `<UI: browser or computer tools already in the repo / CLI / API client>`.

A flow that was not run to the end in the current session is not verified. A missing precondition is a reported failure; never shorten the journey so it passes.

## Evidence

Record both the actions and their side effects (rows written, files created, requests sent). Evidence goes to `.mend/evidence/<item>/` and must still exist after Cleanup.

- Logs: the helper records each actual command, its output and exit code in `.mend/evidence/<item>/<name>.log`; a failed command fails the helper.
- UI: element crops at most 1600 px on the long side; split tall views into several crops. No full-page captures. For the ui profile, also `ui-snapshot.json` and `layout.json` as `mend-quality` describes.
- API: the request and response, with status.

## Helpers

| Script | What it does | How to run it |
|---|---|---|
| `.mend/verify/verify.mjs` | <repo-specific launch, doctor, drive, evidence and cleanup> | `node .mend/verify/verify.mjs` |

Helpers live beside the script in `.mend/verify/`, not inside the skill folder.

## Feature map

`features/README.md` lists every feature; each feature has its own `features/<feature>.md` with these sections:

- **Sub-features:** <list>
- **How to reach it:** <route, menu path, command>
- **How to drive it:** <steps with stable handles, and the expected result of each>
- **Gotchas:** <seed data it needs, flags, timing; a missing one is a reported failure>

`features/exemplars.md` lists the exemplar set per profile; the index is `.mend/exemplars/index.json`.

## Cleanup

Stop only what this run started (`<how: saved PIDs, compose project name for the slot>`). Remove the slot's data directory unless the item needs it for the audit. Never touch other slots, other processes or evidence.

## Risk paths

Paths that raise an item's risk tier above what `mend-ship` already sets:

| Path pattern | Tier | Why |
|---|---|---|
| `<glob>` | medium / high | <reason> |

## Production patterns

Hosts, databases and buckets that are production for this repo. They are also in `.mend/guard.json` as `productionPatterns`, so the guard blocks commands that reach them.

- `<pattern>`

## Locale

User-facing text is in `<locale, e.g. fr-FR>`; it is recorded as `ui.locale` in `.mend/quality.json`.

## Known gaps

- <step or profile that is missing or BLOCKED, and what would unblock it>
```

---

## Feature file template (`features/<feature>.md`)

```markdown
# <Feature name>

## Sub-features
- <sub-feature>

## How to reach it
<route / menu path / command>

## How to drive it
1. <action with a stable handle> -> <expected result>

## Gotchas
- <precondition, seed, flag or timing; a missing one is a reported failure>
```

## Exemplars entry template (`features/exemplars.md`)

```markdown
# Exemplars

| Profile | Id | Locator | File | Why it is a good model |
|---|---|---|---|---|
| <profile> | <id> | <route + selector, file:line or command> | <path under .mend/exemplars/> | <reason> |

Golden exemplars are the ones the user marked `approved: true` in `.mend/exemplars/index.json`.
For each profile with no exemplar, record `none`, a one-sentence reason, the paths searched and the git log range in the index as `{ "profile": "<profile>", "none": "<reason>", "search": { "paths": ["<path>"], "gitLogRange": "<range>" } }`; list the same reason and search here instead of an exemplar row.
```
