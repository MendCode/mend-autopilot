#!/usr/bin/env node
// Runs the quality profiles of one work item from the command line, so owners and workflows that cannot
// import modules can still use them. `plan` says which profiles apply and what each one asks for;
// `run` executes their rubric checks (and integration diffs on request) at base..head.
// Nothing here names a profile: everything comes from the profile folders.

import { promises as fs } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureDeclared } from './capture.mjs';
import { matchesGlobs } from './changes.mjs';
import { loadProfiles, ProfilesUsageError, resolveCheck } from './check-profiles.mjs';
import { readCard } from './repo-read.mjs';
import { critiqueContract } from './critic-reply.mjs';

export const EXIT = { pass: 0, fail: 1, blocked: 3, usage: 64 };
export const ALWAYS_KIND = 'generic';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILES_DIR = path.join(HERE, '..', 'profiles');
const QUALITY_CONFIG = path.join('.mend', 'quality.json');
const WORD = /[a-z0-9]+/g;

export class RubricUsageError extends Error {
  constructor(message) {
    super(`[RUBRIC]: ${message}`);
    this.name = 'RubricUsageError';
  }
}

function listOf(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Profiles whose matchHints fit the item's edit set or goal. A suggestion only; it never assigns. */
export function suggestProfiles(item, profiles) {
  const editSet = listOf(item?.editSet);
  const words = new Set(String(item?.goal ?? '').toLowerCase().match(WORD) ?? []);
  return profiles
    .filter((profile) => profile.kind !== ALWAYS_KIND)
    .filter((profile) => {
      const hints = profile.matchHints ?? {};
      const byPath = editSet.some((entry) => matchesGlobs(entry, listOf(hints.paths)));
      const byIntent = listOf(hints.intents).some((intent) => words.has(intent.toLowerCase()));
      return byPath || byIntent;
    })
    .map((profile) => profile.kind);
}

/** The profiles an item runs: the ones it declares, plus generic. Unknown kinds are a usage error. */
export function assignedProfiles(item, profiles) {
  const byKind = new Map(profiles.map((profile) => [profile.kind, profile]));
  const declared = listOf(item?.profiles);
  const unknown = declared.filter((kind) => !byKind.has(kind));
  if (unknown.length > 0) throw new RubricUsageError(`item declares unknown profiles: ${unknown.join(', ')}`);
  const kinds = [...new Set([ALWAYS_KIND, ...declared])].filter((kind) => byKind.has(kind));
  return kinds.map((kind) => byKind.get(kind));
}

/** What each assigned profile asks for, in a shape a workflow can follow without knowing any profile. */
export function planItem(item, profiles) {
  const assigned = assignedProfiles(item, profiles);
  const referenceDir = profiles.find((profile) => profile.kind === 'ui')?.dir;
  let names = [];
  if (referenceDir) {
    try { names = readdirSync(path.join(referenceDir, 'references'), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name.slice(0, -3)).sort(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const rawTypes = item?.uiType;
  const types = rawTypes === undefined ? [] : typeof rawTypes === 'string' ? [rawTypes] : rawTypes;
  if (!Array.isArray(types) || !types.length && rawTypes !== undefined || types.some((type) => typeof type !== 'string' || !names.includes(type))) throw new RubricUsageError(`unknown or invalid uiType; valid types: ${names.join(', ') || '(none)'}`);
  const input = `${item?.goal ?? ''} ${listOf(item?.editSet).join(' ')}`.toLowerCase();
  const suggestions = rawTypes === undefined ? names.filter((name) => {
    const text = readFileSync(path.join(referenceDir, 'references', `${name}.md`), 'utf8');
    const applies = text.split(/^## Applies when\s*$/m)[1]?.split(/^## /m)[0] ?? '';
    const terms = [name, name.replace(/s$/, ''), ...[...applies.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => match[1])];
    return terms.some((term) => term.length > 2 && input.includes(term.toLowerCase()));
  }) : [];
  const declared = new Set(listOf(item?.profiles));
  const highRisk = item?.risk === 'high' || assigned.some((profile) => profile.riskFloor === 'high');
  const smallest = (field, fallback) => Math.min(...assigned.map((profile) => profile[field] ?? fallback));
  return {
    item: item?.id ?? null,
    uiType: [...new Set(types)],
    suggestedUiTypes: suggestions,
    uiReferences: [...new Set(types)].map((name) => path.join(referenceDir, 'references', `${name}.md`)),
    profiles: assigned.map((profile) => ({
      kind: profile.kind,
      ownerHint: types.length === 1 ? profile.ownerHints?.find((entry) => entry.uiType === types[0])?.ownerHint ?? null : null,
      ownerHints: [...new Set(types)].flatMap((uiType) => {
        const hint = profile.ownerHints?.find((entry) => entry.uiType === uiType)?.ownerHint;
        return hint ? [{ uiType, ownerHint: hint }] : [];
      }),
      riskFloor: profile.riskFloor,
      rubric: profile.rubric,
      integrationDiff: profile.integrationDiff ?? null,
      proposalArtifact: profile.proposalArtifact ?? null,
      humanApproval: profile.humanApproval === 'always' || highRisk,
      proposalApprover: profile.humanApproval === 'always' || highRisk ? 'human' : 'supervisor',
      roundBudget: profile.roundBudget ?? 2,
      fileCap: profile.fileCap ?? null,
      critiqueLens: path.join(profile.dir, profile.critiqueLens),
      cardFields: profile.cardFields ?? [],
      exemplars: profile.exemplars,
    })),
    roundBudget: smallest('roundBudget', 2),
    fileCap: assigned.some((profile) => typeof profile.fileCap === 'number') ? smallest('fileCap', Infinity) : null,
    suggested: suggestProfiles(item, profiles).filter((kind) => !declared.has(kind)),
  };
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new RubricUsageError(`${file}: ${error.message}`);
  }
}

async function runOne({ profile, checkId, context, withoutCard = false, proposal = false }) {
  let check;
  try {
    check = await resolveCheck(profile, checkId, { repo: context.repo });
  } catch (error) {
    return { id: checkId, skipped: true, skipReason: error.message };
  }
  if (withoutCard && check.needsCard === true) return { id: checkId, deferred: true };
  if (context.review && check.needsFinalCard === true) return { id: checkId, deferred: true };
  if (proposal && check.afterProposal === true) return { id: checkId, deferred: true };
  try {
    const config = profile.kind === 'ui' || profile.kind === 'generic'
      ? context.config
      : { ...context.config, ...(profile.kind === 'docs' ? { locale: context.config.ui?.locale ?? context.config.locale } : {}), ...(context.config[profile.kind] ?? {}) };
    const result = await check.run({ ...context, config });
    const failures = [...(result.failures ?? [])];
    for (const override of result.overrides ?? []) {
      const subject = `${profile.kind}.${checkId}.${override.key}=${JSON.stringify(override.to)}`;
      if (override.loosens && !(context.card?.countersigns ?? []).some((sign) => sign.kind === 'gate-loosening' && sign.subject === subject && sign.by?.trim() && sign.reason?.trim() && Number.isFinite(Date.parse(sign.at)))) {
        failures.push({ target: subject, rule: 'gate-loosening-unsigned', detail: 'this exact override needs a dated gate-loosening countersign from the human' });
      }
    }
    const evidence = Object.fromEntries(['overrides', 'allowed', 'designRules', 'scaleMargin'].filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
    return { id: checkId, pass: result.pass === true && failures.length === 0, blocked: result.blocked === true, failures, ...evidence };
  } catch (error) {
    return { id: checkId, pass: false, blocked: false, failures: [{ target: checkId, rule: 'check-crashed', detail: error.message }] };
  }
}

function merged(results) {
  return {
    pass: results.every((result) => result.pass === true),
    failures: results.flatMap((result) => result.failures ?? []),
  };
}

/**
 * Runs every assigned profile's rubric (and integration diff when asked) and returns card-shaped results.
 * withoutCard defers checks that declare needsCard, for rounds that run before the evidence card exists;
 * they are listed as deferred and must run again once the card is written. Proposal rounds also
 * defer checks marked afterProposal; integration and final runs must execute them.
 * reviewCard supplies provisional evidence: only needsFinalCard checks are deferred in that mode.
 */
export async function runItem({ repo, item, baseSha, headSha, profiles, integration = false, withoutCard = false, proposal = false, reviewCard = null }) {
  if (proposal && integration) throw new RubricUsageError('proposal and integration phases cannot be combined');
  if (reviewCard !== null && (withoutCard || typeof reviewCard !== 'object' || Array.isArray(reviewCard))) throw new RubricUsageError('reviewCard must be an object and cannot be combined with withoutCard');
  const config = (await readJsonIfPresent(path.join(repo, QUALITY_CONFIG))) ?? {};
  const card = reviewCard ?? (withoutCard ? null : await readCard({ repo, item }).catch(() => null));
  const context = { repo, item, baseSha, headSha, config, card, review: reviewCard !== null, proposal };
  const results = [];
  for (const profile of assignedProfiles(item, profiles)) {
    const rubric = [];
    for (const checkId of profile.rubric) rubric.push(await runOne({ profile, checkId, context, withoutCard, proposal }));
    const skipped = rubric.filter((result) => result.skipped);
    const entry = { kind: profile.kind, skipped: skipped.length > 0, checks: rubric };
    if (entry.skipped) entry.skipReason = skipped.map((result) => result.skipReason).join('; ');
    const deferred = rubric.filter((result) => result.deferred).map((result) => result.id);
    if (deferred.length > 0) entry.deferred = deferred;
    entry.rubric = merged(rubric.filter((result) => !result.skipped && !result.deferred));
    if (integration && profile.integrationDiff) {
      const diff = await runOne({ profile, checkId: profile.integrationDiff, context });
      entry.integrationCheck = diff;
      entry.integrationDiff = diff.skipped
        ? { pass: false, detail: diff.skipReason }
        : { pass: diff.pass, detail: diff.failures.map((failure) => `${failure.rule}: ${failure.detail}`).join('; ') || 'no differences', ...(diff.overrides ? { overrides: diff.overrides } : {}), ...(diff.allowed ? { allowed: diff.allowed } : {}) };
    }
    results.push(entry);
  }
  const blocked = results.some((entry) => entry.checks.some((result) => result.blocked));
  const loosenings = results.flatMap((entry) => [...entry.checks, ...(entry.integrationDiff ? [entry.integrationDiff] : [])].flatMap((check) => (check.overrides ?? []).filter((override) => override.loosens).map((override) => ({ profile: entry.kind, ...override }))));
  const passesIgnoringUnsigned = (check) => check.pass === true || (withoutCard && check.failures?.length > 0 && check.failures.every((failure) => failure.rule === 'gate-loosening-unsigned'));
  const checksPass = results.every((entry) => !entry.skipped && entry.checks.every((check) => check.deferred || passesIgnoringUnsigned(check)) && (!entry.integrationCheck || passesIgnoringUnsigned(entry.integrationCheck)));
  return { item: item?.id ?? null, baseSha, headSha, pass: checksPass && (!withoutCard || loosenings.length === 0), checksPass, blocked, loosenings, profiles: results };
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = [
  'usage: node run-rubric.mjs plan --item <item.json> [--profiles <dir>]',
  '       node run-rubric.mjs run --item <item.json> --base <sha> --head <sha> [--integration] [--without-card | --review-card <json>] [--proposal] [--repo <dir>] [--profiles <dir>]',
].join('\n');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'plan' && command !== 'run') throw new RubricUsageError(USAGE);
  const options = { command, repo: '.', profiles: DEFAULT_PROFILES_DIR, integration: false, withoutCard: false };
  const valueFlags = { '--item': 'item', '--base': 'base', '--head': 'head', '--repo': 'repo', '--profiles': 'profiles', '--review-card': 'reviewCard' };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--integration') options.integration = true;
    else if (argument === '--without-card') options.withoutCard = true;
    else if (argument === '--proposal') options.proposal = true;
    else if (argument in valueFlags) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) throw new RubricUsageError(`${argument} needs a value\n${USAGE}`);
      options[valueFlags[argument]] = value;
      index += 1;
    } else throw new RubricUsageError(`unknown argument ${argument}\n${USAGE}`);
  }
  if (!options.item) throw new RubricUsageError(`--item is required\n${USAGE}`);
  if (command === 'run' && (!options.base || !options.head)) throw new RubricUsageError(`--base and --head are required\n${USAGE}`);
  return options;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArgs(argv);
    const item = await readJsonIfPresent(path.resolve(options.item));
    if (!item) throw new RubricUsageError(`item file not found: ${options.item}`);
    const profiles = await loadProfiles(path.resolve(options.profiles));
    if (options.command === 'plan') {
      const plan = planItem(item, profiles);
      plan.critiqueCategories = await critiqueContract(assignedProfiles(item, profiles));
      stdout.write(`${JSON.stringify(plan)}\n`);
      return EXIT.pass;
    }
    const reviewCard = options.reviewCard ? await readJsonIfPresent(path.resolve(options.reviewCard)) : null;
    if (options.reviewCard && !reviewCard) throw new RubricUsageError('review card is missing or null');
    // The workflow runs this tool, never the owner, so declared captures are taken here before checks read them.
    await captureDeclared({ repo: path.resolve(options.repo), item, baseSha: options.base, headSha: options.head });
    const report = await runItem({
      repo: path.resolve(options.repo),
      item,
      baseSha: options.base,
      headSha: options.head,
      profiles,
      integration: options.integration,
      withoutCard: options.withoutCard,
      proposal: options.proposal,
      reviewCard,
    });
    stdout.write(`${JSON.stringify(report)}\n`);
    if (report.blocked) return EXIT.blocked;
    return report.pass ? EXIT.pass : EXIT.fail;
  } catch (error) {
    if (error instanceof RubricUsageError || error instanceof ProfilesUsageError) {
      stderr.write(`${error.message}\n`);
      return EXIT.usage;
    }
    stderr.write(`[RUBRIC]: ${error.message}\n`);
    return EXIT.fail;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { stdinArgs } = await import('./stdin-args.mjs');
  process.exitCode = await main(stdinArgs(process.argv.slice(2)));
}
