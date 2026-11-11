import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertFixtures, makeFixtureRepo, removeAll, rulesOf } from '../../../checks/test-support.mjs';
import critiqueLedger, { parseCriticReply } from './critique-ledger.mjs';
import { critiqueContract } from '../../../checks/critic-reply.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'critique-ledger');
const dirs = [];
after(() => removeAll(dirs));

const REPLY = [
  'scores:',
  '| category | base | head | panel-a |',
  '|---|---|---|---|',
  '| generic.scope | n/a | 8 | n/a |',
  '| ui.copy | 6 | 7.5 | 8 |',
  '',
  'vs: generic.scope base=n/a panel-a=n/a - The edit set matches the item.',
  'vs: ui.copy base=better panel-a=same - Labels now name the action as clearly as the panel.',
  'gaming: No - test diff is additions only',
  'findings:',
  '- F3 [blocker] src/a.ts:4: writes outside the account folder -> scope the path',
  '- F4 [nit] src/a.ts:9: unused import -> remove it',
  'resolved: F1, F2',
  'still-open:',
  '- F5: the empty state still shows a zero',
].join('\n');

describe('critique-ledger fixtures', () => {
  test('every pass fixture passes and every fail fixture fails exactly its rules', async () => {
    await assertFixtures(critiqueLedger, FIXTURES);
  });
});

describe('parseCriticReply', () => {
  test('an expected category or anchor cannot be omitted, and duplicate rows cannot overwrite a low score', () => {
    assert.match(parseCriticReply(REPLY, { categories: ['generic.scope', 'ui.copy', 'ui.states'], anchors: ['panel-a'] }).error, /ui.states/);
    assert.match(parseCriticReply(REPLY, { categories: ['generic.scope', 'ui.copy'], anchors: ['panel-a', 'panel-b'] }).error, /panel-b/);
    assert.match(parseCriticReply(REPLY.replace('| ui.copy | 6 | 7.5 | 8 |', '| ui.copy | 6 | 2 | 8 |\n| ui.copy | 6 | 9 | 8 |')).error, /duplicate/i);
  });

  test('a scored category requires a scored anchor, not an empty or all-n/a comparison', () => {
    const reply = '| category | base | head | panel-a |\n|---|---|---|---|\n| ui.copy | n/a | 9 | n/a |\ngaming: no - checked\n';
    assert.match(parseCriticReply(reply, { categories: ['ui.copy'], anchors: ['panel-a'] }).error, /anchor|n\/a/i);
  });

  test('explicitly inapplicable heads need a concrete reason instead of a missing row', () => {
    const reply = '| category | base | head | panel-a |\n|---|---|---|---|\n| generic.sink-floor | n/a | n/a | n/a |\nvs: generic.sink-floor base=n/a panel-a=n/a - No consumable values are involved.\ngaming: no - checked\n';
    const expected = { categories: ['generic.sink-floor'], anchors: ['panel-a'] };
    assert.match(parseCriticReply(reply, expected).error, /not-applicable reason/);
    assert.equal(parseCriticReply(reply + 'not-applicable: generic.sink-floor - This change has no consumable values.\n', expected).error, undefined);
  });

  test('reads the score table, gaming answer, findings and resolved ids', () => {
    assert.deepEqual(parseCriticReply(REPLY), {
      scores: {
        'generic.scope': { base: null, head: 8, anchors: { 'panel-a': null } },
        'ui.copy': { base: 6, head: 7.5, anchors: { 'panel-a': 8 } },
      },
      comparisons: {
        'generic.scope': { base: 'n/a', anchors: { 'panel-a': 'n/a' }, evidence: 'The edit set matches the item.' },
        'ui.copy': { base: 'better', anchors: { 'panel-a': 'same' }, evidence: 'Labels now name the action as clearly as the panel.' },
      },
      gaming: 'no',
      findings: [
        { id: 'F3', severity: 'blocker' },
        { id: 'F4', severity: 'nit' },
      ],
      resolved: ['F1', 'F2'],
    });
  });

  test('a score outside 0-10, a word in a score cell or a missing column makes the reply unparseable', () => {
    for (const row of ['| ui.copy | 6 | 11 | 8 |', '| ui.copy | 6 | good | 8 |', '| ui.copy | 6 | 7 |']) {
      const reply = REPLY.replace('| ui.copy | 6 | 7.5 | 8 |', row);
      assert.match(parseCriticReply(reply).error, /not a category with a number or n\/a/, row);
    }
  });

  test('a reply without a gaming answer is unparseable', () => {
    assert.match(parseCriticReply(REPLY.replace(/gaming:.*\n/, '')).error, /gaming/);
  });
});

