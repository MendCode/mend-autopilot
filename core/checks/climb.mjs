#!/usr/bin/env node
// Climb step: accept a head only when a metric command moves the right way against base and a guard
// command still passes, with the metric and guard files left untouched. Both commands run in temporary
// worktrees of base and head; nothing runs in the user's checkout.

import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchesGlobs } from './changes.mjs';
import { DEFAULT_TIMEOUT_MS, runCommand, withShaWorktrees } from './red-green.mjs';
import { nameStatus } from './repo-read.mjs';

export const EXIT = { accepted: 0, rejected: 1, blocked: 3, usage: 64 };
const METRIC_LINE = /^metric:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/gim;
const DIRECTIONS = new Set(['up', 'down']);

export class ClimbUsageError extends Error {
  constructor(message) {
    super(`[CLIMB]: ${message}`);
    this.name = 'ClimbUsageError';
  }
}

export class ClimbBlockedError extends Error {
  constructor(message) {
    super(`[CLIMB]: BLOCKED: ${message}`);
    this.name = 'ClimbBlockedError';
  }
}

/** The number on the last "metric: <number>" line of a command's output, or null. */
export function readMetric(log) {
  let match;
  let found = null;
  METRIC_LINE.lastIndex = 0;
  while ((match = METRIC_LINE.exec(log)) !== null) found = Number(match[1]);
  return Number.isFinite(found) ? found : null;
}

function validate({ repo, metric, guard, direction, minGain, frozen, timeoutMs, tempRoot }) {
  if (typeof repo !== 'string' || repo === '') throw new ClimbUsageError('repo is required');
  if (typeof metric !== 'string' || metric.trim() === '') throw new ClimbUsageError('a metric command is required');
  if (typeof guard !== 'string' || guard.trim() === '') throw new ClimbUsageError('a guard command is required; a climb without a guard optimises the metric at any cost');
  if (!DIRECTIONS.has(direction)) throw new ClimbUsageError(`direction must be up or down, got ${direction}`);
  if (!Number.isFinite(minGain) || minGain < 0) throw new ClimbUsageError('minGain must be a number of at least 0');
  if (!Array.isArray(frozen) || frozen.some((glob) => typeof glob !== 'string' || glob === '')) throw new ClimbUsageError('frozen must be a list of globs');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ClimbUsageError('timeoutMs must be a positive number');
  if (typeof tempRoot !== 'string' || tempRoot === '') throw new ClimbUsageError('tempRoot must be a folder path');
}

async function frozenEdits({ repo, baseSha, headSha, frozen }) {
  if (frozen.length === 0) return [];
  const changed = await nameStatus({ repo, baseSha, headSha });
  return changed
    .flatMap((change) => [change.path, change.oldPath].filter(Boolean))
    .filter((filePath) => matchesGlobs(filePath, frozen))
    .map((filePath) => ({ rule: 'frozen-edit', detail: `${filePath} is frozen for this climb (metric or guard)` }));
}

export async function runClimbStep({
  repo,
  baseSha,
  headSha,
  metric,
  guard,
  direction = 'up',
  minGain = 0,
  frozen = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tempRoot = os.tmpdir(),
}) {
  validate({ repo, metric, guard, direction, minGain, frozen, timeoutMs, tempRoot });
  const worktrees = { repo, shas: { base: baseSha, head: headSha }, tempRoot, prefix: 'mend-climb-', UsageError: ClimbUsageError, BlockedError: ClimbBlockedError };
  return withShaWorktrees(worktrees, async ({ repoRoot, commits, dirs }) => {
    const frozenFailures = await frozenEdits({ repo: repoRoot, baseSha: commits.base, headSha: commits.head, frozen });
    if (frozenFailures.length > 0) {
      return { accepted: false, failures: frozenFailures, metric: null, guard: null, logs: {} };
    }

    const safety = { guardCwd: repoRoot, BlockedError: ClimbBlockedError };
    const baseGuard = await runCommand({ command: guard, cwd: dirs.base, timeoutMs, ...safety });
    if (baseGuard.exit !== 0) throw new ClimbBlockedError(`the guard fails at base (exit ${baseGuard.exit}); fix the guard or the base before climbing\n${baseGuard.log}`);
    const baseMetric = await runCommand({ command: metric, cwd: dirs.base, timeoutMs, ...safety });
    if (baseMetric.exit !== 0 || baseMetric.timedOut) throw new ClimbBlockedError(`the metric command failed at base (exit ${baseMetric.exit}${baseMetric.timedOut ? ', timed out' : ''})\n${baseMetric.log}`);
    const before = readMetric(baseMetric.log);
    if (before === null) throw new ClimbBlockedError(`the metric command printed no "metric: <number>" line with a finite value at base (exit ${baseMetric.exit})\n${baseMetric.log}`);

    const headGuard = await runCommand({ command: guard, cwd: dirs.head, timeoutMs, ...safety });
    const headMetric = await runCommand({ command: metric, cwd: dirs.head, timeoutMs, ...safety });
    const after = readMetric(headMetric.log);

    const failures = [];
    if (headGuard.exit !== 0) failures.push({ rule: 'guard-regressed', detail: `the guard passes at base and fails at head (exit ${headGuard.exit})` });
    let gain = null;
    if (headMetric.exit !== 0 || headMetric.timedOut) failures.push({ rule: 'metric-failed', detail: `the metric command failed at head (exit ${headMetric.exit}${headMetric.timedOut ? ', timed out' : ''})` });
    else if (after === null) failures.push({ rule: 'metric-missing', detail: `the metric command printed no finite number at head (exit ${headMetric.exit})` });
    else {
      gain = direction === 'up' ? after - before : before - after;
      if (gain <= minGain) failures.push({ rule: 'no-gain', detail: `metric ${before} -> ${after} (${direction}); gain ${gain} is not above ${minGain}` });
    }
    return {
      accepted: failures.length === 0,
      failures,
      metric: { base: before, head: after, gain, direction },
      guard: { baseExit: baseGuard.exit, headExit: headGuard.exit },
      logs: { baseGuard: baseGuard.log, baseMetric: baseMetric.log, headGuard: headGuard.log, headMetric: headMetric.log },
    };
  });
}

