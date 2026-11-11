import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClimbBlockedError, ClimbUsageError, EXIT, readMetric, runClimbStep } from './climb.mjs';
import { makeFixtureRepo, removeAll } from './test-support.mjs';

// A private temp root, so counting leftover worktree folders is not disturbed by other test files.
const PRIVATE_TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mend-climb-suite-')));
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'climb.mjs');
const dirs = [PRIVATE_TMP];
after(() => removeAll(dirs));

// The metric reads a number from size.txt; the guard passes while guard.txt says ok.
const METRIC = 'sh bench.sh';
const GUARD = 'grep -qx ok guard.txt';
const BENCH = 'echo "warming up"\necho "metric: $(cat size.txt)"\n';

function repoWith({ baseSize, headSize, baseGuard = 'ok', headGuard = 'ok', headBench = BENCH, baseBench = BENCH }) {
  return makeFixtureRepo({
    dirs,
    prefix: 'mend-climb-test-',
    files: [
      { path: 'size.txt', base: `${baseSize}\n`, head: `${headSize}\n` },
      { path: 'guard.txt', base: `${baseGuard}\n`, head: `${headGuard}\n` },
      { path: 'bench.sh', base: baseBench, head: headBench },
    ],
  });
}

async function climbDirs() {
  return (await fs.readdir(PRIVATE_TMP)).filter((name) => name.startsWith('mend-climb-'));
}

const step = (repo, options) => runClimbStep({ repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, metric: METRIC, guard: GUARD, tempRoot: PRIVATE_TMP, ...options });

