#!/usr/bin/env node
// Reads one stored critic reply in the format core/skills/mend-quality/critique-prompt.md asks for:
// the score table, comparative judgments, gaming line, findings and resolved line. Shared by the critique-ledger
// check and by workflows, which call the CLI because they cannot import modules.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = { parsed: 0, unparseable: 1, usage: 64 };

const FINDING_LINE = /^\s*-\s*(F[1-9]\d*)\s*\[(blocker|should|nit)\]/;
const GAMING_LINE = /^\s*gaming:\s*(yes|no)\b/im;
const RESOLVED_LINE = /^\s*resolved:\s*(.*)$/im;
const FINDING_ID = /\bF[1-9]\d*\b/g;

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

// Only the generated Materials section's first table declares material status.
export function noneExemplarProfiles(request = '') {
  const lines = request.split(/\r?\n/);
  let fence = null, start = -1;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(lines[i])) fence = null;
      continue;
    }
    if (!fence && lines[i] === '## Materials') { start = i + 1; break; }
  }
  const profiles = new Set();
  if (start < 0) return profiles;
  while (lines[start] === '') start++;
  if (lines[start] !== '| Profile | Material | Status | Detail |' || lines[start + 1] !== '|---|---|---|---|') return profiles;
  for (const line of lines.slice(start + 2)) {
    const match = /^\|\s*([a-z][a-z0-9-]*)\s*\|\s*exemplars\s*\|\s*none in repo\s*\|\s*[^|\s][^\r\n]*\|\s*$/.exec(line);
    if (!line.startsWith('|')) break;
    if (match) profiles.add(match[1]);
  }
  return profiles;
}

function scoreCell(cell) {
  if (cell.toLowerCase() === 'n/a') return null;
  if (!/^\d+(\.\d+)?$/.test(cell)) return undefined;
  const value = Number(cell);
  return value >= 0 && value <= 10 ? value : undefined;
}

/** The first markdown table whose header starts with category | base | head. */
function parseScoreTable(lines, noneProfiles) {
  const start = lines.findIndex((line) => {
    if (!line.trim().startsWith('|')) return false;
    const header = cells(line).map((cell) => cell.toLowerCase());
    return header[0] === 'category' && header[1] === 'base' && header[2] === 'head';
  });
  if (start === -1) return { error: 'no score table with columns category | base | head' };
  const anchorLabels = cells(lines[start]).slice(3);
  if (anchorLabels.length === 0 && noneProfiles.size === 0) return { error: 'score table needs at least one exemplar column' };
  if (anchorLabels.some((label) => !label || ['category', 'base', 'head'].includes(label) || /[=|]/.test(label)) || new Set(anchorLabels).size !== anchorLabels.length) {
    return { error: 'score table exemplar labels must be unique, nonempty and not reserved or contain = or |' };
  }
  const scores = {};
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break;
    const [category, base, head, ...anchors] = cells(line);
    const parsed = [base, head, ...anchors].map(scoreCell);
    if (!category || parsed.length !== anchorLabels.length + 2 || parsed.includes(undefined)) {
      return { error: `score row "${line.trim()}" is not a category with a number or n/a in every column` };
    }
    if (!/^[a-z][a-z0-9-]*\.[a-z0-9-]+$/.test(category) || Object.hasOwn(scores, category)) {
      return { error: `invalid or duplicate score category "${category}"` };
    }
    if (!anchorLabels.length && !noneProfiles.has(category.split('.')[0])) return { error: `no exemplar declaration for ${category}` };
    if (noneProfiles.has(category.split('.')[0]) && anchors.some((value) => value.toLowerCase() !== 'n/a')) return { error: `exemplar columns must be n/a for ${category}` };
    scores[category] = {
      base: parsed[0],
      head: parsed[1],
      anchors: Object.fromEntries(anchorLabels.map((label, index) => [label, parsed[index + 2]])),
    };
  }
  if (Object.keys(scores).length === 0) return { error: 'the score table has no rows' };
  return { scores };
}

function parseComparisons(lines, scores) {
  const comparisons = {};
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const line of lines) {
    if (!/^\s*vs:/i.test(line)) continue;
    const match = /^\s*vs:\s+([^\s]+)\s+(.+)$/.exec(line);
    if (!match) return { error: `malformed vs: line "${line.trim()}"` };
    const [, category, rest] = match;
    if (!Object.hasOwn(scores, category) || Object.hasOwn(comparisons, category)) {
      return { error: `unknown or duplicate vs: category "${category}"` };
    }
    const score = scores[category];
    const labels = ['base', ...Object.keys(score.anchors)];
    const pattern = labels.map((label) => `${escape(label)}=(better|same|worse|n/a)`).join('\\s+');
    const values = new RegExp(`^${pattern}\\s+-\\s+(\\S.*)$`).exec(rest.trim());
    if (!values) return { error: `vs: ${category} needs base and every exemplar in table order, valid judgments and evidence` };
    const judgments = values.slice(1, labels.length + 1);
    for (const [index, label] of labels.entries()) {
      const compared = label === 'base' ? score.base : score.anchors[label];
      if ((judgments[index] === 'n/a') !== (score.head === null || compared === null)) {
        return { error: `vs: ${category} ${label} must use n/a exactly when a compared score is n/a` };
      }
    }
    comparisons[category] = {
      base: judgments[0],
      anchors: Object.fromEntries(labels.slice(1).map((label, index) => [label, judgments[index + 1]])),
      evidence: values[labels.length + 1].trim(),
    };
  }
  for (const category of Object.keys(scores)) {
    if (!Object.hasOwn(comparisons, category)) return { error: `missing vs: line for ${category}` };
  }
  return { comparisons };
}

