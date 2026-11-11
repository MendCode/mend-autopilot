import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import check, { evaluate } from './token-scale.mjs';

const fixtures = new URL('../fixtures/token-scale/', import.meta.url);
const load = async (name) => JSON.parse(await fs.readFile(new URL(name, fixtures), 'utf8'));
const element = (overrides = {}) => ({ fontSize: '16px', fontWeight: '400', borderRadius: '4px', color: 'rgb(20, 30, 40)', backgroundColor: 'rgb(255, 255, 255)', ...overrides });
const snapshot = (elements, pageElements = elements) => ({ components: [{ id: 'card', elements }], page: { elements: pageElements } });
const rulesOf = (result) => [...new Set(result.failures.map((entry) => entry.rule))].sort();

test('every synthetic fixture passes or fails exactly its named rules', async () => {
  const names = (await fs.readdir(fixtures)).filter((name) => name.endsWith('.json')).sort();
  assert.equal(names.length, 6);
  for (const name of names) {
    const fixture = await load(name);
    const result = await check.runFixture(fixture);
    assert.equal(result.pass, name.startsWith('pass-'), name);
    assert.deepEqual(rulesOf(result), fixture.expect.slice().sort(), name);
  }
});

test('off-scale reports the component, property, value and three deterministic nearest values once', async () => {
  const fixture = await load('fail-font-size.json');
  fixture.head.components[0].elements.push(fixture.head.components[0].elements[0]);
  const result = await check.runFixture(fixture);
  assert.equal(result.failures.length, 1);
  const failure = result.failures[0];
  assert.equal(failure.target, 'heading');
  assert.equal(failure.property, 'fontSize');
  assert.equal(failure.value, '18px');
  assert.deepEqual(failure.nearest, ['16px', '12px', '24px']);
  assert.match(failure.detail, /heading: fontSize "18px"/);
});

test('weight, radius and RGBA distances use numeric values and preserve property boundaries', () => {
  const base = snapshot([element({ fontWeight: '300', borderRadius: '2px' }), element({ fontWeight: '700', borderRadius: '8px' }), element({ fontWeight: '500', borderRadius: '6px' }), element({ fontWeight: '900', borderRadius: '20px' })]);
  const head = snapshot([element({ fontWeight: '600', borderRadius: '7px', color: 'rgb(255, 255, 255)' })]);
  const result = evaluate({ base, head });
  assert.deepEqual(result.failures.find((entry) => entry.property === 'fontWeight').nearest, ['500', '700', '300']);
  assert.deepEqual(result.failures.find((entry) => entry.property === 'borderRadius').nearest, ['6px', '8px', '2px']);
  assert.equal(result.failures.find((entry) => entry.property === 'color').value, 'rgb(255, 255, 255)', 'a background token is not automatically a foreground token');
  const palette = snapshot([element({ color: 'rgb(0, 0, 0)' }), element({ color: 'rgb(200, 200, 200)' }), element({ color: 'rgb(50, 50, 50)' }), element({ color: 'rgba(50, 50, 50, 0.5)' })]);
  const colour = evaluate({ base: palette, head: snapshot([element({ color: 'rgb(51, 51, 51)' })]) });
  assert.deepEqual(colour.failures[0].nearest, ['rgb(50, 50, 50)', 'rgb(0, 0, 0)', 'rgba(50, 50, 50, 0.501961)']);
});

test('equivalent computed values and transparent colours do not manufacture tokens', () => {
  const base = snapshot([element({ color: '#141e28', backgroundColor: 'transparent' })]);
  const head = snapshot([element({ fontSize: 16, fontWeight: 'normal', borderRadius: '4px 4px / 4px', color: 'rgba(20,30,40,1)', backgroundColor: 'rgba(200, 100, 50, 0)' })]);
  assert.equal(evaluate({ base, head, ui: { scaleMargin: 0 } }).pass, true);
  const transparent = snapshot([element({ color: 'transparent', backgroundColor: 'transparent' })]);
  const opaque = evaluate({ base: transparent, head: snapshot([element()]) });
  assert.deepEqual(opaque.failures.map((entry) => entry.nearest), [[], []]);
});

