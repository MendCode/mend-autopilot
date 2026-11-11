#!/usr/bin/env node
// Discovers work profiles, validates them against profiles/profile.schema.json and proves that every
// declared check resolves and has been seen both passing and failing on its own synthetic fixtures.
// Adding a work kind means adding a folder; nothing in this file names a profile.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertGuardAllowed, GuardBlockedError } from './guard-command.mjs';

export const EXIT = { ok: 0, invalid: 1, usage: 64 };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILES_DIR = path.join(HERE, '..', 'profiles');
const SCHEMA_FILE = 'profile.schema.json';
const PROFILE_FILE = 'profile.json';
const SKIPPED_DIRS = new Set(['fixtures', 'checks', 'node_modules']);
const ANNOTATION_KEYWORDS = new Set(['$schema', '$id', 'title', 'description', 'examples']);
const ASSERTION_KEYWORDS = new Set([
  'type',
  'additionalProperties',
  'required',
  'properties',
  'pattern',
  'minLength',
  'enum',
  'items',
  'minimum',
]);
const REPO_QUALITY_CONFIG = path.join('.mend', 'quality.json');
const COMMAND_TIMEOUT_MS = 600_000;

export class ProfilesUsageError extends Error {}

export function validateUiReference(text) {
  const sections = ['Applies when', 'References', 'Defaults for this type', 'Slop markers for this type', 'Critic checklist'];
  const matches = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  return sections.filter((name) => {
    const index = matches.findIndex((match) => match[1] === name);
    return index < 0 || !text.slice(matches[index].index + matches[index][0].length, matches[index + 1]?.index ?? text.length).trim();
  }).map((name) => `missing or empty section: ${name}`);
}

function profileError(kind, reason) {
  return new TypeError(`[PROFILES]: ${kind}: ${reason}`);
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator for the keywords profile.schema.json uses

export function assertSupportedSchema(schema, where = '#') {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError(`[PROFILES]: schema: ${where} is not a schema object`);
  }
  for (const keyword of Object.keys(schema)) {
    if (!ANNOTATION_KEYWORDS.has(keyword) && !ASSERTION_KEYWORDS.has(keyword)) {
      throw new TypeError(`[PROFILES]: schema: ${where} uses unsupported keyword "${keyword}"`);
    }
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) assertSupportedSchema(child, `${where}/properties/${name}`);
  if (schema.items) assertSupportedSchema(schema.items, `${where}/items`);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

export function validateValue(schema, value, where = '') {
  const errors = [];
  const label = where || '(root)';
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((type) => matchesType(value, type))) {
      return [{ path: label, message: `must be ${allowed.join(' or ')}` }];
    }
  }
  if (schema.enum && !schema.enum.some((option) => option === value)) {
    errors.push({ path: label, message: `must be one of ${schema.enum.join(', ')}` });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path: label, message: 'must not be empty' });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push({ path: label, message: `must match ${schema.pattern}` });
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path: label, message: `must be at least ${schema.minimum}` });
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => errors.push(...validateValue(schema.items, entry, `${where}[${index}]`)));
  }
  if (typeOf(value) === 'object') {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!(name in value)) errors.push({ path: where ? `${where}.${name}` : name, message: 'is required' });
    }
    for (const [name, entry] of Object.entries(value)) {
      const childPath = where ? `${where}.${name}` : name;
      if (properties[name]) errors.push(...validateValue(properties[name], entry, childPath));
      else if (schema.additionalProperties === false) errors.push({ path: childPath, message: 'is not an allowed field' });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Discovery

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function findProfileFiles(dir) {
  const found = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...(await findProfileFiles(full)));
    } else if (entry.isFile() && entry.name === PROFILE_FILE) {
      found.push(full);
    }
  }
  return found;
}

async function loadSchema(dir) {
  const schemaPath = path.join(dir, SCHEMA_FILE);
  const fallback = path.join(DEFAULT_PROFILES_DIR, SCHEMA_FILE);
  const schema = await readJson((await exists(schemaPath)) ? schemaPath : fallback);
  assertSupportedSchema(schema);
  return schema;
}

