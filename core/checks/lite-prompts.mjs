#!/usr/bin/env node
// Prompts for mend-lite: the strong model specs and critiques, one cheap owner implements.
// Workflow scripts cannot import modules, so prompts are built by this packaged CLI.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The critic is read-only without a shell, so the exact diff is written where it can read it.
export function writeDiff({ worktree, baseSha, head, pathspec, diffPath }) {
  if (![baseSha, head].every((sha) => /^[0-9a-f]{40}$/.test(sha ?? ''))) throw new TypeError('base and head must be full commit ids');
  if (typeof diffPath !== 'string' || diffPath.startsWith('/') || diffPath.split('/').includes('..')) throw new TypeError('diffPath must stay inside the worktree');
  const diff = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', baseSha, head, '--', ...(Array.isArray(pathspec) && pathspec.length ? pathspec : ['.'])], { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const file = path.join(worktree, diffPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, diff);
}

const IMPLICIT_CASES = 'concurrency and retries, boundaries, invalid input, other users and access, partial failure';
// The integrity scan blocks any edit to the checks themselves, so nobody may plan or demand one.
const GATES_FIXED = 'The repository\'s verification commands, check and test scripts, test runner configuration and CI files are fixed: never plan, make or demand a change to them. New tests must be found by the existing runner.';

function itemBlock({ item, worktree, verificationCommands }) {
  return [
    'Work item (JSON): ' + JSON.stringify(item),
    'Worktree: ' + worktree + '. Work only there.',
    'Repository verification: ' + JSON.stringify(verificationCommands),
  ].join('\n');
}

const builders = {
  spec(data) {
    return itemBlock(data) + '\n\nYou are the planner for this item. Read the repository and the item. Do not edit, create or delete any file and do not commit. Write the implementation spec the owner will follow: the exact observable behaviour, including the edge cases and failure modes the item leaves implicit (' + IMPLICIT_CASES + '), status codes and error shapes consistent with the existing code, the mechanism to use where correctness depends on it, the files to change inside the editSet, and the tests that prove each point. Keep it inside the item\'s goal; do not add features. ' + GATES_FIXED + ' If the item cannot be done correctly inside its editSet, list the extra paths it needs in "editSetMissing" with the reason in the spec; otherwise leave it empty. Reply as JSON {"spec": "<the spec as Markdown>", "editSetMissing": ["<path>"]}.';
  },
  owner(data) {
    const { worktree, specPath, round, feedback } = data;
    const lines = [
      itemBlock(data),
      'Implementation spec: read ' + worktree + '/' + specPath + ' first and follow it. Where you think it is wrong, follow it anyway and say why in your final message.',
      'Change only files matching the item editSet. ' + GATES_FIXED + ' Add or update the tests the spec names. cd into the worktree before every shell command; never use git -C.',
      'Run the repository verification yourself until it passes, then commit everything with one message that says what changed. Leave no uncommitted changes.',
      'The untracked .mend/ and .mendcode/ folders in the worktree are the workflow\'s setup and evidence: never delete, move, edit or commit them, even when git status lists them.',
    ];
    if (round > 1 && typeof feedback === 'string' && feedback.trim()) lines.push('This is fix round ' + round + '. Your previous commit was reviewed. Fix exactly this, nothing else, then verify and commit again:\n' + feedback);
    lines.push('If something outside your control stops you, still commit what works and explain the rest in your final message.');
    return lines.join('\n\n');
  },
  critique(data) {
    const { worktree, specPath, diffPath, baseSha, head, verification, round } = data;
    writeDiff(data);
    return [
      itemBlock(data),
      'You are the reviewer. Read-only: do not edit, create or delete files.',
      'Read the implementation spec ' + worktree + '/' + specPath + ' and the full change ' + worktree + '/' + diffPath + ' (base ' + baseSha + ', head ' + head + '), then only the changed files the diff does not make clear. Do not survey the rest of the repository: open another file only when a specific finding depends on it, such as a caller of a changed function.',
      'Repository verification at head (run by the workflow, not by the owner): ' + JSON.stringify(verification),
      'Judge whether this change can be merged: it meets the item and the spec, it handles the implicit cases (' + IMPLICIT_CASES + '), the tests prove the behaviour instead of restating the code, and nothing outside the item changed. Where the spec itself is wrong, say so. ' + GATES_FIXED + ' A spec line that asks for such a change is wrong; never block for skipping it.',
      'Only blocker findings send the change back: a wrong result, a missing case the item or spec requires, a security hole, a test that cannot fail. Style preferences are nits. This is review round ' + round + '.',
      'Reply as JSON {"verdict":"merge"|"fix","summary":"<two sentences>","findings":[{"severity":"blocker"|"nit","file":"<path>","issue":"<what is wrong and the fix>"}]}. verdict is "fix" exactly when there is a blocker.',
    ].join('\n\n');
  },
};

export function buildPrompt(kind, data) {
  const builder = builders[kind];
  if (!builder) throw new TypeError('unknown prompt kind ' + JSON.stringify(kind));
  if (!data || typeof data !== 'object' || !data.item || typeof data.worktree !== 'string') throw new TypeError('prompt data needs item and worktree');
  return builder(data);
}

export function main(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  try {
    if (argv.length !== 2) throw new Error('usage: lite-prompts.mjs <kind> <json>');
    stdout.write(JSON.stringify({ prompt: buildPrompt(argv[0], JSON.parse(argv[1])) }) + '\n');
    return 0;
  } catch (error) {
    stderr.write('[LITE-PROMPTS]: ' + error.message + '\n');
    return 64;
  }
}

function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  const argv = process.argv.slice(2);
  process.exitCode = argv.length === 1 && argv[0] === '--stdin'
    ? main(JSON.parse(readFileSync(0, 'utf8')).args)
    : main(argv);
}
