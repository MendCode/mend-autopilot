import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertFixtures, makeFixtureRepo, removeAll, rulesOf } from '../../../checks/test-support.mjs';
import bugfixShape, { locationsIn, rootCauseText } from './bugfix-shape.mjs';
import redGreen, { evaluate as evaluateRedGreen, regressionCommand } from './red-green.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const dirs = [];
after(() => removeAll(dirs));

const CHECK_SCRIPT = (expected) => `import { total } from './total.mjs';\nprocess.exit(total([0.1, 0.2]) === ${expected} ? 0 : 1);\n`;
const BUGGY = 'export function total(values) {\n  return values.reduce((sum, value) => sum + value, 0);\n}\n';
const FIXED = 'export function total(values) {\n  return Math.round(values.reduce((sum, value) => sum + value * 100, 0)) / 100;\n}\n';

test('every red-green fixture passes or fails exactly the rules it names', async () => {
  await assertFixtures(redGreen, path.join(FIXTURES, 'red-green'));
});

test('every bugfix-shape fixture passes or fails exactly the rules it names', async () => {
  await assertFixtures(bugfixShape, path.join(FIXTURES, 'bugfix-shape'));
});

test('the regression command comes from the item first, then the card, and blank values do not count', () => {
  assert.equal(regressionCommand({ item: { regression: ' pnpm test legacy ' }, card: null }), 'pnpm test legacy');
  assert.equal(regressionCommand({ item: { regressionCommand: '  ', regression: ' pnpm test fallback ' }, card: null }), 'pnpm test fallback');
  assert.equal(regressionCommand({ item: { regressionCommand: ' pnpm test a ' }, card: { redGreen: { command: 'pnpm test' } } }), 'pnpm test a');
  assert.equal(regressionCommand({ item: {}, card: { redGreen: { command: 'pnpm test' } } }), 'pnpm test');
  assert.equal(regressionCommand({ item: { regressionCommand: '  ' }, card: null }), null);
});

test('a red at base that does not match the expected failure is not accepted', () => {
  const unmatched = evaluateRedGreen({ command: 'npm test', outcome: { baseExit: 1, headExit: 0, baseMatched: false, expectBase: 'E_DUP' }, claimed: null });
  assert.equal(unmatched.pass, false);
  assert.deepEqual(unmatched.failures.map((failure) => failure.rule), ['not-red-for-the-bug']);
  const matched = evaluateRedGreen({ command: 'npm test', outcome: { baseExit: 1, headExit: 0, baseMatched: true, expectBase: 'E_DUP' }, claimed: null });
  assert.equal(matched.pass, true);
  const undeclared = evaluateRedGreen({ command: 'npm test', outcome: { baseExit: 1, headExit: 0, baseMatched: null }, claimed: null });
  assert.equal(undeclared.pass, true);
});

test('keep must be green at both sides and match the card', () => {
  const command = 'test regression';
  const keep = 'test characterization';
  for (const [baseExit, headExit, expected] of [[1, 0, 'keep-not-green-at-base'], [0, 1, 'keep-not-green-at-head']]) {
    const result = evaluateRedGreen({ command, keep, outcome: { baseExit: 1, headExit: 0, keep: { command: keep, baseExit, headExit } }, claimed: null });
    assert.deepEqual(rulesOf(result), [expected]);
  }
  const result = evaluateRedGreen({ command, keep, outcome: { baseExit: 1, headExit: 0, keep: { command: keep, baseExit: 0, headExit: 0 } }, claimed: { command, baseExit: 1, headExit: 0, keep: { command: keep, baseExit: 1, headExit: 0 } } });
  assert.deepEqual(rulesOf(result), ['card-red-green-mismatch']);
});

test('profile runs keep from the item or card', async () => {
  const repo = await makeFixtureRepo({ files: [{ path: 'total.mjs', base: BUGGY, head: FIXED }, { path: 'check.mjs', base: CHECK_SCRIPT(0.3), head: CHECK_SCRIPT(0.3) }], dirs });
  const args = { repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha };
  const keep = 'node check.mjs';
  assert.deepEqual(rulesOf(await redGreen.run({ ...args, item: { regressionCommand: keep, regressionKeep: keep } })), ['keep-not-green-at-base']);
  assert.deepEqual(rulesOf(await redGreen.run({ ...args, item: {}, card: { redGreen: { command: keep, baseExit: 1, headExit: 0, keep: { command: keep, baseExit: 1, headExit: 0 } } } })), ['keep-not-green-at-base']);
});

