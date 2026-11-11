// Executable UI rubric (G3) over component snapshots taken from the repo's own running page.
// scoreSnapshot is pure; collectSnapshot is a thin DOM reader that runs inside an existing browser page.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { STOPWORDS, foreignStopwordShare, primaryLanguage, wordsOf } from '../../../checks/text-locale.mjs';

export const DEFAULT_RULES = Object.freeze({
  locale: null,
  maxWords: 12,
  maxHeroNumbers: 1,
  heroFontRatio: 2,
  repeatedPhraseWords: 3,
  repeatedPhraseMaxComponents: 2,
  minFontPx: 11,
  minContrast: 4.5,
  minContrastLarge: 3,
  largeTextPx: 18,
  foreignStopwordRatio: 0.2,
  clipped: false,
  overflow: false,
  staleShownAsStale: true,
  layoutTolerance: 0.08,
  now: null,
});

// Which direction of change makes a rule easier to pass; such overrides need a gate-loosening countersign.
const LOOSER_WHEN = {
  maxWords: 'higher',
  maxHeroNumbers: 'higher',
  heroFontRatio: 'higher',
  repeatedPhraseWords: 'higher',
  repeatedPhraseMaxComponents: 'higher',
  minFontPx: 'lower',
  minContrast: 'lower',
  minContrastLarge: 'lower',
  largeTextPx: 'lower',
  foreignStopwordRatio: 'higher',
  clipped: 'true',
  overflow: 'true',
  staleShownAsStale: 'false',
  layoutTolerance: 'higher',
};

export { STOPWORDS, foreignStopwordShare, wordsOf };

const DASH_LIKE = /^(?:[-‐‑‒–—―−]+|n\/?a|null|undefined|\.{2,}|…)$/i;
const EVIDENCE_DIR = path.join('.mend', 'evidence');
const SNAPSHOT_FILE = 'ui-snapshot.json';

// ---------------------------------------------------------------------------
// Rules

export function resolveRules(overrides = {}) {
  const rules = { ...DEFAULT_RULES };
  const applied = [];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    // These settings belong to token-scale, which validates and reports them.
    if (['scaleMargin', 'scaleAllow', 'designRules'].includes(key)) continue;
    if (key === 'dataSelectors') {
      validateDataSelectors(value);
      if (value.length) applied.push({ key, from: [], to: value, loosens: false });
      continue;
    }
    if (!(key in DEFAULT_RULES)) throw new TypeError(`[UI-RUBRIC]: unknown rule "${key}"`);
    const from = DEFAULT_RULES[key];
    if (value === from) continue;
    const direction = LOOSER_WHEN[key];
    const loosens =
      direction === 'higher' ? value > from : direction === 'lower' ? value < from : direction === 'true' ? value === true : direction === 'false' ? value === false : false;
    rules[key] = value;
    applied.push({ key, from, to: value, loosens });
  }
  return { rules, overrides: applied };
}

function validateDataSelectors(value) {
  if (!Array.isArray(value) || value.some((selector) => typeof selector !== 'string' || selector.trim() === '')) {
    throw new TypeError('[UI-RUBRIC]: dataSelectors must be an array of non-empty strings');
  }
}

// ---------------------------------------------------------------------------
// Text measures

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// ---------------------------------------------------------------------------
// Contrast (WCAG relative luminance)

export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit) : hex[1].match(/../g);
    return { r: parseInt(digits[0], 16), g: parseInt(digits[1], 16), b: parseInt(digits[2], 16), a: 1 };
  }
  const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (rgb) {
    const alphaText = rgb[4];
    const a = alphaText === undefined ? 1 : alphaText.endsWith('%') ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a };
  }
  return null;
}

