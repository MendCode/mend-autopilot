import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import uiRubric, {
  DEFAULT_RULES,
  collectScale,
  collectSnapshot,
  contrastRatio,
  foreignStopwordShare,
  parseColor,
  readComponents,
  readScale,
  resolveRules,
  scoreSnapshot,
  wordsOf,
} from './ui-rubric.mjs';
import { evaluate as evaluateScale } from './token-scale.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'ui-rubric');
const NOW = '2026-11-03T12:00:00Z';
const BASE_RULES = { ...DEFAULT_RULES, locale: 'es', now: NOW };

const text = (value, extra = {}) => ({ text: value, fontPx: 13, color: '#e8ecf2', background: '#22262e', clipped: false, ...extra });
const component = (extra = {}) => ({ id: 'tile', overflow: false, texts: [text('Caudal')], numbers: [{ text: '38 l/s', fontPx: 32 }], timestamps: [], ...extra });
const rulesOf = (result) => [...new Set(result.failures.map((failure) => failure.rule))].sort();

test('empty component evidence cannot pass or be captured', async () => {
  assert.equal(scoreSnapshot([], BASE_RULES).pass, false);
  await assert.rejects(collectSnapshot({ evaluate: async () => [] }, { selector: '.missing' }), /no components/);
});

async function loadFixture(name) {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, name), 'utf8'));
}

// ---------------------------------------------------------------------------
// Fixtures

test('every ui-rubric fixture fails exactly the rules it names and every pass fixture passes', async () => {
  const names = (await fs.readdir(FIXTURES)).filter((name) => name.endsWith('.json')).sort();
  assert.ok(names.some((name) => name.startsWith('pass-')) && names.some((name) => name.startsWith('fail-')));
  for (const name of names) {
    const fixture = await loadFixture(name);
    const result = await uiRubric.runFixture(fixture);
    if (name.startsWith('pass-')) assert.deepEqual(result.failures, [], name);
    else assert.deepEqual(rulesOf(result), [...fixture.expect].sort(), name);
  }
});

test('the verbose KPI card fails on words, hero numbers and locale with the measured values', async () => {
  const result = await uiRubric.runFixture(await loadFixture('fail-kpi-card-verbose.json'));
  const detail = Object.fromEntries(result.failures.map((failure) => [failure.rule, failure.detail]));
  assert.match(detail['max-words'], /^31 words, limit 12/);
  assert.match(detail['hero-numbers'], /^3 hero numbers/);
  assert.match(detail.locale, /^32% of words \(10\/31\)/);
});

test('every rule has a fixture that the rubric asserts fails', async () => {
  const names = (await fs.readdir(FIXTURES)).filter((name) => name.startsWith('fail-'));
  const covered = new Set();
  for (const name of names) for (const rule of (await loadFixture(name)).expect) covered.add(rule);
  for (const rule of ['max-words', 'hero-numbers', 'repeated-phrase', 'min-font', 'clipped', 'overflow', 'locale', 'contrast', 'stale-shown-as-stale']) {
    assert.ok(covered.has(rule), `no failing fixture for ${rule}`);
  }
});

// ---------------------------------------------------------------------------
// Word budget and hero numbers

test('wordsOf drops numbers and the short unit after them but keeps ordinary words', () => {
  assert.deepEqual(wordsOf('4.812 kWh producidos hoy'), ['producidos', 'hoy']);
  assert.deepEqual(wordsOf('+12 % vs. ayer'), ['vs', 'ayer']);
  assert.deepEqual(wordsOf('Presión 2,4 bar en línea norte'), ['presión', 'en', 'línea', 'norte']);
  assert.deepEqual(wordsOf('— · —'), []);
});

test('max-words passes at the limit and fails one word over', () => {
  const twelve = 'uno dos tres cuatro cinco seis siete ocho nueve diez once doce';
  assert.equal(scoreSnapshot([component({ texts: [text(twelve)] })], BASE_RULES).pass, true);
  const result = scoreSnapshot([component({ texts: [text(`${twelve} trece`)] })], BASE_RULES);
  assert.deepEqual(rulesOf(result), ['max-words']);
});

test('data text is excluded only from the word budget, including for old snapshots', () => {
  const own = 'alpha bravo charlie delta echo foxtrot';
  const data = 'golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu';
  const marked = component({ texts: [text(own), text(data, { data: true })] });
  assert.equal(scoreSnapshot([marked], BASE_RULES).pass, true);
  const legacy = component({ texts: [text(own), text(data)] });
  const result = scoreSnapshot([legacy], BASE_RULES);
  assert.equal(result.failures.find((failure) => failure.rule === 'max-words').detail, '26 words, limit 12 (numbers, units and data text excluded)');
  const lowContrast = component({ texts: [text(own), text(data, { data: true, color: '#22262e' })] });
  assert.deepEqual(rulesOf(scoreSnapshot([lowContrast], BASE_RULES)), ['contrast']);
  const foreign = component({ texts: [text('Caudal'), text('the and the and', { data: true })] });
  assert.deepEqual(rulesOf(scoreSnapshot([foreign], BASE_RULES)), ['locale']);
});

