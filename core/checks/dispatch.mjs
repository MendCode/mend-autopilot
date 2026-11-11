#!/usr/bin/env node
// Shared preflight for workflow dispatch and delivery. Configuration is an explicit allowlist,
// not a recursive copy of .mend (which also contains private evidence and other worktrees).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadProfiles } from './check-profiles.mjs';
import { planItem } from './run-rubric.mjs';
import { matchesGlobs } from './changes.mjs';
import { DEFAULT_PUBLIC_SURFACE } from '../profiles/generic/checks/scope-contract.mjs';

const exec = promisify(execFile);
const RUNGS = ['investigate', 'draft', 'autopilot', 'full'];
const TIERS = ['low', 'medium', 'high'];
const SETTINGS = ['quality.json', 'guard.json', 'integrity.json', 'grants.json'].map((file) => `.mend/${file}`);
const EXEMPLAR_INDEX = '.mend/exemplars/index.json';
const minimum = (...rungs) => RUNGS[Math.min(...rungs.map((rung) => RUNGS.indexOf(rung)))];
const maximum = (...tiers) => TIERS[Math.max(...tiers.map((tier) => TIERS.indexOf(tier)))];

function fail(reason) { throw new Error(reason); }

/** Missing grants default to draft; malformed grants never do. Risk floors are tiers, not rungs. */
export function authorize(item, plan, grantFile, actualRisk = 'low', priorRung = 'full') {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id ?? '')) fail('item id must be short kebab-case');
  if (item.type !== 'change') fail('implementation workflows require type change; investigate permits no writes');
  const grant = grantFile === null ? { rung: 'draft', queue: false } : grantFile;
  if (!grant || !RUNGS.includes(grant.rung)) fail('invalid operator grant rung');
  if (!RUNGS.includes(item.rung ?? grant.rung) || !RUNGS.includes(priorRung)) fail('invalid item or prior rung');
  const risks = [item.risk ?? 'low', actualRisk, ...plan.profiles.map((profile) => profile.riskFloor)];
  if (risks.some((tier) => !TIERS.includes(tier))) fail('invalid risk tier');
  const tier = maximum(...risks);
  let rung = minimum(grant.rung, item.rung ?? grant.rung, priorRung);
  if (rung === 'investigate') fail('effective rung investigate does not authorize implementation or delivery');
  if (rung === 'full' && grant.disposable !== true) rung = 'autopilot';
  if (tier !== 'low') rung = minimum(rung, 'draft');
  return { rung, tier, grant: { rung: grant.rung, queue: grant.queue === true, ...(grantFile === null ? {} : { reference: '.mend/grants.json' }) } };
}

/** Read only regular files below root, without traversing symlinks, even inside allowed directories. */
async function safeFile(root, relative, optional = false) {
  if (typeof relative !== 'string' || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) fail('unsafe setup path');
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail(`setup path is not a regular file: ${relative}`);
  }
  return fs.readFile(current);
}

function json(bytes, name) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail(`invalid JSON in ${name}`); }
}

