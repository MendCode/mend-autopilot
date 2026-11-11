// Tests for every api-backend check: the fixture folders, the route helper, and each repo adapter on a real
// throwaway git repo built from the same fixture data.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { promises as fs } from 'node:fs';

import { changesFromFiles } from '../../../checks/changes.mjs';
import { assertFixtures, captureEvidence, makeFixtureRepo, readFixtures, removeAll, rulesOf, writeEvidence } from '../../../checks/test-support.mjs';
import contractDiff, { classifyChanges, surfaceFromOpenApi } from './contract-diff.mjs';
import crossAccount from './cross-account.mjs';
import repeatAbuse from './repeat-abuse.mjs';
import requestEvidence from './request-evidence.mjs';
import routeHygiene from './route-hygiene.mjs';
import { errorStatuses, literalSegment, routeKey, routePattern, routesIn } from './routes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');
const CHECKS = [routeHygiene, crossAccount, repeatAbuse, requestEvidence, contractDiff];
const dirs = [];
after(() => removeAll(dirs));

async function fixture(checkId, name) {
  const all = await readFixtures(path.join(FIXTURES, checkId));
  return all.find((entry) => entry.name === name).fixture;
}

for (const check of CHECKS) {
  test(`every ${check.id} fixture passes or fails exactly the rules it names`, async () => {
    await assertFixtures(check, path.join(FIXTURES, check.id));
  });
}

test('routes are found in chained routers, Python decorators and file-based handlers', () => {
  const express = routesIn('server/routes/a.ts', "ordersRouter.get('/orders/:id', h);\napp.post(\"/orders\", h);");
  assert.deepEqual(express.map(routeKey), ['GET /orders/{id}', 'POST /orders']);
  const flask = routesIn('app/views.py', '@bp.route("/items/<int:item_id>", methods=["GET", "DELETE"])\ndef item(item_id):\n    pass');
  assert.deepEqual(flask.map(routeKey), ['GET /items/{item_id}', 'DELETE /items/{item_id}']);
  const next = routesIn('src/app/(shop)/api/carts/[cartId]/route.ts', 'export async function PUT(request) {}\nexport const GET = handler;');
  assert.deepEqual(next.map(routeKey), ['PUT /api/carts/{cartId}', 'GET /api/carts/{cartId}']);
  assert.deepEqual(routesIn('src/lib/fetch.ts', "client.get('/orders')"), [], 'a client call on an unknown receiver is not a route');
});

test('a route pattern matches concrete URLs of that route and not longer or sibling paths', () => {
  const pattern = routePattern('/orders/:id');
  assert.ok(pattern.test("get('/orders/ord_9')"));
  assert.ok(pattern.test('/orders/42?expand=items'));
  assert.ok(!pattern.test('/orders/42/items'));
  assert.ok(!pattern.test('/orders'));
  assert.ok(!routePattern('/orders').test('/orders-archive'));
  assert.equal(literalSegment('/invoices/{invoice_id}/lines'), '/invoices');
  assert.equal(literalSegment('/{tenant}/billing-accounts/{id}'), '/billing-accounts');
});

test('error statuses are read from the common server idioms and ignore success codes', () => {
  const body = [
    "res.status(201).json(x); res.sendStatus(409);",
    'raise HTTPException(status_code=422)',
    'abort(403)',
    'return Response(status=status.HTTP_404_NOT_FOUND)',
    "return Response.json({}, { status: 503 })",
  ].join('\n');
  assert.deepEqual(errorStatuses(body), [403, 404, 409, 422, 503]);
});

test('route-hygiene accepts a team guard named in config and still needs validation', async () => {
  const files = [{ path: 'server/routes/t.ts', base: null, head: "teamRouter.post('/teams', withTeamSession, (req, res) => {\n  const team = TeamInput.parse(req.body);\n  if (!team) return res.status(400).end();\n});\n" },
    { path: 'tests/t.test.ts', base: null, head: "post('/teams'); expect(400)" }];
  assert.deepEqual(rulesOf(await routeHygiene.runFixture({ files })), ['route-no-auth-decision']);
  assert.equal((await routeHygiene.runFixture({ files, config: { authMarkers: ['withTeamSession'] } })).pass, true);
});

test('cross-account skips routes the config lists as public and routes that never read the id', async () => {
  const head = "ordersRouter.get('/share/:token', async (req, res) => {\n  return res.json(await findShared(req.params.token));\n});\nordersRouter.get('/ping/:n', (req, res) => res.json({ ok: true }));\n";
  const files = [{ path: 'server/routes/share.ts', base: null, head }];
  assert.deepEqual(rulesOf(await crossAccount.runFixture({ files })), ['cross-account']);
  assert.equal((await crossAccount.runFixture({ files, config: { publicRoutes: ['/share/:token'] } })).pass, true);
});

test('repeat-abuse matches whole words, so payload or likely do not count as pay or like', async () => {
  const head = "uploadsRouter.post('/uploads/payload', requireUser, async (req, res) => {\n  // likely large\n  return res.json(await store(req.body));\n});\n";
  assert.equal((await repeatAbuse.runFixture({ files: [{ path: 'server/routes/u.ts', base: null, head }] })).pass, true);
  const camel = "accountRouter.put('/account', requireUser, async (req, res) => {\n  await sendVerifyEmail(req.user.id);\n});\n";
  assert.deepEqual(rulesOf(await repeatAbuse.runFixture({ files: [{ path: 'server/routes/a.ts', base: null, head: camel }] })), ['repeat-unbounded']);
});

