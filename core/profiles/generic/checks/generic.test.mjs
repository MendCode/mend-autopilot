import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { addedLinesBetween, changesFromFiles, collectChanges } from '../../../checks/changes.mjs';
import cardClaims from './card-claims.mjs';
import scopeContract from './scope-contract.mjs';
import singleDerivation, { expressionShape } from './single-derivation.mjs';
import sinkFloor from './sink-floor.mjs';

const temporaryRoots = [];

after(async () => {
  for (const root of temporaryRoots) await fs.rm(root, { recursive: true, force: true });
});

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

async function writeTree(repo, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(repo, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

/** A repository with one base commit and one head commit; returns the SHAs. */
async function makeRepo(baseFiles, headFiles) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'mend-generic-test-'));
  temporaryRoots.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'owner@example.invalid');
  git(repo, 'config', 'user.name', 'Owner');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeTree(repo, baseFiles);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  await writeTree(repo, headFiles);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'head');
  return { repo, baseSha, headSha: git(repo, 'rev-parse', 'HEAD') };
}

describe('change model', () => {
  test('the fixture line diff reports only head lines missing from base', () => {
    assert.deepEqual(addedLinesBetween('a\nb\nc\n', 'a\nx\nb\nc\ny\n'), [
      { line: 2, text: 'x' },
      { line: 5, text: 'y' },
    ]);
    assert.deepEqual(addedLinesBetween(null, 'one\n'), [{ line: 1, text: 'one' }]);
  });

  test('unchanged fixture files are dropped and deletions carry no added lines', () => {
    const changes = changesFromFiles([
      { path: 'same.ts', base: 'x\n', head: 'x\n' },
      { path: 'gone.ts', base: 'x\n', head: null },
    ]);
    assert.deepEqual(changes.map((change) => [change.path, change.status, change.added.length]), [['gone.ts', 'deleted', 0]]);
  });

  test('collectChanges on a real repo matches the fixture model', async () => {
    const { repo, baseSha, headSha } = await makeRepo({ 'src/a.ts': 'one\ntwo\n' }, { 'src/a.ts': 'one\nnew\ntwo\n', 'src/b.ts': 'b\n' });
    const changes = await collectChanges({ repo, baseSha, headSha });
    const byPath = Object.fromEntries(changes.map((change) => [change.path, change]));
    assert.deepEqual(byPath['src/a.ts'].added, [{ line: 2, text: 'new' }]);
    assert.equal(byPath['src/a.ts'].headText, 'one\nnew\ntwo\n');
    assert.equal(byPath['src/b.ts'].status, 'added');
  });
});

describe('checks on a real repository', () => {
  test('sink-floor and single-derivation read base..head through git', async () => {
    const { repo, baseSha, headSha } = await makeRepo(
      { 'server/wallet.ts': 'export function pay(w, n) {\n  return w;\n}\n', 'web/total.ts': 'export {};\n' },
      {
        'server/wallet.ts': 'export function pay(w, n) {\n  w.credits -= n;\n  const total = w.items.reduce((s, i) => s + i.cost, 0);\n  return w;\n}\n',
        'web/total.ts': 'export const view = (w) => {\n  const total = w.items.reduce((s, i) => s + i.cost, 0);\n  return total;\n};\n',
      },
    );
    const sink = await sinkFloor.run({ repo, baseSha, headSha });
    assert.deepEqual(sink.failures.map((failure) => failure.target), ['server/wallet.ts:2']);
    const derived = await singleDerivation.run({ repo, baseSha, headSha });
    assert.equal(derived.failures.length, 1);
    assert.match(derived.failures[0].detail, /server\/wallet\.ts:3 and web\/total\.ts:2/);
  });

  test('scope-contract counts delivered files from git', async () => {
    const { repo, baseSha, headSha } = await makeRepo({ 'README.md': 'x\n' }, { 'docs/a.md': 'a\n', 'docs/b.md': 'b\n' });
    const result = await scopeContract.run({ repo, baseSha, headSha, item: { quantity: { expected: 3, glob: 'docs/*.md' } } });
    assert.deepEqual(result.failures.map((failure) => failure.rule), ['quantity-short']);
  });

  test('card-claims reads the card from .mend/evidence and refuses logs outside the repo', async () => {
    const { repo, headSha } = await makeRepo({ 'a.txt': 'a\n' }, { 'a.txt': 'b\n' });
    const outside = path.join(path.dirname(repo), `${path.basename(repo)}-outside.log`);
    const card = {
      headSha,
      checks: [
        { name: 'unit', command: 'make test', exit: 0, log: '.mend/evidence/item-1/unit.log' },
        { name: 'escape', command: 'make test', exit: 0, log: `../${path.basename(outside)}` },
      ],
      verdict: { sha: headSha },
      auditLanes: [{ lane: 'behaviour', sha: headSha }],
      integrity: { pass: true, flags: [], countersigned: [] },
      countersigns: [],
    };
    await writeTree(repo, {
      '.mend/evidence/item-1.json': JSON.stringify(card),
      '.mend/evidence/item-1/unit.log': '$ make test\nok\nexit: 0\n',
    });
    await fs.writeFile(outside, '$ make test\nexit: 0\n');
    temporaryRoots.push(outside);
    const result = await cardClaims.run({ repo, item: { id: 'item-1' }, headSha });
    assert.deepEqual(result.failures.map((failure) => `${failure.rule} ${failure.target}`), ['check-log-missing check escape']);
    const missing = await cardClaims.run({ repo, item: { id: 'item-2' }, headSha });
    assert.deepEqual(missing.failures.map((failure) => failure.rule), ['card-missing']);
  });
});

