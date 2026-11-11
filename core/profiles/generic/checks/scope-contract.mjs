// G6 scope contract beyond the edit set (integrity.mjs owns out-of-scope files):
// the item's declared quantity is delivered, and public surface changes only when the item asks for it.
import { changesFromFiles, collectChanges, matchesGlobs } from '../../../checks/changes.mjs';

export const DEFAULT_PUBLIC_SURFACE = [
  '**/openapi.yaml',
  '**/openapi.yml',
  '**/openapi.json',
  '**/*.openapi.yaml',
  '**/*.openapi.json',
  '**/*.graphql',
  '**/*.gql',
  '**/*.proto',
];

function quantityFailures(item, changes) {
  const quantity = item?.quantity;
  if (!quantity) return [];
  const { expected, glob, accepted } = quantity;
  if (!Number.isInteger(expected) || expected < 0 || typeof glob !== 'string' || glob === '') {
    return [{ target: '(item)', rule: 'quantity-undeclared', detail: 'item.quantity needs an integer expected and a glob' }];
  }
  const target = Number.isInteger(accepted) ? accepted : expected;
  const delivered = changes.filter((change) => change.status !== 'deleted' && matchesGlobs(change.path, [glob])).map((change) => change.path);
  if (delivered.length === target) return [];
  const agreed = target === expected ? '' : ` (accepted ${accepted} of ${expected})`;
  return [
    {
      target: glob,
      rule: delivered.length < target ? 'quantity-short' : 'quantity-over',
      detail: `${delivered.length} changed files match, item asks for ${target}${agreed}`,
    },
  ];
}

function publicSurfaceFailures(item, changes, config) {
  if (item?.publicChangeRequested === true) return [];
  const globs = [...DEFAULT_PUBLIC_SURFACE, ...(item?.publicSurface ?? []), ...(config?.publicSurface ?? [])];
  return changes
    .filter((change) => matchesGlobs(change.path, globs))
    .map((change) => ({
      target: change.path,
      rule: 'public-surface',
      detail: `public contract ${change.status} but the item does not set publicChangeRequested`,
    }));
}

export function evaluate({ item, changes, config }) {
  const failures = [...quantityFailures(item, changes), ...publicSurfaceFailures(item, changes, config)];
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'scope-contract',
  description: 'Delivered quantity matches the item and public contracts change only when asked.',
  async run({ repo, item, baseSha, headSha, config }) {
    return evaluate({ item, changes: await collectChanges({ repo, baseSha, headSha }), config });
  },
  async runFixture(fixture) {
    return evaluate({ item: fixture.item, changes: changesFromFiles(fixture.files), config: fixture.config });
  },
};
