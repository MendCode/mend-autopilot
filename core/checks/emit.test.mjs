import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceLines } from './capture.mjs';
import { testEvidence } from './emit-tests.mjs';
import { fillPrevious, parseRequest } from './emit-requests.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirs = [];
after(() => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function scratch(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mend-emit-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
  return dir;
}

test('the TAP summary becomes passed, failed, skipped and the sorted failing names', () => {
  const tap = 'TAP version 13\nnot ok 2 - zeta breaks\nok 1 - fine\nnot ok 3 - alpha breaks\n# tests 4\n# pass 1\n# fail 2\n# skipped 1\n';
  assert.deepEqual(testEvidence(tap), { passed: 1, failed: 2, skipped: 1, failing: ['alpha breaks', 'zeta breaks'] });
  assert.equal(testEvidence('no summary here'), null);
});

test('emit-tests runs a real node --test command, keeps its exit code and prints evidence a capture can read', async () => {
  const dir = await scratch({
    'a.test.mjs': "import { test } from 'node:test';\ntest('adds', () => {});\ntest('breaks', () => { throw new Error('x'); });\ntest('later', { skip: true }, () => {});\n",
  });
  const result = spawnSync(process.execPath, [path.join(HERE, 'emit-tests.mjs'), 'node', '--test', 'a.test.mjs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(evidenceLines(result.stdout), [{ passed: 1, failed: 1, skipped: 1, failing: ['breaks'] }]);
});

test('emit-tests without a TAP summary fails instead of inventing counts', async () => {
  const dir = await scratch({});
  const result = spawnSync(process.execPath, [path.join(HERE, 'emit-tests.mjs'), 'echo', 'hello'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no TAP summary/);
  assert.deepEqual(evidenceLines(result.stdout), []);
});

test('a request is METHOD, path and an optional JSON body; anything else is refused', () => {
  assert.deepEqual(parseRequest('POST /orders {"sku":"a1","qty":2}'), { method: 'POST', path: '/orders', body: '{"sku":"a1","qty":2}' });
  assert.deepEqual(parseRequest('GET /orders?page=2'), { method: 'GET', path: '/orders?page=2', body: undefined });
  assert.throws(() => parseRequest('orders'), TypeError);
  assert.throws(() => parseRequest('POST /orders {bad'), SyntaxError);
});

test('emit-requests starts the local service, records each status and stops the service afterwards', async () => {
  const port = 39000 + Math.floor(Math.random() * 2000);
  const dir = await scratch({
    'server.mjs': `import http from 'node:http';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('pid', String(process.pid));\nhttp.createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { res.statusCode = req.headers['x-user'] !== 'u1' ? 401 : req.method === 'POST' && JSON.parse(body).qty > 0 ? 201 : req.url === '/' ? 200 : 404; res.end(); }); }).listen(${port}, '127.0.0.1');\n`,
  });
  const url = `http://127.0.0.1:${port}`;
  const result = spawnSync(process.execPath, [path.join(HERE, 'emit-requests.mjs'), '--start', 'node server.mjs', '--url', url, '--header', 'X-User: u1', '--request', 'POST /orders {"qty":1}', '--request', 'GET /missing'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(evidenceLines(result.stdout), [
    { method: 'POST', url: `${url}/orders`, status: 201 },
    { method: 'GET', url: `${url}/missing`, status: 404 },
  ]);
  const pid = Number(await fs.readFile(path.join(dir, 'pid'), 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('emit-requests refuses a non-local service before starting anything', async () => {
  const dir = await scratch({});
  const result = spawnSync(process.execPath, [path.join(HERE, 'emit-requests.mjs'), '--start', 'touch started', '--url', 'https://api.example.com', '--request', 'GET /'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /not a local service/);
  await assert.rejects(fs.access(path.join(dir, 'started')), { code: 'ENOENT' });
});

test('a request can use a value from the previous JSON response, and a missing one is an error', () => {
  const previous = { id: 'o-7', lines: [{ sku: 'LAMP-01' }] };
  assert.equal(fillPrevious('/orders/{prev.id}/refunds', previous), '/orders/o-7/refunds');
  assert.equal(fillPrevious('{"sku":"{prev.lines.0.sku}"}', previous), '{"sku":"LAMP-01"}');
  assert.equal(fillPrevious('/orders', null), '/orders');
  assert.throws(() => fillPrevious('/orders/{prev.missing}', previous), RangeError);
  assert.throws(() => fillPrevious('/orders/{prev.lines}', previous), RangeError);
});

test('emit-requests chains a created resource into the next request against the running service', async () => {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const dir = await scratch({
    'server.mjs': `import http from 'node:http';\nhttp.createServer((req, res) => { req.resume(); req.on('end', () => { if (req.method === 'POST' && req.url === '/orders') { res.statusCode = 201; res.end(JSON.stringify({ id: 'o-9' })); } else { res.statusCode = req.url === '/orders/o-9/refunds' ? 200 : 404; res.end('{}'); } }); }).listen(${port}, '127.0.0.1');\n`,
  });
  const url = `http://127.0.0.1:${port}`;
  const result = spawnSync(process.execPath, [path.join(HERE, 'emit-requests.mjs'), '--start', 'node server.mjs', '--url', url, '--request', 'POST /orders {"qty":1}', '--request', 'POST /orders/{prev.id}/refunds {"qty":1}'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(evidenceLines(result.stdout).map((line) => [line.url, line.status]), [[`${url}/orders`, 201], [`${url}/orders/o-9/refunds`, 200]]);
});
