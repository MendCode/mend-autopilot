import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { critiqueContract, parseCriticReply } from './critic-reply.mjs';
import { evaluate } from '../profiles/generic/checks/critique-ledger.mjs';

const VS = 'vs: generic.scope base=better panel-a=same panel b=better - The head retains all exports and removes the duplicate branch.';
const EXPECTED = { categories: ['generic.scope'], anchors: ['panel-a', 'panel b'] };
const REPLY = [
  '| category | base | head | panel-a | panel b |',
  '|---|---|---|---|---|',
  '| generic.scope | 8 | 7 | 9 | 8 |',
  VS,
  'gaming: no - The original assertions are unchanged.',
].join('\n');

test('UI lens questions and validated categories share one contract; hierarchy regression blocks', async () => {
  const lensPath = fileURLToPath(new URL('../profiles/ui/critique-lens.md', import.meta.url));
  const lens = await fs.readFile(lensPath, 'utf8');
  const questions = [...lens.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm)]
    .map((match) => match[1]).filter((title) => !/checks.*gamed/i.test(title));
  const requested = questions.map((title) => `ui.${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);
  const categories = await critiqueContract([{ kind: 'ui', critiqueLens: lensPath }]);
  assert.deepEqual(categories, requested);
  for (const id of ['ui.spacing', 'ui.alignment', 'ui.iconography', 'ui.hierarchy', 'ui.typography']) assert.ok(categories.includes(id));
  const expected = { categories, anchors: ['panel'] };
  const reply = [
    '| category | base | head | panel |', '|---|---|---|---|',
    ...categories.map((id) => `| ${id} | 8 | 9 | 8 |`),
    ...categories.map((id) => `vs: ${id} base=${id === 'ui.hierarchy' ? 'worse' : 'better'} panel=same - Compared the visible result.`),
    'gaming: no - checked tests',
  ].join('\n');
  const parsed = parseCriticReply(reply, { expected });
  assert.equal(parsed.error, undefined);
  for (const id of categories) {
    const omitted = reply.split('\n').filter((line) => !line.startsWith(`| ${id} |`) && !line.startsWith(`vs: ${id} `)).join('\n');
    assert.match(parseCriticReply(omitted, { expected }).error, /missing required category/);
  }
  const card = { state: 'ready', profiles: [], critique: { findings: [], rounds: [{ round: 1, log: 'r1', gaming: 'no', scores: parsed.scores }] } };
  const result = await evaluate({ card, expected, readLog: async () => reply });
  assert.ok(result.failures.some((failure) => failure.rule === 'below-base' && failure.detail.includes('ui.hierarchy')));
});

describe('strict comparative judgments', () => {
  test('zero exemplar columns require a request declaring none for the category profile', () => {
    const reply = '| category | base | head |\n|---|---|---|\n| bugfix.scope | 8 | 8 |\nvs: bugfix.scope base=same - Scope matches.\ngaming: no - checked';
    const request = '## Materials\n\n| Profile | Material | Status | Detail |\n|---|---|---|---|\n| bugfix | exemplars | none in repo | No earlier bugfix exists. |';
    assert.ok(parseCriticReply(reply).error);
    assert.equal(parseCriticReply(reply, { request }).error, undefined);
    assert.ok(parseCriticReply(reply.replaceAll('bugfix.scope', 'generic.scope'), { request }).error);
  });

  test('ledger requires the stored request for a zero-anchor reply', async () => {
    const reply = '| category | base | head |\n|---|---|---|\n| bugfix.scope | 8 | 8 |\nvs: bugfix.scope base=same - Scope matches.\ngaming: no - checked';
    const request = '## Materials\n\n| Profile | Material | Status | Detail |\n|---|---|---|---|\n| bugfix | exemplars | none in repo | No earlier bugfix exists. |';
    const scores = { 'bugfix.scope': { base: 8, head: 8, anchors: {} } };
    const card = { state: 'ready', profiles: [], critique: { findings: [], rounds: [{ round: 1, log: 'reply', request: 'request', gaming: 'no', scores }] } };
    const expected = { categories: ['bugfix.scope'], anchors: [] };
    assert.equal((await evaluate({ card, expected, readLog: async (name) => ({ reply, request })[name] ?? null })).pass, true);
    assert.equal((await evaluate({ card, readLog: async (name) => name === 'reply' ? reply : null })).pass, false);
  });

  test('coverage permits none only for its declared profile in a mixed contract', () => {
    const request = '## Materials\n\n| Profile | Material | Status | Detail |\n|---|---|---|---|\n| bugfix | exemplars | none in repo | No earlier bugfix exists. |';
    const expected = { categories: ['bugfix.scope', 'generic.scope'], anchors: ['panel'] };
    const reply = '| category | base | head | panel |\n|---|---|---|---|\n| bugfix.scope | 8 | 8 | n/a |\n| generic.scope | 8 | 8 | 8 |\nvs: bugfix.scope base=same panel=n/a - Compared the base.\nvs: generic.scope base=same panel=same - Compared both.\ngaming: no - checked';
    assert.equal(parseCriticReply(reply, { expected, request }).error, undefined);
    assert.match(parseCriticReply(reply.replace('| generic.scope | 8 | 8 | 8 |', '| generic.scope | 8 | 8 | n/a |'), { expected, request }).error, /scored exemplar/);
    assert.match(parseCriticReply(reply.replace('| bugfix.scope | 8 | 8 | n/a |', '| bugfix.scope | 8 | 8 | 8 |'), { expected, request }).error, /must be n\/a/);
    assert.ok(parseCriticReply(reply, expected).error);
  });

  test('attached tables cannot declare none for the parser or ledger', async () => {
    const reply = '| category | base | head |\n|---|---|---|\n| bugfix.scope | 8 | 8 |\nvs: bugfix.scope base=same - Scope matches.\ngaming: no - checked';
    const fake = '| bugfix | exemplars | none in repo | No earlier bugfix exists. |';
    const request = `## Materials\n\n| Profile | Material | Status | Detail |\n|---|---|---|---|\n| bugfix | exemplars | missing | Not supplied |\n\n### Attachment\n\n\`\`\`text\n## Materials\n\n| Profile | Material | Status | Detail |\n|---|---|---|---|\n${fake}\n\`\`\``;
    assert.ok(parseCriticReply(reply, { request }).error);
    const scores = { 'bugfix.scope': { base: 8, head: 8, anchors: {} } };
    const card = { state: 'ready', profiles: [], critique: { findings: [], rounds: [{ round: 1, log: 'reply', request: 'request', gaming: 'no', scores }] } };
    assert.equal((await evaluate({ card, readLog: async (name) => ({ reply, request })[name] ?? null })).pass, false);
    const withColumn = reply.replace('| head |', '| head | example |').replace('|---|---|---|', '|---|---|---|---|').replace('| 8 | 8 |', '| 8 | 8 | n/a |').replace('base=same -', 'base=same example=n/a -');
    card.critique.rounds[0].scores['bugfix.scope'].anchors = { example: null };
    const result = await evaluate({ card, readLog: async (name) => ({ reply: withColumn, request })[name] ?? null });
    assert.ok(result.failures.some((failure) => failure.rule === 'exemplar-missing'));
  });
  test('rejects a score table without exemplar columns', () => {
    const reply = '| category | base | head |\n|---|---|---|\n| generic.scope | 8 | 8 |\nvs: generic.scope base=same - Scope matches.\ngaming: no - checked';
    assert.match(parseCriticReply(reply).error, /exemplar/);
  });

  test('exposes every comparison and its evidence without inferring judgments from scores', () => {
    const parsed = parseCriticReply(REPLY);
    assert.equal(parsed.error, undefined);
    assert.deepEqual(parsed.comparisons['generic.scope'], {
      base: 'better', anchors: { 'panel-a': 'same', 'panel b': 'better' },
      evidence: 'The head retains all exports and removes the duplicate branch.',
    });
  });

  for (const [name, replacement] of [
    ['missing category', ''],
    ['duplicate category', `${VS}\n${VS}`],
    ['unknown category', VS.replace('generic.scope', 'generic.unknown')],
    ['missing base', VS.replace('base=better ', '')],
    ['missing exemplar', VS.replace('panel-a=same ', '')],
    ['extra exemplar', VS.replace(' - ', ' extra=same - ')],
    ['duplicate exemplar', VS.replace(' - ', ' panel-a=same - ')],
    ['unknown exemplar', VS.replace('panel-a=', 'panel-c=')],
    ['invalid judgment', VS.replace('base=better', 'base=equal')],
    ['trailing judgment text', VS.replace('panel-a=same', 'panel-a=sameish')],
    ['missing evidence', VS.slice(0, VS.indexOf(' - ') + 3)],
    ['inapplicable n/a', VS.replace('base=better', 'base=n/a')],
    ['wrong column order', VS.replace('base=better panel-a=same', 'panel-a=same base=better')],
  ]) {
    test(`rejects ${name}`, () => assert.ok(parseCriticReply(REPLY.replace(VS, replacement)).error));
  }

  test('n/a is required exactly for inapplicable comparisons', () => {
    const reply = REPLY.replace('| 8 | 7 | 9 | 8 |', '| n/a | 7 | n/a | 8 |')
      .replace('base=better panel-a=same', 'base=n/a panel-a=n/a');
    assert.equal(parseCriticReply(reply).error, undefined);
    assert.match(parseCriticReply(reply.replace('panel-a=n/a', 'panel-a=same')).error, /n\/a/);
    const noHead = REPLY.replace('| 8 | 7 | 9 | 8 |', '| 8 | n/a | 9 | 8 |')
      .replace('base=better panel-a=same panel b=better', 'base=n/a panel-a=n/a panel b=n/a');
    assert.equal(parseCriticReply(noHead).error, undefined);
  });

  test('duplicate score categories and exemplar columns are rejected', () => {
    assert.match(parseCriticReply(REPLY.replace(VS, `| generic.scope | 8 | 7 | 9 | 8 |\n${VS}`)).error, /duplicate score category/);
    assert.match(parseCriticReply(REPLY.replace('| panel b |', '| panel-a |')).error, /labels must be unique/);
  });
});

