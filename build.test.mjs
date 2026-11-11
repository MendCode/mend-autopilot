import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { build, assertSafeRelative, BuildError, EXIT, HARNESSES } from './build.mjs';

const BUILD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build.mjs');
const SOURCE_ROOT = path.dirname(BUILD_SCRIPT);

test('documentation names existing core check modules', async () => {
  async function markdownFiles(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(file);
      return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
    }));
    return nested.flat();
  }
  const files = [path.join(SOURCE_ROOT, 'README.md'), ...(await Promise.all(
    ['adapters', 'core/skills', 'core/docs', 'docs'].map((dir) => markdownFiles(path.join(SOURCE_ROOT, dir))),
  )).flat()];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    for (const match of text.matchAll(/\bcore\/checks\/([a-zA-Z0-9_-]+\.mjs)\b/g)) {
      await assert.doesNotReject(fs.access(path.join(SOURCE_ROOT, 'core/checks', match[1])), `${path.relative(SOURCE_ROOT, file)} names missing ${match[0]}`);
    }
  }
});
const SYNTHETIC_DENYLIST = {
  words: ['zorblax', 'acme widgets', 'Ñandú Café'],
  patterns: ['/Users/[^/\\s]+'],
};

const temporaryDirs = [];
after(() => Promise.all(temporaryDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function makeTemporaryDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

async function writeFile(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function makeRepo() {
  const root = await makeTemporaryDir('mend-autopilot-build-test-');
  await writeFile(root, 'build/leak-denylist.json', JSON.stringify(SYNTHETIC_DENYLIST));
  await writeFile(root, 'README.md', '# synthetic package\n');
  await writeFile(root, 'core/skills/demo/SKILL.md', 'core version\n');
  await writeFile(root, 'core/shared.md', 'shared core file\n');
  for (const harness of HARNESSES) {
    await writeFile(
      root,
      `adapters/${harness}/mendcode-package.json`,
      JSON.stringify({ name: `mend-autopilot-${harness}`, version: '0.1.0', description: 'synthetic' }),
    );
  }
  await fs.copyFile(BUILD_SCRIPT, path.join(root, 'build.mjs'));
  return root;
}

function runCli(root, args) {
  return spawnSync(process.execPath, [path.join(root, 'build.mjs'), ...args], { cwd: root, encoding: 'utf8' });
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

const distOf = (root, harness) => path.join(root, 'dist', `mend-autopilot-${harness}`);

const WORKFLOW_LIMIT = 48 * 1024;

async function assertWorkflowSizes(directory, filter = () => true) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      count += await assertWorkflowSizes(file, filter);
    } else if (entry.isFile() && filter(file)) {
      const { size } = await fs.stat(file);
      assert.ok(size < WORKFLOW_LIMIT, `${file} is ${size} bytes; workflows must be under ${WORKFLOW_LIMIT} bytes`);
      count += 1;
    }
  }
  return count;
}

test('source workflow files are below the runtime size limit', async () => {
  assert.ok(await assertWorkflowSizes(path.join(SOURCE_ROOT, 'core/workflows')) > 0);
});

test('quality workflow leaves room below the runtime size limit', async () => {
  const { size } = await fs.stat(path.join(SOURCE_ROOT, 'core/workflows/mend-quality.js'));
  assert.ok(size < 44_000, `mend-quality.js is ${size} bytes; keep it under 44000 bytes`);
});

test('built workflow scripts are below the runtime size limit for every harness', async () => {
  const root = await makeRepo();
  await fs.cp(path.join(SOURCE_ROOT, 'core'), path.join(root, 'core'), { recursive: true });
  await fs.cp(path.join(SOURCE_ROOT, 'adapters'), path.join(root, 'adapters'), { recursive: true });
  for (const harness of HARNESSES) {
    await build({ harness, root });
    const directory = path.join(distOf(root, harness), 'workflows');
    assert.ok(await assertWorkflowSizes(directory, (file) => file.endsWith('.js')) > 0);
    // Helpers must ship and run through Node, not workflow imports/file access.
    for (const [helper, operation, input, expected] of [
      ['quality-prompts.mjs', 'owner', { proposalStage: true, feedback: 'fixture', approvedProposals: [] }, { prompt: "Revise only the proposal artifacts, not the integration. Never edit proposal-plan.json in the item evidence folder: it is the workflow's frozen record of the restated item; put the planned fix and any detail a finding asks for into your proposal artifacts. fixture" }],
      ['quality-review.mjs', 'drift', { firstScores: null }, { result: null }],
    ]) {
      const built = path.join(distOf(root, harness), 'checks', helper);
      assert.equal(await fs.readFile(built, 'utf8'), await fs.readFile(path.join(SOURCE_ROOT, 'core/checks', helper), 'utf8'));
      const result = spawnSync(process.execPath, [built, operation, JSON.stringify(input)], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.trim(), `${harness}/${helper} exited without JSON`);
      assert.deepEqual(JSON.parse(result.stdout), expected);
    }
  }
});

test('quality helper entrypoints work through symlinked directories and remain inert on import', async () => {
  const root = await makeTemporaryDir('mend-quality-cli-');
  const real = path.join(root, 'real');
  const alias = path.join(root, 'alias');
  await fs.mkdir(real);
  await fs.symlink(real, alias, 'dir');
  // The package ships the checks together, so a helper's sibling imports are present.
  for (const sibling of (await fs.readdir(path.join(SOURCE_ROOT, 'core/checks'))).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))) {
    await fs.copyFile(path.join(SOURCE_ROOT, 'core/checks', sibling), path.join(real, sibling));
  }
  for (const [helper, operation, input, expected] of [
    ['quality-prompts.mjs', 'owner', { proposalStage: true, feedback: 'fixture' }, { prompt: "Revise only the proposal artifacts, not the integration. Never edit proposal-plan.json in the item evidence folder: it is the workflow's frozen record of the restated item; put the planned fix and any detail a finding asks for into your proposal artifacts. fixture" }],
    ['quality-review.mjs', 'drift', { firstScores: null }, { result: null }],
  ]) {
    await fs.copyFile(path.join(SOURCE_ROOT, 'core/checks', helper), path.join(real, helper));
    for (const directory of [real, alias]) {
      const entry = path.join(directory, helper);
      const result = spawnSync(process.execPath, [entry, operation, JSON.stringify(input)], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.trim(), `${entry} exited without JSON`);
      assert.deepEqual(JSON.parse(result.stdout), expected);
      const invalid = spawnSync(process.execPath, [entry, operation, '{'], { encoding: 'utf8' });
      assert.equal(invalid.status, 64, invalid.stderr);
      assert.equal(invalid.stdout, '');
      assert.match(invalid.stderr, /QUALITY-(PROMPTS|REVIEW)/);
    }
    const importer = path.join(root, `import-${helper}`);
    await fs.writeFile(importer, `import './alias/${helper}';\nprocess.stdout.write('imported');\n`);
    const imported = spawnSync(process.execPath, [importer], { encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, 'imported');
    assert.equal(imported.stderr, '');
  }
});