test('contract-diff resolves local refs and classifies parameter and response changes', () => {
  const base = surfaceFromOpenApi({
    paths: { '/orders/{id}': { parameters: [{ $ref: '#/components/parameters/Id' }], get: { parameters: [{ name: 'expand', in: 'query' }], responses: { 200: { description: 'ok' }, 404: { description: 'missing' } } } } },
    components: { parameters: { Id: { name: 'id', in: 'path' } } },
  });
  assert.deepEqual(base['GET /orders/{id}'].params, { 'path:id': { required: true }, 'query:expand': { required: false } });
  const head = structuredClone(base);
  head['GET /orders/{id}'].params['query:expand'].required = true;
  delete head['GET /orders/{id}'].responses['404'];
  assert.deepEqual(classifyChanges(base, head).map(({ kind, change }) => `${kind}: ${change}`), [
    'breaking: parameter query:expand became required',
    'internal: response 404 removed',
  ]);
  assert.throws(() => surfaceFromOpenApi({ openapi: '3.1.0' }), TypeError);
});

test('route-hygiene and cross-account run on a real repo built from their fixtures', async () => {
  for (const [check, name] of [[routeHygiene, 'pass-fastapi-route.json'], [routeHygiene, 'fail-no-auth.json'], [crossAccount, 'fail-get-by-id.json']]) {
    const data = await fixture(check.id, name);
    const repo = await makeFixtureRepo({ files: data.files, dirs });
    const result = await check.run({ repo: repo.root, item: { id: 'item-1' }, baseSha: repo.baseSha, headSha: repo.headSha, config: data.config });
    assert.deepEqual(rulesOf(result), [...(data.expect ?? [])].sort(), name);
  }
});

test('repeat-abuse and request-evidence read the card and requests from the item evidence folder', async () => {
  const redeem = await fixture('repeat-abuse', 'pass-idempotent-redeem.json');
  const repo = await makeFixtureRepo({ files: redeem.files, dirs });
  const args = { repo: repo.root, item: { id: 'item-7' }, baseSha: repo.baseSha, headSha: repo.headSha };
  assert.deepEqual(rulesOf(await repeatAbuse.run(args)), ['repeat-unbounded'], 'without the card the invite route is unexplained');
  await fs.mkdir(path.join(repo.root, '.mend', 'evidence'), { recursive: true });
  await fs.writeFile(path.join(repo.root, '.mend', 'evidence', 'item-7.json'), JSON.stringify(redeem.card));
  assert.equal((await repeatAbuse.run(args)).pass, true);

  assert.deepEqual(rulesOf(await requestEvidence.run(args)), ['request-missing']);
  for (const value of [
    { method: 'POST', url: 'http://localhost:4100/rewards/redeem', status: 204 },
    { method: 'POST', url: 'http://localhost:4100/invites/send', status: 202 },
  ]) await captureEvidence({ root: repo.root, itemId: 'item-7', kind: 'request', value });
  assert.equal((await requestEvidence.run(args)).pass, true);
});

test('request evidence rejects manually written status without a capture', async () => {
  const data = await fixture('request-evidence', 'pass-local-request.json');
  const repo = await makeFixtureRepo({ files: data.files, dirs });
  const args = { repo: repo.root, item: { id: 'request-manual' }, baseSha: repo.baseSha, headSha: repo.headSha };
  await writeEvidence({ root: repo.root, itemId: args.item.id, name: 'requests.json', value: data.requests });
  assert.equal((await requestEvidence.run(args)).pass, false);
});

test('contract-diff reads OpenAPI files at both commits, then falls back to the recorded surface, then blocks', async () => {
  const pagination = await fixture('contract-diff', 'fail-breaking-unflagged.json');
  const files = [{ path: 'docs/openapi.json', base: JSON.stringify(pagination.openapi.base), head: JSON.stringify(pagination.openapi.head) }];
  const repo = await makeFixtureRepo({ files, dirs });
  const args = { repo: repo.root, item: { id: 'item-3' }, baseSha: repo.baseSha, headSha: repo.headSha };
  assert.deepEqual(rulesOf(await contractDiff.run(args)), ['breaking-unflagged']);
  assert.equal((await contractDiff.run({ ...args, item: { id: 'item-3', breaking: ['GET /orders'] } })).pass, true);

  const plain = await makeFixtureRepo({ files: [{ path: 'server/app.ts', base: 'a\n', head: 'b\n' }], dirs });
  const plainArgs = { repo: plain.root, item: { id: 'item-4' }, baseSha: plain.baseSha, headSha: plain.headSha };
  const blocked = await contractDiff.run(plainArgs);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(rulesOf(blocked), ['surface-unknown']);
  const recorded = await fixture('contract-diff', 'pass-recorded-surface.json');
  await writeEvidence({ root: plain.root, itemId: 'item-4', name: 'surface.json', value: recorded.surface });
  const result = await contractDiff.run(plainArgs);
  assert.equal(result.pass, true);
  assert.deepEqual(result.changes.map((entry) => entry.change), ['operation added']);
});

test('only changed lines count: an untouched old route without validation is not reported', async () => {
  const old = "ordersRouter.post('/legacy', (req, res) => res.json(req.body));\n";
  const changes = changesFromFiles([{ path: 'server/routes/o.ts', base: old, head: `${old}// note\n` }]);
  assert.equal(changes.length, 1);
  assert.equal((await routeHygiene.runFixture({ files: [{ path: 'server/routes/o.ts', base: old, head: `${old}// note\n` }] })).pass, true);
});
