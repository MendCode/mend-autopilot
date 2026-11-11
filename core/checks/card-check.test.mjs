import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(path.join(HERE, '..', 'skills', 'mend-ship', 'evidence-card.schema.json'), 'utf8'));
const dirs = [];
after(() => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function repoWithCard(card) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mend-card-check-'));
  dirs.push(dir);
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
  git('init', '-q', '-b', 'main');
  await fs.writeFile(path.join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  const file = path.join(dir, 'card.json');
  await fs.writeFile(file, JSON.stringify(card));
  return { dir, base, file };
}

const runCheck = ({ file, dir, base }) => spawnSync(process.execPath, [path.join(HERE, 'card-check.mjs'), '--stdin'], { input: JSON.stringify({ args: [file, dir, base] }), encoding: 'utf8' });

test('a valid card passes with no secret, and a broken one lists its schema failures', async () => {
  const valid = await repoWithCard(SCHEMA.examples[0]);
  const ok = runCheck(valid);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { secret: null, failures: [] });
  const { problem, ...broken } = SCHEMA.examples[0];
  assert.ok(problem);
  const bad = runCheck(await repoWithCard(broken));
  assert.ok(JSON.parse(bad.stdout).failures.some((failure) => failure.rule === 'card-schema' && /missing problem/.test(failure.detail)));
});

test('a secret-like value in the card is reported by kind, never by value', async () => {
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const card = { ...SCHEMA.examples[0], rollback: 'revert, then rotate ' + token };
  const result = runCheck(await repoWithCard(card));
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.secret, 'string');
  assert.ok(!result.stdout.includes(token));
});
