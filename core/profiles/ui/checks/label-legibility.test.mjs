import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';

import check from './label-legibility.mjs';

const fixtures = new URL('../fixtures/label-legibility/', import.meta.url);
const load = async (name) => JSON.parse(await fs.readFile(new URL(name, fixtures), 'utf8'));

test('fixtures pass or report exactly their expected rules', async () => {
  for (const name of (await fs.readdir(fixtures)).filter((entry) => entry.endsWith('.json'))) {
    const fixture = await load(name);
    const result = await check.runFixture(fixture);
    assert.equal(result.pass, name.startsWith('pass-'), name);
    assert.deepEqual([...new Set(result.failures.map((entry) => entry.rule))].sort(), fixture.expect.slice().sort(), name);
    for (const failure of result.failures) {
      assert.match(failure.target, /:\d+$/);
      assert.ok(failure.detail.includes(failure.target));
      assert.match(failure.detail, /mend-allow label-legibility/);
    }
  }
});

test('allowances preserve the rule, location and nonempty reason', async () => {
  const result = await check.runFixture(await load('pass-allowed.json'));
  assert.deepEqual(result.allowed, [{ target: 'src/chart.ts:1', rule: 'label-hidden-overlap', reason: 'Full labels are available in the table' }]);
  assert.deepEqual((await check.runFixture(await load('fail-empty-reason.json'))).allowed, []);
});

test('variants and multiple rules on one line are reported separately', async () => {
  const result = await check.runFixture({ files: [{ path: 'src/chart.tsx', base: null, head: [
    'const axisLabel = { overflow: "ellipsis" };',
    'const axisLabel = { width: 80, ellipsis: "..." };',
    'const text = `${name.substring(0, limit)}...`;',
    'const axis = { hideOverlap: true, overflow: "truncate" }; // mend-allow label-legibility: Alternative table',
  ].join('\n') }] });
  assert.deepEqual(result.failures.map((entry) => entry.rule), ['label-truncated', 'label-truncated', 'label-sliced']);
  assert.deepEqual(result.allowed.map((entry) => entry.rule), ['label-hidden-overlap', 'label-truncated']);
});

test('non-code files, comments and unrelated overflow are ignored', async () => {
  const result = await check.runFixture({ files: [
    { path: 'docs/chart.md', base: null, head: 'hideOverlap: true\n' },
    { path: 'src/chart.ts', base: null, head: '// hideOverlap: true\nconst panel = { overflow: "ellipsis" };\n' },
  ] });
  assert.equal(result.pass, true);
});
