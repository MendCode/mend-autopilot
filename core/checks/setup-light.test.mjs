import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSetup, SetupError } from './setup-light.mjs';

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'setup-light-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(path.join(dir, 'ok.sh'), 'echo fine\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}
const status = (dir) => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });

test('passing commands record PASS and leave every tracked file and .gitignore untouched', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = runSetup({ repo: dir, commands: ['sh ok.sh', 'true'] });
  assert.equal(result.result, 'PASS');
  assert.equal(result.ignored, 'added to .git/info/exclude');
  const record = JSON.parse(readFileSync(path.join(dir, '.mend/evidence/verify.json'), 'utf8'));
  assert.deepEqual(record.steps.map((step) => [step.command, step.exit]), [['sh ok.sh', 0], ['true', 0]]);
  assert.equal(record.profiles.generic, 'PASS');
  assert.match(record.skill, /^\.mendcode\/skills\/verify-setup-light-[a-z0-9-]+\/SKILL\.md$/);
  assert.match(readFileSync(path.join(dir, record.skill), 'utf8'), /- `sh ok\.sh`/);
  assert.ok(JSON.parse(readFileSync(path.join(dir, '.mend/exemplars/index.json'), 'utf8')).some((entry) => entry.profile === 'generic' && entry.none));
  assert.equal(status(dir), '', 'no tracked or unignored file changed');
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.mend/worktrees/probe'], { cwd: dir }).status, 0);
  assert.ok(!existsSync(path.join(dir, '.gitignore')));
});

test('a failing command records FAIL with its log, so no item is dispatched on it', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = runSetup({ repo: dir, commands: ['true', 'echo broken >&2; exit 3'] });
  assert.equal(result.result, 'FAIL');
  assert.equal(result.steps[1].exit, 3);
  assert.match(result.steps[1].tail, /broken/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.mend/evidence/verify.json'), 'utf8')).profiles.generic, 'FAIL');
});

test('running it again does not duplicate the exclude line or the exemplar', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  runSetup({ repo: dir, commands: ['true'] });
  const second = runSetup({ repo: dir, commands: ['true'] });
  assert.equal(second.ignored, 'already ignored');
  const exclude = readFileSync(path.join(dir, '.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '.mend/').length, 1);
  assert.equal(exclude.split('\n').filter((line) => line.startsWith('.mendcode/skills/verify-')).length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.mend/exemplars/index.json'), 'utf8')).length, 1);
});

test('relative repos, no commands and multi-line commands are refused', () => {
  assert.throws(() => runSetup({ repo: 'relative', commands: ['true'] }), SetupError);
  assert.throws(() => runSetup({ repo: '/tmp', commands: [] }), SetupError);
  assert.throws(() => runSetup({ repo: '/tmp', commands: ['true\nrm -rf /'] }), SetupError);
});
