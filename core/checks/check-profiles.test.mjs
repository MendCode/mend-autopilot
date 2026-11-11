import assert from 'node:assert/strict';
import { validateUiReference } from './check-profiles.mjs';

test('UI reference requires all five nonempty sections', () => {
  const good = ['Applies when', 'References', 'Defaults for this type', 'Slop markers for this type', 'Critic checklist'].map((name) => `## ${name}\n\nSynthetic content.`).join('\n\n');
  assert.deepEqual(validateUiReference(good), []);
  assert.ok(validateUiReference(good.replace('## Critic checklist', '## Other')).some((error) => error.includes('Critic checklist')));
  assert.ok(validateUiReference(good.replace('## References\n\nSynthetic content.', '## References')).some((error) => error.includes('References')));
});
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXIT, assertSupportedSchema, checkProfiles, loadProfiles, main, resolveCheck, validateValue } from './check-profiles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SOURCE = path.join(HERE, '..', 'profiles', 'profile.schema.json');
const temporaryRoots = [];

after(async () => {
  for (const root of temporaryRoots) await fs.rm(root, { recursive: true, force: true });
});

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mend-profiles-test-'));
  temporaryRoots.push(root);
  await fs.copyFile(SCHEMA_SOURCE, path.join(root, 'profile.schema.json'));
  return root;
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function baseProfile(kind, overrides = {}) {
  return {
    kind,
    description: `Synthetic ${kind} profile for tests.`,
    matchHints: { paths: [], intents: [] },
    riskFloor: 'low',
    exemplars: { what: 'Two similar files in the repo.', min: 1, max: 3 },
    proposalArtifact: null,
    frozenBaseline: null,
    humanApproval: 'high-risk',
    rubric: ['word-limit'],
    integrationDiff: null,
    critiqueLens: 'critique-lens.md',
    roundBudget: 2,
    fileCap: 4,
    quantityApplies: false,
    cardFields: [],
    ...overrides,
  };
}

// A synthetic check: fails when a text has more than `limit` words.
const WORD_LIMIT_CHECK = `
function score({ text, limit }) {
  const words = text.trim().split(/\\s+/).filter(Boolean).length;
  if (words <= limit) return { pass: true, failures: [] };
  return { pass: false, failures: [{ target: 'text', rule: 'max-words', detail: words + ' words, limit ' + limit }] };
}
export default {
  id: 'word-limit',
  description: 'Text stays within a word limit.',
  async run({ config }) { return score(config); },
  async runFixture(fixture) { return score(fixture.input); },
};
`;

async function addProfile(root, relativeDir, profile, { check = WORD_LIMIT_CHECK, fixtures = 'both', lens = true } = {}) {
  const dir = path.join(root, relativeDir);
  await writeFile(path.join(dir, 'profile.json'), profile);
  if (lens) await writeFile(path.join(dir, 'critique-lens.md'), '# Lens\n\nLook for one thing.\n');
  if (check) await writeFile(path.join(dir, 'checks', 'word-limit.mjs'), check);
  if (fixtures === 'both' || fixtures === 'pass') {
    await writeFile(path.join(dir, 'fixtures', 'word-limit', 'pass-short.json'), { input: { text: 'two words', limit: 3 } });
  }
  if (fixtures === 'both' || fixtures === 'fail') {
    await writeFile(path.join(dir, 'fixtures', 'word-limit', 'fail-long.json'), {
      input: { text: 'one two three four five', limit: 3 },
      expect: ['max-words'],
    });
  }
  return dir;
}