test('hero-numbers counts numbers at least twice the median font and allows one', () => {
  const one = component({ texts: [text('Caudal'), text('Promedio')], numbers: [{ text: '38', fontPx: 48 }, { text: '+2 %', fontPx: 14 }] });
  assert.equal(scoreSnapshot([one], BASE_RULES).pass, true);
  const two = component({ texts: [text('Caudal'), text('Promedio')], numbers: [{ text: '38', fontPx: 48 }, { text: '41', fontPx: 48 }] });
  assert.deepEqual(rulesOf(scoreSnapshot([two], BASE_RULES)), ['hero-numbers']);
});

// ---------------------------------------------------------------------------
// Repeated phrase, size, clipping, overflow

test('a three-word phrase may appear in two components but not three', () => {
  const tile = (id) => component({ id, texts: [text('Caudal'), text('Datos sujetos a revisión')] });
  assert.equal(scoreSnapshot([tile('a'), tile('b')], BASE_RULES).pass, true);
  const result = scoreSnapshot([tile('a'), tile('b'), tile('c')], BASE_RULES);
  assert.deepEqual(rulesOf(result), ['repeated-phrase']);
  assert.equal(result.failures.length, 1, 'one report per set of components, not one per overlapping phrase');
  assert.equal(result.failures[0].target, 'a, b, c');
});

test('min-font fails under 11px and passes at exactly 11px, for texts and numbers', () => {
  assert.equal(scoreSnapshot([component({ texts: [text('Caudal', { fontPx: 11 })] })], BASE_RULES).pass, true);
  assert.deepEqual(rulesOf(scoreSnapshot([component({ texts: [text('Caudal', { fontPx: 10.5 })] })], BASE_RULES)), ['min-font']);
  assert.deepEqual(rulesOf(scoreSnapshot([component({ numbers: [{ text: '38', fontPx: 9 }] })], BASE_RULES)), ['min-font']);
});

test('clipped and overflow fail when the snapshot says so and pass when they are allowed', () => {
  const clipped = component({ texts: [text('Estación Ladera Norte', { clipped: true })] });
  assert.deepEqual(rulesOf(scoreSnapshot([clipped], BASE_RULES)), ['clipped']);
  assert.equal(scoreSnapshot([clipped], { ...BASE_RULES, clipped: true }).pass, true);
  const spilled = component({ overflow: true });
  assert.deepEqual(rulesOf(scoreSnapshot([spilled], BASE_RULES)), ['overflow']);
  assert.equal(scoreSnapshot([spilled], { ...BASE_RULES, overflow: true }).pass, true);
});

// ---------------------------------------------------------------------------
// Locale

test('locale fails when no locale was recorded, with no default language', () => {
  const result = scoreSnapshot([component()], { ...DEFAULT_RULES, now: NOW });
  assert.deepEqual(rulesOf(result), ['locale']);
  assert.match(result.failures[0].detail, /no repo locale recorded/);
});

test('locale detection flags another language above 20% of words and accepts region tags', () => {
  const english = component({ texts: [text('Flow of the north line')] });
  assert.deepEqual(rulesOf(scoreSnapshot([english], BASE_RULES)), ['locale']);
  assert.equal(scoreSnapshot([english], { ...BASE_RULES, locale: 'en-US' }).pass, true);
  const spanish = component({ texts: [text('Caudal de la línea norte')] });
  assert.equal(scoreSnapshot([spanish], { ...BASE_RULES, locale: 'es_PA' }).pass, true);
  assert.deepEqual(rulesOf(scoreSnapshot([spanish], { ...BASE_RULES, locale: 'en' })), ['locale']);
});

test('foreignStopwordShare ignores words that are stopwords in the repo language too', () => {
  const measure = foreignStopwordShare(['a', 'de', 'the', 'caudal'], 'es');
  assert.deepEqual(measure, { foreign: 1, words: 4, share: 0.25 });
  assert.equal(foreignStopwordShare([], 'es').share, 0);
});

test('a short label with no stopwords passes locale; that case is left to the critique', () => {
  assert.equal(scoreSnapshot([component({ texts: [text('Flow rate')] })], BASE_RULES).pass, true);
});

// ---------------------------------------------------------------------------
// Contrast

test('parseColor reads hex and rgb forms and rejects others', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(parseColor('hsl(0 0% 0%)'), null);
  assert.equal(parseColor(undefined), null);
});

test('contrastRatio matches the WCAG extremes and returns null for a see-through background', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  assert.equal(contrastRatio('#000', 'rgba(255,255,255,0.5)'), null);
  assert.ok(contrastRatio('rgba(0,0,0,0.5)', '#ffffff') < contrastRatio('#000000', '#ffffff'));
});

test('contrast uses 4.5:1 for body text and 3:1 from 18px, with unreadable colours skipped', () => {
  const muted = '#707a8c';
  assert.deepEqual(rulesOf(scoreSnapshot([component({ texts: [text('Resumen', { color: muted, fontPx: 17 })] })], BASE_RULES)), ['contrast']);
  assert.equal(scoreSnapshot([component({ texts: [text('Resumen', { color: muted, fontPx: 18 })] })], BASE_RULES).pass, true);
  assert.equal(scoreSnapshot([component({ texts: [text('Resumen', { color: 'hsl(0 0% 50%)' })] })], BASE_RULES).pass, true);
});

// ---------------------------------------------------------------------------
// Stale values