describe('runClimbStep', () => {
  test('a smaller number with direction down and the guard passing at both SHAs is accepted, and no worktree is left', async () => {
    const repo = await repoWith({ baseSize: 400, headSize: 300 });
    const result = await step(repo, { direction: 'down' });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.metric, { base: 400, head: 300, gain: 100, direction: 'down' });
    assert.deepEqual(await climbDirs(), []);
  });

  test('the same gain with the guard failing at head is rejected', async () => {
    const repo = await repoWith({ baseSize: 400, headSize: 300, headGuard: 'broken' });
    const result = await step(repo, { direction: 'down' });
    assert.equal(result.accepted, false);
    assert.deepEqual(result.failures.map((failure) => failure.rule), ['guard-regressed']);
  });

  test('a plateau, a regression and a gain under minGain are rejected as no-gain', async () => {
    for (const [headSize, minGain] of [[400, 0], [450, 0], [395, 10]]) {
      const repo = await repoWith({ baseSize: 400, headSize });
      const result = await step(repo, { direction: 'down', minGain });
      assert.deepEqual(result.failures.map((failure) => failure.rule), ['no-gain'], `head ${headSize}, minGain ${minGain}`);
    }
  });

  test('a guard that already fails at base blocks the climb', async () => {
    const repo = await repoWith({ baseSize: 400, headSize: 300, baseGuard: 'broken', headGuard: 'ok' });
    await assert.rejects(step(repo, { direction: 'down' }), (error) => error instanceof ClimbBlockedError && /guard fails at base/.test(error.message));
    assert.deepEqual(await climbDirs(), []);
  });

  test('shared shell runner refuses unsafe climb commands with the source guard policy', async () => {
    const repo = await repoWith({ baseSize: 400, headSize: 300 });
    await fs.mkdir(path.join(repo.root, '.mend'));
    await fs.writeFile(path.join(repo.root, '.mend', 'guard.json'), JSON.stringify({ productionPatterns: ['guard-policy-target'] }));
    const marker = path.join(repo.root, 'unguarded-marker');
    for (const field of ['metric', 'guard']) {
      for (const [command, rule] of [['cat .env', 'secret-read'], ['printf guard-policy-target', 'production-pattern']]) {
        await assert.rejects(step(repo, { direction: 'down', [field]: `touch '${marker}'; ${command}` }),
          (error) => error instanceof ClimbBlockedError && error.message.includes(rule));
        await assert.rejects(fs.access(marker));
        assert.deepEqual(await climbDirs(), []);
      }
    }
  });

  test('a metric command that prints no number at base blocks the climb; at head it rejects the step', async () => {
    const silent = 'echo "done"\n';
    const blocked = await repoWith({ baseSize: 400, headSize: 300, baseBench: silent, headBench: silent });
    await assert.rejects(step(blocked, { direction: 'down', frozen: [] }), (error) => error instanceof ClimbBlockedError && /no "metric: <number>"/.test(error.message));
    const broken = await repoWith({ baseSize: 400, headSize: 300, headBench: silent });
    const result = await step(broken, { direction: 'down' });
    assert.deepEqual(result.failures.map((failure) => failure.rule), ['metric-missing']);
  });

  test('a metric that prints a number and exits nonzero blocks base or rejects head', async () => {
    const failing = `${BENCH}exit 1\n`;
    const base = await repoWith({ baseSize: 400, headSize: 300, baseBench: failing });
    await assert.rejects(step(base, { direction: 'down' }), (error) => error instanceof ClimbBlockedError && /metric command failed at base/.test(error.message));
    const head = await repoWith({ baseSize: 400, headSize: 300, headBench: failing });
    const result = await step(head, { direction: 'down' });
    assert.equal(result.accepted, false);
    assert.deepEqual(result.failures.map((failure) => failure.rule), ['metric-failed']);
    assert.equal(result.metric.gain, null);
  });

  test('a metric that prints a number then times out blocks base or rejects head', async () => {
    const hanging = `${BENCH}sleep 10\n`;
    const base = await repoWith({ baseSize: 400, headSize: 300, baseBench: hanging });
    await assert.rejects(step(base, { direction: 'down', timeoutMs: 500 }), (error) => error instanceof ClimbBlockedError && /timed out/.test(error.message));
    const head = await repoWith({ baseSize: 400, headSize: 300, headBench: hanging });
    const result = await step(head, { direction: 'down', timeoutMs: 500 });
    assert.equal(result.accepted, false);
    assert.deepEqual(result.failures.map((failure) => failure.rule), ['metric-failed']);
    assert.match(result.failures[0].detail, /timed out/);
    assert.equal(result.metric.gain, null);
  });

  test('a non-finite metric blocks base or rejects head', async () => {
    const overflow = 'echo "metric: 1e999"\n';
    const base = await repoWith({ baseSize: 400, headSize: 300, baseBench: overflow });
    await assert.rejects(step(base, { direction: 'down' }), (error) => error instanceof ClimbBlockedError && /finite value at base/.test(error.message));
    const head = await repoWith({ baseSize: 400, headSize: 300, headBench: overflow });
    const result = await step(head, { direction: 'down' });
    assert.equal(result.accepted, false);
    assert.deepEqual(result.failures.map((failure) => failure.rule), ['metric-missing']);
    assert.equal(result.metric.gain, null);
  });

  test('a head that edits a frozen file is rejected before anything runs', async () => {
    const repo = await repoWith({ baseSize: 400, headSize: 400, headBench: 'echo "metric: 1"\n' });
    const result = await step(repo, { direction: 'down', frozen: ['bench.sh', 'guard.txt'] });
    assert.equal(result.accepted, false);
    assert.deepEqual(result.failures, [{ rule: 'frozen-edit', detail: 'bench.sh is frozen for this climb (metric or guard)' }]);
    assert.equal(result.metric, null);
  });

  test('missing guard, a bad direction and an unknown SHA are usage errors', async () => {
    const repo = await repoWith({ baseSize: 1, headSize: 2 });
    await assert.rejects(step(repo, { guard: '' }), ClimbUsageError);
    await assert.rejects(step(repo, { direction: 'sideways' }), ClimbUsageError);
    await assert.rejects(step(repo, { headSha: 'f'.repeat(40) }), (error) => error instanceof ClimbUsageError && /commit not found/.test(error.message));
  });
});

describe('readMetric', () => {
  test('uses the last metric line and ignores numbers elsewhere', () => {
    assert.equal(readMetric('took 12 ms\nmetric: 5\nretry\nMetric: 4.5\n'), 4.5);
    assert.equal(readMetric('metric: fast\n'), null);
    assert.equal(readMetric('metric: -2e3\n'), -2000);
    assert.equal(readMetric('metric: 1\nmetric: 1e999\n'), null);
  });
});

describe('CLI', () => {
  test('exit codes: 0 accepted, 1 rejected, 3 blocked, 64 usage', async () => {
    const run = (repo, extra) =>
      spawnSync(process.execPath, [CLI, '--repo', repo.root, '--base', repo.baseSha, '--head', repo.headSha, '--metric', METRIC, '--guard', GUARD, ...extra], {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: PRIVATE_TMP },
      }).status;
    const better = await repoWith({ baseSize: 10, headSize: 20 });
    assert.equal(run(better, ['--direction', 'up']), EXIT.accepted);
    assert.equal(run(better, ['--direction', 'down']), EXIT.rejected);
    const brokenBase = await repoWith({ baseSize: 10, headSize: 20, baseGuard: 'no' });
    assert.equal(run(brokenBase, []), EXIT.blocked);
    assert.equal(run(better, ['--min-gain']), EXIT.usage);
    assert.equal(run(better, ['--wat']), EXIT.usage);
  });
});