test('unknown harness exits 64 and writes nothing', async () => {
  const root = await makeRepo();
  const result = runCli(root, ['vscode']);
  assert.equal(result.status, EXIT.usage);
  assert.match(result.stderr, /unknown harness "vscode"/);
  assert.equal(await exists(path.join(root, 'dist')), false);
});

test('missing argument and unknown flag are usage errors', async () => {
  const root = await makeRepo();
  assert.equal(runCli(root, []).status, EXIT.usage);
  assert.equal(runCli(root, ['codex', '--force']).status, EXIT.usage);
  assert.equal(await exists(path.join(root, 'dist')), false);
});

test('adapter file overrides the core file with the same relative path', async () => {
  const root = await makeRepo();
  await writeFile(root, 'adapters/codex/skills/demo/SKILL.md', 'codex adapter version\n');
  const result = await build({ harness: 'codex', root });
  assert.deepEqual(result.leaks, []);
  const shipped = await fs.readFile(path.join(distOf(root, 'codex'), 'skills/demo/SKILL.md'), 'utf8');
  assert.equal(shipped, 'codex adapter version\n');
  const claude = await build({ harness: 'claude', root });
  assert.deepEqual(claude.leaks, []);
  assert.equal(await fs.readFile(path.join(distOf(root, 'claude'), 'skills/demo/SKILL.md'), 'utf8'), 'core version\n');
});

test('all builds the three packages with their own manifest', async () => {
  const root = await makeRepo();
  const result = runCli(root, ['all']);
  assert.equal(result.status, EXIT.ok, result.stderr);
  for (const harness of HARNESSES) {
    const manifest = JSON.parse(await fs.readFile(path.join(distOf(root, harness), 'mendcode-package.json'), 'utf8'));
    assert.equal(manifest.name, `mend-autopilot-${harness}`);
    assert.equal(await exists(path.join(distOf(root, harness), 'shared.md')), true);
  }
});

test('generated files (bytecode caches, .DS_Store) are never shipped or counted as drift', async () => {
  const root = await makeRepo();
  await writeFile(root, 'core/guard/__pycache__/mend_guard.cpython-314.pyc', 'bytecode');
  await writeFile(root, 'core/guard/stray.pyc', 'bytecode');
  await writeFile(root, 'core/.DS_Store', 'finder');
  assert.equal(runCli(root, ['codex']).status, EXIT.ok);
  const dist = distOf(root, 'codex');
  assert.equal(await exists(path.join(dist, 'guard')), false);
  assert.equal(await exists(path.join(dist, '.DS_Store')), false);
  assert.equal(runCli(root, ['codex', '--check']).status, EXIT.ok);
});

