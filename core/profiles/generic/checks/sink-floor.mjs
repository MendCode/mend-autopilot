// A value that is spent or consumed (a balance, stock, a quota) never goes below its floor:
// every new decrement of such a value has a comparison or a clamp next to it.
import { changesFromFiles, collectChanges, isTestPath } from '../../../checks/changes.mjs';

export const DEFAULT_SINK_WORDS = [
  'balance', 'credit', 'credits', 'stock', 'inventory', 'quota', 'remaining', 'points', 'tokens', 'seats', 'qty', 'quantity',
  'available', 'allowance', 'budget',
];
const WINDOW_BEFORE = 6;
const WINDOW_AFTER = 3;
const IDENT = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*';
const DECREMENTS = [
  new RegExp(`(${IDENT})\\s*-=`),
  new RegExp(`(${IDENT})--(?![->\\w])`),
  new RegExp(`(?<![\\w$)\\]-])--(${IDENT})`),
  new RegExp(`(${IDENT})\\s*=\\s*\\1\\s*-(?!=)`),
  new RegExp(`(${IDENT})\\s*:\\s*\\{\\s*decrement\\s*:`),
  new RegExp(`\\.decrement\\(\\s*['"\`]([\\w$]+)['"\`]`),
  /\bSET\s+([A-Za-z_][\w]*)\s*=\s*\1\s*-/i,
];

function wordsOf(identifier) {
  return identifier
    .split('.')
    .pop()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasGuard(window, leaf) {
  const name = escapeRegExp(leaf);
  const guards = [
    new RegExp(`\\b${name}\\b\\s*(?:<=?|>=?)(?!>)`),
    new RegExp(`(?<![=-])(?:<=?|>=?)\\s*[\\w$.]*\\b${name}\\b`),
    new RegExp(`\\b${name}\\b\\s*:\\s*\\{\\s*gte?\\s*:`),
    /\bMath\.max\s*\(\s*0\b/,
    /\bmax\s*\(\s*0\b/,
    /\bclamp\w*\s*\(/,
  ];
  return guards.some((regex) => regex.test(window));
}

function decrementsIn(change, sinkWords) {
  const found = [];
  const headLines = (change.headText ?? '').split('\n');
  for (const { line, text } of change.added) {
    for (const pattern of DECREMENTS) {
      const match = text.match(pattern);
      if (!match) continue;
      const identifier = match[1];
      if (!wordsOf(identifier).some((word) => sinkWords.has(word))) continue;
      const leaf = identifier.split('.').pop();
      const window = headLines.slice(Math.max(0, line - 1 - WINDOW_BEFORE), line + WINDOW_AFTER).join('\n');
      if (!hasGuard(window, leaf)) found.push({ identifier, line });
      break;
    }
  }
  return found;
}

export function evaluate({ changes, config }) {
  const sinkWords = new Set([...DEFAULT_SINK_WORDS, ...(config?.sinkNames ?? [])].map((word) => word.toLowerCase()));
  const failures = changes
    .filter((change) => !change.binary && change.status !== 'deleted' && !isTestPath(change.path))
    .flatMap((change) =>
      decrementsIn(change, sinkWords).map(({ identifier, line }) => ({
        target: `${change.path}:${line}`,
        rule: 'sink-unbounded',
        detail: `"${identifier}" is decremented with no comparison or clamp within ${WINDOW_BEFORE} lines before or ${WINDOW_AFTER} after`,
      })),
    );
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'sink-floor',
  description: 'Every new decrement of a consumable value (balance, stock, quota...) has a floor check beside it.',
  async run({ repo, baseSha, headSha, config }) {
    return evaluate({ changes: await collectChanges({ repo, baseSha, headSha }), config });
  },
  async runFixture(fixture) {
    return evaluate({ changes: changesFromFiles(fixture.files), config: fixture.config });
  },
};
