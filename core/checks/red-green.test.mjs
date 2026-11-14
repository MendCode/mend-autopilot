import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand, runRedGreen, EXIT, RedGreenBlockedError, RedGreenUsageError } from './red-green.mjs';
import { proposalRed } from './proposal-red.mjs';

// A private temp root, so counting leftover worktree folders is not disturbed by other test files running in parallel.
const PRIVATE_TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mend-red-green-suite-')));
after(() => fs.rm(PRIVATE_TMP, { recursive: true, force: true }));

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'red-green.mjs');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
// The regression command: passes only when the checked-out value is "fixed".
const CHECK = 'test "$(cat value.txt)" = fixed';

const temporaryDirs = [];
after(() => Promise.all(temporaryDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

function gitSync(cwd, args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function makeRepo(baseValue, headValue) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mend-red-green-test-')));
  temporaryDirs.push(root);
  gitSync(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, 'value.txt'), `${baseValue}\n`);
  gitSync(root, ['add', '-A']);
  gitSync(root, ['commit', '-q', '-m', 'base']);
  const baseSha = gitSync(root, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(root, 'value.txt'), `${headValue}\n`);
  gitSync(root, ['commit', '-q', '--allow-empty', '-am', 'head']);
  return { root, baseSha, headSha: gitSync(root, ['rev-parse', 'HEAD']) };
}

async function addHeadFiles(repo, files) {
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repo.root, name)), { recursive: true });
    await fs.writeFile(path.join(repo.root, name), content);
  }
  gitSync(repo.root, ['add', '-A']);
  gitSync(repo.root, ['commit', '-q', '--amend', '--no-edit']);
  repo.headSha = gitSync(repo.root, ['rev-parse', 'HEAD']);
}

test('overlays added tests but not changed production files onto base', async () => {
  const repo = await makeRepo('broken', 'fixed');
  await addHeadFiles(repo, {
    'tests/regression.mjs': "import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; assert.equal(readFileSync('value.txt', 'utf8').trim(), 'fixed', 'regression assertion');\n",
    'production.txt': 'head only\n',
  });
  const result = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: '(test ! -f production.txt || test "$(cat value.txt)" = fixed) && node tests/regression.mjs' });
  assert.equal(result.pass, true, result.reason);
  assert.match(result.logs.base, /regression assertion/);
  assert.deepEqual(result.overlaid, ['tests/regression.mjs']);
});

test('proposal rejects load errors without a bug-specific expectation', async () => {
  const repo = await makeRepo('broken', 'broken');
  await addHeadFiles(repo, { 'tests/regression.cjs': "require('./missing-module');\n" });
  const item = { editSet: ['tests/**'], regression: 'node tests/regression.cjs' };
  await assert.rejects(proposalRed({ repo: repo.root, base: repo.baseSha, head: repo.headSha, item }), /set regressionExpect/);
  const result = await proposalRed({ repo: repo.root, base: repo.baseSha, head: repo.headSha, item: { ...item, regressionExpect: 'MODULE_NOT_FOUND' } });
  assert.match(result.output, /MODULE_NOT_FOUND/);
});

test('proposal measures the test even when the owner committed its revised proposal artifacts, but not other files', async () => {
  const repo = await makeRepo('broken', 'broken');
  await addHeadFiles(repo, {
    'tests/regression.cjs': "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt', 'utf8').trim(), 'fixed', 'BUG');\n",
    '.mend/evidence/item/proposal/bugfix-proposal.json': '{"plan":"guard the value"}\n',
  });
  const item = { editSet: ['tests/**'], regression: 'node tests/regression.cjs', regressionExpect: 'BUG' };
  const result = await proposalRed({ repo: repo.root, base: repo.baseSha, head: repo.headSha, item });
  assert.deepEqual(result.files, ['tests/regression.cjs']);
  await addHeadFiles(repo, { 'src/other.js': 'production change\n' });
  await assert.rejects(proposalRed({ repo: repo.root, base: repo.baseSha, head: repo.headSha, item }), /outside the regression test scope: src\/other\.js/);
});