/** Parses scores, comparisons, gaming, findings[{id, severity}] and resolved[], or { error }. */
export function parseCriticReply(text, options = {}) {
  const { request = '' } = options;
  const expected = options.expected ?? (Object.hasOwn(options, 'categories') || Object.hasOwn(options, 'anchors') ? options : undefined);
  const lines = text.split('\n');
  const noneProfiles = noneExemplarProfiles(request);
  const table = parseScoreTable(lines, noneProfiles);
  if (table.error) return { error: table.error };
  if (expected) {
    const error = coverageError(table.scores, expected, text, noneProfiles);
    if (error) return { error };
  }
  const relative = parseComparisons(lines, table.scores);
  if (relative.error) return { error: relative.error };
  const gaming = GAMING_LINE.exec(text);
  if (!gaming) return { error: 'no "gaming: yes|no" line' };
  const findings = [];
  for (const line of lines) {
    const match = FINDING_LINE.exec(line);
    if (match) findings.push({ id: match[1], severity: match[2] });
  }
  const resolvedLine = RESOLVED_LINE.exec(text);
  const resolved = resolvedLine ? resolvedLine[1].match(FINDING_ID) ?? [] : [];
  return { scores: table.scores, comparisons: relative.comparisons, gaming: gaming[1].toLowerCase(), findings, resolved };
}

/** Required rows come from installed lenses, never from the critic's chosen rows. */
export async function critiqueContract(profiles) {
  const categories = [];
  for (const profile of profiles) {
    const lens = await fs.readFile(profile.dir ? path.join(profile.dir, profile.critiqueLens) : profile.critiqueLens, 'utf8');
    const titles = [...lens.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm)].map((match) => match[1]);
    const scored = titles.filter((title) => !/checks.*gamed/i.test(title));
    if (!scored.length) throw new Error(`no critique categories in ${profile.kind}`);
    categories.push(...scored.map((title) => `${profile.kind}.${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`));
  }
  return categories;
}

export function coverageError(scores, expected, text = '', noneProfiles = new Set()) {
  if (!Array.isArray(expected.categories) || expected.categories.length === 0) return 'expected critique categories are missing';
  if (!Array.isArray(expected.anchors) || new Set(expected.anchors).size !== expected.anchors.length || (expected.anchors.length === 0 && expected.categories.some((category) => !noneProfiles.has(category.split('.')[0])))) return 'expected exemplar anchors are missing or duplicate';
  for (const category of expected.categories) if (!Object.hasOwn(scores, category)) return `missing required category ${category}`;
  for (const category of expected.categories) {
    for (const label of expected.anchors) if (!Object.hasOwn(scores[category].anchors ?? {}, label)) return `missing exemplar anchor ${label} in ${category}`;
  }
  for (const category of expected.categories) {
    const score = scores[category];
    if (!noneProfiles.has(category.split('.')[0]) && typeof score.head === 'number' && !expected.anchors.some((label) => typeof score.anchors[label] === 'number')) return `no scored exemplar anchor in ${category}`;
  }
  // Extra rows cannot bypass applicability evidence either.
  for (const [category, score] of Object.entries(scores)) {
    if (score.head === null && !text.split('\n').some((line) => line.startsWith(`not-applicable: ${category} - `) && line.slice(`not-applicable: ${category} - `.length).trim())) return `${category} head is n/a without a not-applicable reason`;
  }
  return null;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length < 1 || argv.length > 3 || argv[0].startsWith('-')) {
    stderr.write('usage: node critic-reply.mjs <reply.md> [expected-json] [request.md]\n');
    return EXIT.usage;
  }
  let text, request = '', expected;
  try {
    text = await fs.readFile(path.resolve(argv[0]), 'utf8');
    if (argv[1]?.trimStart().startsWith('{')) expected = JSON.parse(argv[1]);
    else if (argv[1]) request = await fs.readFile(path.resolve(argv[1]), 'utf8');
    if (argv[2]) {
      if (!expected) throw new Error('request path requires expected-json as the second argument');
      request = await fs.readFile(path.resolve(argv[2]), 'utf8');
    }
  } catch (error) {
    stderr.write(`[CRITIC-REPLY]: ${error.message}\n`);
    return EXIT.usage;
  }
  const parsed = parseCriticReply(text, { expected, request });
  stdout.write(`${JSON.stringify(parsed)}\n`);
  return parsed.error ? EXIT.unparseable : EXIT.parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { stdinArgs } = await import('./stdin-args.mjs');
  process.exitCode = await main(stdinArgs(process.argv.slice(2)));
}