describe('critique-ledger on a repository', () => {
  for (const [name, unscoredHead, unscoredAnchors, expected] of [
    ['unscored required heads', true, false, 'critique-coverage'],
    ['no scored exemplar comparisons', false, true, 'exemplar-missing'],
  ]) {
    test(`a ready card with complete categories rejects ${name}`, async () => {
      const categories = ['scope', 'evidence', 'derivation', 'floor', 'trust', 'stale', 'copy'];
      const reply = [
        '| category | base | head | panel-a |', '|---|---|---|---|',
        ...categories.map((category, index) => `| generic.${category} | 8 | ${unscoredHead && index > 0 ? 'n/a' : '8'} | ${unscoredAnchors ? 'n/a' : '8'} |`),
        ...categories.map((category, index) => `vs: generic.${category} base=${unscoredHead && index > 0 ? 'n/a' : 'same'} panel-a=${unscoredAnchors || (unscoredHead && index > 0) ? 'n/a' : 'same'} - Compared the evidence.`),
        'gaming: no - checked tests',
      ].join('\n');
      const parsed = parseCriticReply(reply);
      assert.equal(parsed.error, undefined);
      const card = { state: 'ready', profiles: [{ kind: 'generic', critique: { score: 8 } }], critique: { rounds: [{ round: 1, log: 'r1', gaming: 'no', scores: parsed.scores }], findings: [] } };
      const contract = { categories: categories.map((category) => `generic.${category}`), anchors: ['panel-a'] };
      const result = await critiqueLedger.runFixture({ card, logs: { r1: reply }, contract });
      assert.equal(result.pass, false);
      assert.ok(result.failures.some((failure) => failure.rule === expected));
      if (unscoredHead) assert.ok(result.failures.some((failure) => failure.rule === 'critique-coverage' && /not-applicable reason/.test(failure.detail)));
    });
  }

  test('a ready card cannot omit required categories from an applied lens', async () => {
    const reply = '| category | base | head | panel-a |\n|---|---|---|---|\n| ui.hierarchy | 8 | 8 | 8 |\nvs: ui.hierarchy base=same panel-a=same - The hierarchy matches the reference.\ngaming: no - checked tests\n';
    const parsed = parseCriticReply(reply);
    const card = {
      state: 'ready',
      profiles: [{ kind: 'ui', skipped: false, critique: { model: 'strong-model', score: 8 } }],
      critique: { rounds: [{ round: 1, log: 'r1', gaming: 'no', scores: parsed.scores }], findings: [] },
    };
    const result = await critiqueLedger.runFixture({ card, logs: { r1: reply } });
    assert.equal(result.pass, false);
    assert.ok(result.failures.some((failure) => failure.detail.includes('ui.states')));
    for (const category of ['ui.spacing', 'ui.alignment']) {
      assert.ok(result.failures.some((failure) => failure.rule === 'critique-missing' && failure.detail.includes(category)));
    }
  });

  test('the stored plan contract is required and every planned category is checked', async () => {
    const { root } = await makeFixtureRepo({ files: [{ path: 'a.txt', base: 'a\n', head: 'b\n' }], dirs, prefix: 'mend-planned-critique-' });
    const dir = path.join(root, '.mend/evidence/item-1');
    await fs.mkdir(dir, { recursive: true });
    const categories = ['generic.custom-goal', 'generic.custom-evidence'];
    const quality = { plan: { critiqueCategories: categories }, exemplars: [{ label: 'panel-a' }] };
    await fs.writeFile(path.join(dir, 'quality.json'), JSON.stringify(quality));
    const card = { state: 'ready', profiles: [{ kind: 'generic', skipped: false, critique: { model: 'strong', score: 8 } }], critique: { rounds: [], findings: [] } };
    for (const rows of [categories, categories.slice(0, 1)]) {
      const reply = ['| category | base | head | panel-a |', '|---|---|---|---|', ...rows.map((category) => `| ${category} | 7 | 8 | 8 |`), ...rows.map((category) => `vs: ${category} base=better panel-a=same - The change meets this category.`), 'gaming: no - checked'].join('\n');
      await fs.writeFile(path.join(dir, 'r1.md'), reply);
      card.critique.rounds = [{ round: 1, log: '.mend/evidence/item-1/r1.md', gaming: 'no', scores: parseCriticReply(reply).scores }];
      const result = await critiqueLedger.run({ repo: root, item: { id: 'item-1' }, card });
      assert.equal(result.pass, rows.length === categories.length);
      if (!result.pass) assert.ok(result.failures.some((failure) => failure.rule === 'critique-coverage' && /generic.custom-evidence/.test(failure.detail)));
    }
    delete quality.plan.critiqueCategories;
    await fs.writeFile(path.join(dir, 'quality.json'), JSON.stringify(quality));
    const missing = await critiqueLedger.run({ repo: root, item: { id: 'item-1' }, card });
    assert.equal(missing.pass, false);
    assert.ok(missing.failures.some((failure) => failure.rule === 'critique-coverage' && failure.detail === 'expected critique categories are missing'));
  });

  test('a ready card with every installed generic category and scored anchors passes', async () => {
    const categories = await critiqueContract([{ kind: 'generic', critiqueLens: fileURLToPath(new URL('../critique-lens.md', import.meta.url)) }]);
    const reply = ['| category | base | head | panel-a |', '|---|---|---|---|', ...categories.map((category) => `| ${category} | n/a | 8 | 8 |`), ...categories.map((category) => `vs: ${category} base=n/a panel-a=same - The change meets this category.`), 'gaming: no - checked'].join('\n');
    const scores = parseCriticReply(reply).scores;
    const card = { state: 'ready', profiles: [{ kind: 'generic', skipped: false, critique: { model: 'strong', score: 8 } }], critique: { rounds: [{ round: 1, log: 'r1', gaming: 'no', scores }], findings: [] } };
    const contract = { categories, anchors: ['panel-a'] };
    assert.equal((await critiqueLedger.runFixture({ card, logs: { r1: reply }, contract })).pass, true);
    const noAnchors = reply.replace(/\| n\/a \| 8 \| 8 \|/g, '| n/a | 8 | n/a |').replace(/panel-a=same/g, 'panel-a=n/a');
    card.critique.rounds[0].scores = parseCriticReply(noAnchors).scores;
    assert.ok(rulesOf(await critiqueLedger.runFixture({ card, logs: { r1: noAnchors }, contract })).includes('critique-coverage'));
  });

  test('a ready card cannot omit lens categories even when its one score matches the stored reply', async () => {
    const reply = '| category | base | head | panel-a |\n|---|---|---|---|\n| generic.scope | n/a | 9 | 8 |\nvs: generic.scope base=n/a panel-a=same - The change meets this category.\ngaming: no - checked\n';
    const card = { state: 'ready', profiles: [{ kind: 'generic', skipped: false, critique: { model: 'strong', score: 9 } }], critique: {
      rounds: [{ round: 1, log: 'r1', gaming: 'no', scores: { 'generic.scope': { base: null, head: 9, anchors: { 'panel-a': 8 } } } }], findings: [],
    } };
    const result = await critiqueLedger.runFixture({ card, logs: { r1: reply } });
    assert.equal(result.pass, false);
    assert.ok(rulesOf(result).includes('critique-coverage'));
  });

  test('reads the card from .mend/evidence and refuses a reply stored outside the repo', async () => {
    const { root } = await makeFixtureRepo({ files: [{ path: 'a.txt', base: 'a\n', head: 'b\n' }], dirs, prefix: 'mend-critique-ledger-' });
    const outsideName = `${path.basename(root)}-reply.md`;
    const outside = path.join(path.dirname(root), outsideName);
    dirs.push(outside);
    const categories = ['scope', 'evidence', 'derivation', 'floor', 'trust', 'stale', 'copy'];
    const reply = [
      '| category | base | head | panel-a |', '|---|---|---|---|',
      ...categories.map((name) => `| generic.${name} | n/a | 8 | 8 |`), '',
      ...categories.map((name) => `vs: generic.${name} base=n/a panel-a=same - The result matches the reference.`),
      'gaming: no - checked tests', '',
    ].join('\n');
    const round = (number, log) => ({
      round: number,
      critic: 'strong-model',
      log,
      diffStat: '1 file changed',
      gaming: 'no',
      scores: parseCriticReply(reply).scores,
    });
    const card = {
      state: 'ready',
      profiles: [{ kind: 'generic', skipped: false, critique: { model: 'strong-model', score: 8, notes: '' } }],
      critique: { rounds: [round(1, '.mend/evidence/item-1/critique-r1.md'), round(2, `../${outsideName}`)], findings: [] },
    };
    await fs.mkdir(path.join(root, '.mend', 'evidence', 'item-1'), { recursive: true });
    await fs.writeFile(path.join(root, '.mend', 'evidence', 'item-1.json'), JSON.stringify(card));
    await fs.writeFile(path.join(root, '.mend', 'evidence', 'item-1', 'critique-r1.md'), reply);
    await fs.writeFile(outside, reply);

    const result = await critiqueLedger.run({ repo: root, item: { id: 'item-1' } });
    assert.deepEqual(
      result.failures.map((failure) => `${failure.rule} ${failure.target}`),
      ['critique-log-missing critique round 2', 'critique-coverage critique round 1'],
    );
  });

  test('a skipped-only card and a missing card are left to other checks', async () => {
    const skipped = await critiqueLedger.runFixture({ card: { state: 'ready', profiles: [{ kind: 'ui', skipped: true, skipReason: 'no browser' }] } });
    assert.equal(skipped.pass, true);
    const missing = await critiqueLedger.runFixture({ card: null });
    assert.deepEqual(rulesOf(missing), []);
  });

  test('a ready card whose every round is void has no counted critique', async () => {
    const card = {
      state: 'ready',
      profiles: [{ kind: 'generic', skipped: false, critique: { model: 'strong-model', score: 8, notes: '' } }],
      critique: {
        rounds: [{ round: 1, critic: 'strong-model', log: 'r1', diffStat: '1 file', gaming: 'no', void: true, scores: { 'generic.scope': { base: null, head: 8, anchors: { 'panel-a': null } } } }],
        findings: [],
      },
    };
    const logs = { r1: '| category | base | head | panel-a |\n|---|---|---|---|\n| generic.scope | n/a | 8 | n/a |\nvs: generic.scope base=n/a panel-a=n/a - The edit stays inside its declared scope.\ngaming: no - x\n' };
    assert.deepEqual(rulesOf(await critiqueLedger.runFixture({ card, logs })), ['critique-missing']);
  });

  test('a finding resolved in the same round that raised it is not backed', async () => {
    const card = {
      state: 'draft',
      profiles: [],
      critique: {
        rounds: [{ round: 1, critic: 'strong-model', log: 'r1', diffStat: '1 file', gaming: 'no', scores: { 'generic.scope': { base: null, head: 6, anchors: { 'panel-a': null } } } }],
        findings: [{ id: 'F1', severity: 'should', status: 'resolved', round: 1 }],
      },
    };
    const logs = { r1: '| category | base | head | panel-a |\n|---|---|---|---|\n| generic.scope | n/a | 6 | n/a |\nvs: generic.scope base=n/a panel-a=n/a - The edit omits one required output.\ngaming: no - x\n- F1 [should] a.ts:1: x -> y\nresolved: F1\n' };
    assert.deepEqual(rulesOf(await critiqueLedger.runFixture({ card, logs })), ['resolution-unbacked']);
  });
});
