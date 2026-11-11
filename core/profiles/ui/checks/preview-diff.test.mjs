import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import previewDiff, { DEFAULT_TOLERANCE, compareLayouts } from './preview-diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'preview-diff');

const block = (id, x, y, width, height) => ({ id, rect: { x, y, width, height } });
const layout = (containerWidth, ...blocks) => ({ containerWidth, blocks });
const PREVIEW = layout(1000, block('hero', 0, 0, 500, 250), block('detail', 500, 0, 250, 250), block('history', 750, 0, 250, 250));
const rulesOf = (result) => [...new Set(result.failures.map((failure) => failure.rule))].sort();

test('empty layout evidence cannot pass on either side', () => {
  for (const [preview, integrated] of [[layout(1000), layout(1000)], [PREVIEW, layout(1000)], [layout(1000), PREVIEW]]) {
    assert.equal(compareLayouts({ preview, integrated }).pass, false);
  }
});

test('every preview-diff fixture fails exactly the rules it names and every pass fixture passes', async () => {
  const names = (await fs.readdir(FIXTURES)).filter((name) => name.endsWith('.json')).sort();
  for (const name of names) {
    const fixture = JSON.parse(await fs.readFile(path.join(FIXTURES, name), 'utf8'));
    const result = await previewDiff.runFixture(fixture);
    if (name.startsWith('pass-')) assert.deepEqual(result.failures, [], name);
    else assert.deepEqual(rulesOf(result), [...fixture.expect].sort(), name);
  }
});

test('the equal-width fallback is named as such against the approved order', async () => {
  const fixture = JSON.parse(await fs.readFile(path.join(FIXTURES, 'fail-equal-width-fallback.json'), 'utf8'));
  const result = compareLayouts(fixture);
  assert.equal(result.pass, false);
  assert.ok(result.mismatches.includes('block order hero/detail/history vs equal-width pairs'), result.mismatches.join('\n'));
  assert.equal(result.maxDelta.toFixed(2), '0.25');
});

test('identical layouts pass with zero delta, and scale does not matter', () => {
  assert.deepEqual(compareLayouts({ preview: PREVIEW, integrated: PREVIEW }), { pass: true, maxDelta: 0, mismatches: [], failures: [] });
  const doubled = layout(2000, block('hero', 0, 0, 1000, 500), block('detail', 1000, 0, 500, 500), block('history', 1500, 0, 500, 500));
  assert.equal(compareLayouts({ preview: PREVIEW, integrated: doubled }).pass, true);
});

test('tolerance is inclusive at the edge and fails just past it', () => {
  const at = layout(1000, block('hero', 0, 0, 580, 250), block('detail', 580, 0, 210, 250), block('history', 790, 0, 210, 250));
  assert.equal(compareLayouts({ preview: PREVIEW, integrated: at, tolerance: 0.08 }).pass, true);
  const past = layout(1000, block('hero', 0, 0, 581, 250), block('detail', 581, 0, 210, 250), block('history', 791, 0, 209, 250));
  const result = compareLayouts({ preview: PREVIEW, integrated: past, tolerance: 0.08 });
  assert.deepEqual(rulesOf(result), ['block-size']);
  assert.equal(result.failures.length, 1);
  assert.equal(DEFAULT_TOLERANCE, 0.08);
});

test('a tighter or looser tolerance changes the verdict for the same drift', () => {
  const drift = layout(1000, block('hero', 0, 0, 540, 250), block('detail', 540, 0, 230, 250), block('history', 770, 0, 230, 250));
  assert.equal(compareLayouts({ preview: PREVIEW, integrated: drift, tolerance: 0.02 }).pass, false);
  assert.equal(compareLayouts({ preview: PREVIEW, integrated: drift, tolerance: 0.05 }).pass, true);
});

test('height drift is measured like width drift', () => {
  const taller = layout(1000, block('hero', 0, 0, 500, 400), block('detail', 500, 0, 250, 250), block('history', 750, 0, 250, 250));
  assert.deepEqual(rulesOf(compareLayouts({ preview: PREVIEW, integrated: taller })), ['block-size']);
});

test('missing and extra blocks are reported and order is compared on the shared blocks only', () => {
  const extra = layout(1000, block('hero', 0, 0, 500, 250), block('detail', 500, 0, 250, 250), block('history', 750, 0, 250, 250), block('banner', 0, 250, 1000, 60));
  assert.deepEqual(rulesOf(compareLayouts({ preview: PREVIEW, integrated: extra })), ['block-extra']);
  const fewer = layout(1000, block('hero', 0, 0, 500, 250), block('history', 750, 0, 250, 250));
  assert.deepEqual(rulesOf(compareLayouts({ preview: PREVIEW, integrated: fewer })), ['block-missing']);
});

test('moving a block to a new row changes the order even when sizes match', () => {
  const stacked = layout(1000, block('hero', 0, 0, 500, 250), block('detail', 500, 0, 250, 250), block('history', 500, 250, 250, 250));
  const result = compareLayouts({ preview: PREVIEW, integrated: stacked });
  assert.deepEqual(rulesOf(result), ['block-order']);
  assert.match(result.mismatches[0], /hero\/detail\/history vs hero\/detail \| history/);
});

test('bad input is rejected with typed errors', () => {
  assert.throws(() => compareLayouts({ preview: PREVIEW, integrated: { containerWidth: 0, blocks: [] } }), /integrated\.containerWidth must be a positive number/);
  assert.throws(() => compareLayouts({ preview: { containerWidth: 1000 }, integrated: PREVIEW }), /preview\.blocks must be an array/);
  assert.throws(() => compareLayouts({ preview: PREVIEW, integrated: PREVIEW, tolerance: -0.1 }), RangeError);
  assert.throws(() => compareLayouts({ preview: PREVIEW, integrated: PREVIEW, tolerance: Number.NaN }), RangeError);
});

test('run fails with layout-missing without evidence, then compares and reports the tolerance override', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'mend-preview-diff-'));
  try {
    assert.deepEqual(rulesOf(await previewDiff.run({ repo, item: { id: 'item-1' }, config: {} })), ['layout-missing']);
    const dir = path.join(repo, '.mend', 'evidence', 'item-1');
    await fs.mkdir(dir, { recursive: true });
    const drift = layout(1000, block('hero', 0, 0, 600, 250), block('detail', 600, 0, 200, 250), block('history', 800, 0, 200, 250));
    await fs.writeFile(path.join(dir, 'layout.json'), JSON.stringify({ preview: PREVIEW, integrated: drift }));
    assert.deepEqual(rulesOf(await previewDiff.run({ repo, item: { id: 'item-1' }, config: {} })), ['block-size']);
    const loosened = await previewDiff.run({ repo, item: { id: 'item-1' }, config: { ui: { layoutTolerance: 0.15 } } });
    assert.equal(loosened.pass, true);
    assert.deepEqual(loosened.overrides, [{ key: 'layoutTolerance', from: 0.08, to: 0.15, loosens: true }]);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
