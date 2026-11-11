import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('changed caller invalidates an old green despite an identical patch', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'mend-integration-policy-'));
  const run = (command, args, input) => spawnSync(command, args, {
    cwd: repo, input, encoding: 'utf8', env: { ...process.env,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
  });
  const git = (...args) => {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q');
    writeFileSync(path.join(repo, 'value.cjs'), 'module.exports = () => 1;\n');
    writeFileSync(path.join(repo, 'caller.cjs'), "if (require('./value.cjs')() !== 2) process.exit(1);\n");
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(path.join(repo, 'value.cjs'), 'module.exports = () => 2;\n');
    git('commit', '-qam', 'item');
    const oldHead = git('rev-parse', 'HEAD');
    assert.equal(run(process.execPath, ['caller.cjs']).status, 0);
    git('checkout', '-q', '--detach', base);
    writeFileSync(path.join(repo, 'caller.cjs'), "if (require('./value.cjs')() !== 3) process.exit(1);\n");
    git('commit', '-qam', 'trunk caller change');
    const trunk = git('rev-parse', 'HEAD');
    git('cherry-pick', oldHead);
    const integration = git('rev-parse', 'HEAD');
    const patchId = (from, to) => {
      const diff = run('git', ['diff', from, to]);
      assert.equal(diff.status, 0, diff.stderr);
      const result = run('git', ['patch-id', '--stable'], diff.stdout);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.trim());
      return result.stdout.trim().split(/\s+/)[0];
    };
    assert.equal(patchId(base, oldHead), patchId(trunk, integration));
    assert.deepEqual(git('diff', '--name-only', base, trunk).split('\n'), ['caller.cjs']);
    assert.notEqual(run(process.execPath, ['caller.cjs']).status, 0);

    // This is a policy contract test, not an automated merge-gate implementation.
    const policy = readFileSync(new URL('../skills/mend-ship/SKILL.md', import.meta.url), 'utf8');
    const record = readFileSync(new URL('../skills/create-verification/SKILL.md', import.meta.url), 'utf8');
    assert.match(record, /integrationInputs[\s\S]*callers, contracts, lockfiles and check configuration/);
    assert.match(policy, /If any input changed, rerun each affected check on the actual result proposed for integration/);
    assert.match(policy, /A failed, blocked or missing rerun blocks merge; the old green cannot be reused for that check, even when the patch-id is equal/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
