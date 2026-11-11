import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { snapshot, verify } from './approval.mjs';

test('approval freezes the preview only, detects edits and deletion, and rejects path escapes', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'mend-approval-'));
  try {
    const file = path.join(repo, 'layout.json');
    const preview = { containerWidth: 800, blocks: [{ id: 'hero', rect: { x: 0, y: 0, width: 800, height: 200 } }] };
    await fs.writeFile(file, JSON.stringify({ preview, integrated: null }));
    const inputs = await snapshot(repo, [{ path: 'layout.json', field: 'preview' }]);
    assert.match(inputs[0].sha256, /^[a-f0-9]{64}$/);
    await fs.writeFile(file, JSON.stringify({ preview, integrated: preview }));
    assert.equal((await verify(repo, inputs)).pass, true);
    await fs.writeFile(file, JSON.stringify({ preview: { ...preview, containerWidth: 900 }, integrated: preview }));
    assert.equal((await verify(repo, inputs)).pass, false);
    await fs.rm(file);
    assert.equal((await verify(repo, inputs)).pass, false);
    await fs.symlink(os.tmpdir(), path.join(repo, 'outside'));
    await assert.rejects(snapshot(repo, [{ path: 'outside' }]), /escapes|not a file/);
    await assert.rejects(snapshot(repo, []), /missing/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
