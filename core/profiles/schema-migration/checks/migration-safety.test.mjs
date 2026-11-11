import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLocalUrl } from '../../../checks/local-url.mjs';
import { assertFixtures, captureEvidence, makeFixtureRepo, readFixtures, removeAll, rulesOf, writeEvidence } from '../../../checks/test-support.mjs';
import migrationSafety, { DRY_RUN_FILE, PLAN_FILE } from './migration-safety.mjs';
import { downDoesSomething, lockRisks, removedNames, splitDirections, statementsOf, touchedTables } from './migration-text.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'migration-safety');
const dirs = [];
after(() => removeAll(dirs));

async function fixture(name) {
  return (await readFixtures(FIXTURES)).find((entry) => entry.name === name).fixture;
}

const risksOf = (filePath, text) => lockRisks(filePath, text).map((entry) => entry.risk).sort();

test('every migration-safety fixture passes or fails exactly the rules it names', async () => {
  await assertFixtures(migrationSafety, FIXTURES);
});

test('down sections are found per tool, and an empty or refusing down does not count', () => {
  assert.equal(splitDirections('-- +goose Up\nCREATE TABLE a (id int);\n-- +goose Down\nDROP TABLE a;\n').down, '-- +goose Down\nDROP TABLE a;\n');
  assert.equal(downDoesSomething(splitDirections('exports.up = (k) => k.schema.createTable("a");\n\nexports.down = function (knex) {\n  return knex.schema.dropTable("a");\n};\n').down), true);
  assert.equal(downDoesSomething(splitDirections('def upgrade():\n    op.drop_table("a")\n\n\ndef downgrade():\n    raise NotImplementedError("one way")\n').down), false);
  assert.equal(downDoesSomething(splitDirections('-- migrate:up\nSELECT 1;\n-- migrate:down\n\n-- nothing to undo\n').down), false);
  assert.equal(splitDirections('revision = "b"\ndown_revision = "a"\n').down, null, 'down_revision is not a down section');
});

test('lock risks are recognised in SQL, Alembic and Rails, and the safe variants are not', () => {
  assert.deepEqual(risksOf('m.sql', 'CREATE UNIQUE INDEX a_idx ON orders (code)'), ['index-not-concurrent']);
  assert.deepEqual(risksOf('m.sql', 'CREATE INDEX CONCURRENTLY a_idx ON orders (code)'), []);
  assert.deepEqual(risksOf('m.sql', 'ALTER TABLE orders ADD COLUMN code text NOT NULL'), ['add-column-not-null-no-default']);
  assert.deepEqual(risksOf('m.sql', "ALTER TABLE orders ADD COLUMN code text NOT NULL DEFAULT 'x'"), []);
  assert.deepEqual(risksOf('m.sql', 'ALTER TABLE orders ALTER COLUMN total TYPE bigint'), ['column-type-change']);
  assert.deepEqual(risksOf('m.sql', 'ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)'), ['constraint-validated']);
  assert.deepEqual(risksOf('m.sql', 'ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) NOT VALID'), []);
  assert.deepEqual(risksOf('m.sql', 'ALTER TABLE orders RENAME COLUMN total TO amount'), ['rename']);
  assert.deepEqual(risksOf('m.sql', 'VACUUM FULL orders'), ['table-rewrite']);
  assert.deepEqual(risksOf('v.py', 'op.create_index(\n    "a_idx",\n    "orders",\n    ["code"],\n)'), ['index-not-concurrent']);
  assert.deepEqual(risksOf('v.py', 'op.create_index("a_idx", "orders", ["code"], postgresql_concurrently=True)'), []);
  assert.deepEqual(risksOf('v.py', 'op.alter_column("orders", "code", nullable=False)'), ['set-not-null']);
  assert.deepEqual(risksOf('m.rb', 'add_index :orders, :code, algorithm: :concurrently'), []);
  assert.deepEqual(risksOf('m.rb', 'change_column :orders, :total, :bigint'), ['column-type-change']);
});

test('statements keep their start line so failures point at the right place', () => {
  assert.deepEqual(statementsOf('m.sql', '-- up\nSELECT 1;\n\nSELECT 2;\n').map((entry) => entry.line), [1, 4]);
  assert.deepEqual(statementsOf('v.py', 'a = 1\nop.add_column(\n  "t",\n  c,\n)\nb = 2\n').map((entry) => entry.line), [1, 2, 6]);
});

test('dropped and renamed names and touched tables come from every supported tool', () => {
  assert.deepEqual(removedNames('ALTER TABLE customers RENAME COLUMN phone TO phone_number;').map((entry) => entry.name), ['phone']);
  assert.deepEqual(removedNames('op.drop_column("customers", "fax")\nop.drop_table("old_sessions")').map((entry) => `${entry.kind}:${entry.name}`), ['column:fax', 'table:old_sessions']);
  assert.deepEqual(removedNames("table.dropColumn('fax');\nremove_column :customers, :pager, :string").map((entry) => entry.name), ['fax', 'pager']);
  assert.deepEqual(touchedTables('CREATE INDEX a ON public.orders (x);\nUPDATE "customers" SET y = 1;\nALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (c) REFERENCES customers (id) ON UPDATE CASCADE;'), ['customers', 'orders']);
  assert.deepEqual(touchedTables("op.create_index('ix', 'invoices', ['due_on'])\nknex.schema.alterTable('payments', t => {})\nadd_reference :refunds, :order"), ['invoices', 'payments', 'refunds']);
});