function captureStreams() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: (chunk) => err.push(chunk) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('schema subset validator', () => {
  test('the shipped profile schema uses only supported keywords', async () => {
    const schema = JSON.parse(await fs.readFile(SCHEMA_SOURCE, 'utf8'));
    assert.doesNotThrow(() => assertSupportedSchema(schema));
  });

  test('an unsupported keyword is rejected instead of silently ignored', () => {
    assert.throws(() => assertSupportedSchema({ type: 'object', properties: { a: { oneOf: [] } } }), /unsupported keyword "oneOf"/);
  });

  test('nullable union types, enums, patterns and minimums are enforced', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'size'],
      properties: {
        name: { type: ['string', 'null'], pattern: '^[a-z]+$' },
        size: { type: 'integer', minimum: 1 },
        tier: { enum: ['low', 'high'] },
      },
    };
    assert.deepEqual(validateValue(schema, { name: null, size: 2 }), []);
    const errors = validateValue(schema, { name: 'Upper', size: 0, tier: 'mid', extra: true }).map((error) => error.path);
    assert.deepEqual(errors.sort(), ['extra', 'name', 'size', 'tier']);
    assert.deepEqual(validateValue(schema, { size: 1.5 }).map((error) => error.message).sort(), ['is required', 'must be integer']);
  });
});

describe('loadProfiles', () => {
  for (const value of [true, false]) {
    test(`legacy humanApproval ${value} is rejected with migration guidance`, async () => {
      const root = await makeRoot();
      await addProfile(root, 'notes', baseProfile('notes', { humanApproval: value }));
      await assert.rejects(loadProfiles(root), /humanApproval: booleans are no longer supported; use "always".*"high-risk"/);
      const io = captureStreams();
      assert.equal(await main([root], io), EXIT.invalid);
      assert.match(io.err(), /humanApproval: booleans are no longer supported/);
    });
  }

  test('approval policies accept only always and high-risk', async () => {
    const schema = JSON.parse(await fs.readFile(SCHEMA_SOURCE, 'utf8'));
    for (const value of ['always', 'high-risk']) assert.deepEqual(validateValue(schema, baseProfile('notes', { humanApproval: value })), []);
    for (const value of ['never', null, 1]) {
      assert.ok(validateValue(schema, baseProfile('notes', { humanApproval: value })).some((error) => error.path === 'humanApproval'));
    }
  });

  test('a valid profile loads with its folder path', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'));
    const profiles = await loadProfiles(root);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].kind, 'notes');
    assert.equal(profiles[0].dir, path.join(root, 'notes'));
  });

  test('a missing required field throws a tagged TypeError naming kind and field', async () => {
    const root = await makeRoot();
    const profile = baseProfile('notes');
    delete profile.roundBudget;
    await addProfile(root, 'notes', profile);
    await assert.rejects(loadProfiles(root), (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /^\[PROFILES\]: notes: roundBudget: is required$/);
      return true;
    });
  });

  test('kind must equal the folder name', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('memo'));
    await assert.rejects(loadProfiles(root), /\[PROFILES\]: memo: kind "memo" must equal its folder name "notes"/);
  });

  test('a duplicate kind in a nested category folder is rejected', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'));
    await addProfile(root, path.join('writing', 'notes'), baseProfile('notes'));
    await assert.rejects(loadProfiles(root), /\[PROFILES\]: notes: duplicate kind/);
  });

  test('a missing critique lens file is rejected', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'), { lens: false });
    await assert.rejects(loadProfiles(root), /critiqueLens: critique-lens\.md not found/);
  });

  test('a proposal without a frozen baseline is rejected', async () => {
    const root = await makeRoot();
    const profile = baseProfile('notes', { proposalArtifact: { name: 'outline', what: 'Section list' } });
    await addProfile(root, 'notes', profile);
    await assert.rejects(loadProfiles(root), /frozenBaseline: must be null exactly when proposalArtifact is null/);
  });

  test('profile.json files inside fixtures folders are not discovered', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'));
    await writeFile(path.join(root, 'notes', 'fixtures', 'word-limit', 'profile.json'), { not: 'a profile' });
    assert.equal((await loadProfiles(root)).length, 1);
  });
});

