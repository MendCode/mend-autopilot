// Every claim on the evidence card is backed by something a reader can open:
// each check has a log with the command and the exit code it claims, every SHA is the verified head,
// and every integrity flag still present is countersigned.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const EXIT_LINE = /^exit: (-?\d+)\s*$/gm;
const EVIDENCE_DIR = path.join('.mend', 'evidence');

function lastExit(log) {
  let match;
  let found = null;
  EXIT_LINE.lastIndex = 0;
  while ((match = EXIT_LINE.exec(log)) !== null) found = Number(match[1]);
  return found;
}

function flagKey(flag) {
  return `${flag.rule} ${flag.file}:${flag.line}`;
}

async function checkFailures(card, readLog) {
  const failures = [];
  for (const check of card.checks ?? []) {
    const target = `check ${check.name}`;
    if (!check.log) {
      failures.push({ target, rule: 'check-log-missing', detail: 'no log path, so the claimed exit cannot be confirmed' });
      continue;
    }
    const log = await readLog(check.log);
    if (log === null) {
      failures.push({ target, rule: 'check-log-missing', detail: `${check.log} does not exist` });
      continue;
    }
    if (!log.split('\n').some((line) => line.trim() === `$ ${check.command}`)) {
      failures.push({ target, rule: 'check-command-mismatch', detail: `${check.log} has no line "$ ${check.command}"` });
    }
    const logged = lastExit(log);
    if (logged === null) failures.push({ target, rule: 'check-exit-mismatch', detail: `${check.log} has no "exit: N" line` });
    else if (logged !== check.exit) failures.push({ target, rule: 'check-exit-mismatch', detail: `card says exit ${check.exit}, log says exit ${logged}` });
  }
  return failures;
}

function shaFailures(card, headSha) {
  const failures = [];
  if (headSha && card.headSha !== headSha) {
    failures.push({ target: 'headSha', rule: 'head-sha', detail: `card names ${card.headSha}, the branch head is ${headSha}` });
  }
  if (card.verdict?.sha !== card.headSha) {
    failures.push({ target: 'verdict', rule: 'verdict-sha', detail: `verdict is for ${card.verdict?.sha}, card head is ${card.headSha}` });
  }
  for (const lane of card.auditLanes ?? []) {
    if (lane.sha !== card.headSha) failures.push({ target: `lane ${lane.lane}`, rule: 'lane-sha', detail: `lane ran on ${lane.sha}, card head is ${card.headSha}` });
  }
  return failures;
}

function countersignFailures(card) {
  const failures = [];
  const integrity = card.integrity ?? { flags: [], countersigned: [] };
  const accepted = new Set((integrity.countersigned ?? []).map(flagKey));
  const signed = new Set((card.countersigns ?? []).filter((entry) => entry.kind === 'integrity-flag').map((entry) => entry.subject));
  for (const flag of integrity.flags ?? []) {
    if (flag.severity === 'warn') continue;
    const key = flagKey(flag);
    if (!accepted.has(key)) failures.push({ target: key, rule: 'flag-uncountersigned', detail: 'blocking integrity flag is not listed in integrity.countersigned' });
    else if (!signed.has(key)) failures.push({ target: key, rule: 'flag-uncountersigned', detail: 'listed as countersigned but no countersigns entry names it' });
  }
  return failures;
}

export async function evaluate({ card, headSha, readLog }) {
  if (!card || typeof card !== 'object') {
    return { pass: false, failures: [{ target: '(card)', rule: 'card-missing', detail: 'no evidence card to check' }] };
  }
  const failures = [...(await checkFailures(card, readLog)), ...shaFailures(card, headSha), ...countersignFailures(card)];
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
  id: 'card-claims',
  needsCard: true,
  needsFinalCard: true,
  description: 'Card checks have logs that show the claimed command and exit; all SHAs are the head; integrity flags are countersigned.',
  async run({ repo, item, headSha, card }) {
    let evidence = card;
    if (!evidence && item?.id) {
      const text = await readOrNull(path.join(repo, EVIDENCE_DIR, `${item.id}.json`));
      evidence = text === null ? null : JSON.parse(text);
    }
    const readLog = async (relative) => {
      const file = insideRepo(repo, relative);
      return file ? readOrNull(file) : null;
    };
    return evaluate({ card: evidence, headSha, readLog });
  },
  async runFixture(fixture) {
    const logs = fixture.logs ?? {};
    return evaluate({ card: fixture.card, headSha: fixture.headSha, readLog: async (name) => (name in logs ? logs[name] : null) });
  },
};
