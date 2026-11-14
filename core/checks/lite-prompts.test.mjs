import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt, main, writeDiff } from './lite-prompts.mjs';

const data = {
  item: { id: 'sample', goal: 'retries are safe', editSet: ['src/a.js'] },
  worktree: '/fixture/worktree',
  verificationCommands: ['node --test'],
  specPath: '.mend/evidence/sample/spec.md',
};

function repoWithChange() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lite-prompts-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' } }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'a.js'), 'export const a = 2;\n');
  git('commit', '-q', '-am', 'head');
  return { dir, baseSha, head: git('rev-parse', 'HEAD') };
}

test('the planner prompt is read-only, names the implicit cases and asks for JSON', () => {
  const prompt = buildPrompt('spec', data);
  for (const rule of ['Do not edit, create or delete any file', 'concurrency and retries', 'other users and access', 'status codes and error shapes consistent with the existing code', 'inside the editSet', 'do not add features', '{"spec":', '"retries are safe"']) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test('the owner prompt points at the spec by path, scopes edits and requires a verified commit', () => {
  const prompt = buildPrompt('owner', { ...data, round: 1, feedback: null });
  for (const rule of ['/fixture/worktree/.mend/evidence/sample/spec.md', 'Change only files matching the item editSet', 'the editSet wins', 'status, progress, runtime', 'never use git -C', 'Run the repository verification yourself', 'Leave no uncommitted changes', 'still commit what works']) {
    assert.ok(prompt.includes(rule), rule);
  }
  assert.ok(!prompt.includes('fix round'));
});

test('a fix round carries the exact feedback and a long spec never enters the prompt', () => {
  const feedback = "Blockers: [{\"issue\":\"other users' keys\"}]\n$HOME `x`";
  const prompt = buildPrompt('owner', { ...data, round: 2, feedback, spec: 'x'.repeat(20_000) });
  assert.match(prompt, /This is fix round 2/);
  assert.ok(prompt.includes(feedback));
  assert.ok(prompt.length < 4000);
});

test('the review prompt writes the exact diff, states the merge bar and asks for the verdict shape', () => {
  const { dir, baseSha, head } = repoWithChange();
  const prompt = buildPrompt('critique', { ...data, worktree: dir, diffPath: '.mend/evidence/sample/diff-r1.patch', baseSha, head, pathspec: ['.'], verification: [{ command: 'node --test', exit: 0 }], round: 1 });
  assert.match(readFileSync(path.join(dir, '.mend/evidence/sample/diff-r1.patch'), 'utf8'), /^\+export const a = 2;$/m);
  for (const rule of ['Read-only', 'Do not survey the rest of the repository', 'run by the workflow, not by the owner', 'Only blocker findings send the change back', 'Where the spec itself is wrong, say so', '"verdict":"merge"|"fix"', baseSha, head]) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test('the diff writer refuses short ids and paths that leave the worktree', () => {
  const { dir, baseSha, head } = repoWithChange();
  assert.throws(() => writeDiff({ worktree: dir, baseSha: 'HEAD', head, diffPath: 'd.patch' }), /full commit ids/);
  for (const diffPath of ['/tmp/d.patch', '../d.patch', 'a/../../d.patch']) {
    assert.throws(() => writeDiff({ worktree: dir, baseSha, head, diffPath }), /inside the worktree/);
  }
});

test('planner, owner and reviewer all hold the checks fixed, and the planner reports a too-narrow editSet', () => {
  const { dir, baseSha, head } = repoWithChange();
  const prompts = {
    spec: buildPrompt('spec', data),
    owner: buildPrompt('owner', { ...data, round: 1 }),
    critique: buildPrompt('critique', { ...data, worktree: dir, diffPath: 'd.patch', baseSha, head, verification: [], round: 1 }),
  };
  for (const [kind, prompt] of Object.entries(prompts)) assert.match(prompt, /check and test scripts, test runner configuration and CI files are fixed/, kind);
  assert.match(prompts.spec, /"editSetMissing"/);
  assert.match(prompts.critique, /never block for skipping it/);
});

test('CLI returns JSON and rejects malformed or unknown requests', () => {
  let out = '', error = '';
  const stdout = { write: (value) => { out += value; } };
  const stderr = { write: (value) => { error += value; } };
  assert.equal(main(['spec', JSON.stringify(data)], stdout, stderr), 0);
  assert.deepEqual(JSON.parse(out), { prompt: buildPrompt('spec', data) });
  for (const args of [[], ['spec', '{'], ['unknown', JSON.stringify(data)], ['owner', '{}']]) {
    out = '';
    assert.equal(main(args, stdout, stderr), 64);
    assert.equal(out, '');
  }
  assert.match(error, /LITE-PROMPTS/);
});

test('the owner is told it writes the change itself, and a round after an empty one does not claim a reviewed commit', () => {
  const first = buildPrompt('owner', { ...data, round: 1, feedback: null });
  assert.match(first, /you write this change yourself, now, in this worktree, and nobody else will/);
  assert.match(first, /do not load the mend-autopilot or mend-quality skills/);
  assert.match(first, /explicit authorization to edit the editSet, run any command the work needs/);
  const second = buildPrompt('owner', { ...data, round: 2, feedback: 'The workflow found problems at your head:\n- nothing was committed: no change was made, so the whole spec is still yours to implement, starting now' });
  assert.doesNotMatch(second, /previous commit was reviewed/);
  assert.match(second, /whole spec is still yours to implement/);
});

test('the planner looks for existing tests that pin what the item changes and reports the undeclared ones', () => {
  const prompt = buildPrompt('spec', { ...data });
  assert.match(prompt, /Search the existing tests for any that pin what this item changes/);
  assert.match(prompt, /not in the item's testChanges: each one goes in "editSetMissing"/);
});

test('the owner knows a one-tree note about earlier rounds of its own item is not someone else working', () => {
  const prompt = buildPrompt('owner', { ...data, round: 1, feedback: null });
  assert.match(prompt, /names «workflow · mend · …» sessions for this item is about those ended rounds: nobody else is working here/);
});

test('the planner names the design: functions to change, helpers and patterns to reuse, where new code goes and a sketch', () => {
  const prompt = buildPrompt('spec', data);
  for (const rule of ['Name the design too, so the owner does not improvise one', 'the functions and files to change inside the editSet', 'the existing helpers and patterns of those files to reuse (by name)', 'where new code goes', 'a short code sketch of the non-obvious part']) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test('the reviewer blocks concrete maintainability problems, never what the spec asked for, and keeps taste a nit', () => {
  const { dir, baseSha, head } = repoWithChange();
  const prompt = buildPrompt('critique', { ...data, worktree: dir, diffPath: 'd.patch', baseSha, head, verification: [], round: 2 });
  for (const rule of ['in code this change adds or touches, a maintainability problem a senior reviewer of this codebase would reject', 'duplicates an existing helper (name it)', 'a pattern the same file already uses ignored', 'where an extraction belongs', 'dead or leftover code', 'a needlessly complex mechanism where the spec or the file shows a simpler one', 'names the file and the concrete fix inside the editSet', 'never what the spec explicitly asks for', 'taste, a nit', 'review round 2']) {
    assert.ok(prompt.includes(rule), rule);
  }
  assert.doesNotMatch(prompt, /Style preferences are nits/);
});

test('the owner writes in the style of the surrounding lines: width, wrapping, lists, headings, naming', () => {
  const prompt = buildPrompt('owner', { ...data, round: 1, feedback: null });
  assert.match(prompt, /the same line width and wrapping, list, table and heading style, naming and language/);
});
