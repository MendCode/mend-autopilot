import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadReviewPolicy } from './review-policy.mjs';
import { scanDiff } from './integrity.mjs';
import { collectChanges } from './changes.mjs';
import { buildCritiqueRequest } from './critique-request.mjs';
import { makeFixtureRepo, gitSync, removeAll } from './test-support.mjs';

const dirs = [];
after(() => removeAll(dirs));

for (const custom of [false, true]) {
  test(`${custom ? 'configured' : 'default'} artifacts are absent from review and integrity, not real changes`, async () => {
    const artifacts = custom
      ? ['cache/root.cache', 'cache/nested/other.cache']
      : ['root.tsbuildinfo', 'nested/build.tsbuildinfo', '__pycache__/root.pyc', 'nested/__pycache__/helper.pyc'];
    const config = custom ? JSON.stringify({ generatedFiles: ['cache/**'] }) : '{}';
    const history = await makeFixtureRepo({ dirs, files: [
      { path: '.gitignore', base: '.mend/\n', head: '.mend/\n' },
      { path: 'src/value.js', base: 'export const value = 1;\n', head: 'export const value = 2;\n' },
      { path: 'src/outside.js', base: null, head: 'export const other = 3;\n' },
      ...artifacts.map((file) => ({ path: file, base: 'old artifact\n', head: 'new artifact\n' })),
    ] });
    await fs.mkdir(path.join(history.root, '.mend'), { recursive: true });
    await fs.writeFile(path.join(history.root, '.mend/quality.json'), config);
    const item = { id: 'fixture', profiles: [], editSet: ['src/value.js'], goal: 'update value' };
    const result = await scanDiff({ repo: history.root, ...history, item });
    assert.ok(result.flags.some((flag) => flag.rule === 'out-of-scope' && flag.file === 'src/outside.js'));
    assert.ok(result.flags.every((flag) => !artifacts.includes(flag.file)));
    const changes = await collectChanges({ repo: history.root, ...history });
    assert.deepEqual(changes.map((entry) => entry.path).sort(), ['src/outside.js', 'src/value.js']);
    const itemPath = path.join(history.root, '.mend/item.json');
    await fs.writeFile(itemPath, JSON.stringify(item));
    const request = await buildCritiqueRequest({ repo: history.root, ...history, itemPath, round: 2, firstFindingId: 'F1', previousHeadSha: history.baseSha });
    for (const artifact of artifacts) assert.ok(!request.includes(artifact), artifact);
    assert.match(request, /\+export const value = 2/);
    assert.match(request, /src\/outside.js/);
    assert.match(request, /normal install without an extra service/);
    assert.match(request, /cut diff growth/);
  });
}

test('base policy wins over head edits, including attempts to hide real source', async () => {
  const history = await makeFixtureRepo({ dirs, files: [
    { path: '.mend/quality.json', base: '{"generatedFiles":[]}', head: '{"generatedFiles":["**"]}' },
    { path: 'src/value.js', base: 'old\n', head: 'new\n' },
    { path: 'build.tsbuildinfo', base: 'old\n', head: 'new\n' },
  ] });
  const policy = await loadReviewPolicy({ repo: history.root, ...history });
  assert.deepEqual(policy.generatedFiles, []);
  const changes = await collectChanges({ repo: history.root, ...history });
  assert.ok(changes.some((entry) => entry.path === 'src/value.js'));
  assert.ok(changes.some((entry) => entry.path === 'build.tsbuildinfo'));
});

test('an untracked propagated verification skill is setup, but a tracked one stays reviewable', async () => {
  const history = await makeFixtureRepo({ dirs, files: [
    { path: '.mendcode/skills/verify-tracked/SKILL.md', base: 'old\n', head: 'old\n' },
    { path: 'src/value.js', base: 'old\n', head: 'new\n' },
  ] });
  await fs.mkdir(path.join(history.root, '.mendcode/skills/verify-copied/scripts'), { recursive: true });
  await fs.writeFile(path.join(history.root, '.mendcode/skills/verify-copied/scripts/verify.mjs'), 'copied\n');
  const policy = await loadReviewPolicy({ repo: history.root, ...history });
  assert.ok(policy.generatedFiles.includes('.mendcode/skills/verify-copied/**'));
  assert.ok(!policy.generatedFiles.some((glob) => glob.includes('verify-tracked')));
  const status = gitSync(history.root, ['status', '--porcelain', '--untracked-files=all', '--', ...policy.pathspec]);
  assert.doesNotMatch(status, /verify-copied/);
});

