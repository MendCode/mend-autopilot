# Critique lens: schema-migration
<!-- critique-categories: deploy-order locks rollback data plan application-code -->

Use with the shared critique prompt. You receive the approved migration plan, the full diff, the dry-run record (command, exit code, database kind, how many rows each table held on either side of the run) and the migration-safety result with its exit code. This profile never reaches autopilot: the item stays a draft for a person to merge.

Answer each question. Every issue names the migration file:line or the table and gives a concrete fix.

1. **Order of a deploy.** Review the captured local compatibility test and its coverage for both application/schema combinations. The static reference check searches both base and head but does not execute either application. Name any uncovered query that could fail: a column the old code still writes, a NOT NULL the old code does not fill, a renamed table the new code reads before the migration runs.
2. **Locks on real sizes.** For each declared lock, say how long it holds on the largest table it touches, using the row counts from the dry run as a floor. A blocking index, a type change or a validated constraint on a busy table needs the online variant (concurrent index, NOT VALID then VALIDATE, a new column plus backfill) or a stated maintenance window.
3. **Rollback that works.** Read the down step as if the up step had half finished. Does it restore the previous schema without losing rows written since? A down step that drops a column the up step backfilled loses data; say so. An irreversible step needs the countersign and a recorded backup or export.
4. **Data, not just schema.** Backfills run in batches with a bound, are safe to re-run, and do not hold a transaction across the whole table. Row counts that moved must match the plan's numbers, and the reason must be in the plan, not discovered in the dry run.
5. **Matches the plan.** Compare tables, steps and their order with the approved plan. An extra step, a merged step or a skipped "switch code" stage is an issue even when the result looks equivalent.
6. **Application code agrees.** The ORM model, types and queries in the same item match the migrated schema: nullability, defaults, names. Code that writes a removed column or skips a newly required one is an issue.
7. **Checks gamed.** A down section that only passes or raises, a lock risk hidden by splitting a statement oddly, a dry run against a database that already had the migration applied, row counts copied rather than measured, or a plan edited after approval to match the result.
