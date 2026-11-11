#!/usr/bin/env node
// Assembles one MendCode package per harness: core/** plus adapters/<harness>/** (adapter wins),
// refusing to write anything when a file matches the private leak denylist.
// Stdlib only; runs on Node 20+ and Bun.

import { promises as fs, realpathSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESSES = ['codex', 'claude', 'opencode-go'];
export const EXIT = { ok: 0, drift: 1, invalidSource: 2, leak: 3, usage: 64 };

const PACKAGE_PREFIX = 'mend-autopilot-';
const DENYLIST_RELATIVE = path.join('build', 'leak-denylist.json');
// Optional, git-ignored: names that must never ship but must not be published either.
const LOCAL_DENYLIST_RELATIVE = path.join('build', 'leak-denylist.local.json');
const PUBLIC_FILES = ['README.md'];
const PUBLIC_DIRS = ['docs'];
const PRIVATE_PUBLIC_SUBDIRS = [path.join('docs', 'tasks')];
const NEVER_SHIPPED_NAMES = new Set(['leak-denylist.json', 'leak-denylist.local.json']);
const GENERATED_NAMES = new Set(['__pycache__', '.pytest_cache', 'node_modules', '.DS_Store']);
const GENERATED_EXTENSIONS = ['.pyc', '.pyo'];

function isGenerated(name) {
  return GENERATED_NAMES.has(name) || GENERATED_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export class BuildError extends Error {
  constructor({ code, message, details = [] }) {
    super(`[BUILD]: ${message}`);
    this.name = 'BuildError';
    this.code = code;
    this.details = details;
  }
}

export function packageName(harness) {
  return `${PACKAGE_PREFIX}${harness}`;
}

export function assertHarness(harness) {
  if (!HARNESSES.includes(harness)) {
    throw new BuildError({
      code: EXIT.usage,
      message: `unknown harness "${harness}"; expected one of ${HARNESSES.join(', ')} or all`,
    });
  }
}

export function assertSafeRelative(relativePath) {
  const normalized = path.normalize(relativePath);
  const escapes =
    path.isAbsolute(relativePath) ||
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.split(path.sep).includes('..');
  if (escapes || normalized === '' || normalized === '.') {
    throw new BuildError({
      code: EXIT.invalidSource,
      message: `path escapes its source tree: ${relativePath}`,
    });
  }
  return normalized;
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function collectTree({ baseDir, excludeDirs = [] }) {
  const files = new Map();
  if (!(await pathExists(baseDir))) return files;
  const baseStat = await fs.lstat(baseDir);
  if (baseStat.isSymbolicLink()) {
    throw new BuildError({ code: EXIT.invalidSource, message: `symlinks are not allowed: ${baseDir}` });
  }
  const excluded = new Set(excludeDirs.map((dir) => path.resolve(dir)));

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (isGenerated(entry.name)) continue;
      const absolute = path.join(currentDir, entry.name);
      const relative = assertSafeRelative(path.relative(baseDir, absolute));
      if (entry.isSymbolicLink()) {
        throw new BuildError({ code: EXIT.invalidSource, message: `symlinks are not allowed: ${absolute}` });
      }
      if (entry.isDirectory()) {
        if (!excluded.has(path.resolve(absolute))) await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new BuildError({ code: EXIT.invalidSource, message: `unsupported file type: ${absolute}` });
      }
      files.set(relative, absolute);
    }
  }

  await walk(baseDir);
  return files;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileDenylist(denylist) {
  const words = Array.isArray(denylist?.words) ? denylist.words : null;
  const patterns = Array.isArray(denylist?.patterns) ? denylist.patterns : null;
  if (!words || !patterns || ![...words, ...patterns].every((entry) => typeof entry === 'string' && entry.trim())) {
    throw new BuildError({
      code: EXIT.invalidSource,
      message: 'denylist must be {"words": [non-empty strings], "patterns": [non-empty regex strings]}',
    });
  }
  const wordRules = words.map((word) => ({
    label: word,
    regex: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word.trim()).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu'),
  }));
  const patternRules = patterns.map((pattern) => {
    try {
      return { label: pattern, regex: new RegExp(pattern, 'iu') };
    } catch (error) {
      throw new BuildError({ code: EXIT.invalidSource, message: `invalid denylist pattern ${pattern}: ${error.message}` });
    }
  });
  return [...wordRules, ...patternRules];
}

async function readDenylist(root, relative, { required }) {
  let raw;
  try {
    raw = await fs.readFile(path.join(root, relative), 'utf8');
  } catch (error) {
    if (!required && error.code === 'ENOENT') return [];
    throw new BuildError({
      code: EXIT.invalidSource,
      message: `leak denylist unreadable at ${relative} (${error.code ?? error.message}); refusing to build without it`,
    });
  }
  try {
    return compileDenylist(JSON.parse(raw));
  } catch (error) {
    if (error instanceof BuildError) throw error;
    throw new BuildError({ code: EXIT.invalidSource, message: `leak denylist ${relative} is not valid JSON: ${error.message}` });
  }
}

async function loadDenylist(root) {
  return [
    ...await readDenylist(root, DENYLIST_RELATIVE, { required: true }),
    ...await readDenylist(root, LOCAL_DENYLIST_RELATIVE, { required: false }),
  ];
}

export function scanText({ label, text, rules }) {
  const hits = [];
  for (const rule of rules) {
    const match = label.match(rule.regex);
    if (match) hits.push(`${label} (path) matches ${match[0]}`);
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of rules) {
      const match = line.match(rule.regex);
      if (match) hits.push(`${label}:${index + 1} matches ${match[0]}`);
    }
  });
  return hits;
}

