#!/usr/bin/env node
// Red-green runner: a regression command must fail at base and pass at head.
// Runs each side in a temporary git worktree it creates and removes itself; never in the user's checkout.

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isTestPath } from './changes.mjs';
import { DEFAULT_GLOBS, globToRegExp } from './integrity.mjs';
import { assertGuardAllowed, GuardBlockedError } from './guard-command.mjs';

const execFileAsync = promisify(execFile);

export const EXIT = { pass: 0, fail: 1, blocked: 3, usage: 64 };
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const LOG_LIMIT = 64 * 1024;
const TIMEOUT_EXIT = 124;
const KILL_GRACE_MS = 2000;

export class RedGreenUsageError extends Error {
  constructor(message) {
    super(`[RED-GREEN]: ${message}`);
    this.name = 'RedGreenUsageError';
  }
}

export class RedGreenBlockedError extends Error {
  constructor(message) {
    super(`[RED-GREEN]: BLOCKED: ${message}`);
    this.name = 'RedGreenBlockedError';
  }
}

async function git(repo, args) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function authorizedTests({ repo, baseSha, headSha, item, testGlobs }) {
  let text;
  try { text = await git(repo, ['show', `${baseSha}:.mend/integrity.json`]); } catch {}
  if (text === undefined && testGlobs === undefined) {
    try { text = await (await import('node:fs/promises')).readFile(path.join(repo, '.mend/integrity.json'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const config = text === undefined ? { testGlobs } : JSON.parse(text);
  const tests = [...DEFAULT_GLOBS.test, ...(Array.isArray(config.testGlobs) ? config.testGlobs.map(String) : [])].map(globToRegExp);
  const scope = (Array.isArray(item?.editSet) ? item.editSet : []).map(globToRegExp);
  const excluded = [...DEFAULT_GLOBS.gateConfig, ...DEFAULT_GLOBS.baseline].map(globToRegExp);
  const changed = await git(repo, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', '--diff-filter=AM', baseSha, headSha, '--']);
  return changed.split('\0').filter((file) => file && scope.some((glob) => glob.test(file)) && tests.some((glob) => glob.test(file)) && !excluded.some((glob) => glob.test(file)));
}

async function resolveCommit(repo, sha, UsageError) {
  if (typeof sha !== 'string' || sha.trim() === '') throw new UsageError('base and head SHAs are required');
  try {
    return (await git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])).trim();
  } catch {
    throw new UsageError(`commit not found: ${sha}`);
  }
}

function tail(text) {
  return text.length <= LOG_LIMIT ? text : `[... ${text.length - LOG_LIMIT} bytes cut ...]\n${text.slice(-LOG_LIMIT)}`;
}

/** Runs the command through the shell in its own process group so a timeout kills the whole tree. */
export async function runCommand({ command, cwd, guardCwd = cwd, timeoutMs, env = process.env, BlockedError = RedGreenBlockedError }) {
  try {
    await assertGuardAllowed({ command, cwd, guardCwd, env });
  } catch (error) {
    if (!(error instanceof GuardBlockedError)) throw error;
    throw new BlockedError(error.message);
  }
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(command, { cwd, env, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > LOG_LIMIT * 2) output = output.slice(-LOG_LIMIT * 2);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const kill = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // already exited
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exit: 127, log: tail(`${output}\n${error.message}`), timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const exit = timedOut ? TIMEOUT_EXIT : code ?? 128;
      const note = timedOut ? `\n[RED-GREEN]: timed out after ${timeoutMs} ms` : signal ? `\n[RED-GREEN]: killed by ${signal}` : '';
      resolve({ exit, log: tail(output + note), timedOut });
    });
  });
}

async function addWorktree({ repo, parent, label, sha, BlockedError }) {
  const target = path.join(parent, label);
  try {
    await git(repo, ['worktree', 'add', '--detach', '--quiet', target, sha]);
  } catch (error) {
    throw new BlockedError(`git worktree add failed for ${label}: ${(error.stderr || error.message).trim()}`);
  }
  return target;
}

async function removeWorktrees(repo, parent, created) {
  for (const target of created) {
    try {
      await git(repo, ['worktree', 'remove', '--force', target]);
    } catch {
      // fall through to the directory removal below
    }
  }
  await rm(parent, { recursive: true, force: true });
  try {
    await git(repo, ['worktree', 'prune']);
  } catch {
    // pruning is best effort; the directories are already gone
  }
}