test('a fresh value needs no marker; a stale one fails with no marker or a dash and passes with a label', () => {
  const stamp = (value, staleMarker) => component({ timestamps: [{ value, freshnessWindowMs: 900000, staleMarker }] });
  assert.equal(scoreSnapshot([stamp('2026-11-03T11:50:00Z', null)], BASE_RULES).pass, true);
  assert.equal(scoreSnapshot([stamp('2026-11-03T11:45:00Z', null)], BASE_RULES).pass, true, 'exactly at the window is still fresh');
  for (const marker of [null, '', '—', '--', 'n/a', '…']) {
    assert.deepEqual(rulesOf(scoreSnapshot([stamp('2026-11-03T10:00:00Z', marker)], BASE_RULES)), ['stale-shown-as-stale'], String(marker));
  }
  assert.equal(scoreSnapshot([stamp('2026-11-03T10:00:00Z', 'Hace 2 h')], BASE_RULES).pass, true);
});

test('an unreadable timestamp fails, epoch milliseconds are accepted, and the rule can be turned off', () => {
  const unreadable = component({ timestamps: [{ value: 'yesterday-ish', freshnessWindowMs: 900000, staleMarker: null }] });
  assert.deepEqual(rulesOf(scoreSnapshot([unreadable], BASE_RULES)), ['stale-shown-as-stale']);
  assert.equal(scoreSnapshot([unreadable], { ...BASE_RULES, staleShownAsStale: false }).pass, true);
  const epoch = component({ timestamps: [{ value: Date.parse(NOW) - 60000, freshnessWindowMs: 900000, staleMarker: null }] });
  assert.equal(scoreSnapshot([epoch], BASE_RULES).pass, true);
});

// ---------------------------------------------------------------------------
// Rules and overrides

test('resolveRules records each override and whether it loosens the rubric', () => {
  const { rules, overrides } = resolveRules({ maxWords: 20, minFontPx: 12, clipped: true, locale: 'es', minContrast: 4.5 });
  assert.equal(rules.maxWords, 20);
  const byKey = Object.fromEntries(overrides.map((entry) => [entry.key, entry.loosens]));
  assert.deepEqual(byKey, { maxWords: true, minFontPx: false, clipped: true, locale: false });
});

test('resolveRules rejects an unknown rule and scoreSnapshot rejects a non-array', () => {
  assert.throws(() => resolveRules({ maxWordz: 20 }), /\[UI-RUBRIC\]: unknown rule "maxWordz"/);
  assert.throws(() => scoreSnapshot({ id: 'tile' }, BASE_RULES), TypeError);
  assert.ok(Object.isFrozen(DEFAULT_RULES));
  assert.equal(DEFAULT_RULES.locale, null);
});

test('resolveRules reports configured data selectors without treating them as a scoring rule', () => {
  const { rules, overrides } = resolveRules({ dataSelectors: ['.data'] });
  assert.equal(rules.dataSelectors, undefined);
  assert.deepEqual(overrides, [{ key: 'dataSelectors', from: [], to: ['.data'], loosens: false }]);
  assert.throws(() => resolveRules({ dataSelectors: [' '] }), TypeError);
});

test('token-scale settings do not become unknown ui-rubric thresholds', () => {
  const { rules, overrides } = resolveRules({ scaleMargin: 0, scaleAllow: [{ property: 'fontSize', value: '20px', reason: 'Heading' }], designRules: 'DESIGN.md', locale: 'en' });
  assert.equal(rules.locale, 'en');
  assert.equal(rules.scaleMargin, undefined);
  assert.deepEqual(overrides.map((entry) => entry.key), ['locale']);
  assert.throws(() => resolveRules({ scaleMargn: 0 }), /unknown rule/);
});

// ---------------------------------------------------------------------------
// DOM reader

function fakeElement({ attrs = {}, style = {}, text = '', children = [], box = { x: 0, y: 0, width: 100, height: 20 }, scroll = null, hidden = false }) {
  const element = {
    attrs,
    computed: { display: hidden ? 'none' : 'block', visibility: 'visible', fontSize: '13px', color: 'rgb(232, 236, 242)', backgroundColor: 'rgba(0, 0, 0, 0)', overflowX: 'visible', overflowY: 'visible', textOverflow: 'clip', webkitLineClamp: 'none', ...style },
    children,
    parentElement: null,
    id: attrs.id ?? '',
    childNodes: [...(text ? [{ nodeType: 3, textContent: text }] : []), ...children.map((child) => ({ nodeType: 1, child }))],
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    matches: (selector) => selector === '.data' && (attrs.class ?? '').split(/\s+/).includes('data'),
    getBoundingClientRect: () => box,
    getClientRects: () => (hidden ? [] : [box]),
    checkVisibility(options) {
      assert.deepEqual(options, { opacityProperty: true, visibilityProperty: true });
      if (['hidden', 'collapse'].includes(this.computed.visibility)) return false;
      for (let node = this; node; node = node.parentElement) {
        const style = node.computed;
        if (style.display === 'none' || style.opacity === '0' || style.contentVisibility === 'hidden') return false;
      }
      return true;
    },
    scrollWidth: scroll?.scrollWidth ?? 100,
    clientWidth: scroll?.clientWidth ?? 100,
    scrollHeight: scroll?.scrollHeight ?? 20,
    clientHeight: scroll?.clientHeight ?? 20,
  };
  Object.defineProperty(element, 'textContent', { get: () => [text, ...children.map((child) => child.textContent)].join(' ').trim() });
  for (const child of children) child.parentElement = element;
  return element;
}

