// The critique result on the card is backed by the critic's stored replies: every score matches the
// reply's score table, every finding a reply raised is on the ledger, a finding is resolved only when a
// later reply says so, and exemplar anchors stay put between rounds. Ready cards also need the last
// counted round to clear the threshold and not be worse than the base or any exemplar, with no blocker or should left open.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { noneExemplarProfiles, parseCriticReply, critiqueContract, coverageError } from '../../../checks/critic-reply.mjs';

export { parseCriticReply };

const EVIDENCE_DIR = path.join('.mend', 'evidence');
const READY_STATES = new Set(['ready', 'merge-ready', 'merged']);
const BLOCKING = new Set(['blocker', 'should']);
const NEEDS_REASON = new Set(['declined', 'disputed']);
const DEFAULT_THRESHOLD = 7;
const DEFAULT_DRIFT_TOLERANCE = 1;
const PROFILES_DIR = fileURLToPath(new URL('../../', import.meta.url));

async function coverageFailures(profiles, last) {
  const failures = [];
  for (const profile of profiles ?? []) {
    if (profile.skipped) continue;
    const kind = profile.kind;
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]*$/.test(kind)) {
      failures.push({ target: 'profile', rule: 'critique-missing', detail: 'invalid profile kind' });
      continue;
    }
    let categories;
    try {
      const lens = await fs.readFile(path.join(PROFILES_DIR, kind, 'critique-lens.md'), 'utf8');
      const marker = /^<!-- critique-categories: ([a-z0-9 -]+) -->$/m.exec(lens);
      categories = marker ? marker[1].trim().split(/\s+/).map((name) => `${kind}.${name}`)
        : await critiqueContract([{ kind, critiqueLens: path.join(PROFILES_DIR, kind, 'critique-lens.md') }]);
      if (!categories?.length || new Set(categories).size !== categories.length) throw new Error('missing or invalid category declaration');
    } catch (error) {
      failures.push({ target: `profile ${kind}`, rule: 'critique-missing', detail: `cannot read critique categories: ${error.message}` });
      continue;
    }
    for (const category of categories) {
      if (!Object.hasOwn(last.scores ?? {}, category)) failures.push({ target: `profile ${kind}`, rule: 'critique-missing', detail: `missing required category ${category}` });
    }
  }
  return failures;
}

function sameScore(left, right) {
  return (left ?? null) === (right ?? null);
}

function scoreMismatches(cardScores, replyScores) {
  const mismatches = [];
  const categories = new Set([...Object.keys(cardScores ?? {}), ...Object.keys(replyScores)]);
  for (const category of categories) {
    const card = cardScores?.[category];
    const reply = replyScores[category];
    if (!card || !reply) {
      mismatches.push(`${category} is ${card ? 'not in the reply' : 'missing from the card'}`);
      continue;
    }
    for (const side of ['base', 'head']) {
      if (!sameScore(card[side], reply[side])) mismatches.push(`${category} ${side}: card ${card[side] ?? 'n/a'}, reply ${reply[side] ?? 'n/a'}`);
    }
    const labels = new Set([...Object.keys(card.anchors ?? {}), ...Object.keys(reply.anchors)]);
    for (const label of labels) {
      if (!Object.hasOwn(card.anchors ?? {}, label) || !Object.hasOwn(reply.anchors, label) || !sameScore(card.anchors?.[label], reply.anchors[label])) {
        mismatches.push(`${category} anchor ${label}: card ${card.anchors?.[label] ?? 'n/a'}, reply ${reply.anchors[label] ?? 'n/a'}`);
      }
    }
  }
  return mismatches;
}

async function readRounds(critique, readLog) {
  const failures = [];
  const replies = [];
  for (const round of critique.rounds ?? []) {
    const target = `critique round ${round.round}`;
    const text = round.log ? await readLog(round.log) : null;
    if (text === null) {
      failures.push({ target, rule: 'critique-log-missing', detail: round.log ? `${round.log} does not exist` : 'no stored critic reply' });
      continue;
    }
    const request = round.request ? await readLog(round.request) : null;
    const reply = parseCriticReply(text, { request: request ?? '' });
    if (reply.error) {
      failures.push({ target, rule: 'score-unbacked', detail: `${round.log}: ${reply.error}` });
      continue;
    }
    for (const mismatch of scoreMismatches(round.scores, reply.scores)) failures.push({ target, rule: 'score-unbacked', detail: mismatch });
    if (round.gaming !== reply.gaming) failures.push({ target, rule: 'score-unbacked', detail: `card says gaming ${round.gaming}, reply says ${reply.gaming}` });
    replies.push({ round, reply, text, request });
  }
  return { failures, replies };
}

