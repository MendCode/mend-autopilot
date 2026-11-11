#!/usr/bin/env node
// Publishes one finished item: pushes its branch and opens (or updates) its pull request with the
// evidence card as the body. Merge-ready items open a ready pull request, drafts a draft one with
// their reason; blocked items and items without commits are never published. It never merges,
// never force-pushes and never touches any branch but the item's own.
// usage: publish-pr.mjs --stdin   with { "args": [<json>] }, json = { worktree, branch, card (object or path), item (path), reason }
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class PublishError extends Error {
  constructor(message) {
    super(`[PUBLISH]: ${message}`);
    this.name = 'PublishError';
  }
}

const BRANCH = /^mend\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const TITLE_MAX = 72;
const SECTION_MAX = 40;

function defaultRunner(command, args, cwd) {
  try {
    const stdout = execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? '').trim(), stderr: String(error.stderr ?? error.message ?? '').trim() };
  }
}

const list = (values) => (Array.isArray(values) ? values : []).map(String).filter((value) => value && value !== 'none');
const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function titleFor(card) {
  const goal = String(card.goal ?? card.item ?? '').replace(/\s+/g, ' ').trim();
  const clipped = goal.length > TITLE_MAX ? goal.slice(0, TITLE_MAX - 1).trimEnd() + '…' : goal;
  return clipped || String(card.item);
}

/** The pull request body: what changed, what proves it and what nobody checked, from the card alone. */
export function bodyFor(card, reason) {
  const lines = [];
  const ready = card.state === 'merge-ready';
  lines.push(ready
    ? `**Merge-ready.** Every check, the review and the audit passed at \`${String(card.headSha).slice(0, 12)}\`. Merging is your call.`
    : `**Draft: not ready to merge.** ${cell(reason) || 'The item stopped before every check passed.'}`);
  if (card.risk?.tier === 'high') lines.push('', `**High risk** (${cell(card.risk.rule)}): read the change yourself before merging.`);
  lines.push('', '### Goal', '', String(card.goal ?? ''));
  const checks = (Array.isArray(card.checks) ? card.checks : []).slice(0, SECTION_MAX);
  if (checks.length) {
    lines.push('', '### Checks', '', '| Command | Exit |', '|---|---|');
    for (const entry of checks) lines.push(`| \`${cell(entry.command)}\` | ${cell(entry.exit)} |`);
  }
  if (card.redGreen) lines.push('', '### Regression', '', `\`${cell(card.redGreen.command)}\` fails at base (exit ${cell(card.redGreen.baseExit)}) and passes at head (exit ${cell(card.redGreen.headExit)}).`);
  const lanes = (Array.isArray(card.auditLanes) ? card.auditLanes : []).slice(0, SECTION_MAX);
  lines.push('', '### Review and audit', '');
  if (card.review?.verdict) lines.push(`- Review by the strong model: **${cell(card.review.verdict)}**`);
  if (card.verdict?.result) lines.push(`- Auditor in its own session: **${cell(card.verdict.result)}**`);
  for (const lane of lanes) lines.push(`  - ${cell(lane.lane)}: ${cell(lane.result)} (${cell(lane.method)})`);
  const flags = (Array.isArray(card.integrity?.flags) ? card.integrity.flags : []).filter((flag) => flag?.severity === 'block');
  lines.push(`- Integrity scan: ${flags.length ? `${flags.length} blocking flag(s)` : 'nothing flagged'}`);
  const notVerified = list(card.notVerified).slice(0, SECTION_MAX);
  if (notVerified.length) {
    lines.push('', '### Not verified', '');
    for (const entry of notVerified) lines.push(`- ${cell(entry)}`);
  }
  lines.push('', `Risk: ${cell(card.risk?.tier ?? 'unknown')}. Rollback: ${cell(card.rollback ?? 'revert the merge commit')}.`);
  lines.push('', `<sub>Made by [mend-autopilot](https://github.com/MendCode/mend-autopilot): a cheap model wrote the change, a strong model reviewed and audited it, programs ran the checks. The full card is \`.mend/evidence/${cell(card.item)}.json\` in the worktree.</sub>`);
  return lines.join('\n');
}

