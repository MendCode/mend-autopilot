// Compare changed components and the whole head page with the existing computed-style scale.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseColor } from './ui-rubric.mjs';

const PROPERTIES = ['fontSize', 'fontWeight', 'borderRadius', 'color', 'backgroundColor'];
const COLOURS = new Set(['color', 'backgroundColor']);
const EVIDENCE_DIR = path.join('.mend', 'evidence');
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function radiusParts(value) {
  // Spaces and division inside CSS math are not shorthand separators.
  const halves = [[]];
  let depth = 0;
  let token = '';
  const flush = () => { if (token) halves.at(-1).push(token); token = ''; };
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')' && --depth < 0) return null;
    if (depth === 0 && (char === '/' || /\s/.test(char))) {
      flush();
      if (char === '/') halves.push([]);
    } else token += char;
  }
  flush();
  const valid = (part) => /^(?:0|\d+(?:\.\d+)?(?:px|%))$/.test(part)
    || (/^(?:calc|min|max|clamp)\(.+\)$/.test(part) && /^[\w\s.%+*/(),-]+$/.test(part));
  if (depth !== 0 || halves.length > 2 || halves.some((half) => half.length === 0 || half.length > 4 || half.some((part) => !valid(part)))) return null;
  const expand = ([a, b = a, c = a, d = b]) => [a, b, c, d];
  return [...expand(halves[0]), ...expand(halves[1] ?? halves[0])];
}