test('readComponents marks data on the element or an ancestor inside the component', () => {
  const own = 'alpha bravo charlie delta echo foxtrot';
  const data = 'golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu';
  const makeRoot = (attrs) => fakeElement({ text: own, children: [fakeElement({ attrs, children: [fakeElement({ text: data })] })] });
  for (const [attrs, options, expected] of [[{ 'data-mend-data': '' }, {}, true], [{ class: 'data' }, { dataSelectors: ['.data'] }, true], [{}, {}, false]]) {
    const root = makeRoot(attrs);
    const { doc, win } = fakePage([root]);
    const [snapshot] = readComponents('.tile', doc, win, options);
    assert.deepEqual(snapshot.texts.map((entry) => entry.data), [false, expected]);
    assert.equal(rulesOf(scoreSnapshot([snapshot], BASE_RULES)).includes('max-words'), !expected);
  }
  const selected = makeRoot({ class: 'data' });
  const selectedPage = fakePage([selected]);
  assert.equal(readComponents({ selector: '.tile', dataSelectors: ['.data'] }, selectedPage.doc, selectedPage.win)[0].texts[1].data, true);
  const root = fakeElement({ text: own });
  fakeElement({ attrs: { 'data-mend-data': '' }, children: [root] });
  const { doc, win } = fakePage([root]);
  assert.equal(readComponents('.tile', doc, win)[0].texts[0].data, false);
});

function fakePage(roots) {
  const doc = { querySelectorAll: () => roots };
  const win = { getComputedStyle: (element) => element.computed };
  return { doc, win };
}

test('readComponents turns a rendered component into texts, numbers, clipping, background and stale markers', () => {
  const title = fakeElement({ text: 'Estación Ladera Norte', style: { overflowX: 'hidden', textOverflow: 'ellipsis', fontSize: '14px' }, scroll: { scrollWidth: 180, clientWidth: 120 } });
  const value = fakeElement({ text: '38 l/s', style: { fontSize: '32px' } });
  const marker = fakeElement({ attrs: { 'data-mend-stale': '' }, text: 'Hace 2 h' });
  const stamp = fakeElement({ attrs: { 'data-mend-timestamp': '2026-11-03T10:00:00Z', 'data-mend-freshness-ms': '900000' }, children: [marker] });
  const hidden = fakeElement({ text: 'Texto oculto', hidden: true });
  const root = fakeElement({ attrs: { 'data-mend-component': 'station-tile' }, style: { backgroundColor: 'rgb(34, 38, 46)' }, box: { x: 10, y: 20, width: 160, height: 96 }, children: [title, value, stamp, hidden] });
  const { doc, win } = fakePage([root]);

  const [snapshot] = readComponents('.tile', doc, win);
  assert.equal(snapshot.id, 'station-tile');
  assert.deepEqual(snapshot.rect, { x: 10, y: 20, width: 160, height: 96 });
  assert.equal(snapshot.overflow, false);
  assert.deepEqual(snapshot.numbers, [{ text: '38 l/s', fontPx: 32 }]);
  const titleEntry = snapshot.texts.find((entry) => entry.text === 'Estación Ladera Norte');
  assert.equal(titleEntry.clipped, true);
  assert.equal(titleEntry.background, 'rgb(34, 38, 46)');
  assert.equal(titleEntry.fontPx, 14);
  assert.ok(!snapshot.texts.some((entry) => entry.text === 'Texto oculto'), 'hidden text is not read');
  assert.deepEqual(snapshot.timestamps, [{ value: '2026-11-03T10:00:00Z', freshnessWindowMs: 900000, staleMarker: 'Hace 2 h' }]);
});

test('readComponents falls back to the element id, then the selector index, and reports overflow', () => {
  const withId = fakeElement({ attrs: { id: 'flow' }, text: 'Caudal' });
  const anonymous = fakeElement({ text: 'Presión', scroll: { scrollWidth: 140, clientWidth: 100 } });
  const { doc, win } = fakePage([withId, anonymous]);
  const snapshots = readComponents('.tile', doc, win);
  assert.deepEqual(snapshots.map((entry) => entry.id), ['flow', '.tile[1]']);
  assert.equal(snapshots[1].overflow, true);
  assert.equal(snapshots[0].texts[0].background, 'rgb(255, 255, 255)', 'no opaque ancestor falls back to white');
});

test('a hidden stale marker does not count as shown', () => {
  const marker = fakeElement({ attrs: { 'data-mend-stale': '' }, text: 'Sin datos', hidden: true });
  const stamp = fakeElement({ attrs: { 'data-mend-timestamp': '2026-11-03T10:00:00Z', 'data-mend-freshness-ms': '900000' }, children: [marker] });
  const root = fakeElement({ attrs: { 'data-mend-component': 'tile' }, children: [stamp] });
  const { doc, win } = fakePage([root]);
  const snapshots = readComponents('.tile', doc, win);
  assert.equal(snapshots[0].timestamps[0].staleMarker, null);
  assert.deepEqual(rulesOf(scoreSnapshot(snapshots, BASE_RULES)), ['stale-shown-as-stale']);
});

