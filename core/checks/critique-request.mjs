#!/usr/bin/env node
// Assemble a complete, profile-driven critique request without running the recorded commands.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadProfiles } from './check-profiles.mjs';
import { assignedProfiles, planItem } from './run-rubric.mjs';
import { readFileAt } from './repo-read.mjs';
import { loadReviewPolicy } from './review-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const gitExec = promisify(execFile);
export class CritiqueUsageError extends Error {}
const sensitive = (p) => path.resolve(p).split(path.sep).some((part) => part.startsWith('.env'));

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

async function read(file, { root, roots = [] } = {}) {
  if (!file || sensitive(file)) throw new CritiqueUsageError(`refused or missing path: ${file}`);
  let real;
  try { real = await fs.realpath(file); } catch { throw new CritiqueUsageError(`file not found: ${file}`); }
  if (sensitive(real)) throw new CritiqueUsageError(`refused path: ${file}`);
  if (root && !inside(root, real)) throw new CritiqueUsageError(`path escapes authorized directory: ${file}`);
  for (const entry of roots) {
    if (inside(entry.logical, path.resolve(file)) && !inside(entry.real, real)) throw new CritiqueUsageError(`path escapes authorized directory: ${file}`);
  }
  // An explicitly named file authorizes that file, not an arbitrary symlink target.
  if (!root && (await fs.lstat(file)).isSymbolicLink()) throw new CritiqueUsageError(`refused symlink: ${file}`);
  try { return await fs.readFile(real, 'utf8'); } catch { throw new CritiqueUsageError(`cannot read file: ${file}`); }
}

// loadProfiles reads profile.json and an optional schema itself. Check their resolved paths first.
async function checkProfileFiles(dir, root) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && !['fixtures', 'checks', 'node_modules'].includes(entry.name)) await checkProfileFiles(file, root);
    else if (entry.name === 'profile.json' || (dir === root && entry.name === 'profile.schema.json')) {
      const real = await fs.realpath(file);
      if (sensitive(real) || !inside(root, real)) throw new CritiqueUsageError(`profile path escapes authorized directory: ${file}`);
    }
  }
}

