// A route that reads or writes a resource by an id from the URL must scope it to the caller:
// an owner, account or tenant condition, or a policy call, in the same handler.
import { changesFromFiles, collectChanges, isTestPath } from '../../../checks/changes.mjs';
import { declaredPublic, hasMarker, pathParams, routeKey, touchedRoutes } from './routes.mjs';

export const DEFAULT_OWNER_MARKERS = [
  'userId', 'user_id', 'ownerId', 'owner_id', 'accountId', 'account_id', 'tenantId', 'tenant_id', 'orgId', 'org_id',
  'organizationId', 'session.user', 'currentUser.id', 'current_user.id', 'req.user.id', 'request.user', 'assertOwner',
  'authorize(', 'can(', 'policy', 'ownedBy', 'belongsTo',
];

function usesParam(body, name) {
  const lines = body.split('\n').slice(1);
  return lines.some((line) => new RegExp(`\\b${name}\\b`).test(line));
}

export function evaluate({ changes, config }) {
  const publicRoutes = new Set(config?.publicRoutes ?? []);
  const failures = [];
  const sources = changes.filter((change) => !change.binary && change.status !== 'deleted' && !isTestPath(change.path));
  for (const route of touchedRoutes(sources)) {
    const params = pathParams(route.path);
    if (params.length === 0 || declaredPublic(route.body) || publicRoutes.has(route.path)) continue;
    const ownerMarkers = [...DEFAULT_OWNER_MARKERS, ...(config?.ownerMarkers ?? [])].filter((marker) => !params.includes(marker));
    const usedParams = params.filter((name) => usesParam(route.body, name));
    if (usedParams.length === 0 || hasMarker(route.body, ownerMarkers)) continue;
    failures.push({
      target: `${route.file}:${route.line}`,
      rule: 'cross-account',
      detail: `${routeKey(route)} uses ${usedParams.join(', ')} from the URL with no owner, account or tenant condition in the handler`,
    });
  }
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'cross-account',
  description: "A resource fetched or changed by a URL id is scoped to the caller, so another account's record is not reachable.",
  async run({ repo, baseSha, headSha, config }) {
    return evaluate({ changes: await collectChanges({ repo, baseSha, headSha }), config });
  },
  async runFixture(fixture) {
    return evaluate({ changes: changesFromFiles(fixture.files), config: fixture.config });
  },
};