test('root cause locations are read from prose with paths, dots and leading ./', () => {
  assert.deepEqual(locationsIn('see ./src/a.b/c.ts:12 and lib/x.py:3.'), [{ path: 'src/a.b/c.ts', line: 12 }, { path: 'lib/x.py', line: 3 }]);
  assert.deepEqual(locationsIn('the total is off by one cent'), []);
  assert.equal(rootCauseText({ item: {}, card: { proof: { note: 'a.ts:1' } } }), 'a.ts:1');
  assert.equal(rootCauseText({ item: null, card: null }), '');
});

test('a line count ignores the trailing newline, so the line after the last one is unknown', async () => {
  const files = [{ path: 'src/a.ts', base: 'a\n', head: 'b\nc\n' }];
  assert.equal((await bugfixShape.runFixture({ item: { rootCause: 'src/a.ts:2' }, files })).pass, true);
  assert.deepEqual(rulesOf(await bugfixShape.runFixture({ item: { rootCause: 'src/a.ts:3' }, files })), ['root-cause-unknown-location']);
});

test('red-green runs the command at base and head of a real repo and compares the card', async () => {
  const repo = await makeFixtureRepo({
    files: [
      { path: 'total.mjs', base: BUGGY, head: FIXED },
      { path: 'check.mjs', base: CHECK_SCRIPT(0.3), head: CHECK_SCRIPT(0.3) },
    ],
    dirs,
  });
  const args = { repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha };
  assert.equal((await redGreen.run({ ...args, item: { id: 'sum', regressionCommand: 'node check.mjs' } })).pass, true);
  assert.deepEqual(rulesOf(await redGreen.run({ ...args, item: { id: 'sum', regressionCommand: 'node -e "process.exit(0)"' } })), ['not-red-at-base']);
  await fs.mkdir(path.join(repo.root, '.mend', 'evidence'), { recursive: true });
  await fs.writeFile(path.join(repo.root, '.mend', 'evidence', 'sum.json'), JSON.stringify({ redGreen: { command: 'node check.mjs', baseExit: 1, headExit: 1, setup: 'true', expectBase: 'BUG', timeoutMs: 1234 } }));
  assert.deepEqual(rulesOf(await redGreen.run({ ...args, item: { id: 'sum' } })), ['card-red-green-mismatch', 'not-red-for-the-bug']);
  assert.deepEqual(rulesOf(await redGreen.run({ ...args, item: { id: 'nothing' } })), ['regression-command-missing']);
});

test('a card red-green block supplies setup, expected failure and timeout when the item omits them', async () => {
  const repo = await makeFixtureRepo({
    files: [
      { path: 'total.mjs', base: BUGGY, head: FIXED },
      { path: 'check.mjs', base: "import { total } from './total.mjs';\nconsole.log('BUG_SIGNATURE');\nprocess.exit(total([0.1, 0.2]) === 0.3 ? 0 : 1);\n", head: CHECK_SCRIPT(0.3) },
    ],
    dirs,
  });
  await fs.mkdir(path.join(repo.root, '.mend', 'evidence'), { recursive: true });
  await fs.writeFile(path.join(repo.root, '.mend', 'evidence', 'sum.json'), JSON.stringify({ redGreen: { command: 'node check.mjs', setup: 'true', expectBase: 'BUG_SIGNATURE', timeoutMs: 1234, baseExit: 1, headExit: 0 } }));
  const result = await redGreen.run({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, item: { id: 'sum' } });
  assert.equal(result.pass, true, result.failures.map((failure) => failure.detail).join('; '));
});

test('regressionCommand and regressionSetup cannot bypass the guard through the profile', async () => {
  const repo = await makeFixtureRepo({ files: [{ path: 'total.mjs', base: BUGGY, head: FIXED }], dirs });
  const marker = path.join(repo.root, 'unguarded-marker');
  const refused = `touch '${marker}'; cat .env`;
  for (const item of [
    { id: 'guarded', regressionCommand: refused },
    { id: 'guarded', regressionCommand: 'exit 0', regressionSetup: refused },
  ]) {
    const result = await redGreen.run({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, item });
    assert.equal(result.pass, false);
    assert.equal(result.blocked, true);
    assert.deepEqual(rulesOf(result), ['red-green-blocked']);
    assert.match(result.failures[0].detail, /secret-read/);
    await assert.rejects(fs.access(marker));
  }
});

test('bugfix-shape reads the diff and the head tree of a real repo', async () => {
  const repo = await makeFixtureRepo({
    files: [
      { path: 'total.mjs', base: BUGGY, head: FIXED },
      { path: 'tests/total.test.mjs', base: null, head: CHECK_SCRIPT(0.3) },
    ],
    dirs,
  });
  const args = { repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha };
  assert.equal((await bugfixShape.run({ ...args, item: { id: 'sum', rootCause: 'total.mjs:2 adds floats directly' } })).pass, true);
  assert.deepEqual(rulesOf(await bugfixShape.run({ ...args, item: { id: 'sum', rootCause: 'floats' } })), ['root-cause-missing']);
});