// ---------------------------------------------------------------------------
// CLI

const USAGE =
  "usage: node climb.mjs --base <sha> --head <sha> --metric '<cmd>' --guard '<cmd>' [--direction up|down] [--min-gain <n>] [--frozen <glob>]... [--repo <dir>] [--timeout-ms <n>] [--json]";

function parseArguments(argv) {
  const options = { repo: process.cwd(), json: false, direction: 'up', minGain: '0', frozen: [], timeoutMs: String(DEFAULT_TIMEOUT_MS) };
  const valueFlags = {
    '--base': 'base',
    '--head': 'head',
    '--metric': 'metric',
    '--guard': 'guard',
    '--direction': 'direction',
    '--min-gain': 'minGain',
    '--repo': 'repo',
    '--timeout-ms': 'timeoutMs',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument in valueFlags || argument === '--frozen') {
      const value = argv[index + 1];
      if (value === undefined) throw new ClimbUsageError(`${argument} needs a value`);
      if (argument === '--frozen') options.frozen.push(value);
      else options[valueFlags[argument]] = value;
      index += 1;
    } else if (argument === '--json') options.json = true;
    else throw new ClimbUsageError(`unknown argument ${argument}`);
  }
  for (const [key, flagName] of [['base', '--base'], ['head', '--head'], ['metric', '--metric'], ['guard', '--guard']]) {
    if (!options[key]) throw new ClimbUsageError(`${flagName} is required`);
  }
  return { ...options, minGain: Number(options.minGain), timeoutMs: Number(options.timeoutMs) };
}

function summary(result) {
  if (!result.metric) return `[CLIMB]: REJECTED: ${result.failures.map((failure) => failure.detail).join('; ')}`;
  const { base, head, direction } = result.metric;
  const verdict = result.accepted ? 'ACCEPTED' : 'REJECTED';
  const reasons = result.failures.map((failure) => `${failure.rule}: ${failure.detail}`).join('; ');
  return `[CLIMB]: ${verdict}: metric ${base} -> ${head ?? 'none'} (${direction}), guard exit ${result.guard.baseExit} -> ${result.guard.headExit}${reasons ? `; ${reasons}` : ''}`;
}

export async function main(argv) {
  try {
    const options = parseArguments(argv);
    const result = await runClimbStep({
      repo: path.resolve(options.repo),
      baseSha: options.base,
      headSha: options.head,
      metric: options.metric,
      guard: options.guard,
      direction: options.direction,
      minGain: options.minGain,
      frozen: options.frozen,
      timeoutMs: options.timeoutMs,
    });
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${summary(result)}\n`);
    return result.accepted ? EXIT.accepted : EXIT.rejected;
  } catch (error) {
    if (error instanceof ClimbUsageError) {
      process.stderr.write(`${error.message}\n${USAGE}\n`);
      return EXIT.usage;
    }
    if (error instanceof ClimbBlockedError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT.blocked;
    }
    throw error;
  }
}

function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
