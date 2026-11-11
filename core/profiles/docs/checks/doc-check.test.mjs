import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertFixtures, makeFixtureRepo, removeAll, rulesOf, writeEvidence } from '../../../checks/test-support.mjs';
import docCheck, { CLI_HELP_FILE, commandSegments, headingSlugs, linkTargets, OUTLINE_FILE, parseMarkdown, RUNS_FILE } from './doc-check.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'doc-check');
const dirs = [];
after(() => removeAll(dirs));

const page = (head) => ({ path: 'docs/page.md', base: '# Page\n', head });

test('every doc-check fixture passes or fails exactly the rules it names', async () => {
  await assertFixtures(docCheck, FIXTURES);
});

test('fences split prose from code, keep the info string and close only on a matching fence', () => {
  const { lines, blocks } = parseMarkdown('Intro\n````md runnable\n```\ninner\n```\n````\nAfter\n');
  assert.deepEqual(blocks.map((block) => [block.line, block.language, block.runnable, block.body.length]), [[2, 'md', true, 3]]);
  assert.deepEqual(lines.map((entry) => entry.kind), ['prose', 'fence', 'code', 'code', 'code', 'fence', 'prose', 'prose']);
});

test('heading anchors drop punctuation, keep letters of any script and number repeats', () => {
  const slugs = headingSlugs('# Getting `started`!\n## Opciones de línea\n## FAQ\n## FAQ\n```\n# not a heading\n```\n');
  assert.deepEqual([...slugs].sort(), ['faq', 'faq-1', 'getting-started', 'opciones-de-línea']);
});

test('links come from inline links and reference definitions, never from inline code', () => {
  assert.deepEqual(linkTargets('See [a](./a.md "title") and ![b](<img/b.png>) but not `[c](./c.md)`.'), ['./a.md', 'img/b.png']);
  assert.deepEqual(linkTargets('[ref]: ../ref.md#top'), ['../ref.md#top']);
});

test('command lines drop the prompt and variable assignments and split on shell operators', () => {
  assert.deepEqual(commandSegments('$ NODE_ENV=test pnpm run build && tally -q a.txt | head'), [['pnpm', 'run', 'build'], ['tally', '-q', 'a.txt'], ['head']]);
  assert.deepEqual(commandSegments('# a comment'), []);
});

test('package manager built-ins, external links and fences in other languages are not reported', async () => {
  const result = await docCheck.runFixture({
    config: { locale: 'en' },
    files: [
      { path: 'package.json', base: '{"scripts":{}}', head: '{"scripts":{}}' },
      page('# Page\n\nInstall with `pnpm install`, read [the spec](https://example.invalid/spec) and [the docs folder](../docs/).\n\n```js\nnpm run nowhere\n```\n'),
    ],
  });
  assert.deepEqual(result.failures, []);
});

test('a lifecycle script without run still has to exist, and the nearest package.json decides', async () => {
  const files = [
    { path: 'package.json', base: '{"scripts":{"test":"node --test"}}', head: '{"scripts":{"test":"node --test"}}' },
    { path: 'docs/package.json', base: '{"scripts":{}}', head: '{"scripts":{}}' },
    page('# Page\n\nRun `npm test` first.\n'),
  ];
  const result = await docCheck.runFixture({ config: { locale: 'en' }, files });
  assert.deepEqual(rulesOf(result), ['invented-command']);
  assert.match(result.failures[0].detail, /docs\/package\.json/);
});

test('flags are checked against the subcommand help when one is recorded', async () => {
  const fixture = {
    config: { locale: 'en' },
    files: [page('# Page\n\nUse `tally export --since 2d` to export.\n')],
    cliHelp: { tools: { tally: 'Usage: tally <command>\n  --since <age>\n', 'tally export': 'Usage: tally export [--to <file>]\n' } },
  };
  assert.deepEqual(rulesOf(await docCheck.runFixture(fixture)), ['invented-flag']);
  fixture.cliHelp.tools['tally export'] += '  --since <age>\n';
  assert.equal((await docCheck.runFixture(fixture)).pass, true);
});

test('only added lines are checked: an old dead link left untouched is not this change', async () => {
  const result = await docCheck.runFixture({
    config: { locale: 'en' },
    files: [{ path: 'docs/page.md', base: '# Page\n\nSee [gone](./gone.md).\n', head: '# Page\n\nSee [gone](./gone.md).\n\nEmpty lines count too.\n' }],
  });
  assert.deepEqual(result.failures, []);
});

test('the repo adapter reads the outline, the recorded runs and the help from the item evidence', async () => {
  const head = '# Usage\n\n## Count a file\n\nRun `tally -q notes.txt` to count.\n\n```sh runnable\ntally notes.txt\n```\n';
  const repo = await makeFixtureRepo({ files: [{ path: 'docs/usage.md', base: '# Usage\n', head }], dirs });
  const args = { repo: repo.root, item: { id: 'usage-count' }, baseSha: repo.baseSha, headSha: repo.headSha, config: { locale: 'en' } };
  assert.deepEqual(rulesOf(await docCheck.run(args)), ['runnable-missing']);

  await writeEvidence({ root: repo.root, itemId: 'usage-count', name: RUNS_FILE, value: { runs: [{ path: 'docs/usage.md', line: 7, exitCode: 0 }] } });
  await writeEvidence({ root: repo.root, itemId: 'usage-count', name: CLI_HELP_FILE, value: { tools: { tally: 'Usage: tally [--format <fmt>] <file>\n' } } });
  await writeEvidence({ root: repo.root, itemId: 'usage-count', name: OUTLINE_FILE, value: { documents: [{ path: 'docs/usage.md', headings: ['Usage', 'Count a file'] }] } });
  assert.deepEqual(rulesOf(await docCheck.run(args)), ['invented-flag']);
});
