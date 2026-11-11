#!/usr/bin/env node
// Pure review calculations. The workflow retains the ledger, approvals and
// retry ordering; the CLI returns data, never edits state or runs commands.
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globToRegExp } from './integrity.mjs';

export function anchorDrift({ scores, firstScores, driftTolerance }) {
  if (!firstScores) return null;
  for (const [category, score] of Object.entries(scores)) {
    for (const [label, value] of Object.entries(score.anchors ?? {})) {
      const before = firstScores[category]?.anchors?.[label];
      if (typeof before === 'number' && typeof value === 'number' && Math.abs(value - before) > Number(driftTolerance)) {
        return category + ' anchor ' + label + ' moved from ' + before + ' to ' + value;
      }
    }
  }
  return null;
}

export function critiqueVerdict({ parsed, threshold, findings }) {
  const reasons = [];
  for (const [category, score] of Object.entries(parsed.scores)) {
    // Coverage validation requires a concrete reason for every n/a head.
    if (score.head !== null && (typeof score.head !== 'number' || score.head < threshold)) reasons.push(category + ' head ' + score.head + ' does not meet the bar');
    const comparison = parsed.comparisons[category];
    if (comparison.base === 'worse') reasons.push(category + ' head is worse than base');
    for (const [label, judgment] of Object.entries(comparison.anchors)) {
      if (judgment === 'worse') reasons.push(category + ' head is worse than exemplar ' + label);
    }
  }
  if (parsed.gaming === 'yes') reasons.push('the critic found the change games its checks');
  for (const finding of findings) {
    if (['blocker', 'should'].includes(finding.severity)) reasons.push(finding.id + ' [' + finding.severity + '] is ' + finding.status);
  }
  return reasons;
}

function normalizedInputPath(file) {
  if (typeof file !== 'string' || file.startsWith('/')) return file;
  const parts = [];
  for (const part of file.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

export function proposalInputs({ withProposal, evidenceDir, approvedProposals, planInputs }) {
  const selected = [];
  for (const profile of withProposal) {
    for (const input of profile.proposalArtifact.inputs ?? []) selected.push({ ...input, path: evidenceDir + '/' + input.path });
  }
  const uniqueSelected = selected.filter((input, index) => selected.findIndex((other) => normalizedInputPath(other.path) === normalizedInputPath(input.path) && other.field === input.field) === index);
  return [...uniqueSelected, ...approvedProposals.filter((file) => !uniqueSelected.some((input) => normalizedInputPath(input.path) === normalizedInputPath(file))).map((file) => ({ path: file })), ...planInputs];
}

export function exemplarProblem({ exemplars, profiles, editSet = [] }) {
  const nonempty = (value) => typeof value === 'string' && value.trim();
  if (!Array.isArray(exemplars) || exemplars.length === 0 || exemplars.some((entry) => !nonempty(entry.label) || !nonempty(entry.path)) || new Set(exemplars.map((entry) => entry.label)).size !== exemplars.length) {
    return 'exemplar labels and paths are required and labels must be unique';
  }
  // An anchor the item edits changes between rounds, so it can no longer anchor a score.
  const scope = (Array.isArray(editSet) ? editSet : []).map(String).map(globToRegExp);
  const edited = exemplars.filter((entry) => scope.some((glob) => glob.test(entry.path.replace(/^\.\//, ''))));
  if (edited.length) return 'exemplars must be files this item does not edit; replace ' + edited.map((entry) => entry.path).join(', ') + ' with an untouched file of the same kind';
  for (const profile of profiles) {
    const count = exemplars.filter((entry) => !entry.profiles || entry.profiles.includes(profile.kind)).length;
    if (count < (profile.exemplars?.min ?? 1) || count > (profile.exemplars?.max ?? 3)) return 'exemplar count is outside the profile contract for ' + profile.kind;
  }
  return null;
}

export function finalEvidence({ profiles, scores, accepted, proposalEvidence }) {
  const critiqueScores = {};
  const profileEvidence = {};
  for (const profile of profiles) {
    const heads = Object.entries(scores).filter(([category, score]) => category.startsWith(profile.kind + '.') && typeof score.head === 'number').map(([, score]) => score.head);
    critiqueScores[profile.kind] = heads.length ? Math.min(...heads) : null;
    const evidence = { ...(accepted.profileEvidence?.[profile.kind] ?? {}) };
    const proposal = proposalEvidence[profile.kind];
    if (profile.proposalArtifact && proposal) {
      evidence.approvedProposal = proposal.approvedProposal;
      if (Object.hasOwn(proposal, 'exemplarPairs')) evidence.exemplarPairs = proposal.exemplarPairs;
      else delete evidence.exemplarPairs;
    }
    profileEvidence[profile.kind] = evidence;
  }
  return { critiqueScores, profileEvidence };
}

export function main(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  try {
    if (argv.length !== 2) throw new Error('usage: quality-review.mjs <drift|verdict|inputs|exemplars|final> <json>');
    const data = JSON.parse(argv[1]);
    let result;
    if (argv[0] === 'drift') result = anchorDrift(data);
    else if (argv[0] === 'verdict') result = critiqueVerdict(data);
    else if (argv[0] === 'inputs') result = proposalInputs(data);
    else if (argv[0] === 'exemplars') result = exemplarProblem(data);
    else if (argv[0] === 'final') result = finalEvidence(data);
    else throw new Error('unknown review operation: ' + argv[0]);
    stdout.write(JSON.stringify({ result }) + '\n');
    return 0;
  } catch (error) {
    stderr.write('[QUALITY-REVIEW]: ' + error.message + '\n');
    return 64;
  }
}

// Node canonicalizes the module URL, but argv may retain a symlinked path.
function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--stdin') {
    const { readFileSync } = await import('node:fs');
    process.exitCode = main(JSON.parse(readFileSync(0, 'utf8')).args);
  } else process.exitCode = main(argv);
}