test('collectSnapshot passes the selector and data selectors to page.evaluate and validates its inputs', async () => {
  const calls = [];
  const page = { evaluate: async (fn, options) => { calls.push([fn, options]); return [component()]; } };
  assert.deepEqual(await collectSnapshot(page, { selector: '[data-mend-component]' }), [component()]);
  assert.equal(calls[0][0], readComponents);
  assert.deepEqual(calls[0][1], { selector: '[data-mend-component]', dataSelectors: [] });
  await collectSnapshot(page, { selector: '.tile', dataSelectors: ['.data'] });
  assert.deepEqual(calls[1][1], { selector: '.tile', dataSelectors: ['.data'] });
  for (const dataSelectors of [null, ' .data', [1], [''], ['  ']]) {
    await assert.rejects(collectSnapshot(page, { selector: '.tile', dataSelectors }), { name: 'TypeError', message: /^\[UI-RUBRIC\]:/ });
  }
  await assert.rejects(collectSnapshot(null, { selector: '.tile' }), /needs a browser page/);
  await assert.rejects(collectSnapshot(page, { selector: ' ' }), /selector is required/);
  await assert.rejects(collectSnapshot({ evaluate: async () => null }, { selector: '.tile' }), /no component list/);
});

// Synthetic canvas pixels, not a claim of browser colour-conversion verification.
function scaleCanvas(pixels, fills = []) {
  return (tag) => {
    assert.equal(tag, 'canvas');
    const context = {
      clearRect() {},
      fillRect() { fills.push(this.fillStyle); },
      getImageData() {
        assert.ok(Object.hasOwn(pixels, this.fillStyle), `missing synthetic pixel for ${this.fillStyle}`);
        return { data: pixels[this.fillStyle] };
      },
    };
    return { getContext: (kind, options) => {
      assert.equal(kind, '2d');
      assert.equal(options.colorSpace, 'srgb');
      return context;
    } };
  };
}

test('collectScale reads visible component and whole-page styles using the DOM traversal', async () => {
  const style = { opacity: '1', fontWeight: '400', lineHeight: '20px', borderRadius: '4px', paddingTop: '4px', paddingRight: '8px', paddingBottom: '4px', paddingLeft: '8px', gap: '8px' };
  const child = fakeElement({ style: { ...style, color: 'rgb(10 20 30 / 50%)', backgroundColor: 'transparent' } });
  const hiddenChild = fakeElement({ style });
  const hidden = fakeElement({ hidden: true, style, children: [hiddenChild] });
  const invisible = fakeElement({ style: { ...style, visibility: 'hidden' } });
  const collapsed = fakeElement({ style: { ...style, visibility: 'collapse' } });
  const transparentChild = fakeElement({ style });
  const transparent = fakeElement({ style: { ...style, opacity: '0' }, children: [transparentChild] });
  const root = fakeElement({ attrs: { 'data-mend-component': 'card' }, style, children: [child, hidden, invisible, collapsed, transparent] });
  const outside = fakeElement({ attrs: { id: 'outside' }, style: { ...style, fontSize: '24px' } });
  const anonymous = fakeElement({ style });
  const all = [root, child, hidden, hiddenChild, invisible, collapsed, transparent, transparentChild, outside, anonymous];
  const doc = {
    querySelectorAll: (selector) => selector === '*' ? all : [root, hidden, outside, anonymous],
    createElement: scaleCanvas({ 'rgb(232, 236, 242)': [232, 236, 242, 255], 'rgba(0, 0, 0, 0)': [0, 0, 0, 0], 'rgb(10 20 30 / 50%)': [10, 20, 30, 128] }),
  };
  const win = { innerWidth: 1024, innerHeight: 768, getComputedStyle: (element) => element.computed };
  const calls = [];
  const page = { evaluate: async (fn, options) => { calls.push([fn, options]); return fn(options, doc, win); } };
  const result = await collectScale(page, { selector: '.card' });
  assert.equal(calls[0][0], readScale);
  assert.deepEqual(calls[0][1], { selector: '.card' });
  assert.deepEqual(result.components.map((entry) => entry.id), ['card', 'outside', '.card[3]']);
  assert.equal(result.components[0].elements.length, 2);
  assert.equal(result.page.elements.length, 4);
  assert.equal(result.page.elements[2].fontSize, '24px');
  assert.deepEqual(result.components[0].elements[1], {
    fontSize: '13px', fontWeight: '400', lineHeight: '20px', borderRadius: '4px', color: 'rgba(10, 20, 30, 0.501961)', backgroundColor: 'rgba(0, 0, 0, 0)', paddingTop: '4px', paddingRight: '8px', paddingBottom: '4px', paddingLeft: '8px', gap: '8px',
  });
  await assert.rejects(collectScale(null, { selector: '.card' }), /needs a browser page/);
  await assert.rejects(collectScale(page, { selector: ' ' }), /selector is required/);
  for (const value of [null, [], { components: [], page: { elements: [] } }]) {
    await assert.rejects(collectScale({ evaluate: async () => value }, { selector: '.card' }), /no scale snapshot/);
  }
});

test('readScale converts modern computed colours through an sRGB canvas', () => {
  const root = fakeElement({ style: { color: 'color(display-p3 1 0 0)', backgroundColor: 'rgb(100% 0% 0% / 25%)' } });
  const fills = [];
  const doc = { querySelectorAll: () => [root], createElement: scaleCanvas({ 'color(display-p3 1 0 0)': [255, 0, 0, 255], 'rgb(100% 0% 0% / 25%)': [255, 0, 0, 64] }, fills) };
  const result = readScale({ selector: '.card' }, doc, { innerWidth: 1024, innerHeight: 768, getComputedStyle: (element) => element.computed });
  assert.equal(result.components[0].elements[0].color, 'rgb(255, 0, 0)');
  assert.equal(result.components[0].elements[0].backgroundColor, 'rgba(255, 0, 0, 0.25098)');
  assert.deepEqual(fills, ['color(display-p3 1 0 0)', 'rgb(100% 0% 0% / 25%)', 'color(display-p3 1 0 0)', 'rgb(100% 0% 0% / 25%)']);
});

