// Shared helpers for profile check tests: run a check's fixture folder, and build a throwaway git repo
// from the same { path, base, head } file lists so the repo adapter is tested on the fixture data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture } from './capture.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

export const rulesOf = (result) => [...new Set(result.failures.map((failure) => failure.rule))].sort();

export async function readFixtures(fixturesDir) {
  const names = (await fs.readdir(fixturesDir)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => ({ name, fixture: JSON.parse(await fs.readFile(path.join(fixturesDir, name), 'utf8')) })));
}

/** Every pass-* fixture passes with no failures; every fail-* fixture fails exactly the rules it names. */
export async function assertFixtures(check, fixturesDir) {
  const fixtures = await readFixtures(fixturesDir);
  assert.ok(fixtures.some(({ name }) => name.startsWith('pass-')), `${check.id}: no pass fixture`);
  assert.ok(fixtures.some(({ name }) => name.startsWith('fail-')), `${check.id}: no fail fixture`);
  for (const { name, fixture } of fixtures) {
    const result = await check.runFixture(fixture);
    if (name.startsWith('pass-')) {
      assert.deepEqual(result.failures, [], name);
      assert.equal(result.pass, true, name);
    } else {
      assert.deepEqual(rulesOf(result), [...fixture.expect].sort(), name);
      assert.equal(result.pass, false, name);
    }
  }
  return fixtures;
}

export function gitSync(cwd, args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function writeSide(root, files, side) {
  for (const file of files) {
    const target = path.join(root, file.path);
    const text = file[side];
    if (text === null || text === undefined) {
      await fs.rm(target, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
}

/**
 * A git repo with a base commit and a head commit built from fixture files. Register cleanup with the
 * returned directory list: `after(() => removeAll(dirs))`.
 */
export async function makeFixtureRepo({ files, dirs, prefix = 'mend-check-test-' }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(root);
  gitSync(root, ['init', '-q', '-b', 'main']);
  await writeSide(root, files, 'base');
  gitSync(root, ['add', '-A']);
  gitSync(root, ['commit', '-q', '--allow-empty', '-m', 'base']);
  const baseSha = gitSync(root, ['rev-parse', 'HEAD']);
  await writeSide(root, files, 'head');
  gitSync(root, ['add', '-A']);
  gitSync(root, ['commit', '-q', '--allow-empty', '-m', 'head']);
  return { root, baseSha, headSha: gitSync(root, ['rev-parse', 'HEAD']) };
}

/** Writes .mend/evidence/<itemId>/<name> as JSON in a test repo (outside git, like real evidence). */
export async function writeEvidence({ root, itemId, name, value }) {
  const dir = path.join(root, '.mend', 'evidence', itemId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), JSON.stringify(value));
}

/** Run a synthetic command through the same capture path as the lead. */
export async function captureEvidence({ root, itemId, kind, value }) {
  const script = `console.log('MEND_EVIDENCE '+JSON.stringify(${JSON.stringify(value)}))`;
  return capture({ repo: root, item: { id: itemId }, kind, command: `node -e ${JSON.stringify(script)}` });
}

export function removeAll(dirs) {
  return Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
}
