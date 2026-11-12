#!/usr/bin/env node
// Starts the package's own `mend` workflow for one item through the MendCode CLI and returns its workflow id.
// The user's request is the approval for low and medium items; a high-risk item starts only after the user said
// yes to it (--approved). This is the start path for the lead: a workflow_script call shows a card that MendCode
// drops as soon as the lead's turn ends, so an unattended start through it never runs.
// usage: start-item.mjs --repo <abs path> --item .mend/items/<id>.json --pkg <abs path> [--approved] [--publish no] [--fix-rounds N]
// Running it again on an item that stopped as a draft resumes its worktree: --fix-rounds N allows owner rounds
// after the first up to N in total (default 1, at most 3), so the next round starts from the reviewer's last findings.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class StartError extends Error {
  constructor(message) {
    super(`[START]: ${message}`);
    this.name = 'StartError';
  }
}

const ITEM_PATH = /^\.mend\/items\/[a-z0-9][a-z0-9-]*\.json$/;
const MODEL_KEYS = ['critic', 'model', 'auditor', 'engine'];

function defaultRunner(command, args, cwd) {
  try {
    return { ok: true, stdout: execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), stderr: '' };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? '').trim(), stderr: String(error.stderr ?? error.message ?? '').trim() };
  }
}

/** The workflow arguments: repo, item and package, plus the models from <pkg>/autopilot.json unless the caller named others. */
export function workflowArgs({ repo, item, pkg, models = {}, publish, fixRounds, readJson = (file) => JSON.parse(readFileSync(file, 'utf8')) }) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) throw new StartError('--repo must be an absolute path');
  if (typeof pkg !== 'string' || !path.isAbsolute(pkg)) throw new StartError('--pkg must be an absolute path');
  if (typeof item !== 'string' || !ITEM_PATH.test(item)) throw new StartError('--item must be .mend/items/<id>.json');
  const defaults = readJson(path.join(pkg, 'autopilot.json'));
  const args = { repo, item, pkg };
  for (const key of MODEL_KEYS) {
    const value = models[key] ?? defaults[key];
    if (value !== undefined && value !== null && String(value).trim()) args[key] = String(value);
  }
  if (!args.critic || !args.model || !args.auditor) throw new StartError('autopilot.json must name critic, model and auditor');
  if (publish === 'no') args.publish = 'no';
  if (fixRounds !== undefined) {
    const rounds = Number(fixRounds);
    if (!Number.isInteger(rounds) || rounds < 0 || rounds > 3) throw new StartError('--fix-rounds must be 0 to 3');
    args.fixRounds = rounds;
  }
  return args;
}

/**
 * Returns { started: true, workflowId } or { started: false, reason }. A high-risk item without `approved`
 * is not started: the lead asks the user once and runs this again with --approved.
 */
export function startItem({ repo, item, pkg, approved = false, models, publish, fixRounds, readJson, settleLooks = 8, pause = defaultPause }, run = defaultRunner) {
  const args = workflowArgs({ repo, item, pkg, models, publish, fixRounds, readJson });
  const itemFile = path.join(repo, item);
  const record = (readJson ?? ((file) => JSON.parse(readFileSync(file, 'utf8'))))(itemFile);
  if (record?.risk === 'high' && !approved) return { started: false, item, reason: 'high risk: ask the user once, then start it with --approved' };
  // By path, not by name: a package's saved scripts resolve by name only in projects where the package is active.
  // The repository is the working directory, never --dir: --dir names MendCode's data directory, and a
  // data directory that is not the user's starts a second daemon whose runs the user never sees.
  const started = run('mendcode', ['workflow', 'run', path.join(pkg, 'workflows', 'mend.js'), '--args', JSON.stringify(args), '--permission', 'full', '--yes', '--json'], repo);
  if (!started.ok) return { started: false, item, reason: `mendcode refused the start: ${(started.stderr || started.stdout).slice(-400)}` };
  const workflowId = parseLines(started.stdout).map((line) => line?.data?.workflow?.workflowId).find(Boolean);
  if (!workflowId) return { started: false, item, reason: `mendcode answered without a workflow id: ${started.stdout.slice(-400)}` };
  // A run that cannot start (an engine this tier refuses, a bad argument) fails within its first seconds.
  for (let look = 0; look < settleLooks; look += 1) {
    pause(SETTLE_STEP_MS);
    const shown = run('mendcode', ['workflow', 'show', workflowId, '--json'], repo);
    const workflow = shown.ok ? parseLines(shown.stdout).map((line) => line?.data?.workflow).find(Boolean) : undefined;
    if (workflow && ['failed', 'blocked', 'stopped'].includes(workflow.state)) return { started: false, item, workflowId, reason: `the run ${workflow.state} at once: ${String(workflow.reason ?? '').slice(0, 400)}` };
  }
  return { started: true, item, workflowId };
}

const SETTLE_STEP_MS = 1000;
const parseLines = (text) => text.split('\n').map((line) => { try { return JSON.parse(line); } catch { return undefined; } });
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const defaultPause = (ms) => Atomics.wait(sleeper, 0, 0, ms);

function parseArgs(argv) {
  const options = { models: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--approved') { options.approved = true; continue; }
    const value = argv[index + 1];
    if (value === undefined) throw new StartError(`${flag} needs a value`);
    index += 1;
    if (flag === '--repo') options.repo = value;
    else if (flag === '--item') options.item = value;
    else if (flag === '--pkg') options.pkg = value;
    else if (flag === '--publish') options.publish = value;
    else if (flag === '--fix-rounds') options.fixRounds = value;
    else if (MODEL_KEYS.includes(flag.slice(2))) options.models[flag.slice(2)] = value;
    else throw new StartError(`unknown argument ${flag}`);
  }
  if (options.repo && options.item && !existsSync(path.join(options.repo, options.item))) throw new StartError(`no item file at ${options.item}`);
  return options;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = startItem(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    if (!result.started) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 64;
  }
}