test('equivalent translucent rgb and modern colours use the same conversion and do not create off-scale tokens', () => {
  const fills = [];
  const pixels = {
    'rgb(255 0 0 / 50%)': [255, 0, 0, 128],
    'color(srgb 1 0 0 / 0.5)': [255, 0, 0, 128],
    'rgba(12.5, 25.25, 50.75, 0.25)': [12, 24, 52, 64],
    'color(srgb 0.0490196078 0.0990196078 0.1990196078 / 0.25)': [12, 24, 52, 64],
  };
  const capture = (color, backgroundColor) => {
    const root = fakeElement({ attrs: { id: 'card' }, style: { fontWeight: '400', borderRadius: '4px', color, backgroundColor } });
    return readScale({ selector: '.card' }, { querySelectorAll: () => [root], createElement: scaleCanvas(pixels, fills) }, { innerWidth: 1024, innerHeight: 768, getComputedStyle: (node) => node.computed });
  };
  const base = capture('rgb(255 0 0 / 50%)', 'rgba(12.5, 25.25, 50.75, 0.25)');
  const head = capture('color(srgb 1 0 0 / 0.5)', 'color(srgb 0.0490196078 0.0990196078 0.1990196078 / 0.25)');
  assert.deepEqual(head, base);
  assert.equal(base.components[0].elements[0].color, 'rgba(255, 0, 0, 0.501961)');
  assert.equal(evaluateScale({ base, head, ui: { scaleMargin: 0 } }).pass, true);
  for (const syntax of Object.keys(pixels)) assert.ok(fills.includes(syntax), `${syntax} must use the canvas too`);
});

test('readScale excludes zero-area and overflow-clipped styles without discarding visible descendants', () => {
  const box = (x, y, width, height) => ({ x, y, width, height });
  const node = (id, options = {}) => fakeElement({ ...options, attrs: { id }, style: { fontSize: `${id.length + 10}px`, ...options.style } });
  const zeroWidthChild = node('visible-overflow', { box: box(5, 5, 20, 10) });
  const zeroWidth = node('zero-width', { box: box(0, 0, 0, 10), children: [zeroWidthChild] });
  const zeroHeight = node('zero-height', { box: box(0, 0, 10, 0) });
  const clippedChild = node('outside-scrollport', { box: box(150, 0, 10, 10) });
  const partialChild = node('partly-visible', { box: box(90, 0, 20, 10) });
  const ancestor = node('scrollport', { style: { overflowX: 'hidden', overflowY: 'hidden' }, children: [clippedChild, partialChild] });
  const root = node('root', { children: [zeroWidth, zeroHeight, ancestor] });
  const walk = (element) => [element, ...element.children.flatMap(walk)];
  const all = walk(root);
  const result = readScale({ selector: '.all' }, {
    querySelectorAll: () => all,
    createElement: scaleCanvas({ 'rgb(232, 236, 242)': [232, 236, 242, 255], 'rgba(0, 0, 0, 0)': [0, 0, 0, 0] }),
  }, { innerWidth: 1024, innerHeight: 768, getComputedStyle: (element) => element.computed });
  const visible = [root, zeroWidthChild, ancestor, partialChild];
  assert.deepEqual(result.page.elements.map((entry) => entry.fontSize), visible.map((entry) => entry.computed.fontSize));
  assert.deepEqual(result.components.find((entry) => entry.id === 'zero-width').elements.map((entry) => entry.fontSize), [zeroWidthChild.computed.fontSize]);
  assert.ok(!result.components.some((entry) => ['zero-height', 'outside-scrollport'].includes(entry.id)));
});

test('collectScale colours match reasoned translucent allowances for both colour properties', async () => {
  const pixels = {
    'rgb(0, 0, 0)': [0, 0, 0, 255],
    'rgba(255, 0, 0, 0.5)': [255, 0, 0, 128],
    'rgba(12.5, 25.25, 50.75, 0.25)': [12, 24, 52, 64],
  };
  const capture = async (color, backgroundColor) => {
    const root = fakeElement({ attrs: { id: 'card' }, style: { fontWeight: '400', borderRadius: '4px', color, backgroundColor } });
    const doc = { querySelectorAll: () => [root], createElement: scaleCanvas(pixels) };
    return collectScale({ evaluate: async (fn, options) => fn(options, doc, { innerWidth: 1024, innerHeight: 768, getComputedStyle: (node) => node.computed }) }, { selector: '.card' });
  };
  const base = await capture('rgb(0, 0, 0)', 'rgb(0, 0, 0)');
  const head = await capture('rgba(255, 0, 0, 0.5)', 'rgba(12.5, 25.25, 50.75, 0.25)');
  assert.deepEqual(evaluateScale({ base, head }).failures.map((failure) => failure.property), ['color', 'backgroundColor']);
  const scaleAllow = [
    { property: 'color', value: 'rgba(255, 0, 0, 0.5)', reason: 'Approved warning foreground' },
    { property: 'backgroundColor', value: 'rgba(12.5, 25.25, 50.75, 0.25)', reason: 'Approved overlay tint' },
  ];
  // Keep the original tokens on the head page so both new tokens also exercise growth.
  head.page.elements.push(...base.page.elements);
  const result = evaluateScale({ base, head, ui: { scaleMargin: 0, scaleAllow } });
  assert.equal(result.pass, true);
  assert.deepEqual(result.allowed, [
    { ...scaleAllow[0], value: 'rgba(255, 0, 0, 0.501961)' },
    { ...scaleAllow[1], value: 'rgba(12, 24, 52, 0.25098)' },
  ]);
  assert.equal(evaluateScale({ base, head, ui: { scaleMargin: 0, scaleAllow: result.allowed } }).pass, true, 'canonicalization is idempotent');
  const wrong = evaluateScale({ base, head, ui: { scaleAllow: [{ ...scaleAllow[0], value: 'rgba(0, 255, 0, 0.5)' }, scaleAllow[1]] } });
  assert.deepEqual(wrong.failures.map((failure) => [failure.rule, failure.property]), [['off-scale', 'color']]);
  assert.deepEqual(wrong.allowed, [result.allowed[1]]);
});

