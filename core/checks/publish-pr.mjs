#!/usr/bin/env node
// Publishes one finished item: pushes its branch and opens (or updates) its pull request with the
// evidence card as the body. Merge-ready items open a ready pull request, drafts a draft one with
// their reason; blocked items and items without commits are never published. It never merges,
// never force-pushes and never touches any branch but the item's own.
// usage: publish-pr.mjs --stdin   with { "args": [<json>] }, json = { worktree, branch, card (object or path), item (path), reason }
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
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

/** The item's own title, else the goal's first sentence without links, cut at a word. */
export function titleFor(card) {
  const own = typeof card.title === 'string' ? card.title.replace(/\s+/g, ' ').trim() : '';
  const goal = own || String(card.goal ?? card.item ?? '')
    .replace(/https?:\/\/\S+/g, '').replace(/\(\s*[^()]*?\s*\)/g, (group) => (/\w/.test(group.slice(1, -1)) ? group : ''))
    .replace(/\s+/g, ' ').trim().split(/(?<=[.:;])\s/)[0].replace(/[.:;]$/, '');
  if (goal.length <= TITLE_MAX) return goal || String(card.item);
  const cut = goal.slice(0, TITLE_MAX - 1);
  return (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[\s,(]+$/, '') + '…';
}

/** Absolute paths of the user's machine never reach a pull request: the worktree and the repository become `.`, the home `~`. */
export function withoutLocalPaths(text, { worktree, home = homedir() }) {
  const roots = [worktree, String(worktree).split('/.mend/worktrees/')[0]].filter((root) => typeof root === 'string' && root.startsWith('/'));
  let clean = String(text);
  for (const root of [...new Set(roots)].sort((a, b) => b.length - a.length)) clean = clean.split(root + '/').join('').split(root).join('.');
  return home && home.length > 1 ? clean.split(home + '/').join('~/').split(home).join('~') : clean;
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

const WRITE = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);
const slugOf = (url) => /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim())?.[1] ?? null;

/**
 * Where the branch goes: origin when the user can push there (or GitHub cannot say), else the user's fork of it.
 * A fork is never created here; without one the item is left unpublished with the command that makes it.
 */
function pushTarget({ worktree, run }) {
  const upstream = slugOf(run('git', ['remote', 'get-url', 'origin'], worktree).stdout);
  if (!upstream) return { remote: 'origin', upstream: null, repo: null };
  const permission = run('gh', ['repo', 'view', upstream, '--json', 'viewerPermission', '--jq', '.viewerPermission'], worktree);
  if (!permission.ok || WRITE.has(permission.stdout)) return { remote: 'origin', upstream, repo: upstream };
  const login = run('gh', ['api', 'user', '--jq', '.login'], worktree);
  if (!login.ok || !login.stdout) return { problem: `you cannot push to ${upstream} and your GitHub login could not be read` };
  const fork = `${login.stdout}/${upstream.split('/')[1]}`;
  const parent = run('gh', ['repo', 'view', fork, '--json', 'parent', '--jq', '.parent.owner.login+"/"+.parent.name'], worktree);
  if (!parent.ok || parent.stdout.toLowerCase() !== upstream.toLowerCase()) return { problem: `you cannot push to ${upstream} and have no fork of it at ${fork}; fork it (gh repo fork ${upstream} --clone=false) and publish again` };
  return { remote: `https://github.com/${fork}.git`, upstream, repo: fork, owner: login.stdout };
}

/**
 * The pull request's base. An item started from the default branch targets it. One started from another branch (an
 * open pull request's branch, say) targets that branch, so its pull request shows only the item's own commits.
 */
function stackBase({ worktree, run, baseSha, base, target }) {
  run('git', ['fetch', '--quiet', 'origin', base], worktree);
  if (run('git', ['merge-base', '--is-ancestor', baseSha, `origin/${base}`], worktree).ok) return {};
  const places = [[target.remote, target.repo], ...(target.remote === 'origin' ? [] : [['origin', target.upstream]])];
  for (const [remote, repo] of places) {
    const heads = run('git', ['ls-remote', '--heads', remote], worktree);
    const match = heads.ok ? heads.stdout.split('\n').map((line) => line.split('\t')).find(([sha, ref]) => sha === baseSha && ref && !ref.startsWith('refs/heads/mend/')) : undefined;
    if (match) return { branch: match[1].slice('refs/heads/'.length), repo };
  }
  return { problem: `the item starts from ${String(baseSha).slice(0, 10)}, which is not on ${base} and is the tip of no pushed branch; push the branch it starts from, or start the item from ${base}` };
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

  const target = pushTarget({ worktree, run });
  if (target.problem) return skip(target.problem);
  const stacked = stackBase({ worktree, run, baseSha: card.baseSha, base, target });
  if (stacked.problem) return skip(stacked.problem);

  const pushed = run('git', ['push', '--set-upstream', target.remote, `${branch}:refs/heads/${branch}`], worktree);
  if (!pushed.ok) return skip(`git push refused: ${pushed.stderr.slice(-300)}`);

  const title = titleFor(card);
  const body = withoutLocalPaths(bodyFor(card, reason), { worktree });
  const prRepo = stacked.repo ?? target.upstream;
  const headRef = target.owner && prRepo !== target.repo ? `${target.owner}:${branch}` : branch;
  const repoArgs = prRepo ? ['--repo', prRepo] : [];
  const existing = target.owner
    ? run('gh', ['pr', 'list', ...repoArgs, '--head', branch, '--state', 'open', '--json', 'url,isDraft,headRepositoryOwner', '--jq', `[.[]|select(.headRepositoryOwner.login=="${target.owner}")][0]|[.url,"OPEN",(.isDraft|tostring)]|join(" ")`], worktree)
    : run('gh', ['pr', 'view', branch, ...repoArgs, '--json', 'url,state,isDraft', '--jq', '[.url,.state,(.isDraft|tostring)]|join(" ")'], worktree);
  const [url, prState, isDraft] = existing.ok ? existing.stdout.split(' ') : [];
  if (url && prState === 'OPEN') {
    const edited = run('gh', ['pr', 'edit', url, '--title', title, '--body', body], worktree);
    if (!edited.ok) return { published: true, state: card.state, url, reason: `pushed; the description could not be updated: ${edited.stderr.slice(-200)}` };
    if (card.state === 'merge-ready' && isDraft === 'true') run('gh', ['pr', 'ready', url], worktree);
    return { published: true, state: card.state, url, reason: 'pushed to the open pull request and updated its description' };
  }
  const created = run('gh', ['pr', 'create', ...repoArgs, '--base', stacked.branch ?? base, '--head', headRef, '--title', title, '--body', body, ...(card.state === 'draft' ? ['--draft'] : [])], worktree);
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
    if (card && typeof input.item === 'string') {
      const item = JSON.parse(readFileSync(input.item, 'utf8'));
      if (typeof item.title === 'string' && item.title.trim()) card.title = item.title;
      if (!card.goal) {
        card.goal = item.goal;
        card.risk = card.risk ?? { tier: item.risk ?? 'unknown', rule: "the item's declared risk" };
      }
    }
    console.log(JSON.stringify(publish({ worktree: input.worktree, branch: input.branch, card, reason: input.reason })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