async function scanFiles({ entries, rules }) {
  const leaks = [];
  for (const { label, bytes } of entries) {
    // Preserve the byte-oriented scan for files that are not valid UTF-8.
    const text = bytes.toString(isUtf8(bytes) ? 'utf8' : 'latin1');
    leaks.push(...scanText({ label, text, rules }));
  }
  return leaks;
}

async function collectPublicTree(root) {
  const entries = [];
  for (const file of PUBLIC_FILES) {
    const absolute = path.join(root, file);
    if (await pathExists(absolute)) {
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new BuildError({ code: EXIT.invalidSource, message: `symlinks are not allowed: ${absolute}` });
      }
      entries.push({ label: file, bytes: await fs.readFile(absolute) });
    }
  }
  for (const dir of PUBLIC_DIRS) {
    const tree = await collectTree({
      baseDir: path.join(root, dir),
      excludeDirs: PRIVATE_PUBLIC_SUBDIRS.map((subdir) => path.join(root, subdir)),
    });
    for (const [relative, absolute] of tree) {
      entries.push({ label: path.join(dir, relative), bytes: await fs.readFile(absolute) });
    }
  }
  return entries;
}

async function assemblePackage({ root, harness }) {
  const adapterDir = path.join(root, 'adapters', harness);
  if (!(await pathExists(path.join(adapterDir, 'mendcode-package.json')))) {
    throw new BuildError({ code: EXIT.invalidSource, message: `missing adapters/${harness}/mendcode-package.json` });
  }
  const coreFiles = await collectTree({ baseDir: path.join(root, 'core') });
  const adapterFiles = await collectTree({ baseDir: adapterDir });
  const assembled = new Map();
  for (const [relative, absolute] of coreFiles) assembled.set(relative, { source: path.join('core', relative), absolute });
  for (const [relative, absolute] of adapterFiles) {
    assembled.set(relative, { source: path.join('adapters', harness, relative), absolute });
  }
  for (const relative of assembled.keys()) {
    if (NEVER_SHIPPED_NAMES.has(path.basename(relative))) {
      throw new BuildError({ code: EXIT.invalidSource, message: `the private denylist must never be shipped: ${relative}` });
    }
  }
  const files = new Map();
  for (const [relative, { source, absolute }] of assembled) {
    files.set(relative, { source, bytes: await fs.readFile(absolute) });
  }
  let manifest;
  try {
    manifest = JSON.parse(files.get('mendcode-package.json').bytes.toString('utf8'));
  } catch (error) {
    throw new BuildError({
      code: EXIT.invalidSource,
      message: `adapters/${harness}/mendcode-package.json is not valid JSON: ${error.message}`,
    });
  }
  if (manifest?.name !== packageName(harness)) {
    throw new BuildError({
      code: EXIT.invalidSource,
      message: `adapters/${harness}/mendcode-package.json name must be ${packageName(harness)}, found ${manifest.name}`,
    });
  }
  return files;
}

