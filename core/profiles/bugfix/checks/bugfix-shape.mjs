// A bugfix names where the bug lives (a file:line that exists at head) and changes code outside the tests:
// a diff that only touches tests, fixtures or snapshots changed the check, not the behaviour.
import { DEFAULT_GLOBS } from '../../../checks/integrity.mjs';
import { changesFromFiles, collectChanges, isTestPath, matchesGlobs } from '../../../checks/changes.mjs';
import { fixtureTree, headTree, readCard } from '../../../checks/repo-read.mjs';

const LOCATION = /([\w@.\-/]+\.[A-Za-z0-9]+):(\d+)/g;

/** The written root cause: the item's rootCause, else the proof note on the card. */
export function rootCauseText({ item, card }) {
  const text = item?.rootCause ?? card?.proof?.note;
  return typeof text === 'string' ? text : '';
}

/** Every path:line reference in a text: [{ path, line }]. */
export function locationsIn(text) {
  return [...text.matchAll(LOCATION)].map((match) => ({ path: match[1].replace(/^\.\//, ''), line: Number(match[2]) }));
}

function lineCount(text) {
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function isNotAFix(filePath) {
  return isTestPath(filePath) || matchesGlobs(filePath, DEFAULT_GLOBS.baseline);
}

export async function evaluate({ changes, tree, rootCause, proposal = false }) {
  const failures = [];
  const locations = locationsIn(rootCause);
  if (locations.length === 0) {
    failures.push({ target: '(root cause)', rule: 'root-cause-missing', detail: 'the root cause names no file:line; say where the defect is, not only what the symptom was' });
  }
  for (const { path: filePath, line } of locations) {
    const text = await tree.read(filePath);
    if (text === null) {
      failures.push({ target: `${filePath}:${line}`, rule: 'root-cause-unknown-location', detail: `${filePath} does not exist at head` });
    } else if (line < 1 || line > lineCount(text)) {
      failures.push({ target: `${filePath}:${line}`, rule: 'root-cause-unknown-location', detail: `${filePath} has ${lineCount(text)} lines at head` });
    }
  }
  const fixes = changes.filter((change) => !isNotAFix(change.path));
  if (!proposal && fixes.length === 0) {
    const touched = changes.map((change) => change.path).join(', ') || 'nothing';
    failures.push({ target: '(diff)', rule: 'fix-only-tests', detail: `only tests, fixtures or snapshots changed (${touched}); the defect is still in the code` });
  }
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'bugfix-shape',
  needsCard: true,
  description: 'The root cause names a file:line that exists at head, and the diff changes code outside tests, fixtures and snapshots.',
  async run({ repo, item, baseSha, headSha, card, proposal }) {
    return evaluate({
      changes: await collectChanges({ repo, baseSha, headSha }),
      tree: await headTree({ repo, headSha }),
      rootCause: rootCauseText({ item, card: await readCard({ repo, item, card }) }),
      proposal,
    });
  },
  async runFixture(fixture) {
    return evaluate({
      changes: changesFromFiles(fixture.files),
      tree: fixtureTree(fixture.files, fixture.paths),
      rootCause: rootCauseText({ item: fixture.item, card: fixture.card }),
    });
  },
};