function normalize(property, value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw new TypeError(`missing or invalid ${property}`);
  let text = String(value).trim().replace(/\s+/g, ' ');
  if (COLOURS.has(property)) {
    if (text.toLowerCase() === 'transparent') return null;
    const color = parseColor(text);
    if (!color || [color.r, color.g, color.b].some((part) => !Number.isFinite(part) || part < 0 || part > 255) || !Number.isFinite(color.a) || color.a < 0 || color.a > 1) {
      throw new TypeError(`invalid ${property} colour "${text}"; capture with collectScale`);
    }
    // The collector reads an 8-bit premultiplied sRGB canvas. Project both
    // captured values and authored allowances onto that same, idempotent grid.
    const alpha = Math.round(color.a * 255);
    if (alpha === 0) return null;
    const channel = (value) => Math.round(Math.round(value * alpha / 255) * 255 / alpha);
    const [r, g, b] = [color.r, color.g, color.b].map(channel);
    const a = Number((alpha / 255).toFixed(6));
    return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  if (property === 'fontWeight') {
    text = ({ normal: '400', bold: '700' })[text] ?? text;
    if (!/^\d+(?:\.\d+)?$/.test(text) || Number(text) < 1 || Number(text) > 1000) throw new TypeError(`invalid fontWeight "${text}"`);
    return String(Number(text));
  }
  if (typeof value === 'number' || text === '0') text = `${text}px`;
  if (property === 'fontSize') {
    if (!/^\d+(?:\.\d+)?px$/.test(text)) throw new TypeError(`invalid fontSize "${text}"`);
    return `${Number.parseFloat(text)}px`;
  }
  const parts = radiusParts(text);
  if (!parts) throw new TypeError(`invalid borderRadius "${text}"`);
  const canonical = parts.map((part) => part.includes('(') ? part : `${Number.parseFloat(part)}${part.endsWith('%') ? '%' : 'px'}`);
  const compact = (half) => {
    const [a, b, c, d] = half;
    return a === b && a === c && a === d ? a : a === c && b === d ? `${a} ${b}` : b === d ? `${a} ${b} ${c}` : half.join(' ');
  };
  const horizontal = compact(canonical.slice(0, 4));
  const vertical = compact(canonical.slice(4));
  return horizontal === vertical ? horizontal : `${horizontal} / ${vertical}`;
}

function settings(ui = {}) {
  const margin = ui.scaleMargin === undefined ? 1 : ui.scaleMargin;
  if (!Number.isInteger(margin) || margin < 0 || margin > 1) throw new TypeError('[TOKEN-SCALE]: ui.scaleMargin must be 0 or 1; it may only be lowered');
  const entries = ui.scaleAllow === undefined ? [] : ui.scaleAllow;
  if (!Array.isArray(entries)) throw new TypeError('[TOKEN-SCALE]: ui.scaleAllow must be an array');
  const allow = new Map(PROPERTIES.map((property) => [property, new Map()]));
  for (const entry of entries) {
    if (!entry || !PROPERTIES.includes(entry.property) || typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new TypeError('[TOKEN-SCALE]: every ui.scaleAllow entry needs a supported property, value and non-empty reason');
    }
    const value = normalize(entry.property, entry.value);
    if (value === null) throw new TypeError('[TOKEN-SCALE]: transparent colours need no allowance');
    if (allow.get(entry.property).has(value)) throw new TypeError('[TOKEN-SCALE]: duplicate ui.scaleAllow property/value');
    allow.get(entry.property).set(value, entry.reason.trim());
  }
  return { margin, allow };
}

function snapshotOf(snapshot, name) {
  if (!snapshot || !Array.isArray(snapshot.components) || !Array.isArray(snapshot.page?.elements) || snapshot.page.elements.length === 0) {
    throw new TypeError(`${name} needs components and a non-empty page.elements array`);
  }
  if (name === 'head' && snapshot.components.length === 0) throw new TypeError('head needs at least one visible component');
  const elementsOf = (elements) => elements.map((element) => Object.fromEntries(PROPERTIES.map((property) => [property, normalize(property, element?.[property])])));
  const ids = new Set();
  const components = snapshot.components.map((component) => {
    if (typeof component?.id !== 'string' || !component.id.trim() || ids.has(component.id) || !Array.isArray(component.elements) || component.elements.length === 0) {
      throw new TypeError(`${name} components need unique non-empty ids and non-empty elements arrays`);
    }
    ids.add(component.id);
    return { id: component.id, elements: elementsOf(component.elements) };
  });
  return { components, page: { elements: elementsOf(snapshot.page.elements) } };
}

function scaleOf(elements, property) {
  return new Set(elements.map((element) => element[property]).filter((value) => value !== null));
}

function nearestValues(property, value, scale) {
  const distance = (candidate) => {
    if (COLOURS.has(property)) {
      const a = parseColor(value);
      const b = parseColor(candidate);
      return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b, 255 * (a.a - b.a));
    }
    if (property === 'borderRadius') {
      const a = radiusParts(value);
      const b = radiusParts(candidate);
      // Unresolved expressions have no numeric distance without the element's dimensions.
      // Keep exact expression matches; rank incomparable values lexically, never via NaN.
      const deltas = a.map((part, index) => {
        if (part === b[index]) return 0;
        if (part.includes('(') || b[index].includes('(') || part.endsWith('%') !== b[index].endsWith('%')) return Infinity;
        return Number.parseFloat(part) - Number.parseFloat(b[index]);
      });
      return Math.hypot(...deltas);
    }
    return Math.abs(Number.parseFloat(value) - Number.parseFloat(candidate));
  };
  return [...scale].sort((a, b) => {
    const left = distance(a);
    const right = distance(b);
    return left === right ? compareText(a, b) : left < right ? -1 : 1;
  }).slice(0, 3);
}