test('unchanged pages with circle, ellipse, polygon and rounded inset decorations remain capturable', async () => {
  const style = { fontWeight: '400', borderRadius: '4px' };
  const root = fakeElement({ attrs: { id: 'card' }, style });
  const shapes = ['circle(50%)', 'ellipse(40% 30% at center)', 'polygon(0% 0%, 100% 0%, 50% 100%)', 'inset(0px round 20px)', 'inset(0px round 20px 10px / 15px 5px)'];
  const decorations = shapes.map((clipPath, index) => fakeElement({ attrs: { id: `decoration-${index}` }, style: { ...style, clipPath }, box: { x: 200, y: index * 100, width: 100, height: 100 } }));
  const doc = {
    querySelectorAll: (selector) => selector === '*' ? [root, ...decorations] : [root],
    createElement: scaleCanvas({ 'rgb(232, 236, 242)': [232, 236, 242, 255], 'rgba(0, 0, 0, 0)': [0, 0, 0, 0] }),
  };
  const page = { evaluate: async (fn, options) => fn(options, doc, { innerWidth: 1024, innerHeight: 768, getComputedStyle: (node) => node.computed }) };
  const base = await collectScale(page, { selector: '.card' });
  const head = await collectScale(page, { selector: '.card' });
  assert.equal(base.page.elements.length, 6, 'existing decorations outside the edited component remain in the page scale');
  assert.equal(base.components.length, 1);
  assert.deepEqual(head, base);
  assert.equal(evaluateScale({ base, head, ui: { scaleMargin: 0 } }).pass, true);
});

test('readScale obeys browser visibility even when computed styles and rectangles look visible', () => {
  const root = fakeElement({ attrs: { id: 'card' } });
  const rejected = fakeElement({ style: { fontSize: '99px' } });
  let calls = 0;
  rejected.checkVisibility = (options) => {
    assert.deepEqual(options, { opacityProperty: true, visibilityProperty: true });
    calls += 1;
    return false;
  };
  const result = readScale({ selector: '.card' }, {
    querySelectorAll: () => [root, rejected],
    createElement: scaleCanvas({ 'rgb(232, 236, 242)': [232, 236, 242, 255], 'rgba(0, 0, 0, 0)': [0, 0, 0, 0] }),
  }, { innerWidth: 100, innerHeight: 100, getComputedStyle: (node) => node.computed });
  assert.equal(calls, 2, 'both component and page traversal consult the browser');
  assert.deepEqual(result.components.map((entry) => entry.id), ['card']);
  assert.deepEqual(result.page.elements.map((entry) => entry.fontSize), ['13px']);
});

test('readScale requires positive bounding area inside the viewport on every edge', () => {
  const cases = [
    ['inside', 10, 10, 10, 10, true],
    ['left-outside', -20, 10, 10, 10, false],
    ['right-outside', 110, 10, 10, 10, false],
    ['top-outside', 10, -20, 10, 10, false],
    ['bottom-outside', 10, 90, 10, 10, false],
    ['left-touching', -10, 10, 10, 10, false],
    ['right-touching', 100, 10, 10, 10, false],
    ['top-touching', 10, -10, 10, 10, false],
    ['bottom-touching', 10, 80, 10, 10, false],
    ['left-partial', -9.5, 10, 10, 10, true],
    ['right-partial', 99.5, 10, 10, 10, true],
    ['top-partial', 10, -9.5, 10, 10, true],
    ['bottom-partial', 10, 79.5, 10, 10, true],
    ['zero-width', 10, 10, 0, 10, false],
    ['zero-height', 10, 10, 10, 0, false],
  ];
  const elements = cases.map(([id, x, y, width, height], index) => fakeElement({ attrs: { id }, box: { x, y, width, height }, style: { fontSize: `${index + 10}px` } }));
  const result = readScale({ selector: '.all' }, {
    querySelectorAll: () => elements,
    createElement: scaleCanvas({ 'rgb(232, 236, 242)': [232, 236, 242, 255], 'rgba(0, 0, 0, 0)': [0, 0, 0, 0] }),
  }, { innerWidth: 100, innerHeight: 80, getComputedStyle: (node) => node.computed });
  assert.deepEqual(result.components.map((entry) => entry.id), cases.filter((entry) => entry[5]).map((entry) => entry[0]));
  assert.deepEqual(result.page.elements.map((entry) => entry.fontSize), elements.filter((_, index) => cases[index][5]).map((element) => element.computed.fontSize));
});

