import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('verification template uses plain single-command invocations', () => {
  const template = readFileSync(new URL('./template.md', import.meta.url), 'utf8');
  const skill = template.match(/```markdown\n([\s\S]*?)\n```/);
  assert.ok(skill, 'skill template exists');
  const commands = [...skill[1].matchAll(/^    (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(commands, ['node .mend/verify/verify.mjs']);
  for (const command of commands) {
    assert.doesNotMatch(command, /\b(?:for|while|until|do|done)\b|\bset\s+-e\b|[$`;&|]/);
    assert.match(command, /^node \.mend\/verify\/verify\.mjs$/);
  }
  assert.doesNotMatch(skill[1], /\$\?|\$\(|`\s*\{\s*echo/);
});

test('template record helper writes real success, failure and blocked records', () => {
  const template = readFileSync(new URL('./template.md', import.meta.url), 'utf8');
  const helper = template.match(/## Record helper[^\n]*\n[\s\S]*?```js\n([\s\S]*?)\n```/);
  assert.ok(helper, 'record helper code block exists');
  const repo = mkdtempSync(path.join(os.tmpdir(), 'verify-template-'));
  try {
    mkdirSync(path.join(repo, '.mend/verify'), { recursive: true });
    writeFileSync(path.join(repo, '.mend/verify/record.mjs'), helper[1]);
    writeFileSync(path.join(repo, '.mend/verify/verify.mjs'), `
import { runVerification } from './record.mjs';
await runVerification({ skill: '.mendcode/skills/verify-fixture/SKILL.md', sha: 'abc123', profiles: { generic: 'PASS' } }, async record => {
  record.steps.push({ name: 'check', command: 'node check.mjs', exit: process.argv[2] === 'fail' ? 2 : 0, log: '.mend/evidence/verify/check.log', integrationInputs: ['check.mjs'] });
  record.feature = 'fixture';
  record.evidencePath = '.mend/evidence/verify/';
  record.evidenceSurvivedCleanup = true;
  if (process.argv[2] === 'throw') throw new Error('drive failed');
  return process.argv[2] === 'blocked' ? 'BLOCKED' : 'PASS';
});
`);
    for (const [scenario, result, exit] of [['pass', 'PASS', 0], ['fail', 'FAIL', 1], ['throw', 'FAIL', 1], ['blocked', 'BLOCKED', 1]]) {
      const run = spawnSync(process.execPath, ['.mend/verify/verify.mjs', scenario], { cwd: repo, encoding: 'utf8' });
      assert.equal(run.status, exit, run.stderr);
      const record = JSON.parse(readFileSync(path.join(repo, '.mend/evidence/verify.json'), 'utf8'));
      assert.equal(record.result, result);
      assert.equal(record.skill, '.mendcode/skills/verify-fixture/SKILL.md');
      assert.equal(record.sha, 'abc123');
      assert.ok(!Number.isNaN(Date.parse(record.at)));
      assert.deepEqual(record.profiles, { generic: 'PASS' });
      assert.deepEqual(record.steps, [{ name: 'check', command: 'node check.mjs', exit: scenario === 'fail' ? 2 : 0, log: '.mend/evidence/verify/check.log', integrationInputs: ['check.mjs'] }]);
      assert.equal(record.feature, 'fixture');
      assert.equal(record.evidencePath, '.mend/evidence/verify/');
      assert.equal(record.evidenceSurvivedCleanup, true);
      if (scenario === 'throw') assert.equal(record.error, 'drive failed');
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
