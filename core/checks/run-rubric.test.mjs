import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadProfiles } from './check-profiles.mjs';
import { ALWAYS_KIND, EXIT, main, planItem, RubricUsageError, runItem, suggestProfiles } from './run-rubric.mjs';
import { captureEvidence, makeFixtureRepo, removeAll } from './test-support.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(HERE, '..', 'profiles');
const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mend-rubric-suite-')));
const CLEANUP = [ROOT];
after(() => removeAll(CLEANUP));

const CHECK_BODIES = {
  'always-pass': 'return { pass: true, failures: [] };',
  'with-exceptions': "return { pass: true, failures: [], overrides: [{ key: 'layoutTolerance', from: 0.08, to: 0.15, loosens: true }], allowed: [{ target: 'src/a.js:1', rule: 'label-truncated', reason: 'synthetic' }] };",
  'always-fail': "return { pass: false, failures: [{ target: 'a.txt', rule: 'too-long', detail: 'synthetic' }] };",
  'always-blocked': "return { pass: false, blocked: true, failures: [{ target: 'db', rule: 'no-database', detail: 'synthetic' }] };",
  'always-throws': "throw new Error('synthetic crash');",
  'echo-context': "return { pass: context.baseSha === 'b1' && context.headSha === 'h1' && context.config.marker === 7, failures: [] };",
  'profile-config': "return { pass: context.config.locale === 'fr-FR' && context.config.genericPhrases[0] === 'example', failures: [] };",
  'scale-evidence': "return { pass: true, failures: [], allowed: [{ property: 'fontSize', value: '20px', reason: 'Approved heading' }], designRules: 'DESIGN.md', scaleMargin: 0 };",
  'reads-card': "return context.card ? { pass: true, failures: [] } : { pass: false, failures: [{ target: '(card)', rule: 'card-missing', detail: 'synthetic' }] };",
  'reports-exceptions': "return { pass: true, failures: [], overrides: [{ key: 'layoutTolerance', from: 0.08, to: 0.15, loosens: true }], allowed: [{ target: 'src/chart.js:2', rule: 'label-truncated', reason: 'full text on focus' }] };",
};
const NEEDS_CARD = new Set(['reads-card']);

async function syntheticProfile({ kind, rubric, integrationDiff = null }) {
  const dir = path.join(ROOT, `profile-${kind}-${rubric.join('-')}`);
  await fs.mkdir(path.join(dir, 'checks'), { recursive: true });
  for (const id of [...rubric, ...(integrationDiff ? [integrationDiff] : [])]) {
    if (!(id in CHECK_BODIES)) continue;
    const needsCard = NEEDS_CARD.has(id) ? ' needsCard: true,' : '';
    const source = `export default { id: '${id}', description: 'synthetic ${id}',${needsCard} async run(context) { ${CHECK_BODIES[id]} } };\n`;
    await fs.writeFile(path.join(dir, 'checks', `${id}.mjs`), source);
  }
  return { kind, rubric, integrationDiff, dir, roundBudget: 2, fileCap: 4, critiqueLens: 'critique-lens.md' };
}

async function repoWithConfig(config) {
  const repo = await fs.mkdtemp(path.join(ROOT, 'repo-'));
  await fs.mkdir(path.join(repo, '.mend'), { recursive: true });
  if (config) await fs.writeFile(path.join(repo, '.mend', 'quality.json'), JSON.stringify(config));
  return repo;
}