/**
 * Checks out each named SHA in its own temporary worktree under one folder made with `prefix`, calls
 * `use({ repoRoot, commits, dirs })`, and removes every worktree afterwards, whatever `use` did.
 * A bad repo or SHA throws `UsageError`; a worktree that cannot be created throws `BlockedError`.
 */
export async function withShaWorktrees(
  { repo, shas, tempRoot = os.tmpdir(), prefix = 'mend-red-green-', UsageError = RedGreenUsageError, BlockedError = RedGreenBlockedError },
  use,
) {
  const repoRoot = (await git(repo, ['rev-parse', '--show-toplevel']).catch(() => {
    throw new UsageError(`not a git repository: ${repo}`);
  })).trim();
  const commits = {};
  for (const [label, sha] of Object.entries(shas)) commits[label] = await resolveCommit(repoRoot, sha, UsageError);

  const parent = await realpath(await mkdtemp(path.join(tempRoot, prefix)));
  const created = [];
  try {
    const dirs = {};
    for (const [label, sha] of Object.entries(commits)) {
      dirs[label] = await addWorktree({ repo: repoRoot, parent, label, sha, BlockedError });
      created.push(dirs[label]);
    }
    return await use({ repoRoot, commits, dirs });
  } finally {
    await removeWorktrees(repoRoot, parent, created);
  }
}

