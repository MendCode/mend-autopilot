import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile } from './write-file.mjs';

const script = fileURLToPath(new URL('./write-file.mjs', import.meta.url));

test('writer preserves raw stdin, creates parents and enforces exclusive and append modes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mend-writer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, `nested space/both'".txt`);
  const text = `Unicode café 🌱\n'"; & | < > \u0060 $ \\ \r\n` + 'long content\n'.repeat(20_000);
  const first = spawnSync(process.execPath, [script, file, '--exclusive'], { input: text, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(await fs.readFile(file, 'utf8'), text);
  const duplicate = spawnSync(process.execPath, [script, '--stdin'], {
    input: JSON.stringify({ args: [file, '--exclusive'], text: 'replacement' }), encoding: 'utf8',
  });
  assert.notEqual(duplicate.status, 0);
  assert.equal(await fs.readFile(file, 'utf8'), text, 'exclusive failure must not truncate');
  const appended = spawnSync(process.execPath, [script, '--stdin'], {
    input: JSON.stringify({ args: [file, '--append'], text: '\nappended\n' }), encoding: 'utf8',
  });
  assert.equal(appended.status, 0, appended.stderr);
  assert.equal(await fs.readFile(file, 'utf8'), text + '\nappended\n');
  await writeFile(file, 'replacement');
  assert.equal(await fs.readFile(file, 'utf8'), 'replacement');
  await assert.rejects(writeFile(file, 'invalid', '--unknown'), /usage/);
  await assert.rejects(writeFile(file, undefined), /usage/);
  assert.equal(await fs.readFile(file, 'utf8'), 'replacement');
  const empty = spawnSync(process.execPath, [script, file], { input: '', encoding: 'utf8' });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(await fs.readFile(file, 'utf8'), '');
});