test('all five property scales enforce page growth, including tokens outside the changed component', () => {
  for (const [property, values] of Object.entries({ fontSize: ['18px', '20px'], fontWeight: ['500', '600'], borderRadius: ['6px', '8px'], color: ['rgb(1, 2, 3)', 'rgb(4, 5, 6)'], backgroundColor: ['rgb(1, 2, 3)', 'rgba(4, 5, 6, 0.5)'] })) {
    const base = snapshot([element()]);
    const page = [element(), ...values.map((value) => element({ [property]: value }))];
    assert.equal(evaluate({ base, head: snapshot([element()], page.slice(0, 2)) }).pass, true, property);
    const result = evaluate({ base, head: snapshot([element()], page) });
    assert.deepEqual(rulesOf(result), ['scale-growth']);
    const failure = result.failures[0];
    assert.deepEqual([failure.property, failure.baseCount, failure.headCount, failure.margin], [property, 1, 3, 1]);
    assert.equal(evaluate({ base, head: snapshot([element()], page.slice(0, 2)), ui: { scaleMargin: 0 } }).pass, false);
  }
});

test('compound and elliptical radii compare all corners, with deterministic suggestions for unlike units', () => {
  const base = snapshot([element({ borderRadius: '0px 8px / 4px 12px' }), element({ borderRadius: '50%' }), element({ borderRadius: '10px' })]);
  const equivalent = snapshot([element({ borderRadius: '0 8px 0 8px / 4px 12px 4px 12px' })]);
  assert.equal(evaluate({ base, head: equivalent }).pass, true);
  const result = evaluate({ base, head: snapshot([element({ borderRadius: '0px 9px / 4px 12px' })]) });
  assert.deepEqual(result.failures[0].nearest, ['0px 8px / 4px 12px', '10px', '50%']);
});

test('unchanged computed math radii pass and new expressions still fail off-scale', () => {
  for (const borderRadius of ['calc(50% - 2px)', 'min(8px, 10%)', 'clamp(2px, calc(10% / 2), 8px)', 'calc(50% - 2px) 8px / max(4px, 5%)']) {
    const base = snapshot([element({ borderRadius })]);
    assert.equal(evaluate({ base, head: structuredClone(base), ui: { scaleMargin: 0 } }).pass, true, borderRadius);
  }
  const base = snapshot([element({ borderRadius: 'calc(50% - 2px)' }), element({ borderRadius: '8px' }), element({ borderRadius: '4px' })]);
  const head = snapshot([element({ borderRadius: 'calc(50% - 3px)' })]);
  const result = evaluate({ base, head });
  assert.deepEqual(rulesOf(result), ['off-scale']);
  assert.equal(result.failures[0].value, 'calc(50% - 3px)');
  assert.deepEqual(result.failures[0].nearest, ['4px', '8px', 'calc(50% - 2px)']);
  const equivalent = snapshot([element({ borderRadius: 'calc(50% - 2px) calc(50% - 2px) / calc(50% - 2px)' })]);
  assert.equal(evaluate({ base, head: equivalent }).pass, true);
  for (const borderRadius of ['calc(50% - 2px', 'calc()', '4px / / 8px', 'nonsense']) {
    assert.deepEqual(rulesOf(evaluate({ base, head: snapshot([element({ borderRadius })]) })), ['snapshot-invalid']);
  }
});

test('allowances are reasoned, scoped and reported; unused allowances cannot mask growth', async () => {
  const result = await check.runFixture(await load('pass-allowed.json'));
  assert.deepEqual(result.allowed, [{ property: 'fontSize', value: '20px', reason: 'Approved section heading token' }]);
  const fixture = await load('fail-growth.json');
  fixture.ui = { scaleAllow: [{ property: 'fontSize', value: '99px', reason: 'Unused' }] };
  const unused = await check.runFixture(fixture);
  assert.deepEqual(unused.allowed, []);
  assert.deepEqual(rulesOf(unused), ['scale-growth']);
  fixture.ui.scaleAllow[0].value = '18px';
  assert.equal((await check.runFixture(fixture)).pass, true);
  const base = snapshot([element()]);
  const head = snapshot([element({ fontSize: '20px', borderRadius: '20px' })]);
  const scoped = evaluate({ base, head, ui: { scaleAllow: result.allowed } });
  assert.deepEqual(scoped.failures.map((entry) => entry.property), ['borderRadius']);
});

