#!/usr/bin/env node
// Prepares a repository for the light path in one step, without changing a tracked file: ignores .mend/
// through .git/info/exclude, writes the verification skill that names the repo's own check commands, runs
// each command once and records .mend/evidence/verify.json, and declares the generic profile's exemplar.
// The lead finds the commands; this program is what decides whether they pass.
// usage: setup-light.mjs --repo <abs path> --command "<cmd>" [--command "<cmd>" ...] [--name <slug>] [--timeout-ms N]
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class SetupError extends Error {
  constructor(message) {
    super(`[SETUP]: ${message}`);
    this.name = 'SetupError';
  }
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const LOG_TAIL = 4000;

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function slugFor(repo) {
  return path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

/** Adds each path to .git/info/exclude unless git already ignores it; returns how `.mend/` is ignored. */
export function ignoreMend(repo, extra = []) {
  const ignored = (probe) => spawnSync('git', ['check-ignore', '-q', probe], { cwd: repo }).status === 0;
  const wanted = [['.mend/', '.mend/worktrees/probe'], ...extra.map((dir) => [dir, `${dir}probe`])].filter(([, probe]) => !ignored(probe));
  const mendWasIgnored = !wanted.some(([line]) => line === '.mend/');
  if (!wanted.length) return 'already ignored';
  // A linked worktree's own git dir has no say: git reads info/exclude only from the common dir.
  const exclude = path.join(path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir'])), 'info', 'exclude');
  mkdirSync(path.dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# mend-autopilot: items, worktrees, evidence and the verification skill\n${wanted.map(([line]) => line).join('\n')}\n`);
  return mendWasIgnored ? 'already ignored' : 'added to .git/info/exclude';
}

function skillText({ name, commands }) {
  return `---
name: verify-${name}
description: How to prove a change to this repository works, for mend-autopilot owners and auditors. Load before verifying a change here.
---

# verify-${name}

Run these from the repository root, in order. A change is verified when every one exits 0.

${commands.map((command) => `- \`${command}\``).join('\n')}

Written by mend-autopilot's light setup from the repository's own scripts. Add a section for driving
the running product here when the checks alone do not show that a feature works.
`;
}

export function runSetup({ repo, commands, name, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = spawnSync }) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) throw new SetupError('--repo must be an absolute path');
  if (!Array.isArray(commands) || !commands.length || commands.some((command) => typeof command !== 'string' || !command.trim() || /[\r\n]/.test(command))) {
    throw new SetupError('give at least one --command, each on one line');
  }
  const root = git(repo, ['rev-parse', '--show-toplevel']);
  const slug = name ?? slugFor(root);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new SetupError('--name must be a lowercase slug');
  const skill = `.mendcode/skills/verify-${slug}/SKILL.md`;
  const ignored = ignoreMend(root, [`${path.posix.dirname(skill)}/`]);
  mkdirSync(path.join(root, path.dirname(skill)), { recursive: true });
  writeFileSync(path.join(root, skill), skillText({ name: slug, commands }));

  const logDir = path.join(root, '.mend', 'evidence', 'verify');
  mkdirSync(logDir, { recursive: true });
  const steps = commands.map((command, index) => {
    const result = spawn('sh', ['-c', command], { cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    const log = `.mend/evidence/verify/step-${index + 1}.log`;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`;
    writeFileSync(path.join(root, log), output);
    const exit = typeof result.status === 'number' ? result.status : 1;
    return { name: `step ${index + 1}`, command, exit, log, ...(exit === 0 ? {} : { tail: output.slice(-LOG_TAIL) }) };
  });
  const pass = steps.every((step) => step.exit === 0);
  const record = {
    skill,
    sha: git(root, ['rev-parse', 'HEAD']),
    ranAt: new Date().toISOString(),
    result: pass ? 'PASS' : 'FAIL',
    steps: steps.map(({ tail, ...step }) => step),
    feature: 'the repository check commands; no drive of the running product',
    evidencePath: '.mend/evidence/verify/',
    evidenceSurvivedCleanup: true,
    profiles: { generic: pass ? 'PASS' : 'FAIL' },
  };
  writeFileSync(path.join(root, '.mend', 'evidence', 'verify.json'), `${JSON.stringify(record, null, 2)}\n`);

  const indexFile = path.join(root, '.mend', 'exemplars', 'index.json');
  mkdirSync(path.dirname(indexFile), { recursive: true });
  const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : [];
  if (!Array.isArray(index)) throw new SetupError('.mend/exemplars/index.json must be an array');
  if (!index.some((entry) => entry?.profile === 'generic')) {
    index.push({ profile: 'generic', none: 'The light setup captures no exemplar; the review and the checks stand in for one.', search: { paths: ['.'], gitLogRange: 'HEAD' } });
    writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  }
  return { result: record.result, skill, ignored, steps: steps.map(({ name: _name, ...step }) => step) };
}

function parseArgs(argv) {
  const options = { commands: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new SetupError(`${flag} needs a value`);
    if (flag === '--repo') options.repo = value;
    else if (flag === '--command') options.commands.push(value);
    else if (flag === '--name') options.name = value;
    else if (flag === '--timeout-ms') options.timeoutMs = Number(value);
    else throw new SetupError(`unknown argument ${flag}`);
  }
  return options;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runSetup(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    if (result.result !== 'PASS') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 64;
  }
}
