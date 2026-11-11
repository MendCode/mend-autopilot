import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertFixtures, captureEvidence, gitSync, makeFixtureRepo, removeAll, rulesOf, writeEvidence } from '../../../checks/test-support.mjs';
import { compareExports, exportsOf } from './exports.mjs';
import surfaceUnchanged, { entriesFromFiles, TEST_RESULTS_FILE } from './surface-unchanged.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'surface-unchanged');
const SAME_RESULTS = { base: { passed: 3, failed: 0, skipped: 0 }, head: { passed: 3, failed: 0, skipped: 0 } };
const dirs = [];
after(() => removeAll(dirs));

const names = (filePath, text) => [...exportsOf(filePath, text).keys()].sort();

test('every surface-unchanged fixture passes or fails exactly the rules it names', async () => {
  await assertFixtures(surfaceUnchanged, FIXTURES);
});

test('JavaScript and TypeScript exports cover declarations, lists, re-exports, defaults and CommonJS', () => {
  const text = [
    'export function a(x, y = f(1)) {}',
    'export async function b(',
    '  opts,',
    ') {}',
    'export default function () {}',
    "export { c, d as e } from './x';",
    "export * from './y';",
    "export * as ns from './z';",
    'export type T = string;',
    'export const h = async (p: number): Promise<void> => {};',
    'const hidden = 1;',
  ].join('\n');
  assert.deepEqual(names('m.ts', text), ['* from ./y', 'T', 'a', 'b', 'c', 'default', 'e', 'h', 'ns']);
  assert.equal(exportsOf('m.ts', text).get('b'), '(opts)');
  assert.equal(exportsOf('m.ts', text).get('h'), '(p: number)');
  assert.deepEqual(names('m.cjs', 'module.exports = { g, h: i };\nexports.j = 1;\n'), ['g', 'h', 'j']);
});

test('Python exports are public top-level names, or exactly __all__ when it is set', () => {
  assert.deepEqual(names('m.py', 'VERSION = 1\n_private = 2\ndef run(a, b=2):\n    inner = 1\nclass Job:\n    def go(self): pass\n'), ['Job', 'VERSION', 'run']);
  assert.deepEqual(names('m.py', '__all__ = ["run"]\ndef run(a):\n    pass\ndef helper():\n    pass\n'), ['run']);
  assert.equal(exportsOf('m.py', 'def run(a, b=2):\n    pass\n').get('run'), '(a, b=2)');
});

test('a call assigned to a const is not mistaken for a parameter list', () => {
  assert.equal(exportsOf('m.ts', 'export const k = compute(1);\n').get('k'), null);
  const before = exportsOf('m.ts', 'export const k = compute(1);\n');
  const after = exportsOf('m.ts', 'export const k = compute(2);\n');
  assert.deepEqual(compareExports(before, after), []);
});

test('identical delete and add pairs become moves; an explicit oldPath is a rename with edits', () => {
  const entries = entriesFromFiles([
    { path: 'a/old.ts', base: 'x\n', head: null },
    { path: 'b/new.ts', base: null, head: 'x\n' },
    { path: 'c/next.ts', oldPath: 'c/prev.ts', base: 'y\n', head: 'z\n' },
    { path: 'same.ts', base: 'q\n', head: 'q\n' },
  ]);
  assert.deepEqual(entries.map((entry) => [entry.path, entry.oldPath, entry.status, entry.similarity]), [
    ['b/new.ts', 'a/old.ts', 'renamed', 100],
    ['c/next.ts', 'c/prev.ts', 'renamed', 50],
  ]);
});

test('a declared whole-file change covers every export of that file', async () => {
  const fixture = {
    item: { surfaceChanges: ['src/new.ts#*'] },
    files: [{ path: 'src/new.ts', base: null, head: 'export const a = 1;\nexport function b() {}\n' }],
    testResults: SAME_RESULTS,
  };
  assert.equal((await surfaceUnchanged.runFixture(fixture)).pass, true);
  fixture.item.surfaceChanges = ['src/new.ts#a'];
  assert.deepEqual(rulesOf(await surfaceUnchanged.runFixture(fixture)), ['export-changed']);
});

test('the repo adapter uses git rename detection and the recorded test results', async () => {
  const body = 'export function slugify(text) {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");\n}\n';
  const testBody = (from) => `import { slugify } from '${from}';\n\ntest('slug', () => expect(slugify('A B')).toBe('a-b'));\n`;
  const repo = await makeFixtureRepo({
    files: [
      { path: 'src/util/slug.ts', base: body, head: null },
      { path: 'src/text/slug.ts', base: null, head: body },
      { path: 'src/text/slug.test.ts', base: testBody('../util/slug'), head: testBody('./slug') },
    ],
    dirs,
  });
  const args = { repo: repo.root, item: { id: 'move-slug' }, baseSha: repo.baseSha, headSha: repo.headSha };
  assert.deepEqual(rulesOf(await surfaceUnchanged.run(args)), ['test-results-missing']);
  gitSync(repo.root, ['checkout', '--detach', repo.baseSha]);
  await captureEvidence({ root: repo.root, itemId: 'move-slug', kind: 'tests', value: SAME_RESULTS.base });
  gitSync(repo.root, ['checkout', '--detach', repo.headSha]);
  await captureEvidence({ root: repo.root, itemId: 'move-slug', kind: 'tests', value: SAME_RESULTS.head });
  assert.equal((await surfaceUnchanged.run(args)).pass, true);
});

test('refactor evidence rejects manually written totals without captures', async () => {
  const repo = await makeFixtureRepo({
    files: [{ path: 'src/value.js', base: 'export const value = 1;\n', head: 'export const value = 2;\n' }],
    dirs,
  });
  const args = { repo: repo.root, item: { id: 'refactor-manual' }, baseSha: repo.baseSha, headSha: repo.headSha };
  await writeEvidence({ root: repo.root, itemId: args.item.id, name: TEST_RESULTS_FILE, value: SAME_RESULTS });
  assert.equal((await surfaceUnchanged.run(args)).pass, false);
});