/** Every profile folder under dir with its parsed data and the reasons it is invalid (empty when valid). */
export async function discoverProfiles(dir) {
  if (!(await exists(dir))) throw new ProfilesUsageError(`profiles directory not found: ${dir}`);
  const schema = await loadSchema(dir);
  const files = (await findProfileFiles(dir)).sort();
  const results = [];
  for (const file of files) {
    const profileDir = path.dirname(file);
    const folder = path.basename(profileDir);
    let data;
    try {
      data = await readJson(file);
    } catch (error) {
      results.push({ dir: profileDir, kind: folder, data: null, errors: [`${PROFILE_FILE} is not valid JSON (${error.message})`] });
      continue;
    }
    const kind = typeof data?.kind === 'string' && data.kind ? data.kind : folder;
    const errors = validateValue(schema, data).map((error) => `${error.path}: ${error.message}`);
    if (typeof data?.humanApproval === 'boolean') {
      errors.unshift('humanApproval: booleans are no longer supported; use "always" for visual work or "high-risk" otherwise');
    }
    if (errors.length === 0) {
      if (data.kind !== folder) errors.push(`kind "${data.kind}" must equal its folder name "${folder}"`);
      if (!(await exists(path.join(profileDir, data.critiqueLens)))) errors.push(`critiqueLens: ${data.critiqueLens} not found in the profile folder`);
      if (data.exemplars.max < data.exemplars.min) errors.push('exemplars: max is below min');
      if ((data.proposalArtifact === null) !== (data.frozenBaseline === null)) {
        errors.push('frozenBaseline: must be null exactly when proposalArtifact is null');
      }
    }
    results.push({ dir: profileDir, kind, data, errors });
  }
  const byKind = new Map();
  for (const result of results) {
    if (byKind.has(result.kind)) result.errors.push(`duplicate kind, also defined in ${path.relative(dir, byKind.get(result.kind).dir)}`);
    else byKind.set(result.kind, result);
  }
  return results;
}

/** Loads and validates every profile; throws TypeError '[PROFILES]: <kind>: <field>: <reason>' on the first malformed one. */
export async function loadProfiles(dir = DEFAULT_PROFILES_DIR) {
  const results = await discoverProfiles(dir);
  for (const result of results) {
    if (result.errors.length > 0) throw profileError(result.kind, result.errors[0]);
  }
  return results.map((result) => ({ ...result.data, dir: result.dir })).sort((a, b) => a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// Check resolution

function assertCheckShape(kind, checkId, module, file) {
  const check = module?.default;
  if (!check || typeof check !== 'object') throw profileError(kind, `check ${checkId}: ${file} has no default export`);
  if (check.id !== checkId) throw profileError(kind, `check ${checkId}: ${file} exports id "${check.id}"`);
  if (typeof check.description !== 'string' || check.description === '') throw profileError(kind, `check ${checkId}: description is missing`);
  if (typeof check.run !== 'function') throw profileError(kind, `check ${checkId}: run is not a function`);
  return check;
}

async function runShell({ command, cwd, env, timeoutMs }) {
  await assertGuardAllowed({ command, cwd, env });
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk) => {
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exit: code ?? (signal ? 124 : 1), output });
    });
  });
}

function commandCheck(checkId, declared) {
  return {
    id: checkId,
    description: declared.description ?? `repo command: ${declared.command}`,
    source: 'repo',
    async run({ repo, item, baseSha, headSha }) {
      const env = {
        ...process.env,
        MEND_BASE_SHA: baseSha ?? '',
        MEND_HEAD_SHA: headSha ?? '',
        MEND_ITEM: item?.id ?? '',
      };
      let result;
      try {
        result = await runShell({ command: declared.command, cwd: repo, env, timeoutMs: declared.timeoutMs ?? COMMAND_TIMEOUT_MS });
      } catch (error) {
        if (!(error instanceof GuardBlockedError)) throw error;
        return { pass: false, blocked: true, failures: [{ target: checkId, rule: 'guard-blocked', detail: error.message }] };
      }
      if (result.exit === 0) return { pass: true, failures: [] };
      return {
        pass: false,
        failures: [{ target: checkId, rule: 'command-exit', detail: `exit ${result.exit}: ${result.output.trimEnd()}` }],
      };
    },
  };
}

/** Resolves a check id to profiles/<kind>/checks/<id>.mjs, or to a command the repo declares in .mend/quality.json. */
export async function resolveCheck(profile, checkId, { repo } = {}) {
  const file = path.join(profile.dir, 'checks', `${checkId}.mjs`);
  if (await exists(file)) {
    const module = await import(pathToFileURL(file).href);
    return { ...assertCheckShape(profile.kind, checkId, module, path.relative(profile.dir, file)), source: 'profile' };
  }
  if (repo) {
    const configPath = path.join(repo, REPO_QUALITY_CONFIG);
    if (await exists(configPath)) {
      const config = await readJson(configPath);
      const declared = config?.checks?.[checkId];
      if (declared && typeof declared.command === 'string' && declared.command.trim() !== '') return commandCheck(checkId, declared);
    }
  }
  throw profileError(profile.kind, `check ${checkId} does not resolve (no checks/${checkId}.mjs and no command in ${REPO_QUALITY_CONFIG})`);
}

