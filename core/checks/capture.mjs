#!/usr/bin/env node
// Lead-operated, local command capture. Output is deliberately not interpreted here.
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertGuardAllowed } from './guard-command.mjs';

const exec = promisify(execFile);
const kinds = new Set(['request', 'migration', 'tests', 'compatibility']);
const safeId = (id) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) && id !== '..';

async function sha(repo, revision) {
  return (await exec('git', ['-C', repo, 'rev-parse', '--verify', `${revision}^{commit}`])).stdout.trim();
}

export async function capture({ repo, item, kind, command }) {
  if (!safeId(item?.id) || !kinds.has(kind) || typeof command !== 'string' || !command.trim()) throw new Error('invalid item, kind or command');
  repo = path.resolve(repo);
  const head = await sha(repo, 'HEAD');
  const status = (await exec('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'])).stdout;
  if (status.trim()) throw new Error('tracked worktree changes must be committed before capture');
  await assertGuardAllowed({ command, cwd: repo });
  const start = new Date().toISOString();
  const stdout = [];
  const stderr = [];
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: repo, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  const end = new Date().toISOString();
  if (await sha(repo, 'HEAD') !== head || (await exec('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'])).stdout.trim()) throw new Error('worktree changed during capture');
  const dir = path.join(repo, '.mend', 'evidence', item.id, 'captures');
  await fs.mkdir(dir, { recursive: true });
  const name = `${kind}-${randomUUID()}`;
  // A single hashed container preserves each byte stream without interleaving chunks.
  const log = Buffer.from(JSON.stringify({ version: 1, stdout: Buffer.concat(stdout).toString('base64'), stderr: Buffer.concat(stderr).toString('base64') }));
  const record = { kind, command, exit, head, start, end, log: `${name}.log`, sha256: createHash('sha256').update(log).digest('hex') };
  await fs.writeFile(path.join(dir, record.log), log, { flag: 'wx' });
  await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(record, null, 2), { flag: 'wx' });
  return record;
}

// Captures the item declares, taken by the workflow (never the owner) so profile checks can pass unattended.
// Each entry is { kind, command, at?: "head" | "base" | "both" }; base runs in a clean detached checkout,
// prepared with item.captureSetup when given, and its records are filed under the item worktree.
export async function captureDeclared({ repo, item, baseSha, headSha }) {
  const entries = Array.isArray(item?.captures) ? item.captures : [];
  if (!entries.length) return [];
  for (const entry of entries) {
    if (!kinds.has(entry?.kind) || typeof entry.command !== 'string' || !entry.command.trim() || !['head', 'base', 'both', undefined].includes(entry.at)) throw new Error('invalid declared capture: ' + JSON.stringify(entry));
  }
  repo = path.resolve(repo);
  const records = [];
  const missing = async (sha, entry) => !(await readCaptures({ repo, itemId: item.id, kind: entry.kind, headSha: sha })).some((record) => record.command === entry.command);
  for (const entry of entries.filter((e) => e.at !== 'base')) {
    if (await missing(headSha, entry)) records.push(await capture({ repo, item, kind: entry.kind, command: entry.command }));
  }
  const atBase = entries.filter((e) => e.at === 'base' || e.at === 'both');
  const pending = [];
  for (const entry of atBase) if (await missing(baseSha, entry)) pending.push(entry);
  if (!pending.length) return records;
  const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'mend-capture-base-'));
  try {
    await exec('git', ['-C', repo, 'worktree', 'add', '--detach', checkout, baseSha]);
    if (typeof item.captureSetup === 'string' && item.captureSetup.trim()) {
      await assertGuardAllowed({ command: item.captureSetup, cwd: checkout });
      await exec('sh', ['-c', item.captureSetup], { cwd: checkout, env: { ...process.env, MEND_REPO_ROOT: repo } });
    }
    const target = path.join(repo, '.mend', 'evidence', item.id, 'captures');
    await fs.mkdir(target, { recursive: true });
    for (const entry of pending) {
      const record = await capture({ repo: checkout, item, kind: entry.kind, command: entry.command });
      const source = path.join(checkout, '.mend', 'evidence', item.id, 'captures');
      for (const name of [record.log, record.log.replace(/\.log$/, '.json')]) await fs.copyFile(path.join(source, name), path.join(target, name), constants.COPYFILE_EXCL);
      records.push(record);
    }
  } finally {
    await exec('git', ['-C', repo, 'worktree', 'remove', '--force', checkout]).catch(() => {});
    await fs.rm(checkout, { recursive: true, force: true });
  }
  return records;
}

// Only files in the item's capture directory are read; malformed or stale records are ignored.
export async function readCaptures({ repo, itemId, kind, headSha }) {
  if (!safeId(itemId) || !kinds.has(kind)) return [];
  const dir = path.join(repo, '.mend', 'evidence', itemId, 'captures');
  let names, expected;
  try { names = await fs.readdir(dir); expected = await sha(repo, headSha); } catch { return []; }
  const captures = [];
  for (const name of names.filter((entry) => entry.startsWith(`${kind}-`) && entry.endsWith('.json'))) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      if (record.kind !== kind || record.head !== expected || typeof record.command !== 'string' || !record.command.trim() || !Number.isInteger(record.exit) || !Number.isFinite(Date.parse(record.start)) || !Number.isFinite(Date.parse(record.end)) || Date.parse(record.end) < Date.parse(record.start) || record.log !== `${name.slice(0, -5)}.log` || !/^[a-f0-9]{64}$/.test(record.sha256)) continue;
      const log = await fs.readFile(path.join(dir, record.log));
      if (createHash('sha256').update(log).digest('hex') !== record.sha256) continue;
      const streams = JSON.parse(log.toString('utf8'));
      const isBase64 = (value) => typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
      if (streams?.version !== 1 || !isBase64(streams.stdout) || !isBase64(streams.stderr)) continue;
      captures.push({ ...record, output: Buffer.from(streams.stdout, 'base64').toString('utf8'), stderr: Buffer.from(streams.stderr, 'base64').toString('utf8') });
    } catch { /* Missing, invalid or unreadable evidence never passes. */ }
  }
  return captures.sort((a, b) => a.end.localeCompare(b.end));
}

// Evidence is read only from stdout, as single-line JSON objects prefixed with MEND_EVIDENCE.
export function evidenceLines(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('MEND_EVIDENCE ')) return [];
    try { return [JSON.parse(line.slice(14))]; } catch { return []; }
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--item', '--kind', '--cmd', '--repo'].includes(argv[i]) || !argv[i + 1] || options[argv[i]]) throw new Error('usage: capture.mjs --item <item.json> --kind request|migration|tests|compatibility --cmd <command> [--repo <worktree>]');
    options[argv[i]] = argv[i + 1];
  }
  if (!options['--item']) throw new Error('--item is required');
  const item = JSON.parse(await fs.readFile(options['--item'], 'utf8'));
  const record = await capture({ repo: options['--repo'] ?? '.', item, kind: options['--kind'], command: options['--cmd'] });
  process.stdout.write(`${JSON.stringify(record)}\n`);
  return record.exit === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { process.stderr.write(`[CAPTURE]: ${error.message}\n`); process.exitCode = 1; }
}