async function diffAgainstDist({ files, outDir }) {
  const drift = [];
  const existing = await collectTree({ baseDir: outDir });
  for (const [relative, { bytes }] of files) {
    const current = existing.get(relative);
    if (!current) {
      drift.push(`missing ${relative}`);
      continue;
    }
    if (!bytes.equals(await fs.readFile(current))) drift.push(`differs ${relative}`);
  }
  for (const relative of existing.keys()) {
    if (!files.has(relative)) drift.push(`extra ${relative}`);
  }
  return drift;
}

async function replaceDist({ files, outDir }) {
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = `${outDir}.staging-${stamp}`;
  const previous = `${outDir}.previous-${stamp}`;
  let movedPrevious = false;
  try {
    for (const [relative, { bytes }] of files) {
      const target = path.join(staging, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
    if (files.size === 0) await fs.mkdir(staging, { recursive: true });
    if (await pathExists(outDir)) {
      await fs.rename(outDir, previous);
      movedPrevious = true;
    }
    await fs.rename(staging, outDir);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    if (movedPrevious && !(await pathExists(outDir))) await fs.rename(previous, outDir);
    throw new BuildError({ code: EXIT.invalidSource, message: `write failed, previous dist kept: ${error.message}` });
  }
  if (movedPrevious) await fs.rm(previous, { recursive: true, force: true });
  return [...files.keys()].map((relative) => path.join(path.relative(path.dirname(outDir), outDir), relative));
}

async function prepare({ root, harnesses, outDirFor }) {
  const rules = await loadDenylist(root);
  const leaks = await scanFiles({ entries: await collectPublicTree(root), rules });
  const plans = [];
  for (const harness of harnesses) {
    const files = await assemblePackage({ root, harness });
    const outDir = outDirFor(harness);
    const entries = [...files.entries()].map(([relative, { source, bytes }]) => ({ label: source, bytes, relative }));
    leaks.push(...(await scanFiles({ entries, rules })));
    plans.push({ harness, files, outDir });
  }
  return { plans, leaks: [...new Set(leaks)] };
}

export async function build({ harness, outDir, check = false, root = path.dirname(fileURLToPath(import.meta.url)) }) {
  const harnesses = harness === 'all' ? HARNESSES : [harness];
  harnesses.forEach(assertHarness);
  if (outDir && harnesses.length > 1) {
    throw new BuildError({ code: EXIT.usage, message: 'outDir applies to a single harness, not all' });
  }
  const resolvedRoot = path.resolve(root);
  const outDirFor = (name) => path.resolve(outDir ?? path.join(resolvedRoot, 'dist', packageName(name)));

  const { plans, leaks } = await prepare({ root: resolvedRoot, harnesses, outDirFor });
  if (leaks.length > 0) return { written: [], drift: [], leaks };

  if (check) {
    const drift = [];
    for (const plan of plans) {
      for (const entry of await diffAgainstDist(plan)) drift.push(`${packageName(plan.harness)}: ${entry}`);
    }
    return { written: [], drift, leaks: [] };
  }

  const written = [];
  for (const plan of plans) written.push(...(await replaceDist(plan)));
  return { written, drift: [], leaks: [] };
}

function usage() {
  return `usage: node build.mjs <${HARNESSES.join('|')}|all> [--check]`;
}

export async function main(argv) {
  const args = argv.filter((arg) => arg !== '--check');
  const check = argv.includes('--check');
  const unknownFlags = args.filter((arg) => arg.startsWith('-'));
  if (args.length !== 1 || unknownFlags.length > 0) {
    console.error(usage());
    return EXIT.usage;
  }
  try {
    const result = await build({ harness: args[0], check });
    if (result.leaks.length > 0) {
      console.error('[BUILD]: leak check failed, nothing written:');
      result.leaks.forEach((leak) => console.error(`  ${leak}`));
      return EXIT.leak;
    }
    if (result.drift.length > 0) {
      console.error('[BUILD]: dist differs from source (run without --check to rebuild):');
      result.drift.forEach((entry) => console.error(`  ${entry}`));
      return EXIT.drift;
    }
    if (check) console.log('[BUILD]: dist matches source');
    else console.log(`[BUILD]: wrote ${result.written.length} files`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof BuildError) {
      console.error(error.message);
      if (error.code === EXIT.usage) console.error(usage());
      return error.code;
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

const invokedDirectly = isInvokedDirectly();
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