test('proposal ignores untracked tooling outside the edit set but not uncommitted item files', async () => {
  const repo = await makeRepo('broken', 'broken');
  await addHeadFiles(repo, { 'tests/regression.cjs': "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt', 'utf8').trim(), 'fixed', 'BUG');\n" });
  const item = { editSet: ['tests/**'], regression: 'node tests/regression.cjs', regressionExpect: 'BUG' };
  await fs.mkdir(path.join(repo.root, 'tools/verify'), { recursive: true });
  await fs.writeFile(path.join(repo.root, 'tools/verify/verify.mjs'), 'local tooling\n');
  const result = await proposalRed({ repo: repo.root, base: repo.baseSha, head: repo.headSha, item });
  assert.deepEqual(result.files, ['tests/regression.cjs']);
  await fs.writeFile(path.join(repo.root, 'tests/extra.cjs'), 'uncommitted\n');
  await assert.rejects(proposalRed({ repo: repo.root, base: repo.baseSha, head: repo.headSha, item }), /commit all authored changes.*tests\/extra\.cjs/);
});

test('custom authorized tests are overlaid in profile and delivery runner', async () => {
  const repo = await makeRepo('broken', 'fixed');
  await addHeadFiles(repo, { 'qa/regression.cjs': "const assert = require('node:assert/strict'); assert.equal(require('node:fs').readFileSync('value.txt', 'utf8').trim(), 'fixed', 'BUG');\n" });
  await fs.mkdir(path.join(repo.root, '.mend'), { recursive: true });
  await fs.writeFile(path.join(repo.root, '.mend/integrity.json'), JSON.stringify({ testGlobs: ['qa/**'] }));
  const item = { editSet: ['qa/**', 'value.txt'], regression: 'node qa/regression.cjs', regressionExpect: 'BUG' };
  const profile = (await import('../profiles/bugfix/checks/red-green.mjs')).default;
  const result = await profile.run({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, item });
  assert.equal(result.pass, true, JSON.stringify(result.failures));
  const itemPath = path.join(repo.root, '.mend/item.json');
  await fs.writeFile(itemPath, JSON.stringify(item));
  const cli = spawnSync(process.execPath, [CLI, '--repo', repo.root, '--base', repo.baseSha, '--head', repo.headSha, '--cmd', item.regression, '--expect-base', 'BUG', '--item', itemPath, '--json'], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.deepEqual(JSON.parse(cli.stdout).overlaid, ['qa/regression.cjs']);
});

test('an overlaid test that passes on the old code does not reproduce the bug', async () => {
  const repo = await makeRepo('broken', 'fixed');
  await addHeadFiles(repo, { 'spec/check.mjs': "console.log('passes on both sides');\n" });
  const result = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: 'node spec/check.mjs' });
  assert.equal(result.pass, false);
  assert.match(result.reason, /does not reproduce the bug/);
  assert.deepEqual(result.overlaid, ['spec/check.mjs']);
});

test('setup runs in both worktrees with the main repository root', async () => {
  const repo = await makeRepo('broken', 'fixed');
  const result = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, setup: 'test -f "$MEND_REPO_ROOT/value.txt" && touch dependency', command: `test -f dependency || exit 2; ${CHECK}` });
  assert.equal(result.pass, true, result.reason);
  assert.equal(result.baseExit, 1);
  assert.equal(result.headExit, 0);
});

test('without a setup, both checkouts use the dependencies the source checkout installed, so a missing package is not a red', async () => {
  const repo = await makeRepo('broken', 'fixed');
  await addHeadFiles(repo, { '.gitignore': 'node_modules/\n' });
  await fs.mkdir(path.join(repo.root, 'node_modules/dep'), { recursive: true });
  await fs.writeFile(path.join(repo.root, 'node_modules/dep/index.txt'), 'installed\n');
  const command = `test -f node_modules/dep/index.txt || exit 2; ${CHECK}`;
  const result = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command, tempRoot: PRIVATE_TMP });
  assert.equal(result.pass, true, result.reason);
  assert.equal(result.baseExit, 1, 'the base fails on the bug, not on the missing package');
  assert.equal(await fs.readFile(path.join(repo.root, 'node_modules/dep/index.txt'), 'utf8'), 'installed\n', 'cleanup leaves the installed dependencies alone');
  const withSetup = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, setup: 'true', command, tempRoot: PRIVATE_TMP });
  assert.equal(withSetup.headExit, 2, 'a setup command installs its own dependencies; nothing is linked');
});

