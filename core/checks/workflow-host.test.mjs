import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { host } from './workflow-host.mjs';
import { loadReviewPolicy } from './review-policy.mjs';
import { makeFixtureRepo, gitSync, removeAll } from './test-support.mjs';

const script = (name) => fileURLToPath(new URL(name, import.meta.url));
function cli(name, args, policy = null) {
  return spawnSync(process.execPath, [script(name), '--stdin'], { input: JSON.stringify({ args, policy }), encoding: 'utf8' });
}

async function fixture(t) {
  const dirs = [];
  t.after(() => removeAll(dirs));
  return makeFixtureRepo({ dirs, prefix: 'mend-host space-', files: [
    { path: '.gitignore', base: '.mend/\n', head: '.mend/\n' },
    { path: 'src/value.js', base: 'export const value = 1;\n', head: 'export const value = 2;\n' },
    { path: 'build.tsbuildinfo', base: 'old\n', head: 'new\n' },
  ] });
}

test('host runs literal Git argv, counts with exclusions and computes patch-id without a shell pipe', async (t) => {
  const { root: cwd, baseSha: base, headSha: head } = await fixture(t);
  assert.equal((await host('git', { cwd, args: ['rev-parse', 'HEAD'] })).trim(), head);
  const result = cli('workflow-host.mjs', ['git', JSON.stringify({ cwd, args: ['rev-parse', 'HEAD'] })]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), head);
  assert.deepEqual(JSON.parse(await host('count', { cwd, base, head, pathspec: ['.', ':(exclude)*.tsbuildinfo'] })), { count: 1 });
  const diff = gitSync(cwd, ['diff', base, head]) + '\n';
  const expected = spawnSync('git', ['patch-id', '--stable'], { cwd, input: diff, encoding: 'utf8' });
  assert.equal(expected.status, 0, expected.stderr);
  assert.equal(await host('patch-id', { cwd, base, head }), expected.stdout);
  await assert.rejects(host('git', { cwd, args: ['rev-parse', '--verify', 'not-a-commit'] }));
});

test('host reads files as data and refuses unsafe worktree parents', async (t) => {
  const { root: cwd } = await fixture(t);
  const file = path.join(cwd, 'data.json');
  await fs.writeFile(file, '{"literal":"$;\\n"}');
  assert.deepEqual(JSON.parse(await host('read-json', { file })), { literal: '$;\n' });
  assert.equal(await host('read', { cwd, file: 'data.json' }), '{"literal":"$;\\n"}');
  assert.equal(await host('exists', { file }), '');
  await assert.rejects(host('exists', { file, directory: true }), /wrong file type/);
  await assert.rejects(host('read-json', { file: path.join(cwd, 'missing.json') }));
  assert.equal(await host('worktree-preflight', { cwd }), '');
  await fs.mkdir(path.join(cwd, '.mend'));
  await fs.symlink(cwd, path.join(cwd, '.mend/worktrees'), 'dir');
  await assert.rejects(host('worktree-preflight', { cwd }), /not a real directory/);
  await assert.rejects(host('unknown', {}), /unknown host operation/);
});

test('capture records real failures, stdout and stderr, and never executes guard refusals', async (t) => {
  const { root: cwd } = await fixture(t);
  for (const [command, exit] of [
    ['printf stdout; printf stderr >&2; exit 7', 7],
    ['true', 0],
    ['kill -TERM $$', 1],
  ]) {
    const file = '.mend/evidence/check.log';
    assert.deepEqual(JSON.parse(await host('execute', { cwd, command, file })), { exit });
    const log = await fs.readFile(path.join(cwd, file), 'utf8');
    assert.ok(log.startsWith('$ ' + command + '\n'));
    assert.ok(log.endsWith('\nexit: ' + exit + '\n'));
    if (exit === 7) assert.match(log, /stdoutstderr/);
    assert.equal(await host('tail', { cwd, file }), 'exit: ' + exit);
  }
  const file = '.mend/evidence/refused.log';
  for (const operation of ['guard', 'execute']) {
    await assert.rejects(host(operation, { cwd, file, command: 'git push --force origin main' }), /git-force/);
  }
  await assert.rejects(fs.access(path.join(cwd, file)));
  const envLog = '.mend/evidence/environment.log';
  const inherited = spawnSync(process.execPath, [script('workflow-host.mjs'), '--stdin'], {
    input: JSON.stringify({ args: ['execute', JSON.stringify({ cwd, file: envLog, command: 'printf "CI=%s TERM=%s" "$CI" "$TERM"' })] }),
    env: { ...process.env, CI: '1', TERM: 'dumb' }, encoding: 'utf8',
  });
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.match(await fs.readFile(path.join(cwd, envLog), 'utf8'), /\nCI=1 TERM=dumb\nexit: 0\n$/);
});

test('stdin CLIs retain direct argument behavior and bind the frozen review policy', async (t) => {
  const { root: repo, baseSha, headSha } = await fixture(t);
  await fs.mkdir(path.join(repo, '.mend'));
  const config = path.join(repo, '.mend/quality.json');
  await fs.writeFile(config, '{}');
  const policy = await loadReviewPolicy({ repo, baseSha });
  const item = path.join(repo, '.mend/item.json');
  await fs.writeFile(item, JSON.stringify({ id: 'fixture', profiles: [], editSet: ['src/value.js'] }));
  const cases = [
    ['review-policy.mjs', [repo, baseSha]],
    ['approval.mjs', ['snapshot', repo, JSON.stringify([{ path: 'src/value.js' }])]],
    ['quality-prompts.mjs', ['owner', JSON.stringify({ proposalStage: true, feedback: `café\n'" $; \\ ` + 'long '.repeat(5000), approvedProposals: [] })]],
    ['quality-review.mjs', ['drift', JSON.stringify({ firstScores: null })]],
    ['run-rubric.mjs', ['plan', '--item', item]],
    ['integrity.mjs', ['--repo', repo, '--item', item, '--base', baseSha, '--head', headSha, '--json']],
  ];
  for (const [name, args] of cases) {
    const direct = spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8', env: { ...process.env, MEND_REVIEW_POLICY: JSON.stringify(policy) } });
    const stdin = cli(name, args, policy);
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(stdin.status, direct.status, stdin.stderr);
    assert.deepEqual(JSON.parse(stdin.stdout), JSON.parse(direct.stdout), name);
  }
  await fs.writeFile(config, '{"generatedFiles":["src/**"]}');
  for (const [name, args] of cases.filter(([name]) => ['review-policy.mjs', 'integrity.mjs'].includes(name))) {
    const result = cli(name, args, policy);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /review policy changed after capture/);
  }
  for (const input of ['{', '{}', '{"args":[1]}']) {
    const result = spawnSync(process.execPath, [script('workflow-host.mjs'), '--stdin'], { input, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});
