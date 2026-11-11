import { readItemEvidence } from '../../../checks/repo-read.mjs';
import { isTestPath, matchesGlobs } from '../../../checks/changes.mjs';
import { DEFAULT_GLOBS } from '../../../checks/integrity.mjs';
import { entriesFromFiles, entriesFromRepo } from './surface-unchanged.mjs';
import { exportsOf, hasSurface } from './exports.mjs';

function evaluate(entries, proposal) {
  const failures = [];
  const fail = (detail) => failures.push({ target: '(evidence)/module-map.json', rule: 'module-map', detail });
  if (!proposal || !Array.isArray(proposal.files)) {
    fail('missing module map files');
    return { pass: false, failures };
  }
  const actual = entries.filter((e) => !isTestPath(e.path) && !matchesGlobs(e.path, DEFAULT_GLOBS.baseline) && (hasSurface(e.path) || (e.oldPath && hasSurface(e.oldPath))));
  const seen = new Set();
  for (const entry of actual) {
    const oldPath = entry.oldPath ?? entry.path;
    const matches = proposal.files.filter((file) => file?.path === entry.path && (file.oldPath ?? file.path) === oldPath);
    if (matches.length !== 1) { fail(`missing or duplicate mapping for ${oldPath} -> ${entry.path}`); continue; }
    const file = matches[0];
    seen.add(file);
    for (const [key, names] of [['before', [...exportsOf(oldPath, entry.baseText).keys()].sort()], ['after', [...exportsOf(entry.path, entry.headText).keys()].sort()]]) {
      if (!Array.isArray(file[key]) || file[key].some((name) => typeof name !== 'string') || JSON.stringify([...file[key]].sort()) !== JSON.stringify(names)) fail(`${entry.path}: ${key} exports differ from the map`);
    }
  }
  if (seen.size !== proposal.files.length) fail('map contains files absent from the source diff');
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'module-map',
  description: 'Compare changed source paths and exported names against the approved module map.',
  async run({ repo, item, baseSha, headSha }) {
    return evaluate(await entriesFromRepo({ repo, baseSha, headSha }), await readItemEvidence({ repo, itemId: item?.id, name: 'module-map.json' }));
  },
  async runFixture(fixture) { return evaluate(entriesFromFiles(fixture.files ?? []), fixture.proposal); },
};