test('keep runs in both prepared worktrees and records exits and logs', async () => {
  const repo = await makeRepo('broken', 'fixed');
  const keep = 'test -f dependency && echo keep-ok';
  const result = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, setup: 'touch dependency', command: CHECK, keep });
  assert.equal(result.pass, true, result.reason);
  assert.deepEqual(result.keep, { command: keep, baseExit: 0, headExit: 0, logs: { base: 'keep-ok\n', head: 'keep-ok\n' } });
});

test('keep failing on either side fails the run', async () => {
  const repo = await makeRepo('broken', 'fixed');
  for (const [keep, side] of [['test "$(cat value.txt)" = fixed', 'base'], ['test "$(cat value.txt)" = broken', 'head']]) {
    const result = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: CHECK, keep });
    assert.equal(result.pass, false);
    assert.match(result.reason, new RegExp(`keep.*${side}`));
    assert.notEqual(result.keep[`${side}Exit`], 0);
  }
});

test('CLI forwards keep and the guard preflights it before setup', async () => {
  const repo = await makeRepo('broken', 'fixed');
  const result = runCli(['--repo', repo.root, '--base', repo.baseSha, '--head', repo.headSha, '--cmd', CHECK, '--keep', 'echo preserved', '--json']);
  assert.equal(result.status, EXIT.pass, result.stderr);
  assert.equal(JSON.parse(result.stdout).keep.logs.base, 'preserved\n');
  const marker = path.join(repo.root, 'keep-guard-marker');
  await assert.rejects(runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: CHECK, setup: `touch '${marker}'`, keep: 'cat .env' }), RedGreenBlockedError);
  await assert.rejects(fs.access(marker));
});

test('expected base signature passes only when the base log matches', async () => {
  const repo = await makeRepo('broken', 'fixed');
  const command = 'test "$(cat value.txt)" = fixed || { echo BUG_SIGNATURE; exit 1; }';
  const matching = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command, expectBase: 'BUG_SIGNATURE' });
  assert.equal(matching.pass, true, matching.reason);
  assert.equal(matching.baseMatched, true);
  const other = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: `${command}; exit 1`, expectBase: 'MISSING_SIGNATURE' });
  assert.equal(other.pass, false);
  assert.equal(other.baseMatched, false);
  assert.match(other.reason, /the base fails, but not with the expected failure \(expected \/MISSING_SIGNATURE\/\)/);
});

test('without an expected base signature behavior is unchanged', async () => {
  const repo = await makeRepo('broken', 'fixed');
  const result = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: CHECK });
  assert.equal(result.pass, true);
  assert.equal(result.expectBase, null);
  assert.equal(result.baseMatched, null);
});

test('invalid expected base expression is a usage error', async () => {
  const repo = await makeRepo('broken', 'fixed');
  await assert.rejects(runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: CHECK, expectBase: '[' }), RedGreenUsageError);
});

test('a failing setup blocks and identifies the side and command', async () => {
  const repo = await makeRepo('broken', 'fixed');
  for (const [setup, side] of [['exit 7', 'base'], ['test "$(cat value.txt)" != fixed', 'head']]) {
    await assert.rejects(runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, setup, command: CHECK }),
      (error) => error instanceof RedGreenBlockedError && error.message.includes(side) && error.message.includes(setup));
  }
});

test('the guard blocks regression and setup commands before any shell side effect', async () => {
  const repo = await makeRepo('broken', 'fixed');
  const marker = path.join(repo.root, 'unguarded-marker');
  const refused = `touch '${marker}'; cat .env`;
  for (const commands of [
    { command: refused },
    { command: CHECK, setup: refused },
    { command: refused, setup: `touch '${marker}'` },
  ]) {
    await assert.rejects(runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, ...commands }),
      (error) => error instanceof RedGreenBlockedError && /secret-read/.test(error.message));
    await assert.rejects(fs.access(marker), 'neither setup nor regression may run before preflight');
    assert.equal(worktreeCount(repo.root), 1);
  }
});