test('untrusted head-only policy cannot hide changes', async () => {
  const history = await makeFixtureRepo({ dirs, files: [
    { path: '.mend/quality.json', base: null, head: '{"generatedFiles":["**"]}' },
    { path: 'src/value.js', base: 'old\n', head: 'new\n' },
  ] });
  const changes = await collectChanges({ repo: history.root, ...history });
  assert.ok(changes.some((entry) => entry.path === 'src/value.js'));
});

test('slashless configured globs apply at every depth and malformed lists fail closed', async () => {
  const history = await makeFixtureRepo({ dirs, files: [
    { path: '.gitignore', base: '.mend/\n', head: '.mend/\n' },
    { path: 'root.cache', base: 'old\n', head: 'new\n' },
    { path: 'nested/build.cache', base: 'old\n', head: 'new\n' },
  ] });
  const file = path.join(history.root, '.mend/quality.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"generatedFiles":["*.cache"]}');
  const { pathspec } = await loadReviewPolicy({ repo: history.root, ...history });
  assert.equal(gitSync(history.root, ['diff', history.baseSha, history.headSha, '--', ...pathspec]), '');
  for (const generatedFiles of [null, '**', [42], ['../outside'], ['/absolute']]) {
    await fs.writeFile(file, JSON.stringify({ generatedFiles }));
    await assert.rejects(loadReviewPolicy({ repo: history.root, ...history }), /repository-relative globs/);
  }
});

test('ignored local policy cannot follow a symlink', async () => {
  const history = await makeFixtureRepo({ dirs, files: [
    { path: '.gitignore', base: '.mend/\n', head: '.mend/\n' },
    { path: 'policy.json', base: '{}', head: '{}' },
  ] });
  await fs.mkdir(path.join(history.root, '.mend'));
  await fs.symlink('../policy.json', path.join(history.root, '.mend/quality.json'));
  await assert.rejects(loadReviewPolicy({ repo: history.root, ...history }), /regular file/);
});

test('all diff consumers share the captured policy and reject later ignored configuration edits', async () => {
  const history = await makeFixtureRepo({ dirs, files: [
    { path: '.gitignore', base: '.mend/\n', head: '.mend/\n' },
    { path: 'src/outside.js', base: null, head: 'export const outside = 1;\n' },
    { path: 'build.tsbuildinfo', base: null, head: 'generated\n' },
  ] });
  await fs.mkdir(path.join(history.root, '.mend'));
  const config = path.join(history.root, '.mend/quality.json');
  await fs.writeFile(config, '{}');
  const captured = await loadReviewPolicy({ repo: history.root, ...history });
  const itemPath = path.join(history.root, '.mend/item.json');
  const item = { id: 'fixture', profiles: [], editSet: ['src/allowed.js'] };
  await fs.writeFile(itemPath, JSON.stringify(item));
  const options = { repo: history.root, ...history, item, itemPath, round: 1, firstFindingId: 'F1' };
  const script = `
    import assert from 'node:assert/strict';
    import { scanDiff } from ${JSON.stringify(new URL('./integrity.mjs', import.meta.url).href)};
    import { collectChanges } from ${JSON.stringify(new URL('./changes.mjs', import.meta.url).href)};
    import { buildCritiqueRequest } from ${JSON.stringify(new URL('./critique-request.mjs', import.meta.url).href)};
    const options = JSON.parse(process.argv[1]);
    if (process.argv[2] === 'changed') {
      for (const consumer of [scanDiff, collectChanges, buildCritiqueRequest]) {
        await assert.rejects(consumer(options), /review policy changed after capture/);
      }
    } else {
      assert.ok((await scanDiff(options)).flags.some(flag => flag.file === 'src/outside.js' && flag.rule === 'out-of-scope'));
      assert.deepEqual((await collectChanges(options)).map(entry => entry.path), ['src/outside.js']);
      const request = await buildCritiqueRequest(options);
      assert.ok(request.includes('src/outside.js'));
      assert.ok(!request.includes('build.tsbuildinfo'));
    }
  `;
  for (const state of ['unchanged', 'changed']) {
    if (state === 'changed') await fs.writeFile(config, '{"generatedFiles":["src/outside.js"]}');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(options), state], {
      encoding: 'utf8', env: { ...process.env, MEND_REVIEW_POLICY: JSON.stringify(captured) },
    });
    assert.equal(result.status, 0, result.stderr);
  }
});