test('--check reports changed, missing and extra files and writes nothing', async () => {
  const root = await makeRepo();
  assert.equal(runCli(root, ['codex']).status, EXIT.ok);
  assert.equal(runCli(root, ['codex', '--check']).status, EXIT.ok);

  const dist = distOf(root, 'codex');
  await fs.writeFile(path.join(dist, 'shared.md'), 'edited by hand\n');
  await fs.writeFile(path.join(dist, 'stray.md'), 'not in source\n');
  await fs.rm(path.join(dist, 'skills/demo/SKILL.md'));

  const result = runCli(root, ['codex', '--check']);
  assert.equal(result.status, EXIT.drift);
  assert.match(result.stderr, /differs shared\.md/);
  assert.match(result.stderr, /extra stray\.md/);
  assert.match(result.stderr, /missing skills\/demo\/SKILL\.md/);
  assert.equal(await fs.readFile(path.join(dist, 'shared.md'), 'utf8'), 'edited by hand\n');
});

test('--check on a never-built package is drift, not success', async () => {
  const root = await makeRepo();
  const result = runCli(root, ['claude', '--check']);
  assert.equal(result.status, EXIT.drift);
  assert.equal(await exists(path.join(root, 'dist')), false);
});

test('a symlink that escapes the source tree is rejected and nothing is written', async () => {
  const root = await makeRepo();
  const outside = await makeTemporaryDir('mend-autopilot-outside-');
  await writeFile(outside, 'secret.md', 'outside data\n');
  await fs.symlink(outside, path.join(root, 'core/skills/escape'));
  const result = runCli(root, ['codex']);
  assert.equal(result.status, EXIT.invalidSource);
  assert.match(result.stderr, /symlinks are not allowed/);
  assert.equal(await exists(path.join(root, 'dist')), false);
});

test('relative paths that climb out of the tree are rejected', () => {
  for (const unsafe of ['../outside.md', 'skills/../../outside.md', '/etc/passwd', '..']) {
    assert.throws(() => assertSafeRelative(unsafe), (error) => error instanceof BuildError && error.code === EXIT.invalidSource);
  }
  assert.equal(assertSafeRelative('skills/demo/SKILL.md'), path.normalize('skills/demo/SKILL.md'));
});

test('a leak in a shipped file exits 3 with file:line and keeps the previous dist', async () => {
  const root = await makeRepo();
  assert.equal(runCli(root, ['codex']).status, EXIT.ok);
  await writeFile(root, 'core/skills/demo/SKILL.md', 'line one\nsee /Users/someone/notes for details\n');
  const result = runCli(root, ['codex']);
  assert.equal(result.status, EXIT.leak);
  assert.match(result.stderr, /core\/skills\/demo\/SKILL\.md:2 matches \/Users\/someone/);
  assert.equal(await fs.readFile(path.join(distOf(root, 'codex'), 'skills/demo/SKILL.md'), 'utf8'), 'core version\n');
});

test('denylist words match case-insensitively as whole words, including multi-word entries', async () => {
  const root = await makeRepo();
  await writeFile(root, 'adapters/claude/fixtures/case.md', 'Built for ZORBLAX\nby Acme   Widgets\nzorblaxian is fine\n');
  const result = await build({ harness: 'claude', root });
  assert.deepEqual(result.leaks.sort(), [
    'adapters/claude/fixtures/case.md:1 matches ZORBLAX',
    'adapters/claude/fixtures/case.md:2 matches Acme   Widgets',
  ]);
  assert.equal(await exists(path.join(root, 'dist')), false);
});

test('a denylisted name in a file path is a leak', async () => {
  const root = await makeRepo();
  await writeFile(root, 'core/fixtures/zorblax-report.md', 'neutral text\n');
  const result = await build({ harness: 'codex', root });
  assert.equal(result.leaks.length, 1);
  assert.match(result.leaks[0], /core\/fixtures\/zorblax-report\.md \(path\) matches zorblax/);
});

test('a leak in the public tree blocks every harness; docs/tasks is private and ignored', async () => {
  const root = await makeRepo();
  await writeFile(root, 'docs/tasks/plan.md', 'private plan mentions zorblax\n');
  assert.equal(runCli(root, ['all']).status, EXIT.ok);

  await writeFile(root, 'docs/guide.md', 'intro\nThanks to Zorblax for the idea\n');
  await fs.rm(path.join(root, 'dist'), { recursive: true });
  const result = runCli(root, ['all']);
  assert.equal(result.status, EXIT.leak);
  assert.match(result.stderr, /docs\/guide\.md:2 matches Zorblax/);
  assert.doesNotMatch(result.stderr, /docs\/tasks/);
  assert.equal(await exists(path.join(root, 'dist')), false);

  assert.equal(runCli(root, ['codex', '--check']).status, EXIT.leak);
});