describe('plan', () => {
  test('UI types are validated against available references and suggestions do not assign them', async () => {
    const profiles = await loadProfiles(PROFILES_DIR);
    const plan = planItem({ profiles: ['ui'], uiType: ['tables', 'states'] }, profiles);
    assert.deepEqual(plan.uiType, ['tables', 'states']);
    assert.throws(() => planItem({ uiType: 'unknown' }, profiles), /unknown.*tables/i);
    const suggested = planItem({ profiles: ['ui'], goal: 'Build a dashboard' }, profiles);
    assert.deepEqual(suggested.uiType, []);
    assert.ok(suggested.suggestedUiTypes.includes('dashboards'));
  });

  test('UI owner hints are advisory and depend on the assigned profile and exact uiType', async () => {
    const profiles = await loadProfiles(PROFILES_DIR);
    for (const [uiType, hint] of [['states', 'strong'], ['marketing', 'strong'], ['forms', 'cheap-with-direction'], ['tables', 'cheap-with-direction']]) {
      const plan = planItem({ profiles: ['ui'], uiType }, profiles);
      assert.equal(plan.profiles.find((entry) => entry.kind === 'ui').ownerHint, hint);
      assert.equal(plan.profiles.find((entry) => entry.kind === 'generic').ownerHint, null);
      assert.equal(plan.profiles.find((entry) => entry.kind === 'ui').humanApproval, true);
    }
    for (const uiType of [undefined]) {
      assert.equal(planItem({ profiles: ['ui'], uiType }, profiles).profiles.find((entry) => entry.kind === 'ui').ownerHint, null);
    }
    for (const uiType of ['unknown', 'toString']) {
      assert.throws(() => planItem({ profiles: ['ui'], uiType }, profiles), RubricUsageError);
    }
    const single = planItem({ profiles: ['ui'], uiType: ['forms'] }, profiles).profiles.find((entry) => entry.kind === 'ui');
    assert.equal(single.ownerHint, 'cheap-with-direction');
    const mixed = planItem({ profiles: ['ui'], uiType: ['states', 'forms'] }, profiles).profiles.find((entry) => entry.kind === 'ui');
    assert.equal(mixed.ownerHint, null);
    assert.deepEqual(mixed.ownerHints, [{ uiType: 'states', ownerHint: 'strong' }, { uiType: 'forms', ownerHint: 'cheap-with-direction' }]);
    assert.deepEqual(planItem({ profiles: [], uiType: 'states' }, profiles).profiles.map((entry) => entry.kind), ['generic']);
  });

  test('approval follows item risk, visual policy and the highest assigned risk floor', async () => {
    const profiles = await loadProfiles(PROFILES_DIR);
    for (const risk of ['low', 'medium', 'high']) {
      for (const profile of profiles) {
        assert.equal(profile.humanApproval, profile.kind === 'ui' ? 'always' : 'high-risk');
        const plan = planItem({ profiles: [profile.kind], risk }, profiles);
        for (const entry of plan.profiles) {
          const human = risk === 'high' || profile.riskFloor === 'high' || entry.kind === 'ui';
          assert.equal(entry.humanApproval, human, `${risk} ${profile.kind} / ${entry.kind}`);
          assert.equal(entry.proposalApprover, human ? 'human' : 'supervisor');
        }
      }
    }
    const mixed = planItem({ profiles: ['docs', 'schema-migration'], risk: 'low' }, profiles);
    assert.ok(mixed.profiles.every((profile) => profile.humanApproval && profile.proposalApprover === 'human'));
  });

  test('an item always runs generic beside the profiles it declares, and the smallest budget wins', async () => {
    const profiles = await loadProfiles(PROFILES_DIR);
    const declared = profiles.find((profile) => profile.kind !== ALWAYS_KIND);
    const plan = planItem({ id: 'item-1', profiles: [declared.kind], editSet: [] }, profiles);
    assert.deepEqual(plan.profiles.map((profile) => profile.kind), [ALWAYS_KIND, declared.kind]);
    const expectedBudget = Math.min(...plan.profiles.map((profile) => profile.roundBudget));
    assert.equal(plan.roundBudget, expectedBudget);
    for (const profile of plan.profiles) {
      await fs.access(profile.critiqueLens);
      assert.ok(Array.isArray(profile.rubric) && profile.rubric.length > 0);
    }
  });

  test('matchHints only suggest: an undeclared profile is listed under suggested and not assigned', async () => {
    const profiles = await loadProfiles(PROFILES_DIR);
    const withPathHint = profiles.find((profile) => profile.kind !== ALWAYS_KIND && profile.matchHints?.paths?.length);
    const samplePath = withPathHint.matchHints.paths[0].replace(/\*\*\//g, 'src/').replace(/\*/g, 'sample');
    const item = { id: 'item-2', profiles: [], editSet: [samplePath], goal: 'change one thing' };
    const plan = planItem(item, profiles);
    assert.deepEqual(plan.profiles.map((profile) => profile.kind), [ALWAYS_KIND]);
    assert.ok(plan.suggested.includes(withPathHint.kind), `${samplePath} should suggest ${withPathHint.kind}`);
  });

  test('an intent word in the goal suggests the profile that lists it', async () => {
    const profiles = await loadProfiles(PROFILES_DIR);
    const withIntent = profiles.find((profile) => profile.kind !== ALWAYS_KIND && profile.matchHints?.intents?.length);
    const suggested = suggestProfiles({ goal: `please ${withIntent.matchHints.intents[0]} this`, editSet: [] }, profiles);
    assert.ok(suggested.includes(withIntent.kind));
  });

  test('a declared profile that does not exist is a usage error, never silently dropped', async () => {
    const profiles = await loadProfiles(PROFILES_DIR);
    assert.throws(() => planItem({ id: 'x', profiles: ['no-such-kind'] }, profiles), RubricUsageError);
  });
});

describe('run', () => {
  test('bugfix proposal requires a root cause while the fix remains mandatory in integration', async () => {
    const all = await loadProfiles(PROFILES_DIR);
    const profile = { ...all.find((entry) => entry.kind === 'bugfix'), rubric: ['bugfix-shape'] };
    const { root: repo, baseSha, headSha } = await makeFixtureRepo({ dirs: CLEANUP, files: [
      { path: 'src/app.js', base: 'broken\n', head: 'broken\n' },
      { path: 'src/app.test.js', base: '', head: 'test regression\n' },
    ] });
    const args = { repo, item: { id: 'bugfix-proposal', profiles: ['bugfix'] }, baseSha, headSha, profiles: [profile] };
    assert.equal((await runItem({ ...args, proposal: true, reviewCard: {} })).pass, false);
    const reviewCard = { proof: { note: 'src/app.js:1 identifies the cause' } };
    assert.equal((await runItem({ ...args, proposal: true, reviewCard })).pass, true);
    const integration = await runItem({ ...args, integration: true, reviewCard });
    assert.equal(integration.pass, false);
    assert.ok(integration.profiles[0].checks[0].failures.some((failure) => failure.rule === 'fix-only-tests'));
  });
  test('migration compatibility is deferred only for proposals and remains required after integration', async () => {
    const all = await loadProfiles(PROFILES_DIR);
    const profile = { ...all.find((entry) => entry.kind === 'schema-migration'), rubric: ['compatibility'] };
    const { root: repo, baseSha, headSha } = await makeFixtureRepo({ dirs: CLEANUP, files: [{ path: 'src/app.js', base: 'base\n', head: 'head\n' }] });
    const item = { id: 'compatibility-stage', profiles: ['schema-migration'] };
    const args = { repo, item, baseSha, headSha, profiles: [profile] };
    await assert.rejects(runItem({ ...args, proposal: true, integration: true }), RubricUsageError);
    const proposal = await runItem({ ...args, proposal: true });
    assert.equal(proposal.pass, true);
    assert.deepEqual(proposal.profiles[0].deferred, ['compatibility']);
    const integration = await runItem({ ...args, integration: true });
    assert.equal(integration.pass, false);
    assert.equal(integration.profiles[0].checks[0].failures[0].rule, 'compatibility');
    const final = await runItem(args);
    assert.equal(final.pass, false);
    await captureEvidence({ root: repo, itemId: item.id, kind: 'compatibility', value: { database: { kind: 'ephemeral' }, combinations: ['base-head', 'head-base'] } });
    assert.equal((await runItem({ ...args, integration: true })).pass, true);
    assert.equal((await runItem(args)).pass, true);
  });
  test('substantive card-dependent checks accept review evidence instead of requiring a final card', async () => {
    const profiles = await loadProfiles(PROFILES_DIR);
    for (const [kind, id] of [['api-backend', 'repeat-abuse'], ['schema-migration', 'migration-safety'], ['bugfix', 'bugfix-shape']]) {
      const profile = profiles.find((entry) => entry.kind === kind);
      const check = (await import(path.join(profile.dir, 'checks', `${id}.mjs`))).default;
      assert.equal(check.needsCard, true, `${kind}/${id} consumes card evidence`);
      assert.notEqual(check.needsFinalCard, true, `${kind}/${id} must run during review`);
    }
  });
  test('real deferred checks consume the final card and reject missing exceptions', async () => {
    const all = await loadProfiles(PROFILES_DIR);
    const migration = JSON.parse(await fs.readFile(path.join(PROFILES_DIR, 'schema-migration/fixtures/migration-safety/pass-irreversible-countersigned.json'), 'utf8'));
    const api = JSON.parse(await fs.readFile(path.join(PROFILES_DIR, 'api-backend/fixtures/repeat-abuse/pass-idempotent-redeem.json'), 'utf8'));
    const cases = [
      { kind: 'api-backend', id: 'repeat-abuse', files: [api.files[1]], card: api.card, rule: 'repeat-unbounded' },
      { kind: 'schema-migration', id: 'migration-safety', files: migration.files, card: migration.card, rule: 'rollback-or-irreversible-countersign', evidence: { 'migration-plan.json': migration.plan }, capture: migration.dryRun },
      { kind: 'bugfix', id: 'bugfix-shape', files: [{ path: 'src/total.js', base: 'bad\n', head: 'fixed\n' }], card: { proof: { note: 'src/total.js:1 fixes the cause' } }, rule: 'root-cause-missing' },
    ];
    for (const sample of cases) {
      const profile = { ...all.find((entry) => entry.kind === sample.kind), rubric: [sample.id], integrationDiff: null };
      const { root: repo, baseSha, headSha } = await makeFixtureRepo({ dirs: CLEANUP, files: sample.files });
      const item = { id: 'case', profiles: [sample.kind] };
      const evidenceDir = path.join(repo, '.mend', 'evidence');
      await fs.mkdir(path.join(evidenceDir, item.id), { recursive: true });
      for (const [name, value] of Object.entries(sample.evidence ?? {})) await fs.writeFile(path.join(evidenceDir, item.id, name), JSON.stringify(value));
      if (sample.capture) await captureEvidence({ root: repo, itemId: item.id, kind: 'migration', value: sample.capture });
      const run = (withoutCard = false) => runItem({ repo, item, baseSha, headSha, profiles: [profile], withoutCard });
      const early = await run(true);
      assert.deepEqual(early.profiles[0].deferred, [sample.id], sample.kind);
      // Proposal and integration reviews must not defer substantive card-dependent checks.
      for (const phase of [{ proposal: true }, { integration: true }]) {
        const review = (reviewCard) => runItem({ repo, item, baseSha, headSha, profiles: [profile], ...phase, reviewCard });
        const missing = await review({});
        assert.equal(missing.pass, false, `${sample.kind} rejects missing review evidence`);
        assert.ok(missing.profiles[0].checks[0].failures.some((failure) => failure.rule === sample.rule), sample.kind);
        const complete = await review(sample.card);
        assert.equal(complete.profiles[0].checks[0].pass, true, sample.kind);
        assert.equal(complete.profiles[0].deferred, undefined, sample.kind);
      }
      await fs.writeFile(path.join(evidenceDir, 'case.json'), JSON.stringify(sample.card));
      const valid = await run();
      assert.equal(valid.profiles[0].checks[0].pass, true, sample.kind);
      await fs.writeFile(path.join(evidenceDir, 'case.json'), '{}');
      const invalid = await run();
      assert.equal(invalid.profiles[0].checks[0].pass, false, sample.kind);
      assert.ok(invalid.profiles[0].checks[0].failures.some((failure) => failure.rule === sample.rule), sample.kind);
    }
  });
  test('reports exceptions and blocks an unsigned loosening including integration checks', async () => {
    const profiles = [await syntheticProfile({ kind: ALWAYS_KIND, rubric: ['with-exceptions'], integrationDiff: 'with-exceptions' })];
    const report = await runItem({ repo: await repoWithConfig(), item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles, integration: true });
    assert.equal(report.pass, false);
    assert.equal(report.profiles[0].checks[0].overrides[0].loosens, true);
    assert.equal(report.profiles[0].checks[0].allowed[0].reason, 'synthetic');
    assert.equal(report.profiles[0].integrationDiff.overrides[0].loosens, true);
  });

  test('docs receives the shared locale and its profile-specific options', async () => {
    const profiles = [await syntheticProfile({ kind: 'docs', rubric: ['profile-config'] })];
    const repo = await repoWithConfig({ ui: { locale: 'fr-FR' }, docs: { genericPhrases: ['example'] } });
    const report = await runItem({ repo, item: { id: 'i', profiles: ['docs'] }, baseSha: 'b', headSha: 'h', profiles });
    assert.equal(report.pass, true);
  });

  test('check evidence retains token allowances and design rules for the critic', async () => {
    const profiles = [await syntheticProfile({ kind: ALWAYS_KIND, rubric: ['scale-evidence'] })];
    const report = await runItem({ repo: await repoWithConfig(), item: { id: 'scale' }, profiles });
    const result = report.profiles[0].checks[0];
    assert.equal(report.pass, true);
    assert.equal(result.designRules, 'DESIGN.md');
    assert.equal(result.scaleMargin, 0);
    assert.deepEqual(result.allowed, [{ property: 'fontSize', value: '20px', reason: 'Approved heading' }]);
  });

  test('loosening overrides fail without a matching countersign and exception metadata is retained', async () => {
    const profiles = [await syntheticProfile({ kind: ALWAYS_KIND, rubric: ['reports-exceptions'] })];
    const repo = await repoWithConfig();
    const report = await runItem({ repo, item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles, withoutCard: true });
    assert.equal(report.pass, false);
    const check = report.profiles[0].checks[0];
    assert.equal(check.overrides[0].to, 0.15);
    assert.equal(check.allowed[0].rule, 'label-truncated');
    assert.ok(check.failures.some((failure) => failure.rule === 'gate-loosening-unsigned'));
    await fs.mkdir(path.join(repo, '.mend/evidence'), { recursive: true });
    const cardFile = path.join(repo, '.mend/evidence/i.json');
    const sign = { kind: 'gate-loosening', subject: 'generic.reports-exceptions.layoutTolerance=0.15', by: 'reviewer', reason: 'approved for the target viewport', at: '2026-09-26T12:00:00Z' };
    await fs.writeFile(cardFile, JSON.stringify({ countersigns: [sign] }));
    assert.equal((await runItem({ repo, item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles })).pass, true);
    await fs.writeFile(cardFile, JSON.stringify({ countersigns: [{ ...sign, subject: 'generic.reports-exceptions.layoutTolerance=0.2' }] }));
    assert.equal((await runItem({ repo, item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles })).pass, false);
  });

  test('all checks pass: the item passes and the context carries shas and repo config', async () => {
    const profiles = [await syntheticProfile({ kind: ALWAYS_KIND, rubric: ['always-pass', 'echo-context'] })];
    const repo = await repoWithConfig({ marker: 7 });
    const report = await runItem({ repo, item: { id: 'i', profiles: [] }, baseSha: 'b1', headSha: 'h1', profiles });
    assert.equal(report.pass, true);
    assert.equal(report.blocked, false);
    assert.deepEqual(report.profiles[0].rubric, { pass: true, failures: [] });
  });

  test('one failing check fails its profile and the item, with the check failures kept', async () => {
    const profiles = [await syntheticProfile({ kind: ALWAYS_KIND, rubric: ['always-pass', 'always-fail'] })];
    const report = await runItem({ repo: await repoWithConfig(), item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles });
    assert.equal(report.pass, false);
    assert.deepEqual(report.profiles[0].rubric.failures.map((failure) => failure.rule), ['too-long']);
  });

  test('a check that throws is a failure named check-crashed, not a pass', async () => {
    const profiles = [await syntheticProfile({ kind: ALWAYS_KIND, rubric: ['always-throws'] })];
    const report = await runItem({ repo: await repoWithConfig(), item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles });
    assert.equal(report.pass, false);
    assert.equal(report.profiles[0].rubric.failures[0].rule, 'check-crashed');
  });

  test('a check that resolves nowhere marks the profile skipped with a reason, and the item does not pass', async () => {
    const profiles = [await syntheticProfile({ kind: ALWAYS_KIND, rubric: ['always-pass', 'not-written'] })];
    const report = await runItem({ repo: await repoWithConfig(), item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles });
    assert.equal(report.profiles[0].skipped, true);
    assert.match(report.profiles[0].skipReason, /not-written/);
    assert.equal(report.pass, false);
  });

  test('a blocked check marks the report blocked', async () => {
    const profiles = [await syntheticProfile({ kind: ALWAYS_KIND, rubric: ['always-blocked'] })];
    const report = await runItem({ repo: await repoWithConfig(), item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles });
    assert.equal(report.blocked, true);
  });

  test('without a card, checks that need one are deferred and listed, not failed; with the card they run', async () => {
    const profiles = [await syntheticProfile({ kind: ALWAYS_KIND, rubric: ['always-pass', 'reads-card'] })];
    const repo = await repoWithConfig();
    const early = await runItem({ repo, item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles, withoutCard: true });
    assert.equal(early.pass, true);
    assert.deepEqual(early.profiles[0].deferred, ['reads-card']);
    const review = await runItem({ repo, item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles, reviewCard: { item: 'i' } });
    assert.equal(review.pass, true);
    assert.equal(review.profiles[0].deferred, undefined, 'needsCard alone never defers a review check');
    const late = await runItem({ repo, item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles });
    assert.equal(late.pass, false);
    assert.equal(late.profiles[0].rubric.failures[0].rule, 'card-missing');
    await fs.mkdir(path.join(repo, '.mend', 'evidence'), { recursive: true });
    await fs.writeFile(path.join(repo, '.mend', 'evidence', 'i.json'), JSON.stringify({ item: 'i' }));
    const withCard = await runItem({ repo, item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles });
    assert.equal(withCard.pass, true);
  });

  test('review evidence cannot waive an unsigned gate loosening', async () => {
    const profiles = [await syntheticProfile({ kind: ALWAYS_KIND, rubric: ['reports-exceptions'] })];
    const repo = await repoWithConfig();
    const run = (reviewCard) => runItem({ repo, item: { id: 'review' }, profiles, reviewCard });
    const unsigned = await run({});
    assert.equal(unsigned.pass, false);
    assert.ok(unsigned.profiles[0].rubric.failures.some((failure) => failure.rule === 'gate-loosening-unsigned'));
    const sign = { kind: 'gate-loosening', subject: 'generic.reports-exceptions.layoutTolerance=0.15', by: 'reviewer', reason: 'Approved exact setting', at: '2026-01-02T10:00:00Z' };
    assert.equal((await run({ countersigns: [sign] })).pass, true);
  });

  test('the real generic profile runs end to end on a git repository without crashing', async () => {
    const profiles = await loadProfiles(PROFILES_DIR);
    const { root: repo, baseSha, headSha } = await makeFixtureRepo({
      dirs: CLEANUP,
      prefix: 'mend-rubric-git-',
      files: [{ path: 'src/total.js', base: 'export const total = (a, b) => a + b;\n', head: 'export const total = (a, b) => a + b + 0;\n' }],
    });
    const item = { id: 'real', profiles: [], editSet: ['src/total.js'] };
    const report = await runItem({ repo, item, baseSha, headSha, profiles, withoutCard: true });
    const crashed = report.profiles.flatMap((entry) => entry.rubric.failures).filter((failure) => failure.rule === 'check-crashed');
    assert.deepEqual(crashed, []);
    assert.deepEqual(report.profiles[0].deferred.sort(), ['card-claims', 'critique-ledger']);
    assert.equal(report.profiles[0].skipped, false);
    const review = await runItem({ repo, item, baseSha, headSha, profiles, reviewCard: {} });
    assert.deepEqual(review.profiles[0].deferred.sort(), ['card-claims', 'critique-ledger']);
    const final = await runItem({ repo, item, baseSha, headSha, profiles });
    assert.equal(final.pass, false);
    assert.equal(final.profiles[0].deferred, undefined);
  });

  test('the integration diff runs only when asked, and its failure fails the item', async () => {
    const profiles = [await syntheticProfile({ kind: ALWAYS_KIND, rubric: ['always-pass'], integrationDiff: 'always-fail' })];
    const repo = await repoWithConfig();
    const without = await runItem({ repo, item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles });
    assert.equal(without.pass, true);
    assert.equal(without.profiles[0].integrationDiff, undefined);
    const withDiff = await runItem({ repo, item: { id: 'i' }, baseSha: 'b', headSha: 'h', profiles, integration: true });
    assert.equal(withDiff.pass, false);
    assert.equal(withDiff.profiles[0].integrationDiff.pass, false);
  });
});

describe('cli', () => {
  function capture() {
    const chunks = { out: '', err: '' };
    return {
      chunks,
      stdout: { write: (text) => { chunks.out += text; } },
      stderr: { write: (text) => { chunks.err += text; } },
    };
  }

  test('no subcommand is a usage error', async () => {
    const io = capture();
    assert.equal(await main([], io), EXIT.usage);
    assert.match(io.chunks.err, /usage:/);
  });

  test('run without shas is a usage error', async () => {
    const io = capture();
    const itemFile = path.join(ROOT, 'item-cli.json');
    await fs.writeFile(itemFile, JSON.stringify({ id: 'cli', profiles: [] }));
    assert.equal(await main(['run', '--item', itemFile], io), EXIT.usage);
  });

  test('review-card CLI requires an object and cannot silently fall back to deferral', async () => {
    const itemFile = path.join(ROOT, 'item-review-cli.json');
    const cardFile = path.join(ROOT, 'review-cli.json');
    await fs.writeFile(itemFile, JSON.stringify({ id: 'review-cli', profiles: [] }));
    const args = ['run', '--item', itemFile, '--base', 'b', '--head', 'h', '--review-card', cardFile];
    assert.equal(await main(args, capture()), EXIT.usage);
    for (const value of [null, [], 'not a card', false]) {
      await fs.writeFile(cardFile, JSON.stringify(value));
      assert.equal(await main(args, capture()), EXIT.usage);
    }
    await fs.writeFile(cardFile, '{}');
    assert.equal(await main([...args, '--without-card'], capture()), EXIT.usage);
  });

  test('plan prints one JSON line with the assigned profiles', async () => {
    const io = capture();
    const itemFile = path.join(ROOT, 'item-plan.json');
    await fs.writeFile(itemFile, JSON.stringify({ id: 'cli', profiles: [] }));
    assert.equal(await main(['plan', '--item', itemFile], io), EXIT.pass);
    const plan = JSON.parse(io.chunks.out);
    assert.deepEqual(plan.profiles.map((profile) => profile.kind), [ALWAYS_KIND]);
  });

  test('plan prints the UI owner hint for the item type', async () => {
    const io = capture();
    const itemFile = path.join(ROOT, 'item-ui-plan.json');
    await fs.writeFile(itemFile, JSON.stringify({ id: 'cli-ui', profiles: ['ui'], uiType: 'forms' }));
    assert.equal(await main(['plan', '--item', itemFile], io), EXIT.pass);
    assert.equal(JSON.parse(io.chunks.out).profiles.find((entry) => entry.kind === 'ui').ownerHint, 'cheap-with-direction');
  });

  test('a missing item file is a usage error', async () => {
    const io = capture();
    assert.equal(await main(['plan', '--item', path.join(ROOT, 'absent.json')], io), EXIT.usage);
  });
});
