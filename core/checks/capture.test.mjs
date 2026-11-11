import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { capture, captureDeclared, evidenceLines, readCaptures } from './capture.mjs';
import { makeFixtureRepo, removeAll } from './test-support.mjs';

const dirs = [];
after(() => removeAll(dirs));

test('capture blocks prohibited commands before they create side effects', async () => {
  const repo = await makeFixtureRepo({ files: [{ path: 'a.txt', base: 'a', head: 'b' }], dirs });
  const marker = path.join(repo.root, 'marker');
  await assert.rejects(capture({ repo: repo.root, item: { id: 'blocked' }, kind: 'tests', command: `git push --force origin main; touch ${JSON.stringify(marker)}` }), /git-force/);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(repo.root, '.mend', 'evidence', 'blocked')), { code: 'ENOENT' });
});

test('capture fails closed on guard configuration warnings', async () => {
  const repo = await makeFixtureRepo({ files: [{ path: 'a.txt', base: 'a', head: 'b' }], dirs });
  await fs.mkdir(path.join(repo.root, '.mend'), { recursive: true });
  await fs.writeFile(path.join(repo.root, '.mend', 'guard.json'), '{');
  const marker = path.join(repo.root, 'marker');
  await assert.rejects(capture({ repo: repo.root, item: { id: 'warning' }, kind: 'tests', command: `touch ${JSON.stringify(marker)}` }), /warning/);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

test('capture binds the full log to its commit and rejects a modified or missing log', async () => {
  const repo = await makeFixtureRepo({ files: [{ path: 'a.txt', base: 'a', head: 'b' }], dirs });
  const args = { repo: repo.root, itemId: 'item-1', kind: 'request', headSha: repo.headSha };
  const record = await capture({ repo: repo.root, item: { id: args.itemId }, kind: args.kind, command: `node -e "console.log('MEND_EVIDENCE '+JSON.stringify({method:'GET',url:'http://localhost/',status:200}))"` });
  const captures = await readCaptures(args);
  assert.equal(captures.length, 1);
  assert.equal(evidenceLines(captures[0].output)[0].status, 200);
  assert.equal((await readCaptures({ ...args, headSha: repo.baseSha })).length, 0);
  const log = path.join(repo.root, '.mend', 'evidence', args.itemId, 'captures', record.log);
  await fs.appendFile(log, 'tampered');
  assert.equal((await readCaptures(args)).length, 0);
  await fs.unlink(log);
  assert.equal((await readCaptures(args)).length, 0);
});

test('fragmented stdout evidence survives interleaved stderr and both streams remain intact', async () => {
  const repo = await makeFixtureRepo({ files: [{ path: 'a.txt', base: 'a', head: 'b' }], dirs });
  const args = { repo: repo.root, itemId: 'streams', kind: 'request', headSha: repo.headSha };
  const script = `process.stdout.write('MEND_EVIDENCE {"status":'); setTimeout(() => { process.stderr.write('diagnostic\\n'); setTimeout(() => process.stdout.write('200}\\n'), 50); }, 50);`;
  await capture({ repo: repo.root, item: { id: args.itemId }, kind: args.kind, command: `node -e ${JSON.stringify(script)}` });
  const [result] = await readCaptures(args);
  assert.deepEqual(evidenceLines(result.output), [{ status: 200 }]);
  assert.equal(result.output, 'MEND_EVIDENCE {"status":200}\n');
  assert.equal(result.stderr, 'diagnostic\n');
});

test('declared captures run at head and in a clean base checkout, filed under the item and readable for both commits', async () => {
  const repo = await makeFixtureRepo({ files: [{ path: 'a.txt', base: 'a', head: 'b' }], dirs });
  const item = { id: 'refactor-1', captures: [{ kind: 'tests', command: 'cat a.txt', at: 'both' }] };
  const records = await captureDeclared({ repo: repo.root, item, baseSha: repo.baseSha, headSha: repo.headSha });
  assert.equal(records.length, 2);
  const [head] = await readCaptures({ repo: repo.root, itemId: item.id, kind: 'tests', headSha: repo.headSha });
  const [base] = await readCaptures({ repo: repo.root, itemId: item.id, kind: 'tests', headSha: repo.baseSha });
  assert.deepEqual([base.output, head.output], ['a', 'b']);
  assert.equal(execFileSync('git', ['-C', repo.root, 'worktree', 'list']).toString().trim().split('\n').length, 1);
});

test('declared captures are not taken again for a commit that already has them', async () => {
  const repo = await makeFixtureRepo({ files: [{ path: 'a.txt', base: 'a', head: 'b' }], dirs });
  const item = { id: 'api-1', captures: [{ kind: 'request', command: 'cat a.txt' }] };
  await captureDeclared({ repo: repo.root, item, baseSha: repo.baseSha, headSha: repo.headSha });
  assert.deepEqual(await captureDeclared({ repo: repo.root, item, baseSha: repo.baseSha, headSha: repo.headSha }), []);
  assert.equal((await readCaptures({ repo: repo.root, itemId: item.id, kind: 'request', headSha: repo.headSha })).length, 1);
});

test('a declared capture passes the guard like a lead capture, and a malformed entry is refused', async () => {
  const repo = await makeFixtureRepo({ files: [{ path: 'a.txt', base: 'a', head: 'b' }], dirs });
  const base = { repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha };
  await assert.rejects(captureDeclared({ ...base, item: { id: 'x', captures: [{ kind: 'tests', command: 'git push --force origin main' }] } }), /git-force/);
  await assert.rejects(captureDeclared({ ...base, item: { id: 'x', captures: [{ kind: 'logs', command: 'true' }] } }), /invalid declared capture/);
  assert.deepEqual(await captureDeclared({ ...base, item: { id: 'x' } }), []);
});