test('temporary regression worktrees use the source repository guard policy', async () => {
  const repo = await makeRepo('broken', 'fixed');
  await fs.mkdir(path.join(repo.root, '.mend'));
  await fs.writeFile(path.join(repo.root, '.mend', 'guard.json'), JSON.stringify({ productionPatterns: ['guard-policy-target'] }));
  const marker = path.join(repo.root, 'policy-marker');
  await assert.rejects(runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha,
    command: `touch '${marker}'; printf guard-policy-target` }),
  (error) => error instanceof RedGreenBlockedError && /production-pattern/.test(error.message));
  await assert.rejects(fs.access(marker));
});

test('a missing guard runtime blocks rather than running the shell', async () => {
  const repo = await makeRepo('broken', 'fixed');
  const marker = path.join(repo.root, 'runtime-marker');
  await assert.rejects(runCommand({ command: `printf ran > '${marker}'`, cwd: repo.root, timeoutMs: 1000,
    env: { ...process.env, PATH: '' } }),
  (error) => error instanceof RedGreenBlockedError && /guard/i.test(error.message));
  await assert.rejects(fs.access(marker));
});

test('CLI accepts setup', async () => {
  const repo = await makeRepo('broken', 'fixed');
  const result = runCli(['--repo', repo.root, '--base', repo.baseSha, '--head', repo.headSha, '--setup', 'touch dependency', '--cmd', `test -f dependency || exit 2; ${CHECK}`, '--json']);
  assert.equal(result.status, EXIT.pass, result.stderr);
  assert.equal(JSON.parse(result.stdout).baseExit, 1);
});

test('CLI accepts --expect-base', async () => {
  const repo = await makeRepo('broken', 'fixed');
  const result = runCli(['--repo', repo.root, '--base', repo.baseSha, '--head', repo.headSha, '--cmd', 'test "$(cat value.txt)" = fixed || { echo BUG_SIGNATURE; exit 1; }', '--expect-base', 'BUG_SIGNATURE', '--json']);
  assert.equal(result.status, EXIT.pass, result.stderr);
  assert.equal(JSON.parse(result.stdout).baseMatched, true);
});

async function redGreenDirs() {
  return (await fs.readdir(PRIVATE_TMP)).filter((name) => name.startsWith('mend-red-green-'));
}

function worktreeCount(root) {
  return gitSync(root, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).length;
}

test('fail at base and pass at head is a PASS, and only temporary worktrees were used', async () => {
  const repo = await makeRepo('broken', 'fixed');
  // An uncommitted edit in the user's checkout must be neither seen nor touched.
  await fs.writeFile(path.join(repo.root, 'value.txt'), 'user edit in progress\n');
  const before = await redGreenDirs();
  const result = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: `pwd; ${CHECK}`, timeoutMs: 20_000, tempRoot: PRIVATE_TMP });
  assert.equal(result.pass, true, result.reason);
  assert.equal(result.baseExit, 1);
  assert.equal(result.headExit, 0);
  assert.ok(!result.logs.base.includes(repo.root) && !result.logs.head.includes(repo.root), 'commands ran outside the user checkout');
  assert.match(result.logs.head, /mend-red-green-[^/]+\/head/);
  assert.equal(await fs.readFile(path.join(repo.root, 'value.txt'), 'utf8'), 'user edit in progress\n');
  assert.equal(worktreeCount(repo.root), 1, 'temporary worktrees are removed');
  assert.deepEqual(await redGreenDirs(), before, 'the temporary folder is removed');
});

test('pass at base and pass at head fails with "test does not reproduce the bug"', async () => {
  const repo = await makeRepo('fixed', 'fixed');
  const result = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: CHECK, timeoutMs: 20_000 });
  assert.equal(result.pass, false);
  assert.equal(result.baseExit, 0);
  assert.equal(result.headExit, 0);
  assert.match(result.reason, /test does not reproduce the bug/);
  assert.equal(worktreeCount(repo.root), 1);
});