// ---------------------------------------------------------------------------
// Fixtures: a check counts only once it has been seen passing and failing

async function listFixtures(dir) {
  if (!(await exists(dir))) return [];
  return (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
}

function sameRules(actual, expected) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length && left.every((rule, index) => rule === right[index]);
}

export async function verifyCheckFixtures(profile, check) {
  const reasons = [];
  if (typeof check.runFixture !== 'function') return [`check ${check.id}: runFixture is not a function, so its fixtures cannot run`];
  const fixtureDir = path.join(profile.dir, 'fixtures', check.id);
  const names = await listFixtures(fixtureDir);
  const passing = names.filter((name) => name.startsWith('pass-'));
  const failing = names.filter((name) => name.startsWith('fail-'));
  if (passing.length === 0) reasons.push(`check ${check.id}: no passing fixture (fixtures/${check.id}/pass-*.json)`);
  if (failing.length === 0) reasons.push(`check ${check.id}: no failing fixture (fixtures/${check.id}/fail-*.json)`);
  for (const name of [...passing, ...failing]) {
    const fixture = await readJson(path.join(fixtureDir, name));
    let result;
    try {
      result = await check.runFixture(fixture);
    } catch (error) {
      reasons.push(`check ${check.id}: fixture ${name} threw ${error.message}`);
      continue;
    }
    const rules = result.failures.map((failure) => failure.rule);
    if (name.startsWith('pass-') && (!result.pass || result.failures.length > 0)) {
      reasons.push(`check ${check.id}: fixture ${name} should pass but failed on ${rules.join(', ')}`);
    }
    if (name.startsWith('fail-')) {
      if (result.pass) reasons.push(`check ${check.id}: fixture ${name} should fail but passed`);
      else if (Array.isArray(fixture.expect) && !sameRules(rules, fixture.expect)) {
        reasons.push(`check ${check.id}: fixture ${name} failed on ${[...new Set(rules)].join(', ')}, expected ${fixture.expect.join(', ')}`);
      }
    }
  }
  return reasons;
}

/** Full registry check: schema, lens, check resolution and fixtures. */
export async function checkProfiles(dir = DEFAULT_PROFILES_DIR) {
  const results = await discoverProfiles(dir);
  const reasons = [];
  for (const result of results) {
    for (const error of result.errors) reasons.push({ kind: result.kind, reason: error });
    if (result.errors.length > 0) continue;
    const profile = { ...result.data, dir: result.dir };
    const referenceDir = path.join(profile.dir, 'references');
    if (await exists(referenceDir)) for (const entry of await fs.readdir(referenceDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      for (const reason of validateUiReference(await fs.readFile(path.join(referenceDir, entry.name), 'utf8'))) reasons.push({ kind: profile.kind, reason: `references/${entry.name}: ${reason}` });
    }
    const checkIds = [...new Set([...profile.rubric, ...(profile.integrationDiff ? [profile.integrationDiff] : [])])];
    for (const checkId of checkIds) {
      let check;
      try {
        check = await resolveCheck(profile, checkId);
      } catch (error) {
        reasons.push({ kind: profile.kind, reason: error.message.replace(`[PROFILES]: ${profile.kind}: `, '') });
        continue;
      }
      for (const reason of await verifyCheckFixtures(profile, check)) reasons.push({ kind: profile.kind, reason });
    }
  }
  return { ok: reasons.length === 0, kinds: results.map((result) => result.kind), reasons };
}

// ---------------------------------------------------------------------------
// CLI

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length > 1 || (argv[0] && argv[0].startsWith('-'))) {
    stderr.write('usage: node checks/check-profiles.mjs [profiles-dir]\n');
    return EXIT.usage;
  }
  const dir = path.resolve(argv[0] ?? DEFAULT_PROFILES_DIR);
  let report;
  try {
    report = await checkProfiles(dir);
  } catch (error) {
    if (error instanceof ProfilesUsageError) {
      stderr.write(`[PROFILES]: ${error.message}\n`);
      return EXIT.usage;
    }
    stderr.write(`${error.message}\n`);
    return EXIT.invalid;
  }
  for (const { kind, reason } of report.reasons) stderr.write(`[PROFILES]: ${kind}: ${reason}\n`);
  if (!report.ok) return EXIT.invalid;
  stdout.write(`[PROFILES]: ${report.kinds.length} profiles valid: ${report.kinds.join(', ')}\n`);
  return EXIT.ok;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