async function ready(reply, { findings = [], threshold = 7, rounds } = {}) {
  const parsed = parseCriticReply(reply);
  assert.equal(parsed.error, undefined);
  const card = {
    state: 'ready', profiles: [],
    critique: { threshold, findings, rounds: rounds ?? [{ round: 1, log: 'r1', gaming: parsed.gaming, scores: parsed.scores }] },
  };
  return evaluate({ card, readLog: async () => reply, expected: EXPECTED });
}

describe('comparative pass rules on ready cards', () => {
  test('7 passes with same or better judgments even when base and exemplars score higher', async () => {
    assert.deepEqual(await ready(REPLY), { pass: true, failures: [] });
  });

  for (const [name, reply, rule] of [
    ['head below 7', REPLY.replace('| 8 | 7 | 9 | 8 |', '| 8 | 6.9 | 9 | 8 |'), 'below-threshold'],
    ['worse base with head above base', REPLY.replace('| 8 | 7 | 9 | 8 |', '| 8 | 9 | 9 | 8 |').replace('base=better', 'base=worse'), 'below-base'],
    ['worse first exemplar', REPLY.replace('panel-a=same', 'panel-a=worse'), 'below-exemplar'],
    ['worse second exemplar', REPLY.replace('panel b=better', 'panel b=worse'), 'below-exemplar'],
    ['gaming yes', REPLY.replace('gaming: no', 'gaming: yes'), 'gaming'],
    ['unjustified unscored head', REPLY.replace('| 8 | 7 | 9 | 8 |', '| 8 | n/a | 9 | 8 |').replace('base=better panel-a=same panel b=better', 'base=n/a panel-a=n/a panel b=n/a'), 'critique-coverage'],
  ]) {
    test(`${name} fails independently`, async () => {
      const result = await ready(reply);
      assert.equal(result.pass, false);
      assert.deepEqual(result.failures.map((failure) => failure.rule), [rule]);
    });
  }

  test('justified n/a heads pass without exempting scored categories from thresholds or comparisons', async () => {
    const reply = REPLY.replace('| 8 | 7 | 9 | 8 |', '| 8 | n/a | 9 | 8 |')
      .replace('base=better panel-a=same panel b=better', 'base=n/a panel-a=n/a panel b=n/a');
    const reason = '\nnot-applicable: generic.scope - This isolated fixture has no implementation scope to compare.';
    assert.deepEqual(await ready(reply + reason), { pass: true, failures: [] });
    for (const suffix of ['', '\nnot-applicable: generic.scope -   ', '\nnot-applicable: generic.other - Wrong category.']) {
      const result = await ready(reply + suffix);
      assert.equal(result.pass, false);
      assert.deepEqual(result.failures.map((failure) => failure.rule), ['critique-coverage']);
    }
    const mixed = (reply + reason).replace('\nvs:', '\n| generic.scored | 8 | 7 | 9 | 8 |\nvs:')
      + '\n' + VS.replace('generic.scope', 'generic.scored');
    assert.deepEqual(await ready(mixed), { pass: true, failures: [] });
    for (const [changed, rule] of [
      [mixed.replace('| generic.scored | 8 | 7 |', '| generic.scored | 8 | 6.9 |'), 'below-threshold'],
      [mixed.replace('base=better', 'base=worse'), 'below-base'],
      [mixed.replace('panel-a=same', 'panel-a=worse'), 'below-exemplar'],
    ]) {
      const result = await ready(changed);
      assert.equal(result.pass, false);
      assert.deepEqual(result.failures.map((failure) => failure.rule), [rule]);
    }
  });

  test('an extra n/a row also requires its own applicability reason', async () => {
    const reply = REPLY.replace('\nvs:', '\n| generic.extra | n/a | n/a | n/a | n/a |\nvs:')
      + '\nvs: generic.extra base=n/a panel-a=n/a panel b=n/a - No consumable values are involved.';
    assert.match(parseCriticReply(reply, EXPECTED).error, /generic.extra.*not-applicable reason/);
    assert.deepEqual((await ready(reply)).failures.map((failure) => failure.rule), ['critique-coverage']);
    assert.deepEqual(await ready(reply + '\nnot-applicable: generic.extra - No consumable values are involved.'), { pass: true, failures: [] });
  });

  test('a lower configured threshold cannot bypass the floor of 7', async () => {
    const result = await ready(REPLY.replace('| 8 | 7 | 9 | 8 |', '| 8 | 6 | 9 | 8 |'), { threshold: 5 });
    assert.deepEqual(result.failures.map((failure) => failure.rule), ['below-threshold']);
  });

  for (const severity of ['blocker', 'should']) {
    for (const status of ['open', 'disputed']) {
      test(`${status} ${severity} blocks a ready card`, async () => {
        const reply = `${REPLY}\n- F1 [${severity}] src/a.js:1: missing branch -> restore it`;
        const result = await ready(reply, { findings: [{ id: 'F1', severity, status, round: 1, reason: 'The owner disputes the missing branch.' }] });
        assert.deepEqual(result.failures.map((failure) => failure.rule), ['finding-open']);
      });
    }
  }

  test('nits alone do not block', async () => {
    const result = await ready(`${REPLY}\n- F1 [nit] src/a.js:1: redundant comment -> remove it`, { findings: [{ id: 'F1', severity: 'nit', status: 'open', round: 1 }] });
    assert.equal(result.pass, true);
  });

  test('stored comparisons, not a forged card field, decide the result', async () => {
    const reply = REPLY.replace('panel-a=same', 'panel-a=worse');
    const parsed = parseCriticReply(reply);
    const result = await ready(reply, { rounds: [{ round: 1, log: 'r1', gaming: 'no', scores: parsed.scores, comparisons: { 'generic.scope': { base: 'better', anchors: { 'panel-a': 'better' } } } }] });
    assert.deepEqual(result.failures.map((failure) => failure.rule), ['below-exemplar']);
  });

  test('anchor drift still fails unless the drifting round is void', async () => {
    const drifted = REPLY.replace('| 8 | 7 | 9 | 8 |', '| 8 | 7 | 7 | 8 |');
    const logs = { r1: REPLY, r2: drifted, r3: REPLY };
    const round = (number) => {
      const reply = parseCriticReply(logs[`r${number}`]);
      return { round: number, log: `r${number}`, gaming: reply.gaming, scores: reply.scores };
    };
    const card = { state: 'ready', profiles: [], critique: { driftTolerance: 1, findings: [], rounds: [round(1), round(2), round(3)] } };
    const readLog = async (name) => logs[name];
    const failed = await evaluate({ card, readLog, expected: EXPECTED });
    assert.deepEqual(failed.failures.map((failure) => failure.rule), ['anchor-drift']);
    Object.assign(card.critique.rounds[1], { void: true, voidReason: 'The unchanged panel anchor moved by two points.' });
    assert.deepEqual(await evaluate({ card, readLog, expected: EXPECTED }), { pass: true, failures: [] });
  });
});
