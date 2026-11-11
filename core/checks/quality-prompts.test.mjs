import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompts, main } from './quality-prompts.mjs';

const contextData = {
  pkg: '/fixture/package', item: { id: 'sample', goal: 'preserve behavior' },
  plan: { profiles: [{ kind: 'docs', proposalArtifact: { name: 'outline', what: 'show structure' } }], roundBudget: 3, fileCap: 5 },
  worktree: '/fixture/worktree', branch: 'mend/sample', evidenceDir: '.mend/evidence/sample',
  verificationCommands: ['node --test'],
};

test('context preserves owner, proposal and verification contracts', () => {
  const prompts = buildPrompts('context', contextData);
  assert.ok(prompts.restate.startsWith(prompts.context));
  for (const rule of ['never git -C', 'You must run shell commands there yourself','mandatory, not an item-selected subset', 'node --test', 'Team design rules/exemplars override']) {
    assert.ok(prompts.context.includes(rule), rule);
  }
  assert.match(prompts.proposal, /Read exemplars first \(G1\)/);
  assert.match(prompts.proposal, /do not touch integration/);
  assert.match(prompts.proposal, /earlier attempt of this same task: they are yours/);
  assert.match(prompts.proposal, /docs: outline - show structure/);
  assert.match(prompts.planEvidence, /human approval must precede integration/);
  const report = JSON.parse(prompts.ownerReport.split('\n').slice(1, 7).join('\n'));
  assert.ok(report.card.drivenPath);
  assert.match(report.card.proof.note, /root cause as path:line/);
  assert.ok(report.profileEvidence['<kind>'].exemplarPairs);
  assert.match(prompts.ownerReport, /never another profile's artifact/);
  assert.match(prompts.ownerReport, /card.irreversible/);
});

test('the planner prompt is read-only, names the implicit cases and asks for JSON', () => {
  const prompt = buildPrompts('spec', contextData);
  assert.ok(prompt.startsWith(buildPrompts('context', contextData).context));
  for (const rule of ['Do not edit, create or delete any file', 'concurrency and retries', 'other users and access', 'status codes and error shapes consistent with the existing code', 'inside the editSet', 'do not add features', '{"spec":']) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test('every owner prompt points at the stored planner spec by path, and a blank path adds nothing', () => {
  const withSpec = buildPrompts('context', { ...contextData, specPath: '.mend/evidence/sample/spec.json' });
  assert.match(withSpec.context, /Implementation spec from the planner/);
  assert.ok(withSpec.context.includes('/fixture/worktree/.mend/evidence/sample/spec.json'));
  assert.ok(withSpec.restate.includes('/fixture/worktree/.mend/evidence/sample/spec.json'));
  assert.match(withSpec.context, /never edit it/);
  assert.equal(buildPrompts('context', { ...contextData, specPath: '  ' }).context, buildPrompts('context', contextData).context);
});

test('a long planner spec never grows the owner prompts', () => {
  const short = buildPrompts('context', { ...contextData, specPath: 'a/spec.json' });
  const long = buildPrompts('context', { ...contextData, specPath: 'a/spec.json', spec: 'x'.repeat(20_000) });
  assert.equal(long.restate.length, short.restate.length);
});

test('a proposal with declared inputs names the exact path the workflow reads', () => {
  const plan = { ...contextData.plan, profiles: [{ kind: 'api-backend', proposalArtifact: { name: 'contract', what: 'list operations', inputs: [{ path: 'contract.json' }] } }] };
  const prompt = buildPrompts('context', { ...contextData, plan }).proposal;
  assert.ok(prompt.includes('api-backend: contract - list operations Save at .mend/evidence/sample/contract.json.'));
  assert.match(prompt, /exact path listed with it/);
});

test('supervision preserves the entire acceptance contract and read-only scope', () => {
  const prompt = buildPrompts('supervise', {
    context: 'context', restatement: { goal: 'goal', finish: 'finish' }, approvedProposals: ['outline.md'], exemplars: ['reference.md'], noArtifacts: true,
  });
  for (const rule of ['read-only', 'every artifact/cited exemplar', 'goal AND finish', 'EVERY acceptance line', 'Without artifacts', 'concrete rejection reason', 'outline.md', 'reference.md']) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test('owner task separates proposal, implementation and fix rounds', () => {
  const revision = buildPrompts('owner', { proposalStage: true, feedback: null });
  assert.ok(revision.startsWith('Revise only the proposal artifacts, not the integration. '));
  assert.match(revision, /Never edit proposal-plan\.json/);
  assert.match(buildPrompts('owner', { proposalStage: true, feedback: null, redProposal: true }), /expected to fail until integration: that is not a blocker/);
  assert.match(buildPrompts('owner', { proposalStage: false, feedback: null, approvedProposals: ['a'] }), /approved proposal without changing it/);
  // The host may attribute the proposal's test files to another session; the implementer still owns them.
  assert.match(buildPrompts('owner', { proposalStage: false, feedback: null, approvedProposals: ['a'] }), /the proposal's tests included, are yours to edit within the edit set/);
  const feedback = "literal 'quotes', $HOME, `command`\nsecond line";
  assert.equal(buildPrompts('owner', { proposalStage: false, feedback }), 'Your previous round was sent back. Fix exactly this, nothing else:\n' + feedback);
});

test('critique preserves score, proposal and hunk-level growth contracts', () => {
  const data = {
    ...contextData, baseSha: 'base', head: 'head', previousHead: 'previous', diffPaths: " -- '.'", lenses: ['lens.md'],
    open: [{ id: 'F1', severity: 'should' }], report: { disputes: [{ id: 'F1', reason: 'because' }], commands: [], exemplars: [] },
    expected: { categories: ['docs.structure'] }, stat: ' 1 file changed\n', snapshotPath: 'plan.json', approvedProposals: ['outline.md'], approved: false, nextFinding: 'F2', hasGrowth: true,
  };
  const prompt = buildPrompts('critique', data);
  for (const rule of ['normal install without an extra service', 'cut diff growth', 'not yet approved; critique the proposal itself', 'Required score categories (exact ids): ["docs.structure"].', 'not-applicable:', 'An open finding alone is NOT an explanation', 'omissions flag the lead', 'Number new findings from F2.', 'review-card.json', 'git diff previous head']) {
    assert.ok(prompt.includes(rule), rule);
  }
  assert.ok(!prompt.includes('Growth evidence:'), 'the workflow appends evidence without CLI transport');
  const approved = buildPrompts('critique', { ...data, approved: true, hasGrowth: false, open: [] });
  assert.match(approved, /approved; check integration against it/);
  assert.ok(!approved.includes('Growth evidence:'));
  assert.ok(!approved.includes('Open findings:'));
});

test('CLI returns JSON and rejects malformed or unknown requests', () => {
  let out = '', error = '';
  const stdout = { write: (value) => { out += value; } };
  const stderr = { write: (value) => { error += value; } };
  assert.equal(main(['context', JSON.stringify(contextData)], stdout, stderr), 0);
  assert.deepEqual(JSON.parse(out), { prompt: buildPrompts('context', contextData) });
  for (const args of [[], ['owner', '{'], ['unknown', '{}'], ['critique', '{}']]) {
    out = '';
    assert.equal(main(args, stdout, stderr), 64);
    assert.equal(out, '');
  }
  assert.match(error, /QUALITY-PROMPTS/);
});
