// A refactor keeps behaviour: the same tests give the same results at base and head, the exported surface
// is unchanged unless the item declares a change, tests are only moved (or follow a move in their imports),
// and the diff stays within the file cap.
import { DEFAULT_GLOBS } from '../../../checks/integrity.mjs';
import { isTestPath, matchesGlobs } from '../../../checks/changes.mjs';
import { nameStatus, readFileAt } from '../../../checks/repo-read.mjs';
import { evidenceLines, readCaptures } from '../../../checks/capture.mjs';
import { compareExports, exportsOf, hasSurface } from './exports.mjs';

export const TEST_RESULTS_FILE = 'test-results.json';
export const DEFAULT_FILE_CAP = 10;
const IMPORT_LINE = /^\s*(?:import\b.*\bfrom\s*['"][^'"]+['"];?|import\s*['"][^'"]+['"];?|(?:const|let|var)\s+[^=]+=\s*require\(\s*['"][^'"]+['"]\s*\);?|from\s+[\w.]+\s+import\b.*|import\s+[\w.]+(?:\s+as\s+\w+)?)\s*$/;
const STATUS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'modified', C: 'added' };

/** Fixture files to entries: identical delete/add pairs and entries with oldPath become renames. */
export function entriesFromFiles(files) {
  const changed = files.filter((file) => file.oldPath || file.base !== file.head);
  const deleted = changed.filter((file) => !file.oldPath && file.base !== null && file.head === null);
  const paired = new Set();
  const entries = [];
  for (const file of changed) {
    if (file.oldPath) {
      entries.push({ path: file.path, oldPath: file.oldPath, status: 'renamed', similarity: file.base === file.head ? 100 : 50, baseText: file.base, headText: file.head });
    } else if (file.base === null && file.head !== null) {
      const source = deleted.find((candidate) => !paired.has(candidate.path) && candidate.base === file.head);
      if (source) {
        paired.add(source.path);
        entries.push({ path: file.path, oldPath: source.path, status: 'renamed', similarity: 100, baseText: source.base, headText: file.head });
      } else {
        entries.push({ path: file.path, oldPath: null, status: 'added', similarity: null, baseText: null, headText: file.head });
      }
    }
  }
  for (const file of changed) {
    if (file.oldPath || (file.base === null && file.head !== null) || paired.has(file.path)) continue;
    entries.push({ path: file.path, oldPath: null, status: file.head === null ? 'deleted' : 'modified', similarity: null, baseText: file.base, headText: file.head });
  }
  return entries;
}

/** The same entries from a real base..head range, with rename similarity from git. */
export async function entriesFromRepo({ repo, baseSha, headSha }) {
  const entries = [];
  for (const { status, similarity, oldPath, path: filePath } of await nameStatus({ repo, baseSha, headSha })) {
    const kind = STATUS[status] ?? 'modified';
    entries.push({
      path: filePath,
      oldPath,
      status: kind,
      similarity,
      baseText: kind === 'added' ? null : await readFileAt({ repo, sha: baseSha, filePath: oldPath ?? filePath }),
      headText: kind === 'deleted' ? null : await readFileAt({ repo, sha: headSha, filePath }),
    });
  }
  return entries;
}

function isPureMove(entry) {
  return entry.status === 'renamed' && entry.similarity === 100;
}

