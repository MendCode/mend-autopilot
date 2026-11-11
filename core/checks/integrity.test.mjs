import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanDiff, formatFlags, mergeConfig, globToRegExp, parseUnifiedDiff, findStructuredSecrets, RULES, EXIT, IntegrityUsageError } from './integrity.mjs';
import { collectChanges } from './changes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'integrity.mjs');
const { cases: CASES } = JSON.parse(await fs.readFile(path.join(HERE, 'fixtures/integrity/cases.json'), 'utf8'));
// Secret-shaped values are assembled here so the fixture file never stores one.
const FAKE_VALUES = {
  '{{FAKE_AWS_KEY}}': ['AKIA', 'Z7Q2', 'M4N8', 'R1T5', 'W3Y6'].join(''),
  '{{FAKE_GITHUB_TOKEN}}': `ghp_${'a1B2'.repeat(9)}`,
};
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const ASSERTION_DROP_FALSE_FLAG_LIMIT = 1;

const temporaryDirs = [];
after(() => Promise.all(temporaryDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

function fillFakes(text) {
  return Object.entries(FAKE_VALUES).reduce((result, [token, value]) => result.split(token).join(value), text);
}

function gitSync(cwd, args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function applyFiles(root, files) {
  for (const [relative, lines] of Object.entries(files)) {
    const target = path.join(root, relative);
    if (lines === null) {
      await fs.rm(target, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${fillFakes(lines.join('\n'))}\n`);
  }
}

/** Builds a two-commit history: base files, then the head changes. */
async function makeHistory({ base, head }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mend-integrity-')));
  temporaryDirs.push(root);
  gitSync(root, ['init', '-q', '-b', 'main']);
  await applyFiles(root, base);
  gitSync(root, ['add', '-A']);
  gitSync(root, ['commit', '-q', '--allow-empty', '-m', 'base']);
  const baseSha = gitSync(root, ['rev-parse', 'HEAD']);
  await applyFiles(root, head);
  gitSync(root, ['add', '-A']);
  gitSync(root, ['commit', '-q', '--allow-empty', '-m', 'head']);
  return { root, baseSha, headSha: gitSync(root, ['rev-parse', 'HEAD']) };
}

function fakeLookup(answers = {}) {
  return async ({ name }) => answers[name] ?? 'found';
}

async function scanCase(fixture) {
  const history = await makeHistory(fixture);
  const result = await scanDiff({
    repo: history.root,
    baseSha: history.baseSha,
    headSha: history.headSha,
    item: fixture.item,
    config: fixture.config,
    lookup: fakeLookup(fixture.lookup),
  });
  return { history, result };
}

function describeFlags(flags) {
  return flags.map((entry) => `${entry.severity} ${entry.rule} ${entry.file}:${entry.line}`).join('\n') || '(none)';
}

function expectedPass(fixture) {
  return !fixture.expect.some((entry) => (entry.severity ?? 'block') === 'block');
}

for (const fixture of CASES) {
  test(`fixture ${fixture.id}: ${fixture.description}`, async () => {
    const { result } = await scanCase(fixture);
    const shown = describeFlags(result.flags);
    for (const expected of fixture.expect) {
      const found = result.flags.some(
        (entry) =>
          entry.rule === expected.rule &&
          (expected.file === undefined || entry.file === expected.file) &&
          (expected.line === undefined || entry.line === expected.line) &&
          (expected.severity === undefined || entry.severity === expected.severity),
      );
      assert.ok(found, `missing ${JSON.stringify(expected)}; got:\n${shown}`);
    }
    const allowedRules = new Set(fixture.expect.map((entry) => entry.rule));
    const unexpected = result.flags.filter((entry) => !allowedRules.has(entry.rule));
    assert.deepEqual(unexpected, [], `unexpected flags:\n${describeFlags(unexpected)}`);
    assert.equal(result.pass, expectedPass(fixture), shown);
    if (fixture.secret) {
      const value = fillFakes(fixture.secret);
      assert.ok(!JSON.stringify(result).includes(value), 'the secret value must not appear in the result');
      assert.ok(!formatFlags(result).includes(value), 'the secret value must not appear in the text report');
    }
  });
}

for (const { name, base, added, clean = false, asyncTest = false } of [
  { name: 'another asserted subject, not a special-cased function name', base: 'expect(total(1, 1)).toBe(2);', added: ['expect(total(2, 2)).toBe(4);'], clean: true },
  { name: 'a callee absent from base assertions', base: 'expect(result).toBe(2);', added: ['expect(add(2, 2)).toBe(4);'], clean: true },
  { name: 'an assignment in a known callee argument', base: 'expect(add(1, 1)).toBe(2);', added: ['expect(add(result = 0, 2)).toBe(2);'] },
  { name: 'a nested call in a known callee argument', base: 'expect(add(1, 1)).toBe(2);', added: ['expect(add(stop(0), 2)).toBe(2);'] },
  { name: 'a member call absent from base assertions', base: 'expect(result).toBe(2);', added: ['expect(math.add(2, 2)).toBe(4);'], clean: true },
  { name: 'nested subject calls with variable arguments', base: 'expect(result).toBe(2);', added: ['expect(normalize(math.add(left, right))).toEqual(expected);'], clean: true },
  { name: 'length and truthiness matchers', base: 'expect(result).toBe(2);', added: ['expect(items).toHaveLength(2);', 'expect(result).toBeTruthy();'], clean: true },
  { name: 'negated matchers and object expectations', base: 'expect(result).toBe(2);', added: ['expect(result).not.toBeNull();', 'expect(value).toMatchObject({ total: 4 });'], clean: true },
  { name: 'semicolon-free assertions', base: 'expect(result).toBe(2)', added: ['expect(result).toBeTruthy()'], clean: true },
  { name: 'an indexed array value', base: 'expect(result).toBe(2);', added: ['expect(items[0]).toBe(1);'], clean: true },
  { name: 'nested indices and member access', base: 'expect(result).toBe(2);', added: ['expect(rows[index + 1].items[0]).toBe(expected[0]);'], clean: true },
  { name: 'an awaited resolves assertion', base: 'expect(result).toBe(2);', added: ['await expect(operation()).resolves.toBe(1);'], clean: true, asyncTest: true },
  { name: 'an awaited rejects assertion without semicolons', base: 'await expect(operation()).resolves.toBe(1)', added: ['await expect(failingOperation()).rejects.toThrow("failed")'], clean: true, asyncTest: true },
  { name: 'an update inside an index', base: 'expect(result).toBe(2);', added: ['expect(items[index++]).toBe(1);'] },
  { name: 'an assignment inside an index', base: 'expect(result).toBe(2);', added: ['expect(items[index = 0]).toBe(1);'] },
  { name: 'dynamic evaluation inside an index', base: 'expect(result).toBe(2);', added: ['expect(items[eval("process.exit(0)")]).toBe(1);'] },
  { name: 'computed process termination', base: 'expect(result).toBe(2);', added: ['expect(process["ex" + "it"](0)).toBeUndefined();'] },
  { name: 'an awaited assertion followed by return', base: 'expect(result).toBe(2);', added: ['await expect(operation()).resolves.toBe(1); return;'], asyncTest: true },
  { name: 'an explicit process exit', base: 'expect(result).toBe(2);', added: ['expect(process.exit(0)).toBeUndefined();'] },
  { name: 'a second statement after an assertion', base: 'expect(result).toBe(2);', added: ['expect(result).toBeTruthy(); return;'] },
  { name: 'an update inside an assertion', base: 'expect(result).toBe(2);', added: ['expect(result++).toBe(2);'] },
  { name: 'dynamic evaluation even when asserted in base', base: 'expect(eval("1 + 1")).toBe(2);', added: ['expect(eval("process.exit(0)")).toBe(undefined);'] },
  { name: 'a callee introduced by another added assertion', base: 'expect(add(1, 1)).toBe(2);', added: ['expect(add(2, 2)).toBe(4);', 'expect(stop(0)).toBe(undefined);'] },
]) {
  test(`test-authoring additive call boundary: ${name}`, async () => {
    const opening = `test('math', ${asyncTest ? 'async ' : ''}() => {`;
    const { result } = await scanCase({
      item: { editSet: ['tests/**'], profiles: ['test-authoring'] },
      base: { 'tests/math.test.ts': [opening, `  ${base}`, '});'] },
      head: { 'tests/math.test.ts': [opening, `  ${base}`, ...added.map((line) => `  ${line}`), '});'] },
    });
    assert.deepEqual(result.flags.map((flag) => flag.rule), clean ? [] : ['test-edit']);
    assert.equal(result.pass, clean);
  });
}

for (const header of [
  ['if (disabled)'],
  ['if (', '  disabled', ')'],
  ['if (disabled) // keep the original body', '', '/* comment between header and body */'],
  ['while (disabled)'],
  ['for (; disabled;)'],
  ['if (enabled) {} else'],
  ['do'],
]) {
  for (const { file, opening, closing, existing, inserted } of [
    { file: 'tests/math.test.ts', opening: "test('math', () => {", closing: '});', existing: 'expect(result).toBe(2);', inserted: 'expect(1).toBe(1);' },
    { file: 'tests/MathTest.java', opening: 'class MathTest { void testMath() {', closing: '} }', existing: 'assertEquals(2, result);', inserted: 'assertEquals(1, 1);' },
  ]) {
    test(`an inserted assertion cannot steal an unbraced body in ${file}: ${header.join(' ')}`, async () => {
      const prefix = [opening, ...header];
      const suffix = ['  return;', ...(header[0] === 'do' ? ['while (disabled);'] : []), `  ${existing}`, closing];
      const { result } = await scanCase({
        item: { editSet: ['tests/**'], profiles: ['test-authoring'] },
        base: { [file]: [...prefix, ...suffix] },
        head: { [file]: [...prefix, `  ${inserted}`, ...suffix] },
      });
      assert.deepEqual(result.flags.map((flag) => flag.rule), ['test-edit']);
      assert.equal(result.pass, false);
    });
  }
}

for (const file of ['tests/MathTest.kt', 'tests/MathTest.scala']) {
  test(`JVM context protects bare bodies and allows semicolon-free assertions in ${file}`, async () => {
    const opening = file.endsWith('.kt') ? 'fun testMath() {' : 'def testMath(): Unit = {';
    const base = [opening, '  if (disabled)', '    return', '  assertEquals(2, result)', '}'];
    for (const safe of [false, true]) {
      const insertion = safe ? 4 : 2;
      const { result } = await scanCase({
        item: { editSet: ['tests/**'], profiles: ['test-authoring'] },
        base: { [file]: base },
        head: { [file]: [...base.slice(0, insertion), '  assertEquals(1, 1)', ...base.slice(insertion)] },
      });
      assert.deepEqual(result.flags.map((flag) => flag.rule), safe ? [] : ['test-edit']);
      assert.equal(result.pass, safe);
    }
  });
}

test('awaited assertions still cannot steal the body of an unbraced if', async () => {
  const prefix = ["test('async operation', async () => {", '  if (disabled)'];
  const suffix = ['    return;', '  expect(result).toBe(2);', '});'];
  const { result } = await scanCase({
    item: { editSet: ['tests/**'], profiles: ['test-authoring'] },
    base: { 'tests/math.test.ts': [...prefix, ...suffix] },
    head: { 'tests/math.test.ts': [...prefix, '    await expect(operation()).resolves.toBe(1);', ...suffix] },
  });
  assert.deepEqual(result.flags.map((flag) => flag.rule), ['test-edit']);
  assert.equal(result.pass, false);
});

test('Java text-block contents are not standalone assertion additions', async () => {
  const prefix = ['class MathTest { void testMath() {', '  String description = """', '    {'];
  const suffix = ['    """;', '  assertEquals(2, result);', '} }'];
  const { result } = await scanCase({
    item: { editSet: ['tests/**'], profiles: ['test-authoring'] },
    base: { 'tests/MathTest.java': [...prefix, ...suffix] },
    head: { 'tests/MathTest.java': [...prefix, '    assertEquals(1, 1);', ...suffix] },
  });
  assert.deepEqual(result.flags.map((flag) => flag.rule), ['test-edit']);
  assert.equal(result.pass, false);
});

test('safe insertions in separate hunks preserve braced control flow', async () => {
  const base = ["test('math', () => {", '  if (disabled) {', '    return;', '  }', '  expect(result).toBe(2);', '});'];
  const { result } = await scanCase({
    item: { editSet: ['tests/**'], profiles: ['test-authoring'] },
    base: { 'tests/math.test.ts': base },
    head: { 'tests/math.test.ts': [base[0], '  expect(items).toHaveLength(2);', ...base.slice(1, -1), '  expect(result).toBeTruthy();', base.at(-1)] },
  });
  assert.deepEqual(result.flags, []);
  assert.equal(result.pass, true);
});

for (const { name, prefix, suffix } of [
  { name: 'a multiline for header after a semicolon', prefix: ['for (let i = 0;'], suffix: ['i < 1; i++)', '  return;'] },
  { name: 'a block comment', prefix: ['/* existing comment', '  {'], suffix: ['*/'] },
  { name: 'a template literal', prefix: ['const text = `', '  {'], suffix: ['`;'] },
  { name: 'an if/else seam', prefix: ['if (disabled) {', '  return;', '}'], suffix: ['else {', '  expect(result).toBe(2);', '}'] },
]) {
  test(`assertion text is not additive inside ${name}`, async () => {
    const start = ["test('math', () => {", ...prefix];
    const end = [...suffix, '  expect(other).toBe(3);', '});'];
    const { result } = await scanCase({
      item: { editSet: ['tests/**'], profiles: ['test-authoring'] },
      base: { 'tests/math.test.ts': [...start, ...end] },
      head: { 'tests/math.test.ts': [...start, '  expect(1).toBe(1);', ...end] },
    });
    assert.deepEqual(result.flags.map((flag) => flag.rule), ['test-edit']);
    assert.equal(result.pass, false);
  });
}

test('every rule has a tamper fixture that catches it and a clean control that ignores it', () => {
  for (const rule of RULES) {
    assert.ok(
      CASES.some((fixture) => fixture.kind === 'tamper' && fixture.expect.some((entry) => entry.rule === rule)),
      `no tamper fixture for ${rule}`,
    );
    assert.ok(
      CASES.some((fixture) => fixture.kind === 'control' && fixture.controlFor?.includes(rule) && !fixture.expect.some((entry) => entry.rule === rule)),
      `no clean control for ${rule}`,
    );
  }
});

test(`assertion-drop stays at block: at most ${ASSERTION_DROP_FALSE_FLAG_LIMIT} false flag in 10 clean test edits`, async () => {
  const controls = CASES.filter((fixture) => fixture.assertionControl);
  assert.ok(controls.length >= 10, `need 10 clean test-edit controls, have ${controls.length}`);
  let falseFlags = 0;
  for (const fixture of controls) {
    const { result } = await scanCase(fixture);
    if (result.flags.some((entry) => entry.rule === 'assertion-drop')) falseFlags += 1;
  }
  assert.ok(falseFlags <= ASSERTION_DROP_FALSE_FLAG_LIMIT, `${falseFlags} false assertion-drop flags`);
});

test('repo config can add patterns and globs but cannot remove built-in rules', async () => {
  const fixture = {
    base: { 'qa/checkout.check.js': ['check("pays", () => verifyTotal(10));'], 'src/a.ts': ['export const a = 1;'] },
    head: {
      'qa/checkout.check.js': ['pending_check("pays", () => verifyTotal(10));'],
      'src/a.ts': ['export const a = 1; // @ts-ignore'],
    },
  };
  const history = await makeHistory(fixture);
  const config = {
    testGlobs: ['qa/**'],
    patterns: { 'skip-marker': ['\\bpending_check\\('], 'type-escape': ['('] },
    rules: { 'type-escape': false },
  };
  const result = await scanDiff({ repo: history.root, baseSha: history.baseSha, headSha: history.headSha, item: { editSet: ['**'] }, config, lookup: fakeLookup() });
  const rules = result.flags.map((entry) => entry.rule);
  assert.ok(rules.includes('skip-marker'), 'the added skip pattern applies to the added test glob');
  assert.ok(rules.includes('test-edit'), 'the added test glob makes qa/ a test folder');
  assert.ok(rules.includes('type-escape'), 'a config key cannot switch off a built-in rule');
  const warnings = result.flags.filter((entry) => entry.rule === 'config-warning').map((entry) => entry.detail);
  assert.ok(warnings.some((detail) => detail.includes('"rules" cannot change or remove')), warnings.join('\n'));
  assert.ok(warnings.some((detail) => detail.includes('invalid regular expression')), warnings.join('\n'));
});

test('editing .mend/integrity.json inside the item is itself a gate edit', async () => {
  const history = await makeHistory({
    base: { '.mend/integrity.json': ['{}'] },
    head: { '.mend/integrity.json': ['{ "testGlobs": ["nothing/**"] }'] },
  });
  const result = await scanDiff({ repo: history.root, baseSha: history.baseSha, headSha: history.headSha, item: { editSet: ['**'] }, lookup: fakeLookup() });
  assert.deepEqual(result.flags.map((entry) => entry.rule), ['gate-config-edit']);
  assert.equal(result.pass, false);
});

test('a missing SHA is a usage error, never a pass', async () => {
  const history = await makeHistory({ base: { 'a.txt': ['a'] }, head: { 'a.txt': ['b'] } });
  await assert.rejects(
    scanDiff({ repo: history.root, baseSha: 'deadbeef', headSha: history.headSha, item: { editSet: ['**'] } }),
    (error) => error instanceof IntegrityUsageError,
  );
  await assert.rejects(scanDiff({ repo: history.root, baseSha: '', headSha: history.headSha, item: {} }), IntegrityUsageError);
});

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: GIT_ENV });
}

test('CLI exits 0 on a clean diff, 1 on blocking flags and prints JSON on request', async () => {
  const clean = CASES.find((fixture) => fixture.id === 'control-source-change');
  const tamper = CASES.find((fixture) => fixture.id === 'tamper-js-skip');
  for (const [fixture, code] of [[clean, EXIT.ok], [tamper, EXIT.flagged]]) {
    const history = await makeHistory(fixture);
    const itemPath = path.join(history.root, '..', `${path.basename(history.root)}-item.json`);
    temporaryDirs.push(itemPath);
    await fs.writeFile(itemPath, JSON.stringify(fixture.item));
    const base = ['--repo', history.root, '--base', history.baseSha, '--head', history.headSha, '--item', itemPath, '--no-lookup'];
    const text = runCli(base);
    assert.equal(text.status, code, text.stderr + text.stdout);
    const json = runCli([...base, '--json']);
    assert.equal(json.status, code);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.pass, code === EXIT.ok);
  }
});

test('CLI loads .mend/integrity.json from the base commit', async () => {
  const history = await makeHistory({
    base: { '.mend/integrity.json': ['{ "patterns": { "skip-marker": ["\\\\bquarantine\\\\("] } }'], 'tests/a.test.js': ["test('a', () => expect(1).toBe(1));"] },
    head: { 'tests/a.test.js': ["quarantine(test('a', () => expect(1).toBe(1)));"] },
  });
  const itemPath = `${history.root}-item.json`;
  temporaryDirs.push(itemPath);
  await fs.writeFile(itemPath, JSON.stringify({ editSet: ['tests/**'] }));
  const result = runCli(['--repo', history.root, '--base', history.baseSha, '--head', history.headSha, '--item', itemPath, '--json', '--no-lookup']);
  assert.equal(result.status, EXIT.flagged, result.stderr);
  assert.ok(JSON.parse(result.stdout).flags.some((entry) => entry.rule === 'skip-marker'));
});

test('CLI loads ignored local integrity configuration when the base has none', async () => {
  const history = await makeHistory({
    base: { 'tests/a.test.js': ["test('a', () => expect(1).toBe(1));"] },
    head: { 'tests/a.test.js': ["quarantine(test('a', () => expect(1).toBe(1)));"] },
  });
  await fs.appendFile(path.join(history.root, '.git', 'info', 'exclude'), '\n.mend/\n');
  await fs.mkdir(path.join(history.root, '.mend'), { recursive: true });
  await fs.writeFile(path.join(history.root, '.mend', 'integrity.json'), JSON.stringify({ patterns: { 'skip-marker': ['\\bquarantine\\('] } }));
  const itemPath = `${history.root}-item.json`;
  temporaryDirs.push(itemPath);
  await fs.writeFile(itemPath, JSON.stringify({ editSet: ['tests/**'] }));
  const result = runCli(['--repo', history.root, '--base', history.baseSha, '--head', history.headSha, '--item', itemPath, '--json', '--no-lookup']);
  assert.equal(result.status, EXIT.flagged, result.stderr);
  assert.ok(JSON.parse(result.stdout).flags.some((entry) => entry.rule === 'skip-marker'));
});

test('CLI adds ignored local integrity rules without dropping rules from the base commit', async () => {
  const history = await makeHistory({
    base: {
      '.mend/integrity.json': ['{"baselineGlobs":["team-base/**"]}'],
      'team-base/a.txt': ['before'],
      'team-local/b.txt': ['before'],
    },
    head: { '.gitignore': ['.mend/'], '.mend/integrity.json': null, 'team-base/a.txt': ['after'], 'team-local/b.txt': ['after'] },
  });
  await fs.writeFile(path.join(history.root, '.mend/integrity.json'), JSON.stringify({ baselineGlobs: ['team-local/**'] }));
  const itemPath = `${history.root}-item.json`;
  temporaryDirs.push(itemPath);
  await fs.writeFile(itemPath, JSON.stringify({ editSet: ['**'] }));
  const result = runCli(['--repo', history.root, '--base', history.baseSha, '--head', history.headSha, '--item', itemPath, '--json', '--no-lookup']);
  assert.equal(result.status, EXIT.flagged, result.stderr);
  const baselines = JSON.parse(result.stdout).flags.filter((entry) => entry.rule === 'baseline-edit').map((entry) => entry.file).sort();
  assert.deepEqual(baselines, ['team-base/a.txt', 'team-local/b.txt']);
});

test('CLI loads an integrity policy absent from both commits and fails closed on malformed local JSON', async () => {
  const history = await makeHistory({
    base: { '.gitignore': ['.mend/'], 'team/a.txt': ['before'] },
    head: { 'team/a.txt': ['after'] },
  });
  await fs.mkdir(path.join(history.root, '.mend'));
  const config = path.join(history.root, '.mend/integrity.json');
  const itemPath = path.join(history.root, '.mend/item.json');
  await fs.writeFile(itemPath, JSON.stringify({ editSet: ['team/**'] }));
  const args = ['--repo', history.root, '--base', history.baseSha, '--head', history.headSha, '--item', itemPath, '--json', '--no-lookup'];
  await fs.writeFile(config, JSON.stringify({ baselineGlobs: ['team/**'] }));
  const result = runCli(args);
  assert.equal(result.status, EXIT.flagged, result.stderr);
  assert.ok(JSON.parse(result.stdout).flags.some((entry) => entry.rule === 'baseline-edit'));
  await fs.writeFile(config, '{');
  assert.equal(runCli(args).status, EXIT.usage);
});

test('CLI usage errors exit 64 with nothing on stdout', async () => {
  const history = await makeHistory({ base: { 'a.txt': ['a'] }, head: { 'a.txt': ['b'] } });
  const itemPath = `${history.root}-item.json`;
  temporaryDirs.push(itemPath);
  await fs.writeFile(itemPath, JSON.stringify({ editSet: ['**'] }));
  const variants = [
    ['--repo', history.root, '--base', '0000000000000000000000000000000000000000', '--head', history.headSha, '--item', itemPath],
    ['--repo', history.root, '--head', history.headSha, '--item', itemPath],
    ['--repo', history.root, '--base', history.baseSha, '--head', history.headSha],
    ['--repo', history.root, '--base', history.baseSha, '--head', history.headSha, '--item', `${itemPath}.missing`],
    ['--repo', history.root, '--base', history.baseSha, '--head', history.headSha, '--item', itemPath, '--fast'],
  ];
  for (const args of variants) {
    const result = runCli(args);
    assert.equal(result.status, EXIT.usage, `${args.join(' ')}\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^\[INTEGRITY\]: /);
  }
});

test('glob translation and diff parsing basics', () => {
  assert.ok(globToRegExp('**/*.test.*').test('a/b/c.test.ts'));
  assert.ok(globToRegExp('**/*.test.*').test('c.test.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/').test('src/a/b.ts'));
  const files = parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2,0 +3,2 @@\n+one\n+two\n');
  assert.deepEqual(files[0].hunks[0].added, [{ line: 3, text: 'one' }, { line: 4, text: 'two' }]);
  assert.equal(parseUnifiedDiff('diff --git a/image.png b/image.png\nindex 1..2 100644\nBinary files a/image.png and b/image.png differ\n')[0].path, 'image.png');
  assert.equal(parseUnifiedDiff('diff --git a/tool b/tool\nold mode 100644\nnew mode 100755\n')[0].path, 'tool');
  assert.equal(parseUnifiedDiff('diff --git "a/name\\tpart.png" "b/name\\tpart.png"\nBinary files differ\n')[0].path, 'name\tpart.png');
  assert.equal(parseUnifiedDiff('diff --git "a/caf\\303\\251.png" "b/caf\\303\\251.png"\nold mode 100644\nnew mode 100755\n')[0].path, 'café.png');
  assert.equal(mergeConfig('not an object').warnings.length, 1);
});

test('integrity scans secret-like values in the item card fields', async () => {
  const history = await makeHistory({ base: { 'src/a.js': ['export const value = 1;'] }, head: { 'src/a.js': ['export const value = 1;'] } });
  const result = await scanDiff({ repo: history.root, baseSha: history.baseSha, headSha: history.headSha, item: {
    id: 'synthetic', editSet: ['**'], problem: `token: "${FAKE_VALUES['{{FAKE_GITHUB_TOKEN}}']}"`, uncertain: [],
  }, lookup: fakeLookup() });
  assert.ok(result.flags.some((flag) => flag.rule === 'secret-like' && flag.file === '(item)'));
});

test('binary and mode-only paths survive Git spaces, quotes and byte escapes', () => {
  const paths = [
    ['image one.png', 'a/image one.png', 'b/image one.png'],
    ['part b/image.png', 'a/part b/image.png', 'b/part b/image.png'],
    ['name\tpart.png', '"a/name\\tpart.png"', '"b/name\\tpart.png"'],
    ['café.png', '"a/caf\\303\\251.png"', '"b/caf\\303\\251.png"'],
    ['bell\u0007.png', '"a/bell\\a.png"', '"b/bell\\a.png"'],
    ['quote"slash\\.png', '"a/quote\\"slash\\\\.png"', '"b/quote\\"slash\\\\.png"'],
  ];
  for (const [expected, oldPath, newPath] of paths) {
    for (const binary of [false, true]) {
      const suffix = binary ? `Binary files ${oldPath} and ${newPath} differ` : 'old mode 100755\nnew mode 100644';
      const files = parseUnifiedDiff(`diff --git ${oldPath} ${newPath}\n${suffix}\n`);
      assert.equal(files.length, 1, expected);
      assert.equal(files[0].oldPath, expected);
      assert.equal(files[0].newPath, expected);
      assert.equal(files[0].path, expected);
      assert.equal(files[0].binary, binary);
    }
  }
});

test('binary snapshots and executable-bit removal reach integrity and profile checks', async () => {
  const snapshot = 'baselines/image one\t.png';
  const executable = 'tools/run task';
  const history = await makeHistory({
    base: { [snapshot]: ['\0before'], [executable]: ['echo ready'] },
    head: {},
  });
  gitSync(history.root, ['update-index', '--chmod=+x', executable]);
  gitSync(history.root, ['commit', '-q', '-m', 'executable baseline']);
  const baseSha = gitSync(history.root, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(history.root, snapshot), '\0after\n');
  gitSync(history.root, ['add', snapshot]);
  gitSync(history.root, ['update-index', '--chmod=-x', executable]);
  gitSync(history.root, ['commit', '-q', '-m', 'binary and mode changes']);
  const headSha = gitSync(history.root, ['rev-parse', 'HEAD']);
  const result = await scanDiff({ repo: history.root, baseSha, headSha, item: { editSet: ['src/**'] }, lookup: fakeLookup() });
  assert.equal(result.pass, false);
  for (const file of [snapshot, executable]) {
    assert.ok(result.flags.some((flag) => flag.rule === 'out-of-scope' && flag.file === file), describeFlags(result.flags));
  }
  assert.ok(result.flags.some((flag) => flag.rule === 'baseline-edit' && flag.file === snapshot));
  const changes = await collectChanges({ repo: history.root, baseSha, headSha });
  assert.equal(changes.length, 2);
  assert.equal(changes.find((change) => change.path === snapshot)?.binary, true);
  assert.equal(changes.find((change) => change.path === executable)?.status, 'modified');
});

test('quoted text and rename headers do not overwrite decoded Git paths', () => {
  const [text] = parseUnifiedDiff('diff --git "a/name\\tpart" "b/name\\tpart"\n--- "a/name\\tpart"\n+++ "b/name\\tpart"\n@@ -1 +1 @@\n-before\n+after\n');
  assert.equal(text.oldPath, 'name\tpart');
  assert.equal(text.newPath, 'name\tpart');
  const [renamed] = parseUnifiedDiff('diff --git "a/old\\tname" "b/new\\tname"\nsimilarity index 100%\nrename from "old\\tname"\nrename to "new\\tname"\n');
  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.oldPath, 'old\tname');
  assert.equal(renamed.newPath, 'new\tname');
  const [deleted] = parseUnifiedDiff('diff --git a/old b/old\ndeleted file mode 100644\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-before\n');
  assert.equal(deleted.path, 'old');
  assert.equal(deleted.newPath, null);
});

test('structured secret scanning preserves assignments and ignores placeholders', () => {
  const value = ['q7R2', 'm9T4', 'v6N8', 'z3L5'].join('');
  for (const input of [{ password: value }, { nested: [`password = "${value}"`] }]) {
    const findings = findStructuredSecrets(input);
    assert.ok(findings.some((finding) => finding.kind === 'assigned-secret'));
    assert.ok(!JSON.stringify(findings).includes(value));
  }
  assert.deepEqual(findStructuredSecrets({ uncertain: ['none'], command: 'test -f src/a.js', password: '${TOKEN}' }), []);
});

test('fixture-named values are not secrets, but a real-looking value with a fixture word inside still is', () => {
  for (const line of [`token: 'test-reviewer-token'`, `apiKey = "fake_api_key_for_tests"`, `secret: 'mock-signing-secret-1'`, `password = "fixture-password-123"`, `token: "stub_token_abcdefgh"`]) {
    assert.deepEqual(findStructuredSecrets({ line }), [], line);
  }
  const real = ['q7R2', 'm9T4', 'v6N8', 'z3L5'].join('');
  for (const line of [`token: '${real}-test'`, `password = "x${real}fake"`, `apiKey: "${real}"`]) {
    assert.ok(findStructuredSecrets({ line }).some((finding) => finding.kind === 'assigned-secret'), line);
  }
});

test('item scanning sees quoted assignments before JSON escaping', async () => {
  const history = await makeHistory({ base: { 'src/a.js': ['export const value = 1;'] }, head: {} });
  const value = ['q7R2', 'm9T4', 'v6N8', 'z3L5'].join('');
  const result = await scanDiff({
    repo: history.root, baseSha: history.baseSha, headSha: history.headSha,
    item: { editSet: ['src/**'], uncertain: [`password = "${value}"`] }, lookup: fakeLookup(),
  });
  assert.equal(result.pass, false);
  assert.ok(result.flags.some((flag) => flag.rule === 'secret-like' && flag.file === '(item)'));
  assert.ok(!JSON.stringify(result).includes(value));
});