export async function runRedGreen({ repo, baseSha, headSha, command, keep, setup, expectBase, timeoutMs = DEFAULT_TIMEOUT_MS, tempRoot = os.tmpdir(), testFiles = [] }) {
  if (typeof repo !== 'string' || repo === '') throw new RedGreenUsageError('repo is required');
  if (typeof tempRoot !== 'string' || tempRoot === '') throw new RedGreenUsageError('tempRoot must be a folder path');
  if (typeof command !== 'string' || command.trim() === '') throw new RedGreenUsageError('a regression command is required');
  if (keep !== undefined && (typeof keep !== 'string' || keep.trim() === '')) throw new RedGreenUsageError('keep must be a non-empty command');
  if (setup !== undefined && (typeof setup !== 'string' || setup.trim() === '')) throw new RedGreenUsageError('setup must be a non-empty command');
  if (expectBase !== undefined && typeof expectBase !== 'string') throw new RedGreenUsageError('expectBase must be a regular expression source');
  let basePattern = null;
  if (expectBase !== undefined) {
    try { basePattern = new RegExp(expectBase); }
    catch { throw new RedGreenUsageError(`invalid expectBase regular expression: ${expectBase}`); }
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RedGreenUsageError('timeoutMs must be a positive number');
  return withShaWorktrees({ repo, shas: { base: baseSha, head: headSha }, tempRoot }, async ({ repoRoot, commits, dirs }) => {
    // Refuse the whole batch before setup can have side effects. Resolve paths in each actual worktree,
    // but retain the source checkout's local guard policy, which is not part of either commit.
    try {
      for (const cwd of Object.values(dirs)) {
        for (const candidate of [setup, command, keep].filter((value) => value !== undefined)) {
          await assertGuardAllowed({ command: candidate, cwd, guardCwd: repoRoot });
        }
      }
    } catch (error) {
      if (!(error instanceof GuardBlockedError)) throw error;
      throw new RedGreenBlockedError(error.message);
    }
    let overlaid;
    try {
      const changed = await git(repoRoot, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', '--diff-filter=AM', commits.base, commits.head, '--']);
      overlaid = changed.split('\0').filter((file) => file && (testFiles.includes(file) || isTestPath(file) || /(^|\/)(tests|test|__tests__|spec)\//.test(file)));
      for (const file of overlaid) await git(dirs.base, ['checkout', commits.head, '--', `:(literal)${file}`]);
    } catch (error) {
      throw new RedGreenBlockedError(`test overlay failed: ${(error.stderr || error.message).trim()}`);
    }
    if (setup !== undefined) {
      for (const side of ['base', 'head']) {
        const result = await runCommand({ command: setup, cwd: dirs[side], guardCwd: repoRoot, timeoutMs, env: { ...process.env, MEND_REPO_ROOT: repoRoot } });
        if (result.exit !== 0) throw new RedGreenBlockedError(`setup failed at ${side}: ${setup} (exit ${result.exit})\n${result.log}`);
      }
    }
    const baseRun = await runCommand({ command, cwd: dirs.base, guardCwd: repoRoot, timeoutMs });
    const headRun = await runCommand({ command, cwd: dirs.head, guardCwd: repoRoot, timeoutMs });
    const keepBase = keep === undefined ? null : await runCommand({ command: keep, cwd: dirs.base, guardCwd: repoRoot, timeoutMs });
    const keepHead = keep === undefined ? null : await runCommand({ command: keep, cwd: dirs.head, guardCwd: repoRoot, timeoutMs });
    const reasons = [];
    const baseMatched = basePattern === null ? null : basePattern.test(baseRun.log);
    if (baseRun.timedOut || headRun.timedOut) reasons.push(`command timed out after ${timeoutMs} ms`);
    if (baseRun.exit === 0) reasons.push('test does not reproduce the bug: the command passes at base');
    else if (basePattern !== null && !baseMatched) reasons.push(`the base fails, but not with the expected failure (expected /${expectBase}/)`);
    if (headRun.exit !== 0 && !headRun.timedOut) reasons.push(`the command still fails at head (exit ${headRun.exit})`);
    if (keepBase && keepBase.exit !== 0) reasons.push(`keep fails at base (exit ${keepBase.exit})`);
    if (keepHead && keepHead.exit !== 0) reasons.push(`keep fails at head (exit ${keepHead.exit})`);
    return {
      pass: reasons.length === 0,
      expectBase: expectBase ?? null,
      baseMatched,
      overlaid,
      baseExit: baseRun.exit,
      headExit: headRun.exit,
      timedOut: baseRun.timedOut || headRun.timedOut,
      reason: reasons.length === 0 ? 'fails at base, passes at head' : reasons.join('; '),
      logs: { base: baseRun.log, head: headRun.log },
      ...(keepBase ? { keep: { command: keep, baseExit: keepBase.exit, headExit: keepHead.exit, logs: { base: keepBase.log, head: keepHead.log } } } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = "usage: node red-green.mjs --base <sha> --head <sha> --cmd '<regression command>' [--keep '<command>'] [--setup '<command>'] [--expect-base '<regex>'] [--repo <dir>] [--timeout-ms <n>] [--json]";

function parseArguments(argv) {
  const options = { repo: process.cwd(), json: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  const valueFlags = { '--base': 'base', '--head': 'head', '--cmd': 'command', '--keep': 'keep', '--setup': 'setup', '--expect-base': 'expectBase', '--repo': 'repo', '--timeout-ms': 'timeoutMs', '--item': 'item' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument in valueFlags) {
      const value = argv[index + 1];
      if (value === undefined) throw new RedGreenUsageError(`${argument} needs a value`);
      options[valueFlags[argument]] = value;
      index += 1;
    } else if (argument === '--json') options.json = true;
    else throw new RedGreenUsageError(`unknown argument ${argument}`);
  }
  for (const [key, flagName] of [['base', '--base'], ['head', '--head'], ['command', '--cmd']]) {
    if (!options[key]) throw new RedGreenUsageError(`${flagName} is required`);
  }
  options.timeoutMs = Number(options.timeoutMs);
  return options;
}

export async function main(argv) {
  try {
    const options = parseArguments(argv);
    const result = await runRedGreen({
      repo: path.resolve(options.repo),
      baseSha: options.base,
      headSha: options.head,
      command: options.command,
      keep: options.keep,
      setup: options.setup,
      expectBase: options.expectBase,
      timeoutMs: options.timeoutMs,
      testFiles: options.item ? await authorizedTests({ repo: path.resolve(options.repo), baseSha: options.base, headSha: options.head, item: JSON.parse(await (await import('node:fs/promises')).readFile(options.item, 'utf8')) }) : [],
    });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`[RED-GREEN]: ${result.pass ? 'PASS' : 'FAIL'}: base exit ${result.baseExit}, head exit ${result.headExit}: ${result.reason}\n`);
    return result.pass ? EXIT.pass : EXIT.fail;
  } catch (error) {
    if (error instanceof RedGreenUsageError) {
      process.stderr.write(`${error.message}\n${USAGE}\n`);
      return EXIT.usage;
    }
    if (error instanceof RedGreenBlockedError) {
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
  const { stdinArgs } = await import('./stdin-args.mjs');
  process.exitCode = await main(stdinArgs(process.argv.slice(2)));
}