async function git(repo, args) {
  try {
    return (await gitExec('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) { throw new CritiqueUsageError(`git failed: ${error.message}`); }
}

function wrap(text) {
  return text.split('\n').map((line) => line.match(/[\s\S]{1,1900}/g)?.join('\n') ?? '').join('\n');
}
function fence(text) {
  const wrapped = wrap(text);
  const longest = (char) => {
    let max = 2;
    for (const match of wrapped.matchAll(char === '`' ? /`+/g : /~+/g)) max = Math.max(max, match[0].length);
    return max;
  };
  const backticks = longest('`'), tildes = longest('~');
  const delimiter = backticks <= tildes ? '`'.repeat(backticks + 1) : '~'.repeat(tildes + 1);
  return `${delimiter}text\n${wrapped}${wrapped.endsWith('\n') ? '' : '\n'}${delimiter}`;
}
function pretty(text) {
  try { JSON.parse(text); } catch { return text; }
  // Format structural whitespace only; never parse and reserialize numeric or string tokens.
  let result = '', depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; result += char; }
    else if (char === '{' || char === '[') { depth++; result += `${char}\n${'  '.repeat(depth)}`; }
    else if (char === '}' || char === ']') { depth--; result += `\n${'  '.repeat(depth)}${char}`; }
    else if (char === ',') result += `,\n${'  '.repeat(depth)}`;
    else if (char === ':') result += ': ';
    else if (!/\s/.test(char)) result += char;
  }
  return result;
}

/** Materials are keyed by profile kind, then proposalArtifact, exemplars or integrationDiff.
 * Each value is { paths: [text file paths], note: string } or exemplars { none: string }.
 */
export async function buildCritiqueRequest(options) {
  const { itemPath, repo, baseSha, headSha, round, firstFindingId, previousHeadSha } = options;
  if (!itemPath || !repo || !baseSha || !headSha || !Number.isInteger(Number(round)) || Number(round) < 1 || !/^F[1-9]\d*$/.test(firstFindingId ?? '')) throw new CritiqueUsageError('itemPath, repo, baseSha, headSha, positive round and firstFindingId (F<n>) are required');
  if (![baseSha, headSha, ...(previousHeadSha ? [previousHeadSha] : [])].every((sha) => /^[a-fA-F0-9]{4,64}$/.test(sha))) throw new CritiqueUsageError('commit SHAs must be hexadecimal');
  const profilesDir = path.resolve(options.profilesDir ?? path.join(HERE, '..', 'profiles'));
  const realProfiles = await fs.realpath(profilesDir);
  const realRepo = await fs.realpath(repo);
  if ([profilesDir, realProfiles, repo, realRepo].some(sensitive)) throw new CritiqueUsageError('refused directory');
  const roots = [{ logical: path.resolve(repo), real: realRepo }, { logical: profilesDir, real: realProfiles }];
  const readGiven = (file) => read(file, { roots });
  let item;
  try { item = JSON.parse(await readGiven(itemPath)); } catch (error) { if (error instanceof CritiqueUsageError) throw error; throw new CritiqueUsageError(`invalid item JSON: ${error.message}`); }
  await checkProfileFiles(realProfiles, realProfiles);
  const profiles = assignedProfiles(item, await loadProfiles(realProfiles));
  const uiReferences = planItem(item, profiles).uiReferences;
  if (!profiles.some((profile) => profile.kind === 'generic')) throw new CritiqueUsageError('generic profile is required');
  const { pathspec } = await loadReviewPolicy({ repo, baseSha });
  const names = await git(repo, ['diff', '--no-renames', '--name-only', '-z', baseSha, headSha, '--', ...pathspec]);
  const files = names.split('\0').filter(Boolean);
  if (files.some(sensitive)) throw new CritiqueUsageError('diff includes an .env path');
  const diff = await git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', baseSha, headSha, '--', ...pathspec]);
  if (!diff.trim()) throw new CritiqueUsageError('diff is empty');
  const parts = [wrap(`# Critique request — round ${round}, first new finding ${firstFindingId}`)];
  const section = (title, content) => parts.push(`${wrap(`## ${title}`)}\n\n${content}`);
  section('Critique prompt', wrap(await read(path.join(HERE, '..', 'skills', 'mend-quality', 'critique-prompt.md'), { root: await fs.realpath(path.join(HERE, '..', 'skills', 'mend-quality')) })));
  for (const profile of profiles) {
    section(`Lens: ${profile.kind}`, wrap(await read(path.join(profile.dir, profile.critiqueLens), { root: realProfiles })));
    if (profile.kind === 'ui') for (const file of uiReferences) section(`UI reference: ${path.basename(file, '.md')} — ${file}`, wrap(await read(file, { root: realProfiles })));
  }
  section('Item', fence(JSON.stringify(item, null, 2)));
  section('Product constraints', 'The result must work in a normal install without an extra service. Apply D18: cut diff growth that no open blocker or should explains before adding other work.');
  const rows = ['| Profile | Material | Status | Detail |', '|---|---|---|---|'];
  const contents = [];
  for (const profile of profiles) {
    for (const [key, label] of [['proposalArtifact', 'proposal artifact'], ['exemplars', 'exemplars'], ['integrationDiff', 'integration diff']]) {
      const requirement = profile[key];
      const supplied = options.materials?.[profile.kind]?.[key] ?? {};
      const paths = supplied.paths ?? [];
      if (!Array.isArray(paths)) throw new CritiqueUsageError(`material paths must be an array: ${profile.kind}.${key}`);
      if (supplied.none !== undefined) {
        if (key !== 'exemplars' || typeof supplied.none !== 'string' || !supplied.none.trim() || /[\r\n]/.test(supplied.none) || paths.length) throw new CritiqueUsageError(`invalid none material: ${profile.kind}.${key}`);
        let index;
        try { index = JSON.parse(await read(path.join(realRepo, '.mend', 'exemplars', 'index.json'), { root: realRepo })); }
        catch { throw new CritiqueUsageError('cannot read exemplar index'); }
        if (!Array.isArray(index) || !index.some((entry) => entry?.profile === profile.kind && entry.none === supplied.none && Array.isArray(entry.search?.paths) && entry.search.paths.length && entry.search.paths.every((p) => typeof p === 'string' && p.trim()) && typeof entry.search.gitLogRange === 'string' && entry.search.gitLogRange.trim()) || index.some((entry) => entry?.profile === profile.kind && !entry.none)) throw new CritiqueUsageError(`none not declared in exemplar index for ${profile.kind}`);
      }
      const optional = key === 'exemplars' && requirement?.min === 0;
      const description = key === 'exemplars' ? requirement?.what : key === 'proposalArtifact' ? requirement?.what : requirement;
      const materials = [];
      for (const file of paths) materials.push({ file, text: await readGiven(file) });
      const empty = materials.filter(({ text }) => !text.trim());
      let status, detail;
      if (supplied.none !== undefined) {
        status = profile.kind === 'ui' && uiReferences.length ? 'reference' : 'none in repo';
        detail = status === 'reference' ? uiReferences.join(', ') : supplied.none;
      } else if (paths.length && !empty.length) {
        status = 'provided'; detail = paths.join(', ');
      } else if (paths.length) {
        status = 'missing'; detail = `Empty material: ${empty.map(({ file }) => file).join(', ')}${supplied.note ? `; ${supplied.note}` : ''}`;
      } else if (!requirement || optional) {
        status = 'not applicable'; detail = !requirement ? `profile declares ${key} as null` : `profile allows zero exemplars (min: 0)${supplied.note ? `: ${supplied.note}` : ''}`;
      } else {
        status = 'missing'; detail = supplied.note || `No material supplied; profile requires: ${description}`;
      }
      for (const { file, text } of materials) contents.push(`${wrap(`### ${profile.kind} — ${label}: ${file}`)}\n\n${fence(text)}`);
      rows.push(`| ${profile.kind} | ${label} | ${status} | ${String(detail).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`);
    }
  }
  section('Materials', `${wrap(rows.join('\n'))}\n\n${contents.join('\n\n')}`);
  for (const file of options.previousCritiques ?? []) section(`Previous critique: ${file}`, fence(await readGiven(file)));
  if (options.ownerReportPath) {
    const report = await readGiven(options.ownerReportPath);
    if (!report.trim()) throw new CritiqueUsageError('owner report is empty');
    section('Owner report', fence(report));
  }
  for (const record of options.commands ?? []) {
    if (typeof record.command !== 'string' || !record.command.trim() || !Number.isInteger(record.exit) || !record.logPath) throw new CritiqueUsageError('command records require command, integer exit and logPath');
    section(`Command: ${record.command} (exit ${record.exit})`, fence(pretty(await readGiven(record.logPath))));
  }
  if (options.rubricPath) section('Rubric', fence(pretty(await readGiven(options.rubricPath))));
  if (options.integrityPath) section('Integrity', fence(pretty(await readGiven(options.integrityPath))));
  if (options.countersigns?.length) section('Countersigns', wrap(options.countersigns.join('\n')));
  for (const file of files) {
    for (const [label, sha] of [['Base', baseSha], ['Head', headSha]]) {
      const content = await readFileAt({ repo, sha, filePath: file });
      section(`${label}: ${file}`, content === null ? `Absent at ${label.toLowerCase()}.` : fence(content));
    }
  }
  if (previousHeadSha) {
    const previousNames = await git(repo, ['diff', '--no-renames', '--name-only', '-z', previousHeadSha, headSha, '--', ...pathspec]);
    if (previousNames.split('\0').filter(Boolean).some(sensitive)) throw new CritiqueUsageError('previous diff includes an .env path');
    section('Diff since previous round', fence(await git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', previousHeadSha, headSha, '--', ...pathspec])));
  }
  section('Diff shortstat', fence(await git(repo, ['diff', '--shortstat', '--no-renames', baseSha, headSha, '--', ...pathspec])));
  section('Full diff', fence(diff));
  return `${parts.join('\n\n')}\n`;
}

// Repeated --command takes a JSON record; --material takes JSON {profile, kind, paths, note}.
export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = { commands: [], previousCritiques: [], countersigns: [], materials: {} };
    const flags = { '--item': 'itemPath', '--repo': 'repo', '--base': 'baseSha', '--head': 'headSha', '--profiles': 'profilesDir', '--round': 'round', '--first-finding': 'firstFindingId', '--previous-head': 'previousHeadSha', '--owner-report': 'ownerReportPath', '--rubric': 'rubricPath', '--integrity': 'integrityPath' };
    for (let i = 0; i < argv.length; i += 2) {
      const flag = argv[i], value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new CritiqueUsageError(`${flag} needs a value`);
      if (flags[flag]) options[flags[flag]] = value;
      else if (flag === '--previous-critique') options.previousCritiques.push(value);
      else if (flag === '--countersign') options.countersigns.push(value);
      else if (flag === '--command') options.commands.push(JSON.parse(value));
      else if (flag === '--material') { const { profile, kind, ...material } = JSON.parse(value); if (!profile || !['proposalArtifact', 'exemplars', 'integrationDiff'].includes(kind)) throw new CritiqueUsageError('invalid material'); (options.materials[profile] ??= {})[kind] = material; }
      else throw new CritiqueUsageError(`unknown argument: ${flag}`);
    }
    stdout.write(await buildCritiqueRequest(options));
    return 0;
  } catch (error) { stderr.write(`[CRITIQUE REQUEST]: ${error.message}\n`); return 64; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