function luminance({ r, g, b }) {
  const channel = (value) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio, or null when the background is not opaque or a color cannot be read. */
export function contrastRatio(foreground, background) {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg || bg.a < 1) return null;
  const blended = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
  const [light, dark] = [luminance(blended), luminance(bg)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

// ---------------------------------------------------------------------------
// Scoring

function timeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function phrasesOf(text, size) {
  const words = wordsOf(text);
  const phrases = [];
  for (let index = 0; index + size <= words.length; index += 1) phrases.push(words.slice(index, index + size).join(' '));
  return phrases;
}

function componentFailures(component, rules, now) {
  const failures = [];
  const target = component.id;
  const texts = component.texts ?? [];
  const numbers = component.numbers ?? [];
  const fail = (rule, detail) => failures.push({ target, rule, detail });

  const words = texts.flatMap((entry) => wordsOf(entry.text));
  const ownWords = texts.filter((entry) => entry.data !== true).flatMap((entry) => wordsOf(entry.text));
  if (ownWords.length > rules.maxWords) fail('max-words', `${ownWords.length} words, limit ${rules.maxWords} (numbers, units and data text excluded)`);

  // Heroes are measured against the body text, so several large numbers cannot raise their own bar.
  const sizesOf = (entries) => entries.map((entry) => entry.fontPx).filter((size) => Number.isFinite(size));
  const bodySizes = sizesOf(texts);
  const heroFloor = median(bodySizes.length > 0 ? bodySizes : sizesOf(numbers)) * rules.heroFontRatio;
  const heroes = numbers.filter((entry) => entry.fontPx >= heroFloor);
  if (heroes.length > rules.maxHeroNumbers) {
    fail('hero-numbers', `${heroes.length} hero numbers (${heroes.map((entry) => entry.text).join(', ')}), limit ${rules.maxHeroNumbers}`);
  }

  for (const entry of [...texts, ...numbers]) {
    if (Number.isFinite(entry.fontPx) && entry.fontPx < rules.minFontPx) fail('min-font', `"${entry.text}" at ${entry.fontPx}px, minimum ${rules.minFontPx}px`);
  }

  if (!rules.clipped) {
    for (const entry of texts) if (entry.clipped === true) fail('clipped', `"${entry.text}" is cut off`);
  }
  if (!rules.overflow && component.overflow === true) fail('overflow', 'content spills outside the component box');

  if (!primaryLanguage(rules.locale)) {
    fail('locale', 'no repo locale recorded; the verification skill records it, there is no default language');
  } else {
    const measure = foreignStopwordShare(words, rules.locale);
    if (measure.share > rules.foreignStopwordRatio) {
      fail('locale', `${Math.round(measure.share * 100)}% of words (${measure.foreign}/${measure.words}) are stopwords of a language other than ${rules.locale}`);
    }
  }

  for (const entry of texts) {
    if (entry.color === undefined || entry.background === undefined) continue;
    const ratio = contrastRatio(entry.color, entry.background);
    if (ratio === null) continue;
    const minimum = entry.fontPx >= rules.largeTextPx ? rules.minContrastLarge : rules.minContrast;
    if (ratio < minimum) fail('contrast', `"${entry.text}" contrast ${ratio.toFixed(2)}:1, minimum ${minimum}:1`);
  }

  if (rules.staleShownAsStale) {
    for (const stamp of component.timestamps ?? []) {
      const at = timeOf(stamp.value);
      if (at === null) {
        fail('stale-shown-as-stale', `timestamp "${stamp.value}" cannot be read, so freshness cannot be shown`);
        continue;
      }
      if (now - at <= stamp.freshnessWindowMs) continue;
      const marker = typeof stamp.staleMarker === 'string' ? stamp.staleMarker.trim() : '';
      if (marker === '' || DASH_LIKE.test(marker)) {
        const shown = marker === '' ? 'no marker' : `"${marker}"`;
        fail('stale-shown-as-stale', `value is ${Math.round((now - at) / 60000)} min old (window ${Math.round(stamp.freshnessWindowMs / 60000)} min) and shows ${shown}`);
      }
    }
  }
  return failures;
}

/** Pure scoring of component snapshots against the rubric rules. */
export function scoreSnapshot(snapshots, rules = DEFAULT_RULES) {
  if (!Array.isArray(snapshots)) throw new TypeError('[UI-RUBRIC]: snapshots must be an array of components');
  if (snapshots.length === 0) return { pass: false, failures: [{ target: '(item)', rule: 'snapshot-empty', detail: 'no components were captured' }] };
  const effective = { ...DEFAULT_RULES, ...rules };
  const now = timeOf(effective.now) ?? Date.now();
  const failures = snapshots.flatMap((component) => componentFailures(component, effective, now));

  const owners = new Map();
  for (const component of snapshots) {
    const phrases = new Set((component.texts ?? []).flatMap((entry) => phrasesOf(entry.text, effective.repeatedPhraseWords)));
    for (const phrase of phrases) {
      if (!owners.has(phrase)) owners.set(phrase, []);
      owners.get(phrase).push(component.id);
    }
  }
  const reported = new Set();
  for (const [phrase, ids] of owners) {
    if (ids.length <= effective.repeatedPhraseMaxComponents) continue;
    const key = ids.join('|');
    if (reported.has(key)) continue;
    reported.add(key);
    failures.push({ target: ids.join(', '), rule: 'repeated-phrase', detail: `"${phrase}" repeats in ${ids.length} components, limit ${effective.repeatedPhraseMaxComponents}` });
  }
  return { pass: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// DOM reader. Runs inside the page via page.evaluate, so it must be self-contained.

export function readComponents(selector, doc = globalThis.document, win = globalThis.window, options = {}) {
  if (typeof selector === 'object' && selector !== null) {
    options = selector;
    selector = options.selector;
  }
  const dataSelectors = options.dataSelectors ?? [];
  const numeric = /^[+\-−±~≈]?\s*\d[\d.,\s]*(?:\s*(?:%|[A-Za-z°µ/]{1,4}))?$/u;
  const isTransparent = (color) => !color || color === 'transparent' || /^rgba\(.*,\s*0(?:\.0+)?\s*\)$/.test(color);
  const rendered = (element) => {
    const style = win.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const backgroundOf = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const color = win.getComputedStyle(node).backgroundColor;
      if (!isTransparent(color)) return color;
    }
    return 'rgb(255, 255, 255)';
  };
  const cutsContent = (style) =>
    ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY) || style.textOverflow === 'ellipsis' || (style.webkitLineClamp && style.webkitLineClamp !== 'none');
  const directText = (element) =>
    Array.from(element.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  const descendants = (element) => Array.from(element.children).flatMap((child) => [child, ...descendants(child)]);

  return Array.from(doc.querySelectorAll(selector)).map((component, index) => {
    const box = component.getBoundingClientRect();
    const result = {
      id: component.getAttribute('data-mend-component') || component.id || `${selector}[${index}]`,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      overflow: component.scrollWidth > component.clientWidth + 1 || component.scrollHeight > component.clientHeight + 1,
      texts: [],
      numbers: [],
      timestamps: [],
    };
    for (const element of [component, ...descendants(component)]) {
      if (!rendered(element)) continue;
      const style = win.getComputedStyle(element);
      if (element.getAttribute('data-mend-timestamp') !== null) {
        const marker = [element, ...descendants(element)].find((node) => node.getAttribute('data-mend-stale') !== null && rendered(node));
        result.timestamps.push({
          value: element.getAttribute('data-mend-timestamp'),
          freshnessWindowMs: Number(element.getAttribute('data-mend-freshness-ms')),
          staleMarker: marker ? marker.textContent.trim() : null,
        });
      }
      const text = directText(element);
      if (text === '') continue;
      const fontPx = Number.parseFloat(style.fontSize);
      if (numeric.test(text)) {
        result.numbers.push({ text, fontPx });
        continue;
      }
      let data = false;
      for (let node = element; node; node = node.parentElement) {
        if (node.getAttribute('data-mend-data') !== null || dataSelectors.some((item) => node.matches(item))) data = true;
        if (data || node === component) break;
      }
      result.texts.push({
        text,
        data,
        fontPx,
        color: style.color,
        background: backgroundOf(element),
        clipped: cutsContent(style) && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1),
      });
    }
    return result;
  });
}

/** Reads component snapshots from a page the repo already drives (Playwright or Puppeteer page.evaluate). */
export async function collectSnapshot(page, { selector, dataSelectors = [] } = {}) {
  if (!page || typeof page.evaluate !== 'function') throw new TypeError('[UI-RUBRIC]: collectSnapshot needs a browser page with evaluate()');
  if (typeof selector !== 'string' || selector.trim() === '') throw new TypeError('[UI-RUBRIC]: selector is required');
  validateDataSelectors(dataSelectors);
  const components = await page.evaluate(readComponents, { selector, dataSelectors });
  if (!Array.isArray(components)) throw new TypeError('[UI-RUBRIC]: page returned no component list');
  if (components.length === 0) throw new TypeError('[UI-RUBRIC]: page returned no components for the selector');
  return components;
}

/** Self-contained scale reader for page.evaluate; page.elements covers the whole visible page. */
export function readScale({ selector }, doc = globalThis.document, win = globalThis.window) {
  const fields = ['fontSize', 'fontWeight', 'lineHeight', 'borderRadius', 'color', 'backgroundColor', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap'];
  const descendants = (element) => Array.from(element.children).flatMap((child) => [child, ...descendants(child)]);
  const rectOf = (box) => ({ left: box.left ?? box.x, top: box.top ?? box.y, right: (box.left ?? box.x) + box.width, bottom: (box.top ?? box.y) + box.height });
  const area = (rect) => rect.right > rect.left && rect.bottom > rect.top;
  const intersect = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const viewport = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
  const rendered = (element) => {
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const box = rectOf(element.getBoundingClientRect());
    if (!area(box)) return false;
    let visible = intersect(box, viewport);
    if (!area(visible)) return false;
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      const clips = (value) => ['hidden', 'clip', 'auto', 'scroll'].includes(value);
      const bounds = rectOf(node.getBoundingClientRect());
      if (clips(style.overflowX)) visible = { ...visible, left: Math.max(visible.left, bounds.left), right: Math.min(visible.right, bounds.right) };
      if (clips(style.overflowY)) visible = { ...visible, top: Math.max(visible.top, bounds.top), bottom: Math.min(visible.bottom, bounds.bottom) };
      if (!area(visible)) return false;
    }
    // Clip paths and masks deliberately do not affect the token scale.
    return true;
  };
  let context;
  const colour = (value) => {
    const text = value.trim().toLowerCase();
    if (text === 'transparent') return 'rgba(0, 0, 0, 0)';
    // Every syntax takes the same sRGB/8-bit path, including alpha and premultiplication.
    context ??= doc.createElement('canvas').getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!context) throw new TypeError('[UI-RUBRIC]: cannot normalize computed colours without a 2D canvas');
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = text;
    context.fillRect(0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    // Same canonical premultiplied grid as token-scale's authored colour allowances.
    const alpha = pixel[3];
    if (alpha === 0) return 'rgba(0, 0, 0, 0)';
    const channel = (value) => Math.round(Math.round(value * alpha / 255) * 255 / alpha);
    const channels = [channel(pixel[0]), channel(pixel[1]), channel(pixel[2]), alpha / 255];
    const [r, g, b, a] = channels.map((part) => Number(part.toFixed(6)));
    if (a === 0) return 'rgba(0, 0, 0, 0)';
    return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
  };
  const styles = (elements) => elements.filter(rendered).map((element) => {
    const style = win.getComputedStyle(element);
    return Object.fromEntries(fields.map((field) => [field, field === 'color' || field === 'backgroundColor' ? colour(style[field]) : style[field]]));
  });
  const components = Array.from(doc.querySelectorAll(selector)).map((component, index) => ({
    id: component.getAttribute('data-mend-component') || component.id || `${selector}[${index}]`,
    elements: styles([component, ...descendants(component)]),
  })).filter((component) => component.elements.length > 0);
  return { components, page: { elements: styles(Array.from(doc.querySelectorAll('*'))) } };
}

/** Capture base and head at the same viewport widths as their critique crops. */
export async function collectScale(page, { selector } = {}) {
  if (!page || typeof page.evaluate !== 'function') throw new TypeError('[UI-RUBRIC]: collectScale needs a browser page with evaluate()');
  if (typeof selector !== 'string' || selector.trim() === '') throw new TypeError('[UI-RUBRIC]: selector is required');
  const snapshot = await page.evaluate(readScale, { selector });
  if (!Array.isArray(snapshot?.components) || !Array.isArray(snapshot?.page?.elements) || snapshot.page.elements.length === 0) {
    throw new TypeError('[UI-RUBRIC]: page returned no scale snapshot');
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Check module

async function readSnapshotFile(repo, itemId) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(repo, EVIDENCE_DIR, itemId, SNAPSHOT_FILE), 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.components ?? null;
  } catch {
    return null;
  }
}

function withOverrides(result, overrides) {
  return { ...result, overrides };
}

export default {
  id: 'ui-rubric',
  description: 'Component snapshots meet the UI rubric: word budget, one hero number, no repeated phrases, readable size and contrast, nothing clipped or overflowing, the repo locale, stale values marked.',
  async run({ repo, item, config }) {
    const { rules, overrides } = resolveRules(config?.ui ?? {});
    const snapshots = item?.id ? await readSnapshotFile(repo, item.id) : null;
    if (!snapshots) {
      return withOverrides(
        { pass: false, failures: [{ target: '(item)', rule: 'snapshot-missing', detail: `no ${path.join(EVIDENCE_DIR, item?.id ?? '<item>', SNAPSHOT_FILE)}; capture it with collectSnapshot on the running page` }] },
        overrides,
      );
    }
    return withOverrides(scoreSnapshot(snapshots, rules), overrides);
  },
  async runFixture(fixture) {
    const { rules, overrides } = resolveRules(fixture.rules ?? {});
    return withOverrides(scoreSnapshot(fixture.snapshots, rules), overrides);
  },
};