describe('heuristic edges', () => {
  test('sink-floor ignores SQL comments, test files and arrow functions that only look like comparisons', async () => {
    const result = await sinkFloor.runFixture({
      files: [
        { path: 'db/a.sql', base: null, head: '-- remaining balance shown on page\nSELECT 1;\n' },
        { path: 'src/wallet.test.ts', base: null, head: 'wallet.balance -= 5;\n' },
        { path: 'src/fees.ts', base: null, head: 'const fee = (w) => w.balance;\nw.balance -= fee(w);\n' },
      ],
    });
    assert.deepEqual(result.failures.map((failure) => failure.target), ['src/fees.ts:2']);
  });

  test('sink-floor accepts a clamp with Math.max(0, ...)', async () => {
    const result = await sinkFloor.runFixture({
      files: [{ path: 'src/q.ts', base: null, head: 'quota.remaining = Math.max(0, quota.remaining - used);\nquota.remaining -= 0;\n' }],
    });
    assert.equal(result.pass, true);
  });

  test('single-derivation honours ignoreNames and skips self-updates', async () => {
    const files = [
      { path: 'a.ts', base: null, head: 'const offset = page * size;\ncount = count + 1;\n' },
      { path: 'b.ts', base: null, head: 'const offset = page * size;\ncount = count + 1;\n' },
    ];
    assert.equal((await singleDerivation.runFixture({ files })).pass, false);
    assert.equal((await singleDerivation.runFixture({ files, config: { singleDerivation: { ignoreNames: ['offset'] } } })).pass, true);
  });

  test('expression shape erases local names but keeps property names and operators', () => {
    assert.equal(expressionShape('rows.reduce((acc, r) => acc + r.price * r.qty, 0)'), expressionShape('items.reduce((s, i) => s + i.price * i.qty, 0)'));
    assert.notEqual(expressionShape('a.price * a.qty'), expressionShape('a.price * a.weight'));
  });

  test('scope-contract reports an over-delivery and a malformed quantity', async () => {
    const files = [
      { path: 'docs/a.md', base: null, head: 'a\n' },
      { path: 'docs/b.md', base: null, head: 'b\n' },
    ];
    const over = await scopeContract.runFixture({ item: { quantity: { expected: 1, glob: 'docs/*.md' } }, files });
    assert.deepEqual(over.failures.map((failure) => failure.rule), ['quantity-over']);
    const malformed = await scopeContract.runFixture({ item: { quantity: { expected: 'two' } }, files });
    assert.deepEqual(malformed.failures.map((failure) => failure.rule), ['quantity-undeclared']);
  });

  test('card-claims ignores warn-severity flags and uses the last exit line of a log', async () => {
    const card = {
      headSha: 'abc',
      checks: [{ name: 'unit', command: 'run', exit: 0, log: 'l' }],
      verdict: { sha: 'abc' },
      auditLanes: [{ lane: 'x', sha: 'abc' }],
      integrity: { pass: true, flags: [{ rule: 'test-literal-in-source', file: 'a', line: 1, severity: 'warn' }], countersigned: [] },
      countersigns: [],
    };
    const result = await cardClaims.runFixture({ headSha: 'abc', card, logs: { l: '$ run\nchild printed exit: 1\nexit: 1\nretry\nexit: 0\n' } });
    assert.equal(result.pass, true);
  });
});
