import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { stdinArgs } from './stdin-args.mjs';

const probe = `
  import { stdinArgs } from ${JSON.stringify(new URL('./stdin-args.mjs', import.meta.url).href)};
  const args = stdinArgs(process.argv.slice(1));
  console.log(JSON.stringify({ args, policy: process.env.MEND_REVIEW_POLICY ?? null }));
`;
const run = (args, input) => spawnSync(process.execPath, ['--input-type=module', '-e', probe, '--', ...args], {
  input, encoding: 'utf8', env: { ...process.env, MEND_REVIEW_POLICY: 'inherited-policy' },
});

test('stdin argument transport preserves literal data and replaces or clears inherited policy', () => {
  const args = ['literal\n"\' $ \\ &;', 'x'.repeat(200_000)];
  const policy = { fingerprint: 'captured', generatedFiles: ['*.cache'] };
  const result = run(['--stdin'], JSON.stringify({ args, policy }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args, policy: JSON.stringify(policy) });
  const cleared = run(['--stdin'], JSON.stringify({ args: ['plan'], policy: null }));
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(JSON.parse(cleared.stdout), { args: ['plan'], policy: null });
});

test('direct CLI arguments do not read stdin or change policy, malformed transport fails closed', () => {
  const args = ['plan', '--item', 'item.json'];
  assert.equal(stdinArgs(args), args);
  const direct = run(args, 'not JSON');
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout), { args, policy: 'inherited-policy' });
  for (const input of ['', '{', '{}', '{"args":"bad"}', '{"args":[null]}']) {
    const result = run(['--stdin'], input);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
  assert.throws(() => stdinArgs(['plan', '--stdin']), /cannot be combined/);
});