function baseBranch({ worktree, run }) {
  const remote = run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], worktree);
  if (remote.ok && remote.stdout.startsWith('origin/')) return remote.stdout.slice('origin/'.length);
  const viewed = run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], worktree);
  return viewed.ok && viewed.stdout ? viewed.stdout : null;
}

/**
 * Returns { published, state, url?, reason }. `published: false` with a reason is a normal outcome
 * (no remote, no GitHub login, a blocked item), not an error.
 */
export function publish({ worktree, branch, card, reason = '' }, run = defaultRunner) {
  if (typeof worktree !== 'string' || !worktree.startsWith('/')) throw new PublishError('worktree must be an absolute path');
  if (typeof branch !== 'string' || !BRANCH.test(branch)) throw new PublishError('branch must be mend/<item id>');
  if (!card || typeof card !== 'object') throw new PublishError('card is required');
  const skip = (why) => ({ published: false, state: card.state, reason: why });

  if (!['merge-ready', 'draft'].includes(card.state)) return skip(`the item is ${card.state}; only merge-ready and draft items are published`);
  if (!/^[0-9a-f]{40}$/.test(String(card.headSha ?? '')) || card.headSha === card.baseSha) return skip('the item has no commits to publish');
  const head = run('git', ['rev-parse', 'HEAD'], worktree);
  if (!head.ok || head.stdout !== card.headSha) return skip('the worktree head is not the head on the card');
  const current = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], worktree);
  if (!current.ok || current.stdout !== branch) return skip(`the worktree is not on ${branch}`);
  if (!run('git', ['remote', 'get-url', 'origin'], worktree).ok) return skip('the repository has no origin remote');
  if (!run('gh', ['auth', 'status'], worktree).ok) return skip('GitHub CLI is not logged in; run `gh auth login` and publish again');
  const base = baseBranch({ worktree, run });
  if (!base) return skip('could not find the default branch of origin');

  const pushed = run('git', ['push', '--set-upstream', 'origin', `${branch}:refs/heads/${branch}`], worktree);
  if (!pushed.ok) return skip(`git push refused: ${pushed.stderr.slice(-300)}`);

  const title = titleFor(card);
  const body = bodyFor(card, reason);
  const existing = run('gh', ['pr', 'view', branch, '--json', 'url,state,isDraft', '--jq', '[.url,.state,(.isDraft|tostring)]|join(" ")'], worktree);
  const [url, prState, isDraft] = existing.ok ? existing.stdout.split(' ') : [];
  if (url && prState === 'OPEN') {
    const edited = run('gh', ['pr', 'edit', branch, '--title', title, '--body', body], worktree);
    if (!edited.ok) return { published: true, state: card.state, url, reason: `pushed; the description could not be updated: ${edited.stderr.slice(-200)}` };
    if (card.state === 'merge-ready' && isDraft === 'true') run('gh', ['pr', 'ready', branch], worktree);
    return { published: true, state: card.state, url, reason: 'pushed to the open pull request and updated its description' };
  }
  const created = run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body, ...(card.state === 'draft' ? ['--draft'] : [])], worktree);
  if (!created.ok) return skip(`pushed ${branch}, but the pull request could not be opened: ${created.stderr.slice(-300)}`);
  return { published: true, state: card.state, url: created.stdout.split('\n').pop(), reason: card.state === 'draft' ? 'opened as a draft pull request' : 'opened the pull request' };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--stdin') ({ args } = JSON.parse(readFileSync(0, 'utf8')));
    if (!Array.isArray(args) || args.length !== 1) throw new PublishError('usage: publish-pr.mjs --stdin with one JSON argument');
    const input = JSON.parse(args[0]);
    const card = typeof input.card === 'string' ? JSON.parse(readFileSync(input.card, 'utf8')) : input.card;
    // A draft that never reached the card step carries only its ids; the item supplies the goal and risk.
    if (card && typeof input.item === 'string' && !card.goal) {
      const item = JSON.parse(readFileSync(input.item, 'utf8'));
      card.goal = item.goal;
      card.risk = card.risk ?? { tier: item.risk ?? 'unknown', rule: "the item's declared risk" };
    }
    console.log(JSON.stringify(publish({ worktree: input.worktree, branch: input.branch, card, reason: input.reason })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