async function skillFiles(repo, directory, files) {
  // The verification skill is the one permitted source tree outside .mend. Helpers and
  // feature maps belong to its contract; credentials and symlinks never do.
  for (const entry of await fs.readdir(path.join(repo, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink() || /^(?:\.|credentials|secrets?|auth[.-])/i.test(entry.name)) fail('unsafe file in verification skill');
    // Local Python imports generate bytecode caches; they are not verification inputs.
    if (entry.isDirectory() && entry.name === '__pycache__') continue;
    if (entry.isDirectory()) await skillFiles(repo, relative, files);
    else files.set(relative, await safeFile(repo, relative));
  }
}

async function setupFiles(repo, plan) {
  const files = new Map();
  for (const relative of SETTINGS) {
    const bytes = await safeFile(repo, relative, true);
    if (bytes === null) continue;
    const value = json(bytes, relative);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid setup object: ${relative}`);
    files.set(relative, bytes);
  }
  const verifyPath = '.mend/evidence/verify.json';
  const verifyBytes = await safeFile(repo, verifyPath);
  const verify = json(verifyBytes, verifyPath);
  if (verify?.result !== 'PASS') fail('repository verification must record PASS');
  if (typeof verify.skill !== 'string' || !/^\.(mendcode|claude)\/skills\/verify-[^/]+\/SKILL\.md$/.test(verify.skill)) fail('verification skill path is missing or invalid');
  files.set(verify.skill, await safeFile(repo, verify.skill));
  await skillFiles(repo, path.posix.dirname(verify.skill), files);
  // New verification helpers live in the ignored setup directory, not the skill.
  const helper = await safeFile(repo, '.mend/verify/verify.mjs', true);
  if (helper !== null) await skillFiles(repo, '.mend/verify', files);
  files.set(verifyPath, verifyBytes);
  const indexPath = EXEMPLAR_INDEX;
  const indexBytes = await safeFile(repo, indexPath);
  const index = json(indexBytes, indexPath);
  if (!Array.isArray(index)) fail('exemplar index must be an array');
  const selected = [];
  for (const profile of plan.profiles) {
    if (verify.profiles?.[profile.kind] !== 'PASS') fail(`verification profile ${profile.kind} is missing or blocked`);
    const entries = index.filter((entry) => entry?.profile === profile.kind);
    if (!entries.length) fail(`missing exemplar set for ${profile.kind}`);
    if (entries.some((entry) => Object.hasOwn(entry, 'none'))) {
      const entry = entries[0];
      if (entries.length !== 1 || typeof entry.none !== 'string' || !entry.none.trim() || /[\r\n]/.test(entry.none) || Object.hasOwn(entry, 'file') || !Array.isArray(entry.search?.paths) || !entry.search.paths.length || !entry.search.paths.every((p) => typeof p === 'string' && p.trim()) || typeof entry.search.gitLogRange !== 'string' || !entry.search.gitLogRange.trim()) fail(`invalid none exemplar declaration for ${profile.kind}`);
      selected.push(entry);
      continue;
    }
    for (const entry of entries) {
      // Restrict artifacts to the documented exemplar tree and non-credential file types.
      if (typeof entry.file !== 'string' || !entry.file.startsWith(`.mend/exemplars/${profile.kind}/`) || !/\.(png|jpe?g|webp|md|txt|json)$/i.test(entry.file) || /(?:^|\/)(?:\.|credentials|secrets?|auth[.-])/i.test(entry.file.slice('.mend/exemplars/'.length))) fail('unsafe exemplar artifact path');
      files.set(entry.file, await safeFile(repo, entry.file));
      selected.push(entry);
    }
  }
  files.set(indexPath, Buffer.from(JSON.stringify(selected, null, 2)));
  return files;
}

export function riskForChanges(changes, config = {}) {
  let tier = 'low';
  let rule = 'changed paths have no higher built-in risk rule';
  const high = /(?:^|\/)(?:migrations?|auth(?:entication|orization)?|permissions?|roles?|payments?|billing|secrets?|credentials|\.github|\.gitlab|ci)(?:[./_-]|$)|(?:^|\/)(?:[^/]*lock(?:\.[^/]*)?|bun\.lockb|npm-shrinkwrap\.json|\.env(?:\.[^/]*)?)$/i;
  for (const change of changes) {
    for (const file of change.paths) {
      if (change.status === 'D' || high.test(file) || matchesGlobs(file, [...DEFAULT_PUBLIC_SURFACE, ...(config.publicSurface ?? [])])) {
        return { tier: 'high', rule: `high-risk path or deletion: ${file}` };
      }
      if (/(?:^|\/)(?:shared|common|lib|components)(?:\/|$)/i.test(file)) {
        tier = 'medium';
        rule = `shared module path: ${file}`;
      }
    }
  }
  return { tier, rule };
}

async function changedRisk(repo, base, head, config) {
  if (![base, head].every((sha) => /^[0-9a-f]{40}$/.test(sha ?? ''))) fail('risk scan requires base and head SHAs');
  const { stdout } = await exec('git', ['diff', '--name-status', '-z', '-M', base, head, '--'], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
  const fields = stdout.split('\0');
  const changes = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    const paths = fields.slice(index, index + (/^[RC]/.test(status) ? 2 : 1));
    index += paths.length;
    if (!paths.length || paths.some((file) => !file)) fail('invalid changed-path report');
    changes.push({ status, paths });
  }
  return riskForChanges(changes, config);
}

async function propagate(repo, worktree, files) {
  const expected = path.join(repo, '.mend/worktrees');
  if (path.dirname(worktree) !== expected || await fs.realpath(worktree) !== worktree) fail('worktree is outside its authorized location');
  const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: worktree });
  if (stdout.trim() !== worktree) fail('destination is not a worktree root');
  // Validate all destinations before writing any. Reused settings must agree; never silently
  // replace local operator policy or keep stale policy from a previous dispatch.
  for (const relative of SETTINGS) {
    if (!files.has(relative) && await safeFile(worktree, relative, true) !== null) fail(`worktree has setup absent from source: ${relative}`);
  }
  for (const [relative, bytes] of files) {
    const previous = await safeFile(worktree, relative, true);
    // The index is filtered for a new destination, but a checkout may already contain the
    // unfiltered tracked source. Preserve that checkout (and its clean Git status), while
    // still rejecting any content that matches neither source nor the propagated selection.
    const sourceIndex = relative === EXEMPLAR_INDEX ? await safeFile(repo, relative) : null;
    if (previous !== null && !previous.equals(bytes) && !(sourceIndex && previous.equals(sourceIndex))) fail(`worktree setup conflicts with source: ${relative}`);
    if (previous !== null) {
      const sourceMode = (await fs.stat(path.join(repo, relative))).mode;
      const destinationMode = (await fs.stat(path.join(worktree, relative))).mode;
      // Group/other execute bits do not make a helper executable by its owner.
      if ((sourceMode & 0o100) !== (destinationMode & 0o100)) fail(`worktree executable permission conflicts with source: ${relative}`);
      const sourceExecutable = (sourceMode & 0o111) !== 0;
      const destinationExecutable = (destinationMode & 0o111) !== 0;
      if (sourceExecutable !== destinationExecutable) fail(`worktree executable permission conflicts with source: ${relative}`);
    }
  }
  for (const [relative, bytes] of files) {
    const destination = path.join(worktree, relative);
    if (await safeFile(worktree, relative, true) !== null) continue;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const executable = ((await fs.stat(path.join(repo, relative))).mode & 0o111) !== 0;
    await fs.writeFile(destination, bytes, { flag: 'wx', mode: executable ? 0o700 : 0o600 });
  }
}

async function main(argv) {
  try {
    const [mode, ...rest] = argv;
    if (!['preflight', 'propagate', 'delivery'].includes(mode) || rest.length % 2) fail('invalid dispatch arguments');
    const args = Object.fromEntries(Array.from({ length: rest.length / 2 }, (_, index) => [rest[index * 2], rest[index * 2 + 1]]));
    const repo = await fs.realpath(args['--repo']);
    const marker = await exec('git', ['ls-files', '--', '.mend/setup-complete'], { cwd: repo });
    if (marker.stdout.trim()) fail('tracked setup marker is not a valid initialization record');
    const item = JSON.parse(await fs.readFile(path.resolve(args['--item']), 'utf8'));
    const profiles = await loadProfiles();
    const plan = planItem(item, profiles);
    if (args['--light'] !== undefined && args['--light'] !== 'yes') fail('invalid dispatch arguments');
    // mend-lite runs no profile checks, so it needs only the generic verification and exemplars.
    const files = await setupFiles(repo, args['--light'] === 'yes' ? planItem({ ...item, profiles: ['generic'] }, profiles) : plan);
    const grant = files.has('.mend/grants.json') ? json(files.get('.mend/grants.json'), 'grants.json') : null;
    authorize(item, plan, grant);
    const worktree = path.join(repo, '.mend/worktrees', item.id);
    const config = files.has('.mend/quality.json') ? json(files.get('.mend/quality.json'), 'quality.json') : {};
    const risk = mode === 'delivery' ? await changedRisk(worktree, args['--base'], args['--head'], config) : { tier: 'low' };
    const authorization = authorize(item, plan, grant, risk.tier, args['--prior-rung'] ?? 'full');
    if (mode === 'propagate') await propagate(repo, worktree, files);
    // The setup paths let a workflow tell its own untracked copies from files a worker left behind.
    process.stdout.write(JSON.stringify({ pass: true, ...authorization, riskRule: risk.rule, ...(mode === 'propagate' ? { setup: [...files.keys()].sort() } : {}) }) + '\n');
    return 0;
  } catch (error) {
    // Do not echo file contents or subprocess output that could include private data.
    process.stdout.write(JSON.stringify({ pass: false, reason: error.code ? `setup read failed (${error.code})` : error.message }) + '\n');
    return 3;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { stdinArgs } = await import('./stdin-args.mjs');
  process.exitCode = await main(stdinArgs(process.argv.slice(2)));
}
