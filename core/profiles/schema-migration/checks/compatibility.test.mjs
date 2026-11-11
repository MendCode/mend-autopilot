import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { capture, readCaptures } from '../../../checks/capture.mjs';
import { makeFixtureRepo, removeAll } from '../../../checks/test-support.mjs';
import compatibility from './compatibility.mjs';

const dirs = [];
after(() => removeAll(dirs));

test('compatibility requires successful local tests for both application/schema combinations', async () => {
  const capture = { command: 'node compatibility-test.mjs', exit: 0, database: { kind: 'ephemeral' }, combinations: ['base-head', 'head-base'] };
  assert.equal((await compatibility.runFixture({ capture })).pass, true);
  assert.equal((await compatibility.runFixture({ capture: { ...capture, exit: 1 } })).pass, false);
  assert.equal((await compatibility.runFixture({ capture: { ...capture, combinations: ['base-head'] } })).pass, false);
  assert.equal((await compatibility.runFixture({})).pass, false);
});

test('captured SQLite application writes reject a new required column without a default', async () => {
  // The old and new application both insert only the original column. Both cross-version
  // combinations are executed against independent in-memory databases; evidence is emitted
  // only if both writes succeed. Python's sqlite3 is in its standard library.
  const script = `import json, sqlite3, sys
base_schema = "CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL)"
head_schema = "CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL, category TEXT NOT NULL" + (" DEFAULT 'general'" if sys.argv[1] == "compatible" else "") + ")"
def write_entry(db):
    db.execute("INSERT INTO entries (id, label) VALUES (?, ?)", (1, "sample"))
for schema in (head_schema, base_schema):
    with sqlite3.connect(":memory:") as db:
        db.execute(schema)
        write_entry(db)
print("MEND_EVIDENCE " + json.dumps({"database": {"kind": "ephemeral"}, "combinations": ["base-head", "head-base"]}))
`;
  const repo = await makeFixtureRepo({ files: [{ path: 'compatibility.py', base: script, head: script }], dirs });
  const args = { repo: repo.root, item: { id: 'sqlite-compatibility' }, headSha: repo.headSha };
  const failed = await capture({ repo: repo.root, item: args.item, kind: 'compatibility', command: 'python3 compatibility.py incompatible' });
  assert.notEqual(failed.exit, 0);
  const [failedLog] = await readCaptures({ repo: repo.root, itemId: args.item.id, kind: 'compatibility', headSha: repo.headSha });
  assert.match(failedLog.stderr, /NOT NULL constraint failed: entries\.category/);
  assert.equal((await compatibility.run(args)).pass, false);

  // Use a separate item to avoid depending on timestamp ordering between captures.
  const passingArgs = { ...args, item: { id: 'sqlite-compatible' } };
  const passed = await capture({ repo: repo.root, item: passingArgs.item, kind: 'compatibility', command: 'python3 compatibility.py compatible' });
  assert.equal(passed.exit, 0);
  assert.equal((await compatibility.run(passingArgs)).pass, true);
});