test('local database urls include file-backed databases and exclude shared hosts', () => {
  assert.equal(isLocalUrl('postgres://u@localhost:5432/x'), true);
  assert.equal(isLocalUrl('sqlite3:tmp/dry_run.sqlite3'), true);
  assert.equal(isLocalUrl('mysql://u@db.internal.example.com/x'), false);
  assert.equal(isLocalUrl('not a url'), false);
});

test('a missing throwaway database blocks the item instead of failing it', async () => {
  const result = await migrationSafety.runFixture(await fixture('fail-no-ephemeral-database.json'));
  assert.equal(result.blocked, true);
  assert.match(result.failures[0].detail, /^BLOCKED:/);
  const ready = await migrationSafety.runFixture(await fixture('pass-additive-column.json'));
  assert.equal(ready.blocked, undefined);
});

test('a down file that is empty does not count as a rollback', async () => {
  const data = structuredClone(await fixture('pass-declared-locks-sibling-down.json'));
  data.files[1].head = '-- nothing to undo\n';
  assert.deepEqual(rulesOf(await migrationSafety.runFixture(data)), ['rollback-or-irreversible-countersign']);
});

test('a countersign for another file does not cover this one', async () => {
  const data = structuredClone(await fixture('pass-irreversible-countersigned.json'));
  data.card.countersigns[0].subject = 'prisma/migrations/20251201000000_other/migration.sql';
  assert.deepEqual(rulesOf(await migrationSafety.runFixture(data)), ['rollback-or-irreversible-countersign']);
});

test('the repo adapter reads the plan, dry run and card from the item evidence folder', async () => {
  const data = await fixture('pass-irreversible-countersigned.json');
  const repo = await makeFixtureRepo({ files: data.files, dirs });
  const args = { repo: repo.root, item: { id: 'mig-1' }, baseSha: repo.baseSha, headSha: repo.headSha };
  assert.deepEqual(rulesOf(await migrationSafety.run(args)), ['dry-run-missing', 'plan-missing', 'rollback-or-irreversible-countersign']);
  await writeEvidence({ root: repo.root, itemId: 'mig-1', name: PLAN_FILE, value: data.plan });
  await captureEvidence({ root: repo.root, itemId: 'mig-1', kind: 'migration', value: data.dryRun });
  await fs.writeFile(path.join(repo.root, '.mend', 'evidence', 'mig-1.json'), JSON.stringify(data.card));
  assert.equal((await migrationSafety.run(args)).pass, true);
});

test('migration evidence rejects a manually written dry run without a capture', async () => {
  const data = await fixture('pass-additive-column.json');
  const repo = await makeFixtureRepo({ files: data.files, dirs });
  const args = { repo: repo.root, item: { id: 'migration-manual' }, baseSha: repo.baseSha, headSha: repo.headSha };
  await writeEvidence({ root: repo.root, itemId: args.item.id, name: PLAN_FILE, value: data.plan });
  await writeEvidence({ root: repo.root, itemId: args.item.id, name: DRY_RUN_FILE, value: data.dryRun });
  assert.equal((await migrationSafety.run(args)).pass, false);
});

test('empty row counts do not demonstrate a migration dry run', async () => {
  const data = structuredClone(await fixture('pass-additive-column.json'));
  data.dryRun.rowCounts = { before: {}, after: {} };
  assert.equal((await migrationSafety.runFixture(data)).pass, false);
});

test('each side must contain measurements even for planned created or dropped tables', async () => {
  const original = await fixture('pass-additive-column.json');
  for (const [before, after, change] of [[{}, { orders: 0 }, 'created'], [{ orders: 0 }, {}, 'dropped']]) {
    const data = structuredClone(original);
    data.plan.rowCountChanges = { orders: change };
    data.dryRun.rowCounts = { before, after };
    assert.deepEqual(rulesOf(await migrationSafety.runFixture(data)), ['dry-run-missing']);
  }
});

test('expand-contract reads the head commit of a real repo, ignoring migrations, tests and docs', async () => {
  const data = await fixture('fail-expand-contract.json');
  const files = [
    ...data.files.filter((file) => file.path !== 'server/customers.ts'),
    { path: 'tests/customers.test.ts', base: null, head: 'expect(row.legacy_email).toBeUndefined();\n' },
    { path: 'docs/history.md', base: null, head: 'legacy_email was removed in January.\n' },
  ];
  const repo = await makeFixtureRepo({ files, dirs });
  await writeEvidence({ root: repo.root, itemId: 'mig-2', name: PLAN_FILE, value: data.plan });
  await captureEvidence({ root: repo.root, itemId: 'mig-2', kind: 'migration', value: data.dryRun });
  const args = { repo: repo.root, item: { id: 'mig-2' }, baseSha: repo.baseSha, headSha: repo.headSha };
  assert.equal((await migrationSafety.run(args)).pass, true);
});

test('dropping a column while removing its last application reference fails expand-contract', async () => {
  const data = structuredClone(await fixture('fail-expand-contract.json'));
  data.files[1].head = 'export function contactAddress(customer) { return customer.email; }\n';
  assert.ok(rulesOf(await migrationSafety.runFixture(data)).includes('expand-contract'));
  const repo = await makeFixtureRepo({ files: data.files, dirs });
  await writeEvidence({ root: repo.root, itemId: 'mig-base', name: PLAN_FILE, value: data.plan });
  await captureEvidence({ root: repo.root, itemId: 'mig-base', kind: 'migration', value: data.dryRun });
  const result = await migrationSafety.run({ repo: repo.root, item: { id: 'mig-base' }, baseSha: repo.baseSha, headSha: repo.headSha });
  assert.ok(rulesOf(result).includes('expand-contract'));
});