/** Pure evaluator. Explicit new-token allowances exempt that value from both rules, not the whole property. */
export function evaluate({ base, head, ui = {}, designRules = null }) {
  const { margin, allow } = settings(ui);
  const failures = [];
  const allowed = [];
  const result = () => ({ pass: failures.length === 0, failures, allowed, designRules, scaleMargin: margin });
  try {
    base = snapshotOf(base, 'base');
    head = snapshotOf(head, 'head');
  } catch (error) {
    failures.push({ target: '(item)', rule: 'snapshot-invalid', detail: error.message });
    return result();
  }
  for (const property of PROPERTIES) {
    const baseScale = scaleOf(base.page.elements, property);
    const headScale = scaleOf(head.page.elements, property);
    const exemptions = allow.get(property);
    const used = new Set([...headScale, ...head.components.flatMap((component) => [...scaleOf(component.elements, property)])]);
    for (const [value, reason] of exemptions) {
      if (used.has(value)) allowed.push({ property, value, reason });
    }
    for (const component of head.components) {
      for (const value of scaleOf(component.elements, property)) {
        if (baseScale.has(value) || exemptions.has(value)) continue;
        const nearest = nearestValues(property, value, baseScale);
        failures.push({ target: component.id, rule: 'off-scale', property, value, nearest, detail: `${component.id}: ${property} "${value}" is absent from the base page; nearest: ${nearest.join(', ') || '(empty scale)'}` });
      }
    }
    const allowedCount = [...headScale].filter((value) => !baseScale.has(value) && exemptions.has(value)).length;
    if (headScale.size - allowedCount > baseScale.size + margin) {
      failures.push({ target: '(page)', rule: 'scale-growth', property, baseCount: baseScale.size, headCount: headScale.size, allowedCount, margin, detail: `${property}: base ${baseScale.size}, head ${headScale.size}, allowed new ${allowedCount}, margin ${margin}` });
    }
  }
  return result();
}

async function repoFile(repo, relative) {
  if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative)) throw new TypeError('[TOKEN-SCALE]: file paths must be repository-relative');
  const root = await fs.realpath(repo);
  const inside = (file) => {
    const rel = path.relative(root, file);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new TypeError('[TOKEN-SCALE]: file path escapes the repository');
    return file;
  };
  return inside(await fs.realpath(inside(path.resolve(root, relative))));
}

export default {
  id: 'token-scale',
  description: 'Changed UI components reuse the base page scale; new page tokens need bounded growth or a reasoned allowance.',
  async run({ repo, item, config }) {
    const ui = config?.ui ?? {};
    const { margin } = settings(ui);
    const failures = [];
    let designRules = null;
    const declared = ui.designRules !== undefined;
    const designPath = declared ? ui.designRules : 'DESIGN.md';
    try {
      const file = await repoFile(repo, designPath);
      if (!(await fs.stat(file)).isFile()) throw new TypeError('design rules must name a file');
      designRules = path.normalize(designPath);
    } catch (error) {
      if (declared || error.code !== 'ENOENT') failures.push({ target: '(repo)', rule: 'design-rules-invalid', detail: `cannot use design rules: ${error.message}` });
    }
    if (typeof item?.id !== 'string' || !item.id.trim() || /[\\/]/.test(item.id) || ['.', '..'].includes(item.id)) {
      return { pass: false, failures: [...failures, { target: '(item)', rule: 'snapshot-missing', detail: 'a valid item id is required for scale evidence' }], allowed: [], designRules, scaleMargin: margin };
    }
    const snapshots = {};
    for (const version of ['base', 'head']) {
      const name = path.join(EVIDENCE_DIR, item.id, `ui-scale-${version}.json`);
      try {
        snapshots[version] = JSON.parse(await fs.readFile(await repoFile(repo, name), 'utf8'));
      } catch (error) {
        failures.push({ target: name, rule: error.code === 'ENOENT' ? 'snapshot-missing' : 'snapshot-invalid', detail: `cannot read ${name}; capture it with collectScale: ${error.message}` });
      }
    }
    if (failures.length) return { pass: false, failures, allowed: [], designRules, scaleMargin: margin };
    return evaluate({ ...snapshots, ui, designRules });
  },
  async runFixture(fixture) {
    return evaluate({ base: fixture.base, head: fixture.head, ui: fixture.ui, designRules: fixture.designRules ?? null });
  },
};