function ledgerFailures(findings, replies) {
  const failures = [];
  const ledger = new Map((findings ?? []).map((finding) => [finding.id, finding]));
  const raised = new Map();
  const resolvedIn = new Map();
  for (const { round, reply } of replies) {
    for (const finding of reply.findings) if (!raised.has(finding.id)) raised.set(finding.id, { ...finding, round: round.round });
    for (const id of reply.resolved) if (!resolvedIn.has(id)) resolvedIn.set(id, round.round);
  }
  for (const [id, finding] of raised) {
    const entry = ledger.get(id);
    if (!entry) failures.push({ target: id, rule: 'finding-dropped', detail: `round ${finding.round} raised ${id} [${finding.severity}] and the card ledger does not list it` });
    else if (entry.severity !== finding.severity) {
      failures.push({ target: id, rule: 'finding-dropped', detail: `the reply says ${finding.severity}, the card says ${entry.severity}; decline with a reason instead of relabelling` });
    }
  }
  for (const entry of findings ?? []) {
    if (NEEDS_REASON.has(entry.status) && !entry.reason?.trim()) {
      failures.push({ target: entry.id, rule: 'finding-unreasoned', detail: `${entry.status} without a written reason` });
    }
    if (entry.status === 'resolved') {
      const round = resolvedIn.get(entry.id);
      if (round === undefined || round <= entry.round) {
        failures.push({ target: entry.id, rule: 'resolution-unbacked', detail: 'marked resolved but no later critic reply lists it as resolved' });
      }
    }
  }
  return failures;
}

function anchorDrift(counted, tolerance) {
  const failures = [];
  if (counted.length < 2) return failures;
  const first = counted[0];
  for (const round of counted.slice(1)) {
    for (const [category, score] of Object.entries(round.scores ?? {})) {
      for (const [label, value] of Object.entries(score.anchors ?? {})) {
        const before = first.scores?.[category]?.anchors?.[label];
        if (typeof value !== 'number' || typeof before !== 'number') continue;
        if (Math.abs(value - before) > tolerance) {
          failures.push({
            target: `critique round ${round.round}`,
            rule: 'anchor-drift',
            detail: `${category} anchor ${label} moved from ${before} to ${value} (tolerance ${tolerance}); void the round and rerun with a fresh critic`,
          });
        }
      }
    }
  }
  return failures;
}

function lowestHead(scores, kind) {
  const heads = Object.entries(scores ?? {})
    .filter(([category, score]) => category.startsWith(`${kind}.`) && typeof score.head === 'number')
    .map(([, score]) => score.head);
  return heads.length === 0 ? null : Math.min(...heads);
}

function profileScoreFailures(profiles, last, ready) {
  const failures = [];
  for (const profile of profiles ?? []) {
    if (profile.skipped || !profile.critique) continue;
    const lowest = lowestHead(last.scores, profile.kind);
    if (lowest === null) {
      if (ready) failures.push({ target: `profile ${profile.kind}`, rule: 'critique-missing', detail: `the last round scores no "${profile.kind}." category` });
      continue;
    }
    if (profile.critique.score !== lowest) {
      failures.push({ target: `profile ${profile.kind}`, rule: 'score-unbacked', detail: `profile score ${profile.critique.score}, lowest ${profile.kind} head in round ${last.round} is ${lowest}` });
    }
  }
  return failures;
}

function readyFailures(critique, last, reply, request) {
  const failures = [];
  const threshold = Math.max(DEFAULT_THRESHOLD, critique.threshold ?? DEFAULT_THRESHOLD);
  const target = `critique round ${last.round}`;
  const noneProfiles = noneExemplarProfiles(request ?? '');
  if (reply && Object.entries(reply.scores).some(([category, score]) => typeof score.head === 'number' && !noneProfiles.has(category.split('.')[0])) && !Object.entries(reply.scores).some(([category, score]) =>
    typeof score.head === 'number' && Object.entries(score.anchors).some(([label, value]) =>
      typeof value === 'number' && ['better', 'same', 'worse'].includes(reply.comparisons[category]?.anchors[label])))) {
    failures.push({ target, rule: 'exemplar-missing', detail: 'the stored reply has no scored comparison with an exemplar' });
  }
  for (const [category, score] of Object.entries(last.scores ?? {})) {
    // Coverage validation checks n/a justifications against the stored reply.
    if (score.head !== null && (typeof score.head !== 'number' || score.head < threshold)) failures.push({ target, rule: 'below-threshold', detail: `${category} head ${score.head ?? 'n/a'} does not meet ${threshold}` });
    const comparison = reply?.comparisons[category];
    if (comparison?.base === 'worse') {
      failures.push({ target, rule: 'below-base', detail: `${category} head is worse than base: ${comparison.evidence}` });
    }
    for (const [label, judgment] of Object.entries(comparison?.anchors ?? {})) {
      if (judgment === 'worse') failures.push({ target, rule: 'below-exemplar', detail: `${category} head is worse than exemplar ${label}: ${comparison.evidence}` });
    }
  }
  if (last.gaming === 'yes') failures.push({ target, rule: 'gaming', detail: 'the critic found the change games its checks' });
  for (const finding of critique.findings ?? []) {
    if (BLOCKING.has(finding.severity) && (finding.status === 'open' || finding.status === 'disputed')) {
      failures.push({ target: finding.id, rule: 'finding-open', detail: `${finding.severity} finding is ${finding.status}` });
    }
  }
  return failures;
}