/** Lines of one text missing from the other, counted as multisets so it stays linear on large files. */
function linesMissingFrom(text, other) {
  const counts = new Map();
  for (const line of other.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  return text.split('\n').filter((line) => {
    const left = counts.get(line) ?? 0;
    if (left === 0) return true;
    counts.set(line, left - 1);
    return false;
  });
}

/** A test whose only changed lines are imports followed a moved module; it did not change what it checks. */
function onlyImportsChanged(entry) {
  if (entry.baseText === null || entry.headText === null) return false;
  const changed = [...linesMissingFrom(entry.headText, entry.baseText), ...linesMissingFrom(entry.baseText, entry.headText)];
  return changed.length > 0 && changed.every((line) => IMPORT_LINE.test(line));
}

function isDeclared(declared, filePath, oldPath, name) {
  return [filePath, oldPath].filter(Boolean).some((candidate) => declared.has(`${candidate}#${name}`) || declared.has(`${candidate}#*`));
}

function checkExports({ entries, item, failures }) {
  const declared = new Set(Array.isArray(item?.surfaceChanges) ? item.surfaceChanges : []);
  for (const entry of entries) {
    if (isTestPath(entry.path) || matchesGlobs(entry.path, DEFAULT_GLOBS.baseline)) continue;
    if (!hasSurface(entry.path) && !(entry.oldPath && hasSurface(entry.oldPath))) continue;
    const before = exportsOf(entry.oldPath ?? entry.path, entry.baseText);
    const after = exportsOf(entry.path, entry.headText);
    for (const difference of compareExports(before, after)) {
      if (isDeclared(declared, entry.path, entry.oldPath, difference.name)) continue;
      const detail = difference.change === 'signature'
        ? `${difference.name} changed its parameters from ${difference.before} to ${difference.after}`
        : `${difference.name} was ${difference.change}`;
      failures.push({ target: `${entry.path}#${difference.name}`, rule: 'export-changed', detail: `${detail}; list "${entry.path}#${difference.name}" in the item's surfaceChanges if this is intended` });
    }
  }
}

function checkTests({ entries, failures }) {
  for (const entry of entries) {
    if (!isTestPath(entry.path) && !(entry.oldPath && isTestPath(entry.oldPath))) continue;
    if (isPureMove(entry) || onlyImportsChanged(entry)) continue;
    failures.push({ target: entry.path, rule: 'test-edited', detail: `a test was ${entry.status} in a refactor; tests may only move or follow a moved import, otherwise the check and the code changed together` });
  }
}

function summary(side) {
  const failing = Array.isArray(side?.failing) ? [...side.failing].sort() : [];
  return { passed: side?.passed, failed: side?.failed, skipped: side?.skipped ?? 0, failing };
}

function checkTestResults({ testResults, failures }) {
  const target = `(evidence)/${TEST_RESULTS_FILE}`;
  const valid = (side) => side && ['passed', 'failed', 'skipped'].every((key) => Number.isSafeInteger(side[key] ?? (key === 'skipped' ? 0 : undefined)) && (side[key] ?? 0) >= 0) && side.passed + side.failed > 0 && (side.failing === undefined || (Array.isArray(side.failing) && side.failing.every((name) => typeof name === 'string')));
  if (!valid(testResults?.base) || !valid(testResults?.head)) {
    failures.push({ target, rule: 'test-results-missing', detail: 'no recorded test results for both base and head (passed, failed, skipped and the failing test names)' });
    return;
  }
  const base = summary(testResults.base);
  const head = summary(testResults.head);
  if (JSON.stringify(base) !== JSON.stringify(head)) {
    failures.push({ target, rule: 'test-results-differ', detail: `base ${base.passed} passed, ${base.failed} failed, ${base.skipped} skipped; head ${head.passed} passed, ${head.failed} failed, ${head.skipped} skipped${base.failing.join() !== head.failing.join() ? '; the failing tests differ' : ''}` });
  }
}

export function evaluate({ entries, item, testResults, config }) {
  const failures = [];
  checkExports({ entries, item, failures });
  checkTests({ entries, failures });
  checkTestResults({ testResults, failures });
  const cap = Number.isInteger(config?.fileCap) ? config.fileCap : DEFAULT_FILE_CAP;
  const counted = entries.filter((entry) => !isPureMove(entry));
  if (counted.length > cap) {
    failures.push({ target: '(diff)', rule: 'file-cap', detail: `${counted.length} files changed (pure moves not counted); the cap is ${cap}, so split the refactor` });
  }
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'surface-unchanged',
  description: 'Identical test results at base and head, no undeclared change to exported names or parameters, tests only moved, and the diff within the file cap.',
  async run({ repo, item, baseSha, headSha, config }) {
    const baseCaptures = await readCaptures({ repo, itemId: item?.id, kind: 'tests', headSha: baseSha });
    const headCaptures = await readCaptures({ repo, itemId: item?.id, kind: 'tests', headSha });
    const base = baseCaptures.at(-1);
    const head = headCaptures.at(-1);
    const testResults = base && head && base.command === head.command && base.exit === head.exit ? { base: evidenceLines(base.output).at(-1), head: evidenceLines(head.output).at(-1) } : null;
    return evaluate({
      entries: await entriesFromRepo({ repo, baseSha, headSha }),
      item,
      testResults,
      config,
    });
  },
  async runFixture(fixture) {
    return evaluate({ entries: entriesFromFiles(fixture.files ?? []), item: fixture.item, testResults: fixture.testResults, config: fixture.config });
  },
};
