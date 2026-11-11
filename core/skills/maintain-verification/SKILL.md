---
name: maintain-verification
description: Checks that a repo's verification skill (verify-<repo>) and its exemplar set still match the product - reads each feature's source for drift, drives every feature live, checks every exemplar locator - and ends as clean, changed or blocked. Load only when the user asks to maintain or refresh a verification skill.
---

# maintain-verification

A verification skill goes stale as the product changes: routes move, components are renamed, seed data changes. This pass finds the drift and fixes the skill, never the product.

## 1. What you may edit

Only these places:

- the folder of the skill being maintained, `<repo>/.mendcode/skills/verify-<repo>/` (or `.claude/skills/verify-<repo>/` for Claude Code);
- the gitignored `<repo>/.mend/verify/` script and helpers;
- `<repo>/.mend/exemplars/`.

Product code, tests, config, CI and the database schema are out of bounds. If keeping the skill true would need a product change, that is a finding to report, not an edit to make.

## 2. Outcomes

The pass ends with exactly one of these:

| Outcome | Meaning | What you deliver |
|---|---|---|
| `clean` | Every feature drove as written and every exemplar resolves. | A short report; no PR. |
| `changed` | The skill, helpers or exemplar set needed updates. | One PR confined to tracked changes in section 1, with the report in its body; report changes to gitignored helpers separately. |
| `blocked` | The pass could not finish. | A report that names the blocker and what would remove it. |

A product regression found during the pass is always reported, whatever the outcome. Never edit the skill so a broken feature looks intended.

## 3. Before starting

- **No verification skill in the repo:** stop and point the user to `create-verification`.
- **More than one candidate skill:** ask the user which one to maintain.
- Read the skill, its `features/README.md` and `.mend/exemplars/index.json` before anything else.
- Inspect `.mend/verify/verify.mjs` and its helpers before running; keep its automatic `.mend/evidence/verify.json` record accurate on PASS, failure and blocked runs. Do not stamp it by hand.

## 4. The pass

1. **Index hygiene.** Every file in `features/` is listed in `features/README.md`, every listed feature has a file, and each file still has the four sections the `create-verification` template gives it. Fix what is missing in the skill.
2. **Source readers.** For each feature, one reader on a cheap model reads the product source, read-only: it does not drive anything and does not edit anything. Each reader returns:
   - a summary of the feature as the code has it now;
   - its entry points (routes, commands, endpoints) with `file:line`;
   - likely drift from the feature file, each with `file:line`;
   - one recipe to drive it live.
3. **Reconcile.** Compare each reader's answer with its feature file and list the differences. A difference is a hypothesis until the live pass confirms it.
4. **Live pass.** The lead drives every feature using the skill as written, with the skill's own Launch, Doctor, Drive, Evidence and Cleanup:
   - run the doctor once before the first drive, and once more whenever a drive fails;
   - a feature counts as checked only if it was driven to its end in this pass; reading the source is not enough;
   - a feature that cannot be reached is marked unreachable only together with the exact missing prerequisite and the route that was tried.
5. **Exemplar set check.** For every entry in `.mend/exemplars/index.json`, confirm the locator still resolves:
   - a ui crop still renders at its route and selector (recapture it if it changed, at most 1600 px on the long side);
   - an endpoint or migration still exists at its `file:line` and answers as recorded;
   - a command still runs.

   Then list the new components, endpoints and migrations that are not in the set yet.
6. **Triage each difference** (section 5) and apply the fixes that belong to the skill.
7. **Decide the outcome** (section 2) and write the report.

## 5. Triage

| What you found | What it is | What to do |
|---|---|---|
| The product works, the skill describes it wrongly (a moved route, a renamed handle, a new seed step) | Doc drift | Fix the skill. |
| The skill cannot drive something the product does correctly (missing helper, unsupported tool) | Harness gap | Fix the skill or its helpers if you can; otherwise report it and the outcome is `blocked` for that feature. |
| The product no longer does what it should | Product regression | Report it with the evidence. Do not change the skill to match it. |

## 6. Golden exemplars

An exemplar the user approved (`approved: true`) keeps its flag only while it is unchanged. When its locator or its file changes, set `approved` to `false` and list it in the report for the user to approve again. Never mark an exemplar approved yourself.

## 7. Cadence

How often this runs is the user's choice. This skill never schedules itself, sets up automation or asks to be run on a timer.

## 8. Report

- Outcome and the head SHA the pass ran on.
- For each feature: checked live, changed, or unreachable (with prerequisite and route).
- Exemplars that no longer resolved, what was recaptured, and which lost their golden flag.
- New items missing from the exemplar set.
- Product regressions, with evidence.
- Commands run, with exit codes and log paths.

## Example

After a refactor moved two endpoints and renamed one component, three exemplar locators no longer resolve. The pass updates the two endpoint locators, recaptures the renamed component's crop and leaves its `approved` flag off for the user. The product code is untouched. The outcome is `changed`, with one PR inside the skill directory and `.mend/exemplars/`.

## Counterexamples

- Editing product code during the pass.
- Marking a feature checked from reading its source, with no live drive.
- Updating a golden exemplar and keeping it approved without asking the user.
- Rewriting a feature file so a broken flow looks like the intended one.
