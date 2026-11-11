import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { anchorDrift, critiqueVerdict, proposalInputs, exemplarProblem, finalEvidence, main } from './quality-review.mjs';

// Workflows cannot export/import helpers at runtime. Exercise their actual local
// function declarations without executing the workflow's top-level orchestration.
const workflow = readFileSync(new URL('../workflows/mend-quality.js', import.meta.url), 'utf8');
const [growthEvidence, justifiedGrowth] = ['growthEvidence', 'justifiedGrowth'].map((name) => {
  const declaration = workflow.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'))?.[0];
  assert.ok(declaration, `missing local workflow function ${name}`);
  return new Function(`return (${declaration});`)();
});

test('anchor drift uses the first scores and strict tolerance boundary', () => {
  const firstScores = { quality: { anchors: { reference: 8 } } };
  assert.equal(anchorDrift({ firstScores: null }), null);
  for (const value of [7, 8, 9, null]) {
    assert.equal(anchorDrift({ firstScores, driftTolerance: 1, scores: { quality: { anchors: { reference: value } } } }), null);
  }
  assert.equal(anchorDrift({ firstScores, driftTolerance: 1, scores: { quality: { anchors: { reference: 5 } } } }), 'quality anchor reference moved from 8 to 5');
});

test('verdict retains all score, comparative, gaming and blocking reasons', () => {
  const parsed = { scores: { quality: { head: 6 } }, comparisons: { quality: { base: 'worse', anchors: { reference: 'worse' } } }, gaming: 'yes' };
  const findings = [{ id: 'F1', severity: 'blocker', status: 'open' }, { id: 'F2', severity: 'should', status: 'disputed' }, { id: 'F3', severity: 'nit', status: 'open' }];
  assert.deepEqual(critiqueVerdict({ parsed, threshold: 7, findings }), [
    'quality head 6 does not meet the bar', 'quality head is worse than base', 'quality head is worse than exemplar reference',
    'the critic found the change games its checks', 'F1 [blocker] is open', 'F2 [should] is disputed',
  ]);
  for (const head of [7, null]) {
    assert.deepEqual(critiqueVerdict({ parsed: { scores: { quality: { head } }, comparisons: { quality: { base: 'same', anchors: {} } }, gaming: 'no' }, threshold: 7, findings: [] }), []);
  }
});

test('review CLI fails closed on missing or malformed inputs', () => {
  let output = '';
  const stdout = { write: (text) => { output += text; } };
  const stderr = { write: () => {} };
  assert.equal(main(['drift', '{"firstScores":null}'], stdout, stderr), 0);
  assert.deepEqual(JSON.parse(output), { result: null });
  for (const args of [[], ['drift', '{'], ['verdict', '{}'], ['unknown', '{}'], ['growth', '{}'], ['growth', '{"hunks":[null]}']]) {
    output = '';
    assert.equal(main(args, stdout, stderr), 64);
    assert.equal(output, '');
  }
});

test('proposal inputs deduplicate normalized path/field pairs without dropping fields or snapshots', () => {
  const planInputs = [{ path: 'evidence/plan.json', sha256: 'identity' }];
  assert.deepEqual(proposalInputs({
    evidenceDir: 'evidence', planInputs,
    withProposal: [{ proposalArtifact: { inputs: [
      { path: 'proposal/../outline.json', field: 'title' },
      { path: './outline.json', field: 'title' },
      { path: 'outline.json', field: 'body' },
    ] } }],
    approvedProposals: ['evidence/outline.json', 'evidence/preview.html'],
  }), [
    { path: 'evidence/proposal/../outline.json', field: 'title' },
    { path: 'evidence/outline.json', field: 'body' },
    { path: 'evidence/preview.html' }, ...planInputs,
  ]);
});

test('drift tolerance survives JSON transport for non-finite argument values', () => {
  const data = { firstScores: { q: { anchors: { a: 8 } } }, scores: { q: { anchors: { a: 5 } } } };
  assert.equal(anchorDrift({ ...data, driftTolerance: 'NaN' }), null);
  assert.equal(anchorDrift({ ...data, driftTolerance: 'Infinity' }), null);
  assert.match(anchorDrift({ ...data, driftTolerance: '-Infinity' }), /moved from 8 to 5/);
});

