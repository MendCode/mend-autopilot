#!/usr/bin/env node
// One trusted exclusion policy for review, integrity and verification side effects.
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const CONFIG = '.mend/quality.json';
export const DEFAULT_GENERATED_FILES = ['**/*.tsbuildinfo', '**/__pycache__/**'];

export async function loadReviewPolicy({ repo, baseSha, expected = process.env.MEND_REVIEW_POLICY ? JSON.parse(process.env.MEND_REVIEW_POLICY) : null }) {
  const git = async (args) => (await exec('git', ['-C', repo, ...args], { encoding: 'utf8' })).stdout;
  // Resolve first: a bad base must not silently fall back to mutable local policy.
  await git(['rev-parse', '--verify', `${baseSha}^{commit}`]);
  let text, source = 'base';
  try { text = await git(['show', `${baseSha}:${CONFIG}`]); }
  catch {
    source = 'defaults';
    let ignored = false;
    try { await git(['check-ignore', '-q', CONFIG]); ignored = true; } catch {}
    if (ignored) try {
      for (const relative of ['.mend', CONFIG]) {
        const stat = await lstat(path.join(repo, relative));
        if (stat.isSymbolicLink() || (relative === CONFIG ? !stat.isFile() : !stat.isDirectory())) throw new Error('quality config must be a regular file inside the repository');
      }
      text = await readFile(path.join(repo, CONFIG), 'utf8');
      source = 'local';
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const fingerprint = createHash('sha256').update(source + '\n' + (text ?? '')).digest('hex');
  if (expected) {
    if (expected.repo !== path.resolve(repo) || expected.baseSha !== baseSha || expected.fingerprint !== fingerprint || !Array.isArray(expected.generatedFiles) || JSON.stringify(expected.pathspec) !== JSON.stringify(generatedPathspec(expected.generatedFiles))) {
      throw new Error('review policy changed after capture; recover trusted configuration before continuing');
    }
    return expected;
  }
  const config = text === undefined ? {} : JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('quality config must be an object');
  const generatedFiles = config.generatedFiles === undefined ? DEFAULT_GENERATED_FILES : config.generatedFiles;
  if (!Array.isArray(generatedFiles) || generatedFiles.some((glob) => typeof glob !== 'string' || !glob.trim() || glob.startsWith('/') || glob.split('/').includes('..') || glob.startsWith(':'))) {
    throw new Error('quality.generatedFiles must be an array of repository-relative globs');
  }
  const propagated = await propagatedVerificationSkills(repo, git, baseSha);
  return { repo: path.resolve(repo), baseSha, fingerprint, generatedFiles: [...generatedFiles, ...propagated], pathspec: generatedPathspec([...generatedFiles, ...propagated]) };
}

// Dispatch copies an untracked project verification skill into each worktree; that copy is setup, not authored work.
async function propagatedVerificationSkills(repo, git, baseSha) {
  const globs = [];
  for (const root of ['.mendcode/skills', '.claude/skills']) {
    let names = [];
    try { names = (await readdir(path.join(repo, root), { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith('verify-')).map((entry) => entry.name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names) {
      if (!(await git(['ls-tree', '--name-only', baseSha, '--', `${root}/${name}`])).trim()) globs.push(`${root}/${name}/**`);
    }
  }
  return globs;
}

function generatedPathspec(globs) {
  return ['.', ...globs.map((glob) => `:(top,exclude,glob)${glob.includes('/') ? glob : `**/${glob}`}`)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { stdinArgs } = await import('./stdin-args.mjs');
    const [repo, baseSha] = stdinArgs(process.argv.slice(2));
    console.log(JSON.stringify(await loadReviewPolicy({ repo, baseSha })));
  } catch (error) {
    console.error(`[REVIEW-POLICY]: ${error.message}`);
    process.exitCode = 1;
  }
}