export async function evaluate({ card, readLog, expected }) {
  if (!card || typeof card !== 'object') return { pass: true, failures: [] };
  const ready = READY_STATES.has(card.state);
  const critique = card.critique;
  const critiqued = (card.profiles ?? []).some((profile) => !profile.skipped);
  if (!critique || !Array.isArray(critique.rounds) || critique.rounds.length === 0) {
    const failures = ready && critiqued ? [{ target: 'critique', rule: 'critique-missing', detail: 'a ready card needs at least one stored critique round' }] : [];
    return { pass: failures.length === 0, failures };
  }
  const { failures, replies } = await readRounds(critique, readLog);
  failures.push(...ledgerFailures(critique.findings, replies));
  const counted = critique.rounds.filter((round) => !round.void);
  failures.push(...anchorDrift(counted, critique.driftTolerance ?? DEFAULT_DRIFT_TOLERANCE));
  const last = counted.at(-1);
  if (!last) {
    if (ready) failures.push({ target: 'critique', rule: 'critique-missing', detail: 'every round is void' });
  } else {
    failures.push(...profileScoreFailures(card.profiles, last, ready));
    if (ready) {
      if (!expected) failures.push(...await coverageFailures(card.profiles, last));
      const stored = replies.find((entry) => entry.round === last);
      failures.push(...readyFailures(critique, last, stored?.reply, stored?.request));
      try {
        const categories = expected ? expected.categories : await critiqueContract(
          (card.profiles ?? []).filter((profile) => !profile.skipped).map((profile) => ({ kind: profile.kind, critiqueLens: fileURLToPath(new URL(`../../${profile.kind}/critique-lens.md`, import.meta.url)) })),
        );
        const anchors = expected?.anchors ?? [...new Set(Object.values(counted[0].scores ?? {}).flatMap((score) => Object.keys(score.anchors ?? {})))];
        for (const entry of replies.filter((entry) => !entry.round.void)) {
          const error = coverageError(entry.reply.scores, { categories, anchors }, entry.text, noneExemplarProfiles(entry.request ?? ''));
          if (error) failures.push({ target: `critique round ${entry.round.round}`, rule: 'critique-coverage', detail: error });
        }
      } catch (error) {
        failures.push({ target: 'critique', rule: 'critique-coverage', detail: error.message });
      }
    }
  }
  return { pass: failures.length === 0, failures };
}

async function readOrNull(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function insideRepo(repo, relative) {
  const root = path.resolve(repo);
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

export default {
  id: 'critique-ledger',
  needsCard: true,
  needsFinalCard: true,
  description: 'Critique scores, gaming answers and findings match stored replies; ready cards score at least 7 and are not worse than base or any exemplar, with no blocker or should open.',
  async run({ repo, item, card }) {
    let evidence = card;
    if (!evidence && item?.id) {
      const text = await readOrNull(path.join(repo, EVIDENCE_DIR, `${item.id}.json`));
      evidence = text === null ? null : JSON.parse(text);
    }
    const readLog = async (relative) => {
      const file = insideRepo(repo, relative);
      return file ? readOrNull(file) : null;
    };
    const qualityText = item?.id ? await readOrNull(path.join(repo, EVIDENCE_DIR, item.id, 'quality.json')) : null;
    const quality = qualityText ? JSON.parse(qualityText) : null;
    // mend-pr verifies the receipt for quality.json before and after this check. Reuse its
    // resolved plan rather than deriving a different contract from default lens paths.
    return evaluate({ card: evidence, readLog, expected: quality ? {
      categories: quality.plan?.critiqueCategories,
      anchors: (quality.exemplars ?? []).map((entry) => entry.label),
    } : undefined });
  },
  async runFixture(fixture) {
    const logs = fixture.logs ?? {};
    return evaluate({ card: fixture.card, readLog: async (name) => (name in logs ? logs[name] : null), expected: fixture.contract });
  },
};
