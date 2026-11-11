import { test } from 'node:test';
import assert from 'node:assert/strict';
import moduleMap from './module-map.mjs';

test('the integration must match the approved file and export map', async () => {
  const fixture = {
    files: [{ path: 'src/a.js', base: 'export const a = 1;\n', head: 'export const b = 1;\n' }],
    proposal: { files: [{ path: 'src/a.js', before: ['a'], after: ['b'] }] },
  };
  assert.equal((await moduleMap.runFixture(fixture)).pass, true);
  fixture.proposal.files[0].after = ['c'];
  assert.equal((await moduleMap.runFixture(fixture)).pass, false);
  fixture.proposal = null;
  assert.equal((await moduleMap.runFixture(fixture)).pass, false);
});
