import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCritiqueRequest, CritiqueUsageError, main } from './critique-request.mjs';
import { makeFixtureRepo, gitSync, removeAll } from './test-support.mjs';

const dirs = [];
const profilesSource = fileURLToPath(new URL('../profiles/', import.meta.url));
after(() => removeAll(dirs));
async function setup() {
  const repo = await makeFixtureRepo({ dirs, files: [
    { path: 'value.txt', base: 'broken\n', head: 'fixed\n' },
    { path: 'new.txt', base: null, head: 'new test\n' },
  ] });
  const itemPath = path.join(repo.root, 'item.json');
  const logPath = path.join(repo.root, 'test.log');
  await fs.writeFile(itemPath, JSON.stringify({ id: 'T1', profiles: ['bugfix'], goal: 'fix regression' }));
  await fs.writeFile(logPath, 'regression passed\n');
  return { repo: repo.root, baseSha: repo.baseSha, headSha: repo.headSha, itemPath, logPath, round: 1, firstFindingId: 'F1', commands: [{ command: 'test regression', exit: 0, logPath }] };
}

test('assembles profile lenses, materials, versions, logs and complete diff', async () => {
  const options = await setup();
  const proposal = path.join(options.repo, 'reproduction.json');
  await fs.writeFile(proposal, '{"reproduced":true}');
  options.materials = { bugfix: { proposalArtifact: { paths: [proposal] }, exemplars: { note: 'no example supplied' } } };
  const request = await buildCritiqueRequest(options);
  assert.ok(request.indexOf('Lens: generic') < request.indexOf('Lens: bugfix'));
  assert.match(request, /\| bugfix \| proposal artifact \| provided \|/);
  assert.match(request, /\| generic \| proposal artifact \| not applicable \|/);
  assert.match(request, /\| bugfix \| exemplars \| missing \| no example supplied/);
  assert.match(request, /reproduced/);
  assert.match(request, /## Base: value.txt\n\n```text\nbroken/);
  assert.match(request, /## Head: value.txt\n\n```text\nfixed/);
  assert.match(request, /## Base: new.txt\n\nAbsent at base/);
  assert.match(request, /Command: test regression \(exit 0\)/);
  assert.match(request, /## Diff shortstat[\s\S]*2 files changed/);
  assert.match(request, /## Full diff[\s\S]*\+fixed/);
});

test('wraps long log lines without losing content and pretty prints JSON', async () => {
  const options = await setup();
  const line = 'x'.repeat(5000);
  await fs.writeFile(options.logPath, line);
  let request = await buildCritiqueRequest(options);
  assert.ok(request.split('\n').every((entry) => entry.length <= 2000));
  const log = request.split('## Command: test regression (exit 0)\n\n```text\n')[1].split('\n```')[0];
  assert.equal(log.replaceAll('\n', ''), line);
  await fs.writeFile(options.logPath, '{"result":{"pass":true}}');
  request = await buildCritiqueRequest(options);
  assert.match(request, /"result": \{\n    "pass": true/);
});

test('empty required materials are marked missing, including a mixed list', async () => {
  const options = await setup();
  const empty = path.join(options.repo, 'empty-proposal.txt');
  const nonempty = path.join(options.repo, 'proposal.txt');
  await fs.writeFile(empty, ' \n\t');
  await fs.writeFile(nonempty, 'reproduction evidence');
  for (const paths of [[empty], [empty, nonempty]]) {
    const request = await buildCritiqueRequest({ ...options, materials: { bugfix: { proposalArtifact: { paths, note: 'awaiting reproduction' } } } });
    assert.match(request, /\| bugfix \| proposal artifact \| missing \| Empty material:/);
    assert.match(request, /awaiting reproduction/);
    assert.doesNotMatch(request, /\| bugfix \| proposal artifact \| provided \|/);
  }
});

test('handles many short fence sequences without exceeding the argument limit', async () => {
  const options = await setup();
  const log = '`x'.repeat(1_000_000);
  await fs.writeFile(options.logPath, log);
  const request = await buildCritiqueRequest(options);
  const block = request.split('## Command: test regression (exit 0)\n\n')[1];
  const lines = block.split('\n');
  assert.equal(lines[0], '```text');
  const closing = lines.indexOf('```', 1);
  assert.ok(closing > 1);
  assert.equal(lines.slice(1, closing).join(''), log);
  assert.ok(request.split('\n').every((line) => line.length <= 2000));
});

test('preserves large and otherwise noncanonical JSON number tokens', async () => {
  const options = await setup();
  await fs.writeFile(options.logPath, '{"large":9007199254740993,"exponent":1.2300e+50,"negativeZero":-0}');
  const request = await buildCritiqueRequest(options);
  assert.match(request, /"large": 9007199254740993/);
  assert.match(request, /"exponent": 1\.2300e\+50/);
  assert.match(request, /"negativeZero": -0/);
  assert.doesNotMatch(request, /9007199254740992/);
});

test('long sequences of both fence delimiters remain inside a valid bounded fence', async () => {
  const options = await setup();
  const log = `${'`'.repeat(1900)}\n${'~'.repeat(1900)}\nend`;
  await fs.writeFile(options.logPath, log);
  const request = await buildCritiqueRequest(options);
  assert.ok(request.split('\n').every((line) => line.length <= 2000));
  const block = request.split('## Command: test regression (exit 0)\n\n')[1];
  const lines = block.split('\n');
  const opening = lines[0].match(/^(`+|~+)text$/);
  assert.ok(opening);
  const closing = lines.indexOf(opening[1], 1);
  assert.equal(lines.slice(1, closing).join('\n'), log);
  assert.equal(lines[closing + 1], '');
});

async function copyProfiles(options) {
  const target = path.join(options.repo, 'profiles');
  await fs.mkdir(target);
  await fs.copyFile(path.join(profilesSource, 'profile.schema.json'), path.join(target, 'profile.schema.json'));
  for (const kind of ['generic', 'bugfix']) {
    await fs.mkdir(path.join(target, kind));
    for (const name of ['profile.json', 'critique-lens.md']) await fs.copyFile(path.join(profilesSource, kind, name), path.join(target, kind, name));
  }
  return target;
}

test('zero-minimum exemplars are not applicable without a note', async () => {
  const options = await setup();
  const profilesDir = await copyProfiles(options);
  const profileFile = path.join(profilesDir, 'bugfix', 'profile.json');
  const profile = JSON.parse(await fs.readFile(profileFile, 'utf8'));
  profile.exemplars.min = 0;
  await fs.writeFile(profileFile, JSON.stringify(profile));
  const request = await buildCritiqueRequest({ ...options, profilesDir });
  assert.match(request, /\| bugfix \| exemplars \| not applicable \| profile allows zero exemplars \(min: 0\)/);
});

test('none requires a matching index declaration and is rendered distinctly', async () => {
  const options = await setup();
  const materials = { bugfix: { exemplars: { none: 'No earlier bugfix exists.' } } };
  await assert.rejects(buildCritiqueRequest({ ...options, materials }), /exemplar index/i);
  const dir = path.join(options.repo, '.mend/exemplars');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify([{ profile: 'bugfix', none: 'No earlier bugfix exists.', search: { paths: ['src'], gitLogRange: 'HEAD' } }]));
  const request = await buildCritiqueRequest({ ...options, materials });
  assert.match(request, /\| bugfix \| exemplars \| none in repo \| No earlier bugfix exists\./);
  await assert.rejects(buildCritiqueRequest({ ...options, materials: { bugfix: { exemplars: { none: 'Different reason.' } } } }), /exemplar index/i);
  await assert.rejects(buildCritiqueRequest({ ...options, materials: { bugfix: { exemplars: { none: 'No earlier bugfix exists.', paths: ['x'] } } } }), /none/i);
});

test('UI references follow the lens and replace indexed none as exemplar material', async () => {
  const options = await setup();
  await fs.writeFile(options.itemPath, JSON.stringify({ id: 'T1', profiles: ['ui'], uiType: ['tables'] }));
  const dir = path.join(options.repo, '.mend/exemplars');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify([{ profile: 'ui', none: 'No UI examples.', search: { paths: ['src'], gitLogRange: 'HEAD' } }]));
  const request = await buildCritiqueRequest({ ...options, materials: { ui: { exemplars: { none: 'No UI examples.' } } } });
  assert.ok(request.indexOf('Lens: ui') < request.indexOf('UI reference: tables'));
  assert.match(request, /\| ui \| exemplars \| reference \| .*tables\.md/);
  assert.match(request, /Tables, lists, search, filters and pagination/);
});

test('rejects escaped profile lenses and symlinks escaping authorized roots', async () => {
  const options = await setup();
  const profilesDir = await copyProfiles(options);
  const external = path.join(options.repo, 'outside.txt');
  await fs.writeFile(external, 'not authorized as a lens');
  const lens = path.join(profilesDir, 'bugfix', 'critique-lens.md');
  await fs.unlink(lens);
  await fs.symlink(external, lens);
  await assert.rejects(buildCritiqueRequest({ ...options, profilesDir }), /escapes authorized directory/);

  await fs.unlink(lens);
  await fs.copyFile(path.join(profilesSource, 'bugfix', 'critique-lens.md'), lens);
  const profileFile = path.join(profilesDir, 'bugfix', 'profile.json');
  const profile = JSON.parse(await fs.readFile(profileFile, 'utf8'));
  profile.critiqueLens = '../../outside.txt';
  await fs.writeFile(profileFile, JSON.stringify(profile));
  const schemaFile = path.join(profilesDir, 'profile.schema.json');
  const schema = JSON.parse(await fs.readFile(schemaFile, 'utf8'));
  delete schema.properties.critiqueLens.pattern;
  await fs.writeFile(schemaFile, JSON.stringify(schema));
  await assert.rejects(buildCritiqueRequest({ ...options, profilesDir }), /escapes authorized directory/);

  const link = path.join(options.repo, 'linked-log');
  await fs.symlink(external, link);
  await assert.rejects(buildCritiqueRequest({ ...options, commands: [{ command: 'test', exit: 0, logPath: link }] }), /symlink/);
});

test('includes changes since the previous round', async () => {
  const options = await setup();
  const previousHeadSha = options.headSha;
  await fs.writeFile(path.join(options.repo, 'value.txt'), 'fixed again\n');
  gitSync(options.repo, ['add', 'value.txt']);
  gitSync(options.repo, ['commit', '-q', '-m', 'round 2']);
  options.headSha = gitSync(options.repo, ['rev-parse', 'HEAD']);
  const request = await buildCritiqueRequest({ ...options, round: 2, firstFindingId: 'F3', previousHeadSha });
  assert.match(request, /## Diff since previous round[\s\S]*\+fixed again/);
});

test('rejects missing logs, empty diff, empty owner report and .env paths', async () => {
  const options = await setup();
  await assert.rejects(buildCritiqueRequest({ ...options, commands: [{ command: 'test', exit: 0, logPath: path.join(options.repo, 'missing') }] }), CritiqueUsageError);
  await assert.rejects(buildCritiqueRequest({ ...options, headSha: options.baseSha }), CritiqueUsageError);
  const report = path.join(options.repo, 'report.txt');
  await fs.writeFile(report, '  \n');
  await assert.rejects(buildCritiqueRequest({ ...options, ownerReportPath: report }), CritiqueUsageError);
  const env = path.join(options.repo, '.env', 'log');
  await assert.rejects(buildCritiqueRequest({ ...options, commands: [{ command: 'test', exit: 0, logPath: env }] }), CritiqueUsageError);
  let stderr = '';
  const status = await main(['--item', options.itemPath, '--repo', options.repo, '--base', options.baseSha, '--head', options.baseSha, '--round', '1', '--first-finding', 'F1'], { stdout: { write() {} }, stderr: { write(text) { stderr += text; } } });
  assert.equal(status, 64);
  assert.match(stderr, /diff is empty/);
});