describe('resolveCheck', () => {
  test('a profile check module resolves before any repo command', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'));
    const repo = await makeRoot();
    await writeFile(path.join(repo, '.mend', 'quality.json'), { checks: { 'word-limit': { command: 'exit 1' } } });
    const [profile] = await loadProfiles(root);
    const check = await resolveCheck(profile, 'word-limit', { repo });
    assert.equal(check.source, 'profile');
  });

  test('an unresolved check id throws naming the id and both places it looked', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'));
    const [profile] = await loadProfiles(root);
    await assert.rejects(resolveCheck(profile, 'spell-check'), /\[PROFILES\]: notes: check spell-check does not resolve \(no checks\/spell-check\.mjs and no command in \.mend\/quality\.json\)/);
  });

  test('a repo command from .mend/quality.json resolves and receives the SHAs', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'));
    const repo = await makeRoot();
    await writeFile(path.join(repo, '.mend', 'quality.json'), {
      checks: {
        'spell-check': { command: 'test "$MEND_BASE_SHA" = aaa && test "$MEND_HEAD_SHA" = bbb', description: 'Repo spell check' },
        'always-red': { command: 'echo broken word; exit 3' },
      },
    });
    const [profile] = await loadProfiles(root);
    const green = await resolveCheck(profile, 'spell-check', { repo });
    assert.equal(green.source, 'repo');
    assert.deepEqual(await green.run({ repo, baseSha: 'aaa', headSha: 'bbb' }), { pass: true, failures: [] });
    const wrongSha = await green.run({ repo, baseSha: 'zzz', headSha: 'bbb' });
    assert.equal(wrongSha.pass, false);
    const red = await (await resolveCheck(profile, 'always-red', { repo })).run({ repo, baseSha: 'a', headSha: 'b' });
    assert.equal(red.pass, false);
    assert.equal(red.failures[0].rule, 'command-exit');
    assert.match(red.failures[0].detail, /^exit 3: broken word/);
  });

  test('failed repo commands retain assertions preceding a long summary', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'));
    const repo = await makeRoot();
    await writeFile(path.join(repo, '.mend', 'quality.json'), {
      checks: { failed: { command: "printf 'AssertionError: expected 2\\n'; seq 1 40; exit 1" } },
    });
    const [profile] = await loadProfiles(root);
    const result = await (await resolveCheck(profile, 'failed', { repo })).run({ repo });
    assert.equal(result.pass, false);
    assert.match(result.failures[0].detail, /AssertionError: expected 2/);
    assert.match(result.failures[0].detail, /40/);
  });

  test('repo commands are blocked by the guard before any part of the shell runs', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'));
    const [profile] = await loadProfiles(root);
    const repo = await makeRoot();
    await writeFile(path.join(repo, '.mend', 'guard.json'), { productionPatterns: ['guard-policy-target'] });
    for (const [command, rule] of [
      ['touch unguarded-marker; cat .env', 'secret-read'],
      ['touch unguarded-marker; printf guard-policy-target', 'production-pattern'],
    ]) {
      await writeFile(path.join(repo, '.mend', 'quality.json'), { checks: { guarded: { command } } });
      const check = await resolveCheck(profile, 'guarded', { repo });
      const result = await check.run({ repo, item: { id: 'guarded' } });
      assert.equal(result.pass, false);
      assert.equal(result.blocked, true);
      assert.equal(result.failures[0].rule, 'guard-blocked');
      assert.match(result.failures[0].detail, new RegExp(rule));
      await assert.rejects(fs.access(path.join(repo, 'unguarded-marker')));
    }
  });

  test('a check module with the wrong id is rejected', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'), { check: WORD_LIMIT_CHECK.replace("id: 'word-limit'", "id: 'other'") });
    const [profile] = await loadProfiles(root);
    await assert.rejects(resolveCheck(profile, 'word-limit'), /exports id "other"/);
  });
});

