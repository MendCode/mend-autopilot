// A derived number (a total, a rate, a count) has one place that computes it; everything else reads it.
// Flags the same derived name, or the same derivation shape, newly computed in two or more non-test files.
import { changesFromFiles, collectChanges, isTestPath } from '../../../checks/changes.mjs';

const ASSIGNMENT = /^\s*(?:export\s+)?(?:(?:const|let|var|val|final|def|readonly)\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?::\s*[\w$<>[\]|., ?]+?)?\s*=(?![=>])\s*(.+?)[;,]?\s*$/;
const OBJECT_FIELD = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(.+?)[;,]?\s*$/;
const ARITHMETIC = /[\w)\]]\s*[+\-*/%]\s*[\w(.]/;
const AGGREGATE = /\.reduce\s*\(|\bsum\s*\(|\.sum\s*\(|\bSUM\s*\(|\bMath\.(?:round|floor|ceil)\s*\(/;
const STRING_START = /^["'`]/;
const MIN_NAME_LENGTH = 3;
const MIN_SHAPE_OPERATORS = 2;

function normalizeName(lhs) {
  const leaf = lhs.split('.').pop();
  return leaf.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function isDerived(rhs, leaf) {
  if (STRING_START.test(rhs) || rhs.includes('${')) return false;
  if (new RegExp(`\\b${leaf}\\b`).test(rhs)) return false;
  return ARITHMETIC.test(rhs) || AGGREGATE.test(rhs);
}

/** Shape of an expression with identifiers erased but property names and operators kept. */
export function expressionShape(rhs) {
  return rhs
    .replace(/\s+/g, '')
    .replace(/\.([A-Za-z_$][\w$]*)/g, '.\u0000$1')
    .replace(/(^|[^\u0000\w$])[A-Za-z_$][\w$]*/g, '$1_')
    .replace(/\u0000/g, '');
}

function operatorCount(shape) {
  return (shape.match(/[+\-*/%]|\.reduce|sum\(/gi) ?? []).length;
}

function derivationsIn(change) {
  const found = [];
  for (const { line, text } of change.added) {
    const match = text.match(ASSIGNMENT) ?? text.match(OBJECT_FIELD);
    if (!match) continue;
    const [, lhs, rhs] = match;
    const leaf = lhs.split('.').pop();
    const name = normalizeName(lhs);
    if (name.length < MIN_NAME_LENGTH || !isDerived(rhs, leaf)) continue;
    found.push({ name, shape: expressionShape(rhs), where: `${change.path}:${line}`, file: change.path });
  }
  return found;
}

function groupAcrossFiles(entries, keyOf) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].filter(([, list]) => new Set(list.map((entry) => entry.file)).size >= 2);
}

export function evaluate({ changes, config }) {
  const ignored = new Set((config?.singleDerivation?.ignoreNames ?? []).map((name) => name.toLowerCase()));
  const derivations = changes
    .filter((change) => !change.binary && change.status !== 'deleted' && !isTestPath(change.path))
    .flatMap(derivationsIn)
    .filter((entry) => !ignored.has(entry.name));
  const failures = [];
  const reported = new Set();
  for (const [name, list] of groupAcrossFiles(derivations, (entry) => entry.name)) {
    list.forEach((entry) => reported.add(entry.where));
    failures.push({ target: name, rule: 'duplicate-derivation', detail: `"${name}" is computed in ${list.map((entry) => entry.where).join(' and ')}; compute once and read it elsewhere` });
  }
  const shapeKey = (entry) => (operatorCount(entry.shape) >= MIN_SHAPE_OPERATORS ? entry.shape : null);
  for (const [shape, list] of groupAcrossFiles(derivations, shapeKey)) {
    const fresh = list.filter((entry) => !reported.has(entry.where));
    if (fresh.length === 0) continue;
    failures.push({ target: shape, rule: 'duplicate-derivation', detail: `the same calculation appears in ${list.map((entry) => entry.where).join(' and ')}` });
  }
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'single-derivation',
  description: 'A derived value is computed in one place of the change, not recomputed in a second file.',
  async run({ repo, baseSha, headSha, config }) {
    return evaluate({ changes: await collectChanges({ repo, baseSha, headSha }), config });
  },
  async runFixture(fixture) {
    return evaluate({ changes: changesFromFiles(fixture.files), config: fixture.config });
  },
};