test('readScale clips each overflow axis through ancestors outside the selector', () => {
  for (const property of ['overflowX', 'overflowY']) {
    for (const value of ['hidden', 'clip', 'visible', 'auto', 'scroll']) {
      const inside = fakeElement({ attrs: { id: 'inside' }, box: { x: 25, y: 25, width: 5, height: 5 } });
      const partial = fakeElement({ attrs: { id: 'partial' }, box: { x: 35, y: 35, width: 10, height: 10 } });
      const touching = fakeElement({ attrs: { id: 'touching' }, box: { x: 40, y: 25, width: 5, height: 5 } });
      const outside = fakeElement({ attrs: { id: 'outside' }, box: { x: 25, y: 50, width: 5, height: 5 } });
      const elements = [inside, partial, touching, outside];
      const middle = fakeElement({ children: elements });
      fakeElement({ style: { [property]: value }, box: { x: 20, y: 20, width: 20, height: 20 }, children: [middle] });
      const result = readScale({ selector: '.all' }, {
        querySelectorAll: () => elements,
        createElement: scaleCanvas({ 'rgb(232, 236, 242)': [232, 236, 242, 255], 'rgba(0, 0, 0, 0)': [0, 0, 0, 0] }),
      }, { innerWidth: 100, innerHeight: 100, getComputedStyle: (node) => node.computed });
      const expected = value === 'visible' ? elements.map((element) => element.id)
        : property === 'overflowX' ? ['inside', 'partial', 'outside'] : ['inside', 'partial', 'touching'];
      assert.deepEqual(result.components.map((entry) => entry.id), expected, `${property}: ${value}`);
      assert.deepEqual(result.page.elements, result.components.flatMap((entry) => entry.elements));
    }
  }
});

test('readScale intersects nested clipping regions cumulatively', () => {
  const child = fakeElement({ attrs: { id: 'child' }, box: { x: 0, y: 10, width: 100, height: 10 } });
  const inner = fakeElement({ style: { overflowX: 'scroll' }, box: { x: 0, y: 0, width: 40, height: 40 }, children: [child] });
  fakeElement({ style: { overflowX: 'auto' }, box: { x: 60, y: 0, width: 40, height: 40 }, children: [inner] });
  const result = readScale({ selector: '.child' }, {
    querySelectorAll: () => [child],
    createElement: scaleCanvas({ 'rgb(232, 236, 242)': [232, 236, 242, 255], 'rgba(0, 0, 0, 0)': [0, 0, 0, 0] }),
  }, { innerWidth: 100, innerHeight: 100, getComputedStyle: (node) => node.computed });
  assert.deepEqual(result.components, []);
  assert.deepEqual(result.page.elements, []);
});

test('readScale counts clip paths and masks without parsing them or injecting DOM probes', () => {
  const styles = [
    { clipPath: 'circle(0px)' },
    { clipPath: 'ellipse(0px 10px)' },
    { clipPath: 'inset(50% round 5px)' },
    { clipPath: 'polygon(0px 0px, 10px 0px, 20px 0px)' },
    { clipPath: 'polygon(evenodd, 0px 0px, 100px 100px, 0px 100px, 100px 0px)' },
    { clipPath: 'circle(calc(50% - 2px) at center)' },
    { clipPath: 'url(#clip)' },
    { clipPath: 'path("M0 0 H100 V100 H0 Z")' },
    { mask: 'url(#mask)' },
    { maskImage: 'linear-gradient(transparent, transparent)' },
    { webkitMaskImage: 'url("mask.svg")' },
  ];
  for (const style of styles) {
    const child = fakeElement({ style: { fontSize: '99px' }, box: { x: 0, y: 0, width: 2, height: 2 } });
    const root = fakeElement({ attrs: { id: 'decoration' }, style, children: [child] });
    const result = readScale({ selector: '.decoration' }, {
      querySelectorAll: (selector) => selector === '*' ? [root, child] : [root],
      // Only a detached colour canvas is permitted; no wrappers or hit targets.
      createElement: scaleCanvas({ 'rgb(232, 236, 242)': [232, 236, 242, 255], 'rgba(0, 0, 0, 0)': [0, 0, 0, 0] }),
    }, { innerWidth: 100, innerHeight: 100, getComputedStyle: (node) => node.computed });
    assert.deepEqual(result.page.elements.map((entry) => entry.fontSize), ['13px', '99px'], JSON.stringify(style));
    assert.deepEqual(result.components[0].elements, result.page.elements);
  }
});

// ---------------------------------------------------------------------------
// Check module

test('run fails with snapshot-missing when the evidence file is absent and scores it when present', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'mend-ui-rubric-'));
  try {
    const missing = await uiRubric.run({ repo, item: { id: 'item-1' }, config: { ui: { locale: 'es' } } });
    assert.deepEqual(rulesOf(missing), ['snapshot-missing']);

    const dir = path.join(repo, '.mend', 'evidence', 'item-1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'ui-snapshot.json'), JSON.stringify({ components: [component({ overflow: true })] }));
    const scored = await uiRubric.run({ repo, item: { id: 'item-1' }, config: { ui: { locale: 'es', minFontPx: 10 } } });
    assert.deepEqual(rulesOf(scored), ['overflow']);
    assert.deepEqual(scored.overrides.map((entry) => [entry.key, entry.loosens]), [['locale', false], ['minFontPx', true]]);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
