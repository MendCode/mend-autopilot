// A schema change ships as a new migration with a rollback (or a countersigned irreversible step), declares
// the locks it takes, keeps old names readable until code stops using them, matches its approved plan,
// and was dry-run on an ephemeral database with row counts that only moved where the plan said.
import { changesFromFiles, collectChanges, isTestPath, matchesGlobs } from '../../../checks/changes.mjs';
import { isLocalUrl } from '../../../checks/local-url.mjs';
import { evidenceLines, readCaptures } from '../../../checks/capture.mjs';
import { countersignsFor, fixtureTree, headTree, readCard, readItemEvidence } from '../../../checks/repo-read.mjs';
import { downDoesSomething, lockRisks, nameVariants, railsReversibleChange, removedNames, siblingDownPath, splitDirections, touchedTables } from './migration-text.mjs';

export const PLAN_FILE = 'migration-plan.json';
export const DRY_RUN_FILE = 'migration-dry-run.json';
export const DEFAULT_MIGRATION_GLOBS = ['**/migrations/**', '**/migrate/**', '**/alembic/versions/**', '**/*.migration.*'];
export const DEFAULT_SCHEMA_GLOBS = ['**/schema.prisma', '**/models.py', '**/models/*.py', '**/*.entity.ts', 'db/schema.rb', '**/db/schema.ts'];
const NON_CODE = /\.(?:md|mdx|txt|rst|adoc|lock|log|csv)$/i;

function fail(failures, target, rule, detail) {
  failures.push({ target, rule, detail });
}

async function hasRollback({ change, down, tree }) {
  if (downDoesSomething(down) || railsReversibleChange(change.headText)) return true;
  const sibling = siblingDownPath(change.path);
  if (sibling === null || !tree.has(sibling)) return false;
  // The sibling file is all down; prefix a marker line so the same emptiness test applies.
  return downDoesSomething(`-- down\n${(await tree.read(sibling)) ?? ''}`);
}

async function staleReferences({ name, tree, migrationGlobs }) {
  const hits = [];
  for (const variant of nameVariants(name)) {
    const word = new RegExp(`\\b${variant}\\b`);
    for (const hit of await tree.search(variant)) {
      if (matchesGlobs(hit.path, migrationGlobs) || isTestPath(hit.path) || NON_CODE.test(hit.path) || !word.test(hit.text)) continue;
      hits.push(`${hit.path}:${hit.line}`);
    }
  }
  return [...new Set(hits)];
}

function checkPlan({ plan, migrations, failures }) {
  if (!plan || typeof plan !== 'object') {
    fail(failures, `(evidence)/${PLAN_FILE}`, 'plan-missing', 'new migrations have no approved migration plan recorded for the item');
    return;
  }
  const touched = new Set(migrations.flatMap((entry) => entry.tables));
  const planned = new Set(Array.isArray(plan.tables) ? plan.tables : []);
  const unplanned = [...touched].filter((table) => !planned.has(table)).sort();
  const untouched = [...planned].filter((table) => !touched.has(table)).sort();
  if (unplanned.length > 0) fail(failures, `(evidence)/${PLAN_FILE}`, 'plan-mismatch', `migrations touch tables the plan does not list: ${unplanned.join(', ')}`);
  if (untouched.length > 0) fail(failures, `(evidence)/${PLAN_FILE}`, 'plan-mismatch', `the plan lists tables no migration touches: ${untouched.join(', ')}`);
}

function expectedDelta(plan, table) {
  const planned = plan?.rowCountChanges?.[table];
  return planned === undefined ? 0 : planned;
}

function checkRowCounts({ dryRun, plan, failures }) {
  const before = dryRun.rowCounts?.before;
  const after = dryRun.rowCounts?.after;
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' ||
      Array.isArray(before) || Array.isArray(after) ||
      Object.keys(before).length === 0 || Object.keys(after).length === 0 ||
      [...Object.values(before), ...Object.values(after)].some((count) => !Number.isSafeInteger(count) || count < 0)) {
    fail(failures, `(evidence)/${DRY_RUN_FILE}`, 'dry-run-missing', 'the dry run recorded no row counts before and after');
    return;
  }
  for (const table of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const expected = expectedDelta(plan, table);
    const had = table in before;
    const has = table in after;
    if (!had || !has) {
      const planned = (!had && expected === 'created') || (!has && expected === 'dropped');
      if (!planned) fail(failures, `(evidence)/${DRY_RUN_FILE}`, 'row-count-changed', `table ${table} ${had ? 'disappeared' : 'appeared'} and the plan does not say it is ${had ? 'dropped' : 'created'}`);
      continue;
    }
    const delta = after[table] - before[table];
    if (delta !== expected) fail(failures, `(evidence)/${DRY_RUN_FILE}`, 'row-count-changed', `table ${table} went from ${before[table]} to ${after[table]} rows; the plan expects a change of ${expected}`);
  }
}

