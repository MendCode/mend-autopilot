// Read-only access for profile checks: files at a commit, the item's evidence records and its card.
// Fixtures get the same view through fixtureTree, so a check's pure part never knows which one it has.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export const EVIDENCE_DIR = path.join('.mend', 'evidence');

async function git(repo, args) {
  const { stdout } = await execFileAsync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
    maxBuffer: GIT_MAX_BUFFER,
    encoding: 'utf8',
  });
  return stdout;
}

/** Text of a file at a commit, or null when it does not exist there. */
export async function readFileAt({ repo, sha, filePath }) {
  try {
    return await git(repo, ['show', `${sha}:${filePath}`]);
  } catch {
    return null;
  }
}

/** Every tracked path at a commit. */
export async function listFilesAt({ repo, sha }) {
  const output = await git(repo, ['ls-tree', '-r', '--name-only', sha]);
  return output.split('\n').filter(Boolean);
}

/** Lines containing a literal string at a commit: [{ path, line, text }]. */
export async function searchAt({ repo, sha, literal }) {
  let output;
  try {
    output = await git(repo, ['grep', '-n', '-I', '-F', '-e', literal, sha]);
  } catch {
    return [];
  }
  const prefix = `${sha}:`;
  return output
    .split('\n')
    .filter(Boolean)
    .map((raw) => {
      const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
      const match = rest.match(/^(.*?):(\d+):(.*)$/);
      return match ? { path: match[1], line: Number(match[2]), text: match[3] } : null;
    })
    .filter(Boolean);
}

/**
 * A view of the head tree: has(path), paths(), read(path) and search(literal) -> [{ path, line, text }].
 * Checks take this view so the same code runs on a git commit and on a fixture.
 */
export async function headTree({ repo, headSha }) {
  const paths = new Set(await listFilesAt({ repo, sha: headSha }));
  return {
    has: (filePath) => paths.has(filePath),
    paths: () => [...paths],
    read: (filePath) => (paths.has(filePath) ? readFileAt({ repo, sha: headSha, filePath }) : Promise.resolve(null)),
    search: (literal) => searchAt({ repo, sha: headSha, literal }),
  };
}

/** The same view built from fixture files ({ path, head }) plus extra paths that exist but are not shown. */
export function fixtureTree(files = [], extraPaths = []) {
  const texts = new Map();
  for (const file of files) if (file.head !== null && file.head !== undefined) texts.set(file.path, file.head);
  for (const extra of extraPaths) if (!texts.has(extra)) texts.set(extra, '');
  return {
    has: (filePath) => texts.has(filePath),
    paths: () => [...texts.keys()],
    read: async (filePath) => texts.get(filePath) ?? null,
    search: async (literal) =>
      [...texts.entries()].flatMap(([filePath, text]) =>
        text
          .split('\n')
          .map((line, index) => ({ path: filePath, line: index + 1, text: line }))
          .filter((entry) => entry.text.includes(literal)),
      ),
  };
}

/** Changed paths with rename similarity: [{ status, similarity, oldPath, path }] (status A, M, D or R). */
export async function nameStatus({ repo, baseSha, headSha }) {
  const output = await git(repo, ['diff', '--name-status', '-M', baseSha, headSha]);
  return output
    .split('\n')
    .filter(Boolean)
    .map((raw) => {
      const [code, first, second] = raw.split('\t');
      const status = code[0];
      const similarity = status === 'R' ? Number(code.slice(1)) : null;
      return { status, similarity, oldPath: status === 'R' ? first : null, path: status === 'R' ? second : first };
    });
}

async function readJsonFile(file, label) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TypeError(`[EVIDENCE]: ${label} is not valid JSON (${error.message})`);
  }
}

/** A JSON record the item keeps at .mend/evidence/<item>/<name>, or null when it was never written. */
export async function readItemEvidence({ repo, itemId, name }) {
  if (!itemId) return null;
  return readJsonFile(path.join(repo, EVIDENCE_DIR, itemId, name), `${itemId}/${name}`);
}

/** The card passed in, or the item's card at .mend/evidence/<item>.json, or null. */
export async function readCard({ repo, item, card }) {
  if (card) return card;
  if (!item?.id) return null;
  return readJsonFile(path.join(repo, EVIDENCE_DIR, `${item.id}.json`), `${item.id}.json`);
}

/** Countersigns on the card whose kind is listed and whose subject mentions the given text. */
export function countersignsFor(card, { kinds, subject }) {
  const list = Array.isArray(card?.countersigns) ? card.countersigns : [];
  return list.filter((entry) => kinds.includes(entry?.kind) && typeof entry?.subject === 'string' && entry.subject.includes(subject));
}

/** The card's uncertain list as plain strings ("none" yields an empty list). */
export function uncertainNotes(card) {
  const list = Array.isArray(card?.uncertain) ? card.uncertain : [];
  return list.filter((entry) => typeof entry === 'string' && entry !== 'none');
}