test('a scale margin cannot be loosened and malformed allowances are rejected', () => {
  const snapshots = { base: snapshot([element()]), head: snapshot([element()]) };
  for (const scaleMargin of [2, -1, 0.5, '0', null, NaN]) assert.throws(() => evaluate({ ...snapshots, ui: { scaleMargin } }), /scaleMargin/);
  for (const scaleAllow of [null, {}, [{ property: 'gap', value: '8px', reason: 'Not scored' }], [{ property: 'fontSize', value: '20px', reason: ' ' }], [{ property: 'fontSize', reason: 'Missing value' }]]) {
    assert.throws(() => evaluate({ ...snapshots, ui: { scaleAllow } }), TypeError);
  }
});

test('missing fields, empty evidence and malformed colours fail rather than passing an empty scale', () => {
  const valid = snapshot([element()]);
  for (const head of [null, {}, snapshot([]), { components: [], page: { elements: [element()] } }, snapshot([element({ color: 'unknown' })]), snapshot([element({ fontSize: undefined })])]) {
    assert.deepEqual(rulesOf(evaluate({ base: valid, head })), ['snapshot-invalid']);
  }
  assert.deepEqual(rulesOf(evaluate({ base: { components: [], page: { elements: [] } }, head: valid })), ['snapshot-invalid']);
  assert.deepEqual(rulesOf(evaluate({ base: valid, head: snapshot([element({ color: 'rgba(1, 2, 3, .)' })]) })), ['snapshot-invalid']);
});

test('run reads item evidence, reports repository design rules without parsing them and rejects missing or escaped files', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'mend-token-scale-'));
  try {
    const item = { id: 'item-1' };
    const missing = await check.run({ repo, item });
    assert.deepEqual(rulesOf(missing), ['snapshot-missing']);
    assert.equal(missing.failures.length, 2);
    const directory = path.join(repo, '.mend', 'evidence', item.id);
    await fs.mkdir(directory, { recursive: true });
    const fixture = await load('pass-allowed.json');
    for (const version of ['base', 'head']) await fs.writeFile(path.join(directory, `ui-scale-${version}.json`), JSON.stringify(fixture[version]));
    const context = { repo, item, config: { ui: fixture.ui } };
    assert.equal((await check.run(context)).designRules, null);
    await fs.writeFile(path.join(repo, 'DESIGN.md'), 'Synthetic design rules, not JSON.');
    const rootRules = await check.run(context);
    assert.equal(rootRules.pass, true);
    assert.equal(rootRules.designRules, 'DESIGN.md');
    assert.deepEqual(rootRules.allowed, fixture.ui.scaleAllow);
    await fs.mkdir(path.join(repo, 'docs'));
    await fs.writeFile(path.join(repo, 'docs', 'visual.md'), 'Synthetic custom rules.');
    const configured = { ...context, config: { ui: { ...fixture.ui, designRules: 'docs/visual.md' } } };
    assert.equal((await check.run(configured)).designRules, path.join('docs', 'visual.md'));
    for (const designRules of ['missing.md', '../outside.md', '', null, path.join(repo, 'DESIGN.md')]) {
      assert.deepEqual(rulesOf(await check.run({ ...context, config: { ui: { ...fixture.ui, designRules } } })), ['design-rules-invalid']);
    }
    assert.deepEqual(rulesOf(await check.run({ ...context, item: { id: '../escape' } })), ['snapshot-missing']);
    await fs.writeFile(path.join(directory, 'ui-scale-head.json'), '{broken');
    assert.deepEqual(rulesOf(await check.run(context)), ['snapshot-invalid']);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
