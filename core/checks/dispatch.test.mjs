import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorize, riskForChanges } from './dispatch.mjs';

const plan = { profiles: [{ kind: 'generic', riskFloor: 'low' }] };
const item = { id: 'fixture', type: 'change', risk: 'low' };

test('effective authorization never raises the item, grant or previously dispatched rung', () => {
  assert.equal(authorize(item, plan, null).rung, 'draft');
  assert.equal(authorize({ ...item, rung: 'draft' }, plan, { rung: 'autopilot', queue: true }).rung, 'draft');
  assert.equal(authorize(item, plan, { rung: 'full', disposable: false }).rung, 'autopilot');
  assert.equal(authorize(item, plan, { rung: 'full', disposable: true }).rung, 'full');
  assert.equal(authorize(item, plan, { rung: 'autopilot' }, 'low', 'draft').rung, 'draft');
  assert.equal(authorize(item, { profiles: [{ riskFloor: 'medium' }] }, { rung: 'full', disposable: true }).rung, 'draft');
  for (const input of [{ ...item, type: 'investigate' }, { ...item, rung: 'investigate' }, { ...item, rung: 'invalid' }]) {
    assert.throws(() => authorize(input, plan, { rung: 'full', disposable: true }));
  }
  assert.throws(() => authorize(item, plan, { rung: 'investigate' }));
  assert.throws(() => authorize(item, plan, {}));
});

for (const file of ['bun.lockb', 'npm-shrinkwrap.json', 'packages/app/bun.lockb', 'packages/app/npm-shrinkwrap.json']) {
  test(`a change only to ${file} raises risk and caps authorization at draft`, () => {
    const risk = riskForChanges([{ status: 'M', paths: [file] }]);
    assert.equal(risk.tier, 'high');
    for (const rung of ['autopilot', 'full']) {
      const authorization = authorize(item, plan, { rung, queue: true, disposable: true }, risk.tier);
      assert.equal(authorization.tier, 'high');
      assert.equal(authorization.rung, 'draft');
    }
  });
}

test('actual changed paths and deletions raise risk regardless of the declared low risk', () => {
  for (const file of ['src/auth/login.js', 'db/migrations/001.sql', 'src/payments/charge.js', '.github/workflows/build.yml', 'pnpm-lock.yaml', 'api/openapi.yaml']) {
    assert.equal(riskForChanges([{ status: 'M', paths: [file] }]).tier, 'high', file);
  }
  assert.equal(riskForChanges([{ status: 'D', paths: ['src/total.js'] }]).tier, 'high');
  assert.equal(riskForChanges([{ status: 'R100', paths: ['src/auth/old.js', 'src/total.js'] }]).tier, 'high');
  assert.equal(riskForChanges([{ status: 'M', paths: ['src/shared/total.js'] }]).tier, 'medium');
  const risk = riskForChanges([{ status: 'M', paths: ['src/contract.json'] }], { publicSurface: ['src/contract.json'] });
  assert.equal(risk.tier, 'high');
  assert.equal(authorize(item, plan, { rung: 'autopilot', queue: true }, risk.tier).rung, 'draft');
});
