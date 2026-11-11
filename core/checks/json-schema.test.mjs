import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateSchema } from './json-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CARD_SCHEMA = JSON.parse(readFileSync(path.join(HERE, '..', 'skills', 'mend-ship', 'evidence-card.schema.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const [readyExample, mergedExample] = CARD_SCHEMA.examples;

describe('evidence card schema', () => {
  test('proposal approval records the human or supervisor identity, time, reason and artifacts', () => {
    for (const approver of ['human', 'supervisor']) {
      const card = clone(readyExample);
      card.proposalApproval = { approver, by: approver === 'human' ? 'operator' : 'strong-model', at: '2026-01-01T00:00:00.000Z', reason: 'The proposal preserves the declared contract.', artifacts: ['proposal/contract.json'] };
      assert.deepEqual(validateSchema(CARD_SCHEMA, card), []);
      for (const field of ['approver', 'by', 'at', 'reason', 'artifacts']) {
        const missing = clone(card);
        delete missing.proposalApproval[field];
        assert.ok(validateSchema(CARD_SCHEMA, missing).some((error) => error.message.includes(`missing ${field}`)));
      }
      card.proposalApproval.approver = 'owner';
      assert.ok(validateSchema(CARD_SCHEMA, card).length > 0);
    }
  });

  test('both examples in the schema are valid cards', () => {
    for (const example of CARD_SCHEMA.examples) assert.deepEqual(validateSchema(CARD_SCHEMA, example), [], example.item);
  });

  test('red-green cards preserve the procedure used to prove the regression', () => {
    const card = clone(mergedExample);
    Object.assign(card.redGreen, { setup: 'pnpm install --frozen-lockfile', expectBase: 'BUG_SIGNATURE', timeoutMs: 120000, keep: { command: 'node keep.mjs', baseExit: 0, headExit: 0, logs: { base: '', head: '' } } });
    assert.deepEqual(validateSchema(CARD_SCHEMA, card), []);
    card.redGreen.keep.baseExit = 1;
    assert.ok(validateSchema(CARD_SCHEMA, card).length > 0);
    card.redGreen.keep.baseExit = 0;
    card.redGreen.timeoutMs = 0;
    assert.ok(validateSchema(CARD_SCHEMA, card).some((error) => /not above 0/.test(error.message)));
  });

  const broken = [
    ['a ready card without a critique block', () => { const card = clone(readyExample); delete card.critique; return card; }, /missing critique/],
    ['a card without a problem', () => { const card = clone(readyExample); delete card.problem; return card; }, /missing problem/],
    ['a declined finding without a reason', () => { const card = clone(readyExample); delete card.critique.findings[1].reason; return card; }, /missing reason/],
    ['a void round without its reason', () => { const card = clone(readyExample); card.critique.rounds[1].void = true; return card; }, /missing voidReason/],
    ['a score category that is not <profile>.<question>', () => { const card = clone(readyExample); card.critique.rounds[0].scores.Copy = card.critique.rounds[0].scores['ui.copy']; return card; }, /does not match/],
    ['a ui call-out without its after crop', () => { const card = clone(readyExample); delete card.profiles[1].changeCallouts[0].after; return card; }, /missing after/],
    ['a ready card whose auditor did not pass', () => { const card = clone(readyExample); card.verdict.result = 'ISSUES'; return card; }, /must be "PASS"/],
    ['a bugfix card without red-green', () => { const card = clone(mergedExample); delete card.redGreen; return card; }, /missing redGreen/],
    ['an empty notVerified list', () => { const card = clone(mergedExample); card.notVerified = []; return card; }, /fewer than 1 items/],
    ['a merged card outside a granted queue', () => { const card = clone(mergedExample); card.grant.queue = false; return card; }, /must be true/],
  ];
  for (const [name, make, expected] of broken) {
    test(`rejects ${name}`, () => {
      const messages = validateSchema(CARD_SCHEMA, make()).map((error) => `${error.path}: ${error.message}`);
      assert.ok(messages.some((message) => expected.test(message)), messages.join('\n'));
    });
  }
});

describe('validator', () => {
  test('an unknown keyword is refused, so a schema rule cannot go unenforced', () => {
    assert.throws(() => validateSchema({ type: 'object', patternProperties: {} }, {}), /unsupported keyword "patternProperties"/);
  });

  test('oneOf needs exactly one match', () => {
    const schema = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
    assert.deepEqual(validateSchema(schema, 1.5), []);
    assert.equal(validateSchema(schema, 2).length, 1);
  });
});