describe('checkProfiles registry', () => {
  test('a valid profile with passing and failing fixtures is ok', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'));
    const report = await checkProfiles(root);
    assert.deepEqual(report, { ok: true, kinds: ['notes'], reasons: [] });
  });

  test('a check that has never been seen failing is rejected', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'), { fixtures: 'pass' });
    const report = await checkProfiles(root);
    assert.equal(report.ok, false);
    assert.deepEqual(report.reasons, [{ kind: 'notes', reason: 'check word-limit: no failing fixture (fixtures/word-limit/fail-*.json)' }]);
  });

  test('a fail fixture that passes is rejected', async () => {
    const root = await makeRoot();
    const dir = await addProfile(root, 'notes', baseProfile('notes'), { fixtures: 'pass' });
    await writeFile(path.join(dir, 'fixtures', 'word-limit', 'fail-not-really.json'), { input: { text: 'short', limit: 3 } });
    const report = await checkProfiles(root);
    assert.deepEqual(report.reasons, [{ kind: 'notes', reason: 'check word-limit: fixture fail-not-really.json should fail but passed' }]);
  });

  test('a fail fixture that fails for the wrong rule is rejected', async () => {
    const root = await makeRoot();
    const dir = await addProfile(root, 'notes', baseProfile('notes'), { fixtures: 'pass' });
    await writeFile(path.join(dir, 'fixtures', 'word-limit', 'fail-wrong-rule.json'), {
      input: { text: 'one two three four', limit: 3 },
      expect: ['min-font'],
    });
    const report = await checkProfiles(root);
    assert.deepEqual(report.reasons, [{ kind: 'notes', reason: 'check word-limit: fixture fail-wrong-rule.json failed on max-words, expected min-font' }]);
  });

  test('a rubric id that resolves nowhere is reported, not thrown', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes', { rubric: ['word-limit', 'tone-check'] }));
    const report = await checkProfiles(root);
    assert.deepEqual(report.reasons, [{ kind: 'notes', reason: 'check tone-check does not resolve (no checks/tone-check.mjs and no command in .mend/quality.json)' }]);
  });

  test('a new work kind is added by adding a folder, with no core edit', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'));
    const before = await fs.readFile(path.join(HERE, 'check-profiles.mjs'), 'utf8');
    await addProfile(root, path.join('tools', 'cli-tool'), baseProfile('cli-tool', { riskFloor: 'medium', matchHints: { paths: ['bin/**'], intents: ['flag', 'subcommand'] } }));
    const report = await checkProfiles(root);
    assert.deepEqual(report, { ok: true, kinds: ['notes', 'cli-tool'], reasons: [] });
    assert.equal(await fs.readFile(path.join(HERE, 'check-profiles.mjs'), 'utf8'), before);
    assert.doesNotMatch(before, /cli-tool|'notes'|'ui'|'generic'/);
  });

  test('reference sections are validated for any profile that has references', async () => {
    const root = await makeRoot();
    const dir = await addProfile(root, 'notes', baseProfile('notes'));
    await writeFile(path.join(dir, 'references', 'example.md'), '## Applies when\n\nSynthetic use.\n');
    const report = await checkProfiles(root);
    assert.equal(report.ok, false);
    assert.ok(report.reasons.some(({ kind, reason }) => kind === 'notes' && reason.includes('references/example.md') && reason.includes('Critic checklist')));
  });
});

describe('CLI', () => {
  test('exit 0 lists the valid kinds', async () => {
    const root = await makeRoot();
    await addProfile(root, 'notes', baseProfile('notes'));
    const io = captureStreams();
    assert.equal(await main([root], io), EXIT.ok);
    assert.equal(io.out(), '[PROFILES]: 1 profiles valid: notes\n');
  });

  test('exit 1 prints one tagged line per reason', async () => {
    const root = await makeRoot();
    const profile = baseProfile('notes');
    delete profile.fileCap;
    await addProfile(root, 'notes', profile);
    const io = captureStreams();
    assert.equal(await main([root], io), EXIT.invalid);
    assert.equal(io.err(), '[PROFILES]: notes: fileCap: is required\n');
  });

  test('exit 64 for a missing directory or an unknown flag', async () => {
    const io = captureStreams();
    assert.equal(await main([path.join(os.tmpdir(), 'mend-profiles-does-not-exist')], io), EXIT.usage);
    assert.equal(await main(['--fix'], captureStreams()), EXIT.usage);
    assert.match(io.err(), /profiles directory not found/);
  });
});