test('exemplars require unique labels, paths and each profile count', () => {
  const exemplar = { label: 'reference', path: 'reference.md' };
  const profiles = [{ kind: 'docs', exemplars: { min: 1, max: 1 } }];
  assert.equal(exemplarProblem({ exemplars: [exemplar], profiles }), null);
  for (const exemplars of [[], [exemplar, exemplar], [{ ...exemplar, path: '' }]]) {
    assert.match(exemplarProblem({ exemplars, profiles }), /labels and paths/);
  }
  assert.match(exemplarProblem({ exemplars: [{ ...exemplar, profiles: ['ui'] }], profiles }), /profile contract for docs/);
  assert.match(exemplarProblem({ exemplars: [exemplar, { ...exemplar, label: 'other' }], profiles }), /profile contract for docs/);
});

test('an exemplar inside the edit set is refused, because editing it would move the anchor between rounds', () => {
  const profiles = [{ kind: 'api-backend', exemplars: { min: 1, max: 3 } }];
  const editSet = ['src/http/app.js', 'test/**'];
  assert.match(exemplarProblem({ exemplars: [{ label: 'order route', path: 'src/http/app.js' }], profiles, editSet }), /does not edit; replace src\/http\/app\.js/);
  assert.match(exemplarProblem({ exemplars: [{ label: 'helpers', path: './test/helpers.js' }], profiles, editSet }), /replace \.\/test\/helpers\.js/);
  assert.equal(exemplarProblem({ exemplars: [{ label: 'catalog route', path: 'src/http/catalog.js' }], profiles, editSet }), null);
});

test('final evidence keeps approved proposal associations and lowest scored head', () => {
  const profiles = [{ kind: 'bugfix', proposalArtifact: {} }, { kind: 'docs' }];
  const scores = { 'bugfix.a': { head: 8 }, 'bugfix.b': { head: 7 }, 'docs.a': { head: null } };
  const accepted = { profileEvidence: { bugfix: { approvedProposal: 'wrong', exemplarPairs: ['wrong'], proof: 'kept' } } };
  const proposalEvidence = { bugfix: { approvedProposal: 'approved' } };
  assert.deepEqual(finalEvidence({ profiles, scores, accepted, proposalEvidence }), {
    critiqueScores: { bugfix: 7, docs: null },
    profileEvidence: { bugfix: { approvedProposal: 'approved', proof: 'kept' }, docs: {} },
  });
});

test('growth retains exact text/binary hunk keys and demands every justification', () => {
  for (const hunks of [undefined, [null], [1]]) {
    assert.throws(() => growthEvidence({ hunks }), /growth requires extracted hunk keys/);
  }
  const growth = growthEvidence({
    hunks: ['diff --git a/a b/a\n@@ -1 +1 @@', 'diff --git a/b b/b\nBinary files a/b and b/b differ'],
    before: 1, after: 3, growthFactor: 2, previousHead: 'base', head: 'head',
    findings: [{ id: 'F1', round: 1 }], rounds: [{ round: 1, log: 'critique-r1.md' }, { round: 2, log: 'critique-r2.md' }],
  });
  assert.deepEqual(growth.hunks, ['diff --git a/a b/a\n@@ -1 +1 @@', 'diff --git a/b b/b\nBinary files a/b and b/b differ']);
  assert.deepEqual(growth.logs, ['critique-r1.md']);
  const explanations = growth.hunks.map((hunk) => ({ hunk, finding: 'F1', reason: 'required lines' }));
  assert.equal(justifiedGrowth({ growth, explanations }), true);
  for (const invalid of [undefined, [], explanations.slice(1), explanations.map((entry) => ({ ...entry, finding: 'F2' })), explanations.map((entry) => ({ ...entry, reason: ' ' }))]) {
    assert.equal(justifiedGrowth({ growth, explanations: invalid }), false);
  }
  assert.equal(justifiedGrowth({ growth: { ...growth, hunks: [] }, explanations: [] }), false);
});

test('local growth validation covers all hunk keys even above the CLI argument limit', () => {
  const hunks = Array.from({ length: 3000 }, (_, index) => `diff --git a/src/total.js b/src/total.js\n@@ -${index * 2 + 1} +${index * 2 + 1} @@`);
  assert.ok(Buffer.byteLength(JSON.stringify(hunks)) > 128 * 1024);
  const growth = growthEvidence({ hunks, findings: [{ id: 'F1', round: 1 }], rounds: [{ round: 1, log: 'critique-r1.md' }] });
  assert.deepEqual(growth.hunks, hunks);
  const explanations = hunks.map((hunk) => ({ hunk, finding: 'F1', reason: 'Addresses the open finding.' }));
  assert.equal(justifiedGrowth({ growth, explanations }), true);
  assert.equal(justifiedGrowth({ growth, explanations: explanations.slice(0, -1) }), false);
  assert.equal(justifiedGrowth({ growth, explanations: explanations.map((entry) => ({ ...entry, finding: 'F2' })) }), false);
});
