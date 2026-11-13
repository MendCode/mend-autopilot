#!/usr/bin/env node
// Starts the package's own `mend` workflow for one item through the MendCode CLI and returns its workflow id.
// The user's request is the approval for low and medium items; a high-risk item starts only after the user said
// yes to it (--approved). From the user's own terminal it starts the run. Inside a MendCode session, where only the
// user may start a workflow, it prints the workflow_script call to make; the user approves its card, and
// --wait-since keeps the lead's turn (and so the card) alive until the run appears.
// usage: start-item.mjs --repo <abs path> --item .mend/items/<id>.json --pkg <abs path> [--approved] [--publish no] [--fix-rounds N]
//        start-item.mjs --repo <abs path> --item .mend/items/<id>.json --wait-since <since> [--wait-minutes 30]
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
    return { ok: true, stdout: execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim(), stderr: '' };
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
export function startItem({ repo, item, pkg, approved = false, models, publish, fixRounds, readJson, settleLooks = 8, pause = defaultPause, env = process.env, now = Date.now }, run = defaultRunner) {
  const args = workflowArgs({ repo, item, pkg, models, publish, fixRounds, readJson });
  const itemFile = path.join(repo, item);
  const record = (readJson ?? ((file) => JSON.parse(readFileSync(file, 'utf8'))))(itemFile);
  if (record?.risk === 'high' && !approved) return { started: false, item, reason: 'high risk: ask the user once, then start it with --approved' };
  // MendCode lets only the user start a workflow: a session's own shell is refused, and the workflow_script tool
  // shows the user a card. Inside a session the lead makes that call and then waits here (--wait-since) for the answer.
  const since = now();
  const viaCard = () => ({
    started: false, item, insideMendcode: true, since,
    call: { tool: 'workflow_script', name: 'mend', args },
    reason: 'inside a MendCode session only the user can start a workflow: call workflow_script with this name and args, then run start-item again with --wait-since <since> in the same turn',
  });
  // MendCode's own shells carry the variable; another engine's shell does not, and is known by the refusal below.
  if (env[AGENT_SHELL_ENV]) return viaCard();
  // By path, not by name: a package's saved scripts resolve by name only in projects where the package is active.
  // The repository is the working directory, never --dir: --dir names MendCode's data directory, and a
  // data directory that is not the user's starts a second daemon whose runs the user never sees.
  const started = run('mendcode', ['workflow', 'run', path.join(pkg, 'workflows', 'mend.js'), '--args', JSON.stringify(args), '--permission', 'full', '--yes', '--json'], repo);
  if (!started.ok && /only the user can/.test(started.stderr + started.stdout)) return viaCard();
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

/**
 * Waits for the run the user approved on the workflow_script card: a `mend` workflow in this repository, started
 * at or after `since`, whose tasks name this item. Returns { started: true, workflowId } or why it gave up.
 */
export function waitForStart({ repo, item, since, minutes = 30, pause = defaultPause, now = Date.now }, run = defaultRunner) {
  if (!ITEM_PATH.test(String(item))) throw new StartError('--item must be .mend/items/<id>.json');
  if (!Number.isFinite(Number(since))) throw new StartError('--wait-since needs the since value start-item printed');
  const id = path.basename(item, '.json');
  const deadline = now() + Math.max(1, Math.min(120, Number(minutes))) * 60_000;
  const named = (task) => String(task?.label ?? task?.title ?? '').split(/\s+/).includes(id);
  for (;;) {
    const listed = run('mendcode', ['workflow', 'list', '--json'], repo);
    const workflows = listed.ok ? parseLines(listed.stdout).map((line) => line?.data?.workflows).find(Array.isArray) ?? [] : [];
    const found = workflows.find((workflow) => workflow.name === 'mend' && samePath(workflow.directory, repo) && Number(workflow.startedAt) >= Number(since) && (workflow.tasks ?? []).some(named));
    if (found) return ['failed', 'blocked', 'stopped'].includes(found.state)
      ? { started: false, item, workflowId: found.workflowId, reason: `the run ${found.state} at once: ${String(found.reason ?? '').slice(0, 400)}` }
      : { started: true, item, workflowId: found.workflowId };
    if (now() >= deadline) return { started: false, item, reason: `no run started within ${minutes} minutes: the user has not approved the workflow card, or declined it` };
    pause(WAIT_STEP_MS);
  }
}

const AGENT_SHELL_ENV = 'MENDCODE_AGENT_SHELL';
const WAIT_STEP_MS = 10_000;
const samePath = (a, b) => { try { return realpathSync(String(a)) === realpathSync(String(b)); } catch { return String(a) === String(b); } };
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
    else if (flag === '--wait-since') options.since = value;
    else if (flag === '--wait-minutes') options.minutes = value;
    else if (MODEL_KEYS.includes(flag.slice(2))) options.models[flag.slice(2)] = value;
    else throw new StartError(`unknown argument ${flag}`);
  }
  if (options.repo && options.item && !existsSync(path.join(options.repo, options.item))) throw new StartError(`no item file at ${options.item}`);
  return options;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.since !== undefined ? waitForStart(options) : startItem(options);
    console.log(JSON.stringify(result));
    if (!result.started) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 64;
  }
}
