# Evidence card: PR body template

The card JSON (`evidence-card.schema.json`) is the source. The PR body is rendered from it with the template below. Two rules shape the layout:

- **Problem first.** The body opens with what is wrong or missing today, then the goal. A reviewer who does not know the problem cannot judge whether the change solves it.
- **One screen first.** Everything above the `<details>` block fits on one screen: about 25 lines. A reviewer decides from the summary whether to open the details.
- **Nothing the card does not hold.** Every line is filled from a card field. If a field is empty, the line says so (`none recorded`); it is never dropped to make the summary look cleaner.

## Review guidance by risk tier

Print the line that matches `risk.tier`, word for word, right under the title.

| Tier | Line printed in the PR | What it covers |
|---|---|---|
| low | `Review: read this card and skim the diff.` | Changes inside one module, covered by checks, with no item from the high list. |
| medium | `Review: read this card and the diff of shared modules.` | Changes that touch code used by other modules or screens. |
| high | `Review: full review of the diff.` | Migrations, auth, payments, secrets, CI, lockfiles, deletions, public API. |

A repo's verification skill may raise a tier for its own paths (for example "anything under `billing/` is high"). It may never lower one.

## Template

```markdown
## {{goal}}

{{problem}}

{{reviewLine}}

| | |
|---|---|
| State | {{state}} · rung {{rung}} · queue grant {{grant.queue ? "yes" : "no"}} |
| Risk | {{risk.tier}}, because {{risk.rule}} |
| Verified SHA | `{{verdict.sha}}` (head `{{headSha}}`) |
| Auditor | {{verdict.result}} by {{verdict.verifier}} ({{verdict.verifierModel}}), author {{verdict.author}} |
| Checks | {{passedChecks}}/{{checks.length}} exit 0 |
| Profiles | {{for each profile: kind: rubric PASS/FAIL, critique score/10; or "skipped: reason"}} |
| Critique | lowest head {{lowest head in the last counted round}}/10, threshold {{critique.threshold}} · {{counted rounds}} rounds{{void rounds ? ", " + n + " void" : ""}} · findings {{open}} open, {{declined}} declined, {{disputed}} disputed — on a light card (`path: "light"`) this row is instead `Review | light path: {{review.verdict}} by {{review.critic}} · {{review.rounds.length}} rounds · {{blockers in the last round}} blockers, {{nits}} nits (no scores)` |
| Integrity | {{integrity.pass ? "PASS" : flags.length + " flags, " + countersigned.length + " countersigned"}} |
| Red-green | {{redGreen ? "base exit " + baseExit + " / head exit " + headExit : "not required"}} |
| Rounds | {{rounds.used}}/{{rounds.budget}}{{rejectedBy.length ? ", rejected by " + rejectedBy : ""}} |
| Proof | {{proof.changeType}}: {{first artifact, first figure as "metric before → after unit", or note}} |

**Not verified:** {{notVerified joined with "; "}}
**Not changed:** {{notChanged joined with "; "}}
**Uncertain:** {{uncertain joined with "; "}}
**Rollback:** {{rollback}}{{if a countersign of kind irreversible: " (irreversible: " + its subject + ", countersigned)"}}

{{if countersigns: "**Countersigned:** " + each "kind subject, by who: reason"}}
{{if flaky: "**Flaky:** " + each "check runs [exits]" + " (not a clean PASS)"}}
{{if escalation and not approvedBy: "**Needs approval:** move this item to " + toModel + " (" + reason + ")"}}

<details>
<summary>Details</summary>

### Checks
| Check | Command | Exit |
|---|---|---|
{{for each check: | name | `command` | exit |}}

### Driven path
{{numbered drivenPath.steps}}

Artifacts: {{drivenPath.artifacts}}

### Profiles
{{for each profile:
#### kind
- Exemplar → proposal: each pair
- Approved proposal: approvedProposal
- Rubric: PASS, or each failure
- Critique: score/10 by model — notes
- Integration diff: PASS/FAIL — detail
- Change call-outs: each "target: change (before → after)"
}}

### Critique
| Round | Critic | Diff | Lowest head | Gaming | Reply |
|---|---|---|---|---|---|
{{for each round: | round{{void ? " (void: " + voidReason + ")" : ""}} | critic | diffStat | lowest head | gaming | `log` |}}

| Finding | Severity | Status | Round | Reason |
|---|---|---|---|---|
{{for each finding: | id | severity | status | round | reason or "" |}}

### Integrity
{{for each flag: | rule | file:line | detail | severity | countersigned yes/no |}}

### Audit lanes
| Lane | Result | SHA | Method |
|---|---|---|---|
{{for each lane}}

{{if verdict.reusedFrom: "Verdict reused from `sha` (reason)."}}
{{if attention: "Attention (reviewed by reviewedBy): " + flags, or "no flags"}}

Decision log: `{{decisionLog}}` · Card: `.mend/evidence/{{item}}.json`
</details>
```

## Rendered example (low risk bug fix)

```markdown
## Invoice totals round half-up to two decimals, matching the line items.

Invoice totals round half-down, so a total can differ by one cent from the sum of its line items.

Review: read this card and skim the diff.

| | |
|---|---|
| State | merged · rung autopilot · queue grant yes |
| Risk | low, because pure function inside one module, covered by tests |
| Verified SHA | `0a1b2c3` (head `0a1b2c3`) |
| Auditor | PASS by auditor-1 (cheap-model-b), author owner-2 |
| Checks | 1/2 exit 0 |
| Profiles | bugfix: rubric PASS, critique 9/10 |
| Critique | lowest head 9/10, threshold 7 · 1 round · findings 0 open, 1 declined, 0 disputed |
| Integrity | 1 flag, 1 countersigned |
| Red-green | base exit 1 / head exit 0 |
| Rounds | 1/2 |
| Proof | bugfix: see red-green |

**Not verified:** invoices in currencies with no minor unit
**Not changed:** none
**Uncertain:** none
**Rollback:** revert the merge commit

**Countersigned:** integrity-flag test-edit src/invoice.test.ts:18, by operator: the old test asserted the bug (round half-down); the new expectation is the specified behaviour
```

The `Checks 1/2` line is honest: the integrity check exited 1 because of the flag that was later countersigned. The card does not hide a non-zero exit; the countersign explains it.
