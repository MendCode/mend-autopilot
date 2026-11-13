import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish, bodyFor, titleFor, PublishError } from './publish-pr.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const card = (extra = {}) => ({
  item: 'login-case', goal: 'Sign-in accepts an email in any letter case', state: 'merge-ready', headSha: HEAD, baseSha: BASE,
  risk: { tier: 'low', rule: 'declared' }, checks: [{ command: 'bun test', exit: 0 }],
  redGreen: { command: 'bun test tests/login.test.ts', baseExit: 1, headExit: 0 },
  review: { verdict: 'merge' }, verdict: { result: 'PASS' }, auditLanes: [{ lane: 'login', result: 'PASS', method: 'drove the endpoint' }],
  integrity: { flags: [] }, notVerified: ['browser rendering'], rollback: 'revert the merge commit', ...extra,
});

/** A fake git/gh that answers from a table and records every call. */
function fakeRunner(overrides = {}) {
  const calls = [];
  const answers = {
    'git rev-parse HEAD': { ok: true, stdout: HEAD },
    'git rev-parse --abbrev-ref HEAD': { ok: true, stdout: 'mend/login-case' },
    'git remote get-url origin': { ok: true, stdout: 'git@github.com:acme/app.git' },
    'gh auth status': { ok: true, stdout: '' },
    'git symbolic-ref --quiet --short refs/remotes/origin/HEAD': { ok: true, stdout: 'origin/main' },
    'git fetch': { ok: true, stdout: '' },
    'git merge-base --is-ancestor': { ok: true, stdout: '' },
    'git push': { ok: true, stdout: '' },
    'gh pr view': { ok: false, stdout: '', stderr: 'no pull requests found' },
    'gh pr create': { ok: true, stdout: 'https://github.com/acme/app/pull/7' },
    'gh pr edit': { ok: true, stdout: '' },
    'gh pr ready': { ok: true, stdout: '' },
    ...overrides,
  };
  const run = (command, args) => {
    calls.push([command, ...args]);
    const full = [command, ...args].join(' ');
    const key = Object.keys(answers).filter((prefix) => full.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
    return key ? { stderr: '', ...answers[key] } : { ok: false, stdout: '', stderr: `unexpected ${full}` };
  };
  return { run, calls };
}

const input = (extra = {}) => ({ worktree: '/repo/.mend/worktrees/login-case', branch: 'mend/login-case', card: card(), ...extra });

test('a merge-ready item is pushed to its own branch and opens a ready pull request against the default branch', () => {
  const { run, calls } = fakeRunner();
  const result = publish(input(), run);
  assert.deepEqual(result, { published: true, state: 'merge-ready', url: 'https://github.com/acme/app/pull/7', reason: 'opened the pull request' });
  assert.ok(calls.some((call) => call.join(' ') === 'git push --set-upstream origin mend/login-case:refs/heads/mend/login-case'));
  const create = calls.find((call) => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create');
  assert.equal(create[create.indexOf('--base') + 1], 'main');
  assert.ok(!create.includes('--draft'));
  assert.ok(!calls.some((call) => call.includes('--force') || call.includes('-f') || call.includes('merge')), 'never forces or merges');
});

test('a draft item opens a draft pull request that says why it is not ready', () => {
  const { run, calls } = fakeRunner();
  const result = publish(input({ card: card({ state: 'draft' }), reason: 'rounds spent: a test still fails' }), run);
  assert.equal(result.reason, 'opened as a draft pull request');
  const create = calls.find((call) => call[2] === 'create');
  assert.ok(create.includes('--draft'));
  assert.match(create[create.indexOf('--body') + 1], /Draft: not ready to merge\.\*\* rounds spent: a test still fails/);
});

test('blocked items and items without commits are never pushed', () => {
  for (const extra of [{ state: 'blocked' }, { headSha: BASE }, { headSha: 'nope' }]) {
    const { run, calls } = fakeRunner();
    const result = publish(input({ card: card(extra) }), run);
    assert.equal(result.published, false);
    assert.ok(!calls.some((call) => call[1] === 'push'), JSON.stringify(extra));
  }
});

test('no remote, no GitHub login or a moved head stop before the push with the reason', () => {
  const cases = [
    [{ 'git remote get-url origin': { ok: false } }, /no origin remote/],
    [{ 'gh auth status': { ok: false } }, /gh auth login/],
    [{ 'git rev-parse HEAD': { ok: true, stdout: 'c'.repeat(40) } }, /head is not the head on the card/],
    [{ 'git rev-parse --abbrev-ref HEAD': { ok: true, stdout: 'main' } }, /not on mend\/login-case/],
  ];
  for (const [overrides, reason] of cases) {
    const { run, calls } = fakeRunner(overrides);
    const result = publish(input(), run);
    assert.equal(result.published, false);
    assert.match(result.reason, reason);
    assert.ok(!calls.some((call) => call[1] === 'push'));
  }
});

test('a pull request already open for the branch is updated, and marked ready once the item is merge-ready', () => {
  const { run, calls } = fakeRunner({ 'gh pr view': { ok: true, stdout: 'https://github.com/acme/app/pull/7 OPEN true' } });
  const result = publish(input(), run);
  assert.equal(result.url, 'https://github.com/acme/app/pull/7');
  assert.ok(calls.some((call) => call[2] === 'edit'));
  assert.ok(calls.some((call) => call[2] === 'ready'));
  assert.ok(!calls.some((call) => call[2] === 'create'));
});

test('a refused push is reported, not retried with force', () => {
  const { run, calls } = fakeRunner({ 'git push': { ok: false, stderr: '! [rejected] (non-fast-forward)' } });
  const result = publish(input(), run);
  assert.equal(result.published, false);
  assert.match(result.reason, /non-fast-forward/);
  assert.equal(calls.filter((call) => call[1] === 'push').length, 1);
});

test('only mend/<id> branches and absolute worktrees are accepted', () => {
  assert.throws(() => publish(input({ branch: 'main' }), fakeRunner().run), PublishError);
  assert.throws(() => publish(input({ worktree: 'relative' }), fakeRunner().run), PublishError);
});

test('the body carries the checks, the regression, the audit and what was not verified; a high risk is called out', () => {
  const body = bodyFor(card({ risk: { tier: 'high', rule: 'touches auth' } }), '');
  for (const part of ['Merge-ready', '`bun test`', 'fails at base (exit 1) and passes at head (exit 0)', 'Auditor in its own session: **PASS**', '- browser rendering', '**High risk** (touches auth)', 'Merging is your call']) {
    assert.ok(body.includes(part), part);
  }
  assert.equal(titleFor(card({ goal: 'x'.repeat(100) })).length, 72);
});

const FORKED = {
  'gh repo view acme/app': { ok: true, stdout: 'READ' },
  'gh api user': { ok: true, stdout: 'dev' },
  'gh repo view dev/app': { ok: true, stdout: 'acme/app' },
  'gh pr list': { ok: true, stdout: '' },
};

test('without write access to origin, the branch goes to the user\'s fork and the pull request is opened on origin from it', () => {
  const { run, calls } = fakeRunner(FORKED);
  const result = publish(input(), run);
  assert.equal(result.published, true);
  assert.ok(calls.some((call) => call.join(' ') === 'git push --set-upstream https://github.com/dev/app.git mend/login-case:refs/heads/mend/login-case'));
  assert.ok(!calls.some((call) => call[1] === 'push' && call.includes('origin')), 'never pushes to a repository the user cannot write');
  const create = calls.find((call) => call[2] === 'create');
  assert.equal(create[create.indexOf('--repo') + 1], 'acme/app');
  assert.equal(create[create.indexOf('--head') + 1], 'dev:mend/login-case');
  assert.equal(create[create.indexOf('--base') + 1], 'main');
});

test('without write access and without a fork, nothing is pushed and the reason names the fork command; no fork is created', () => {
  const { run, calls } = fakeRunner({ ...FORKED, 'gh repo view dev/app': { ok: false, stderr: 'not found' } });
  const result = publish(input(), run);
  assert.equal(result.published, false);
  assert.match(result.reason, /gh repo fork acme\/app --clone=false/);
  assert.ok(!calls.some((call) => call[1] === 'push' || call[1] === 'fork'));
});

test('an item started from another pushed branch opens its pull request against that branch, so only its own commits show', () => {
  const { run, calls } = fakeRunner({
    ...FORKED,
    'git merge-base --is-ancestor': { ok: false },
    'git ls-remote --heads https://github.com/dev/app.git': { ok: true, stdout: `${'c'.repeat(40)}\trefs/heads/main\n${BASE}\trefs/heads/docs/goals` },
  });
  const result = publish(input(), run);
  assert.equal(result.published, true);
  const create = calls.find((call) => call[2] === 'create');
  assert.equal(create[create.indexOf('--repo') + 1], 'dev/app');
  assert.equal(create[create.indexOf('--base') + 1], 'docs/goals');
  assert.equal(create[create.indexOf('--head') + 1], 'mend/login-case');
});

test('an item started from a commit no pushed branch points at is not published with someone else\'s commits', () => {
  const { run, calls } = fakeRunner({ 'git merge-base --is-ancestor': { ok: false }, 'git ls-remote --heads': { ok: true, stdout: `${'c'.repeat(40)}\trefs/heads/main` } });
  const result = publish(input(), run);
  assert.equal(result.published, false);
  assert.match(result.reason, /not on main and is the tip of no pushed branch/);
  assert.ok(!calls.some((call) => call[1] === 'push'));
});
