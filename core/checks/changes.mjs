// Shared change model for profile checks: one entry per changed file with its added head lines and full head text.
// collectChanges reads a real base..head range; changesFromFiles builds the same shape from synthetic fixtures.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DEFAULT_GLOBS, globToRegExp, parseUnifiedDiff } from './integrity.mjs';
import { loadReviewPolicy } from './review-policy.mjs';

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const TEST_PATTERNS = DEFAULT_GLOBS.test.map((glob) => globToRegExp(glob));
const LCS_CELL_LIMIT = 4_000_000;

async function git(repo, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

export function isTestPath(filePath) {
  return TEST_PATTERNS.some((regex) => regex.test(filePath));
}

export function matchesGlobs(filePath, globs) {
  return globs.some((glob) => globToRegExp(glob).test(filePath));
}

/** Changes between two commits of a git repository. */
export async function collectChanges({ repo, baseSha, headSha }) {
  if (!repo || !baseSha || !headSha) throw new TypeError('[CHANGES]: repo, baseSha and headSha are required');
  const { pathspec } = await loadReviewPolicy({ repo, baseSha });
  const diff = await git(repo, ['diff', '--no-color', '--no-ext-diff', '-U0', '-M', '--src-prefix=a/', '--dst-prefix=b/', baseSha, headSha, '--', ...pathspec]);
  const changes = [];
  for (const file of parseUnifiedDiff(diff)) {
    if (file.binary) {
      changes.push({ path: file.path, status: file.status, binary: true, added: [], headText: null });
      continue;
    }
    const headText = file.status === 'deleted' ? null : await git(repo, ['show', `${headSha}:${file.path}`], { allowFailure: true });
    changes.push({
      path: file.path,
      status: file.status,
      binary: false,
      added: file.hunks.flatMap((hunk) => hunk.added),
      headText,
    });
  }
  return changes;
}

function splitLines(text) {
  if (text === null || text === undefined || text === '') return [];
  return text.replace(/\n$/, '').split('\n');
}

/** Head lines not present in base, by longest common subsequence. Small synthetic files only. */
export function addedLinesBetween(baseText, headText) {
  const base = splitLines(baseText);
  const head = splitLines(headText);
  if (base.length === 0) return head.map((text, index) => ({ line: index + 1, text }));
  if (base.length * head.length > LCS_CELL_LIMIT) throw new RangeError('[CHANGES]: fixture file too large for the line diff');
  const table = Array.from({ length: base.length + 1 }, () => new Uint32Array(head.length + 1));
  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = head.length - 1; j >= 0; j -= 1) {
      table[i][j] = base[i] === head[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const added = [];
  let i = 0;
  let j = 0;
  while (j < head.length) {
    if (i < base.length && base[i] === head[j]) {
      i += 1;
      j += 1;
    } else if (i < base.length && table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      added.push({ line: j + 1, text: head[j] });
      j += 1;
    }
  }
  return added;
}

/** Fixture form: [{ path, base: string|null, head: string|null }] with null meaning the file does not exist on that side. */
export function changesFromFiles(files) {
  if (!Array.isArray(files)) throw new TypeError('[CHANGES]: files must be an array');
  return files
    .filter((file) => file.base !== file.head)
    .map((file) => {
      const base = file.base ?? null;
      const head = file.head ?? null;
      const status = base === null ? 'added' : head === null ? 'deleted' : 'modified';
      return { path: file.path, status, binary: false, added: head === null ? [] : addedLinesBetween(base, head), headText: head };
    });
}