function checkDryRun({ dryRun, plan, failures }) {
  if (!dryRun || typeof dryRun !== 'object' || typeof dryRun.command !== 'string' || dryRun.command.trim() === '') {
    fail(failures, `(evidence)/${DRY_RUN_FILE}`, 'dry-run-missing', 'no dry run of the migrations was recorded (command, exit code, database and row counts)');
    return;
  }
  const database = dryRun.database ?? {};
  if (database.kind === 'unavailable') {
    fail(failures, `(evidence)/${DRY_RUN_FILE}`, 'ephemeral-database-unavailable', 'BLOCKED: the verification skill has no throwaway database to migrate; the item waits for one and never runs against a shared database');
    return true;
  }
  if (database.kind !== 'ephemeral' || (database.url !== undefined && !isLocalUrl(database.url))) {
    fail(failures, `(evidence)/${DRY_RUN_FILE}`, 'dry-run-not-ephemeral', `the dry run used ${database.kind ?? 'an unnamed'} database${database.url ? ` at a non-local address` : ''}; it must run on a throwaway local copy`);
  }
  if (dryRun.exit !== 0) fail(failures, `(evidence)/${DRY_RUN_FILE}`, 'dry-run-failed', `${dryRun.command} exited ${dryRun.exit ?? '(no exit code)'}`);
  checkRowCounts({ dryRun, plan, failures });
  return false;
}

export async function evaluate({ changes, tree, baseTree, card, plan, dryRun, config }) {
  const migrationGlobs = config?.migrationGlobs ?? DEFAULT_MIGRATION_GLOBS;
  const schemaGlobs = config?.schemaGlobs ?? DEFAULT_SCHEMA_GLOBS;
  const failures = [];
  const relevant = changes.filter((change) => !change.binary && !isTestPath(change.path));
  const migrationChanges = relevant.filter((change) => matchesGlobs(change.path, migrationGlobs));
  const added = migrationChanges.filter((change) => change.status === 'added');
  for (const change of migrationChanges.filter((entry) => entry.status !== 'added')) {
    fail(failures, change.path, 'migration-edited', `an existing migration was ${change.status}; databases that already ran it will not see the edit, so add a new migration instead`);
  }
  const schemaChanged = relevant.filter((change) => matchesGlobs(change.path, schemaGlobs) && !matchesGlobs(change.path, migrationGlobs));
  if (schemaChanged.length > 0 && added.length === 0) {
    fail(failures, schemaChanged[0].path, 'migration-missing', `the schema definition changed (${schemaChanged.map((change) => change.path).join(', ')}) but no new migration was added`);
  }
  const upFiles = added.filter((change) => !/\.down\.[^/]+$/.test(change.path));
  if (upFiles.length === 0) return { pass: failures.length === 0, failures };

  const declaredLocks = Array.isArray(plan?.declaredLocks) ? plan.declaredLocks : [];
  const migrations = [];
  for (const change of upFiles) {
    const { up, down } = splitDirections(change.headText ?? '');
    migrations.push({ path: change.path, tables: touchedTables(up) });
    const irreversible = countersignsFor(card, { kinds: ['irreversible'], subject: change.path }).length > 0;
    if (!irreversible && !(await hasRollback({ change, down, tree }))) {
      fail(failures, change.path, 'rollback-or-irreversible-countersign', 'no down section that does something, no sibling .down file, and no "irreversible" countersign naming this file');
    }
    for (const { risk, line } of lockRisks(change.path, up)) {
      if (!declaredLocks.some((entry) => entry?.file === change.path && entry?.risk === risk)) {
        fail(failures, `${change.path}:${line}`, 'lock-risk-undeclared', `${risk} is not in the plan's declaredLocks for this file`);
      }
    }
    for (const { kind, name, line } of removedNames(up)) {
      const references = [...new Set((await Promise.all([tree, baseTree].filter(Boolean).map((view) => staleReferences({ name, tree: view, migrationGlobs })))).flat())];
      if (references.length > 0) {
        fail(failures, `${change.path}:${line}`, 'expand-contract', `${kind} ${name} is dropped or renamed while base or head code references it (${references.slice(0, 3).join(', ')}); ship the code change first and remove the ${kind} in a later item`);
      }
    }
  }
  checkPlan({ plan, migrations, failures });
  const blocked = checkDryRun({ dryRun, plan, failures });
  return blocked ? { pass: false, blocked: true, failures } : { pass: failures.length === 0, failures };
}

export default {
  id: 'migration-safety',
  needsCard: true,
  description: 'New migrations roll back or are countersigned irreversible, declare their locks, follow expand-contract, match the plan and pass an ephemeral dry run.',
  async run({ repo, item, baseSha, headSha, config, card }) {
    const changes = await collectChanges({ repo, baseSha, headSha });
    const captures = await readCaptures({ repo, itemId: item?.id, kind: 'migration', headSha });
    const capture = captures.at(-1);
    const observed = capture && evidenceLines(capture.output).at(-1);
    return evaluate({
      changes,
      tree: await headTree({ repo, headSha }),
      baseTree: await headTree({ repo, headSha: baseSha }),
      card: await readCard({ repo, item, card }),
      plan: await readItemEvidence({ repo, itemId: item?.id, name: PLAN_FILE }),
      dryRun: observed && { ...observed, command: capture.command, exit: capture.exit },
      config,
    });
  },
  async runFixture(fixture) {
    return evaluate({
      changes: changesFromFiles(fixture.files),
      tree: fixtureTree(fixture.files, fixture.paths),
      baseTree: fixtureTree((fixture.files ?? []).map((file) => ({ path: file.oldPath ?? file.path, head: file.base }))),
      card: fixture.card,
      plan: fixture.plan,
      dryRun: fixture.dryRun,
      config: fixture.config,
    });
  },
};