test('UTF-8 accented denylist terms are reported in public files but ignored in private paths', async () => {
  const root = await makeRepo();
  await writeFile(root, 'docs/tasks/plan.md', 'private: Ñandú Café\n');
  await writeFile(root, 'private.txt', 'private: Ñandú Café\n');
  assert.equal(runCli(root, ['codex']).status, EXIT.ok);

  await writeFile(root, 'docs/guide.md', 'intro\nmentions ñANDÚ CAFÉ\n');
  const result = runCli(root, ['codex']);
  assert.equal(result.status, EXIT.leak);
  assert.match(result.stderr, /docs\/guide\.md:2 matches ñANDÚ CAFÉ/);
  assert.doesNotMatch(result.stderr, /docs\/tasks|private\.txt/);
});

test('ASCII and Latin-1 denylist terms are still detected in non-UTF-8 files', async () => {
  const root = await makeRepo();
  await writeFile(root, 'docs/binary.dat', Buffer.concat([
    Buffer.from([0xff]), Buffer.from('\nZORBLAX\nÑandú Café\n', 'latin1'),
  ]));
  const result = runCli(root, ['codex']);
  assert.equal(result.status, EXIT.leak);
  assert.match(result.stderr, /docs\/binary\.dat:2 matches ZORBLAX/);
  assert.match(result.stderr, /docs\/binary\.dat:3 matches Ñandú Café/);
  assert.deepEqual((await build({ harness: 'codex', root })).leaks, [
    'docs/binary.dat:2 matches ZORBLAX',
    'docs/binary.dat:3 matches Ñandú Café',
  ]);
});

test('a leak in one harness writes no harness at all', async () => {
  const root = await makeRepo();
  await writeFile(root, 'adapters/opencode-go/notes.md', 'path /Users/someone\n');
  const result = runCli(root, ['all']);
  assert.equal(result.status, EXIT.leak);
  assert.equal(await exists(path.join(root, 'dist')), false);
});

test('the denylist and docs/tasks are never shipped', async () => {
  const root = await makeRepo();
  await writeFile(root, 'docs/tasks/plan.md', 'private\n');
  assert.equal(runCli(root, ['codex']).status, EXIT.ok);
  const shipped = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else shipped.push(path.relative(distOf(root, 'codex'), absolute));
    }
  }
  await walk(distOf(root, 'codex'));
  assert.deepEqual(shipped.sort(), ['mendcode-package.json', 'shared.md', path.normalize('skills/demo/SKILL.md')].sort());

  await writeFile(root, 'core/leak-denylist.json', '{}');
  assert.equal(runCli(root, ['codex']).status, EXIT.invalidSource);
});

test('the optional local denylist adds its names, never ships, and its absence still builds', async () => {
  const root = await makeRepo();
  await writeFile(root, 'core/skills/demo/SKILL.md', 'written by quuxcorp\n');
  assert.equal(runCli(root, ['codex']).status, EXIT.ok);
  await writeFile(root, 'build/leak-denylist.local.json', JSON.stringify({ words: ['quuxcorp'], patterns: [] }));
  const result = runCli(root, ['codex', '--check']);
  assert.equal(result.status, EXIT.leak);
  assert.match(result.stderr, /quuxcorp/);
  await writeFile(root, 'build/leak-denylist.local.json', '{not json');
  assert.equal(runCli(root, ['codex']).status, EXIT.invalidSource);
});

test('a missing denylist refuses to build', async () => {
  const root = await makeRepo();
  await fs.rm(path.join(root, 'build/leak-denylist.json'));
  const result = runCli(root, ['codex']);
  assert.equal(result.status, EXIT.invalidSource);
  assert.match(result.stderr, /refusing to build without it/);
  assert.equal(await exists(path.join(root, 'dist')), false);
});

test('an adapter manifest with the wrong name is rejected', async () => {
  const root = await makeRepo();
  await writeFile(root, 'adapters/claude/mendcode-package.json', JSON.stringify({ name: 'other', version: '0.1.0' }));
  const result = runCli(root, ['claude']);
  assert.equal(result.status, EXIT.invalidSource);
  assert.match(result.stderr, /name must be mend-autopilot-claude/);
});

test('a rebuild removes files that no longer exist in source and leaves no staging folders', async () => {
  const root = await makeRepo();
  assert.equal(runCli(root, ['codex']).status, EXIT.ok);
  await fs.rm(path.join(root, 'core/shared.md'));
  assert.equal(runCli(root, ['codex']).status, EXIT.ok);
  assert.equal(await exists(path.join(distOf(root, 'codex'), 'shared.md')), false);
  assert.deepEqual(await fs.readdir(path.join(root, 'dist')), ['mend-autopilot-codex']);
});