test('fail at base and fail at head fails because head still fails', async () => {
  const repo = await makeRepo('broken', 'still broken');
  const result = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: CHECK, timeoutMs: 20_000 });
  assert.equal(result.pass, false);
  assert.notEqual(result.headExit, 0);
  assert.match(result.reason, /still fails at head/);
});

test('a command that hangs is killed at the timeout and the run fails', async () => {
  const repo = await makeRepo('broken', 'fixed');
  const before = await redGreenDirs();
  const started = Date.now();
  const result = await runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: 'sleep 30', timeoutMs: 300, tempRoot: PRIVATE_TMP });
  assert.ok(Date.now() - started < 10_000, 'the timeout stopped the command');
  assert.equal(result.pass, false);
  assert.equal(result.baseExit, 124);
  assert.match(result.reason, /timed out/);
  assert.match(result.logs.base, /timed out after 300 ms/);
  assert.equal(worktreeCount(repo.root), 1);
  assert.deepEqual(await redGreenDirs(), before);
});

test('a worktree that cannot be created is BLOCKED, runs nothing and leaves nothing behind', async () => {
  const repo = await makeRepo('broken', 'fixed');
  await fs.writeFile(path.join(repo.root, '.git', 'worktrees'), 'not a folder\n');
  const marker = path.join(repo.root, '..', `${path.basename(repo.root)}-ran`);
  temporaryDirs.push(marker);
  const before = await redGreenDirs();
  await assert.rejects(
    runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: `touch '${marker}'`, timeoutMs: 20_000, tempRoot: PRIVATE_TMP }),
    (error) => error instanceof RedGreenBlockedError && /git worktree add failed/.test(error.message),
  );
  await assert.rejects(fs.access(marker), 'the command never ran');
  assert.deepEqual(await redGreenDirs(), before);
});

test('missing or unknown SHAs and an empty command are usage errors', async () => {
  const repo = await makeRepo('broken', 'fixed');
  await assert.rejects(runRedGreen({ repo: repo.root, baseSha: '', headSha: repo.headSha, command: CHECK }), RedGreenUsageError);
  await assert.rejects(runRedGreen({ repo: repo.root, baseSha: 'f00dfeed', headSha: repo.headSha, command: CHECK }), RedGreenUsageError);
  await assert.rejects(runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: ' ' }), RedGreenUsageError);
  await assert.rejects(runRedGreen({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, command: CHECK, tempRoot: '' }), RedGreenUsageError);
});

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: GIT_ENV });
}

test('CLI exit codes: 0 pass, 1 fail, 3 blocked, 64 usage', async () => {
  const good = await makeRepo('broken', 'fixed');
  const pass = runCli(['--repo', good.root, '--base', good.baseSha, '--head', good.headSha, '--cmd', CHECK]);
  assert.equal(pass.status, EXIT.pass, pass.stderr);
  assert.match(pass.stdout, /PASS: base exit 1, head exit 0/);

  const same = await makeRepo('fixed', 'fixed');
  const fail = runCli(['--repo', same.root, '--base', same.baseSha, '--head', same.headSha, '--cmd', CHECK, '--json']);
  assert.equal(fail.status, EXIT.fail);
  assert.match(JSON.parse(fail.stdout).reason, /test does not reproduce the bug/);

  await fs.writeFile(path.join(same.root, '.git', 'worktrees'), 'not a folder\n');
  const blocked = runCli(['--repo', same.root, '--base', same.baseSha, '--head', same.headSha, '--cmd', CHECK]);
  assert.equal(blocked.status, EXIT.blocked);
  assert.match(blocked.stderr, /BLOCKED/);

  for (const args of [
    ['--repo', good.root, '--base', good.baseSha, '--head', good.headSha],
    ['--repo', good.root, '--base', 'nope', '--head', good.headSha, '--cmd', CHECK],
    ['--repo', good.root, '--base', good.baseSha, '--head', good.headSha, '--cmd', CHECK, '--keep'],
  ]) {
    const usage = runCli(args);
    assert.equal(usage.status, EXIT.usage, args.join(' '));
    assert.equal(usage.stdout, '');
  }
});
