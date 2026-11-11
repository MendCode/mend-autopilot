// Every new route validates its input at the boundary, states an auth decision (a guard or an explicit
// public marker) and has a test that exercises one of its error statuses.
import { changesFromFiles, collectChanges, isTestPath } from '../../../checks/changes.mjs';
import { fixtureTree, headTree } from '../../../checks/repo-read.mjs';
import { declaredPublic, errorStatuses, hasMarker, literalSegment, newRoutes, routeKey, routePattern, takesInput } from './routes.mjs';

export const DEFAULT_VALIDATION_MARKERS = [
  '.parse(', '.safeParse(', '.parseAsync(', 'validate', 'Validator', 'zValidator', 'Schema', 'schema', 'Joi.', 'yup.',
  'celebrate(', '@Body(', 'ValidationPipe', 'BaseModel', 'model_validate', 'marshmallow',
];
export const DEFAULT_AUTH_MARKERS = [
  'requireAuth', 'requireUser', 'requireAdmin', 'requireRole', 'authenticate', 'isAuthenticated', 'ensureAuth', 'withAuth',
  'getServerSession', 'getSession', 'currentUser', 'current_user', 'req.user', 'request.user', 'Depends(get_current',
  'login_required', 'permission_required', 'verifyToken', '@UseGuards', 'authorize(',
];
const ANNOTATED_PYTHON_PARAM = /\bdef\s+\w+\s*\([^)]*\b\w+\s*:\s*[A-Za-z_]/;

function validates(route, markers) {
  return hasMarker(route.body, markers) || ANNOTATED_PYTHON_PARAM.test(route.body);
}

/** A router-wide guard registered above the route, such as router.use(requireAuth). */
function guardedByMiddleware(text, line, markers) {
  return text
    .split('\n')
    .slice(0, line - 1)
    .some((entry) => /\.use\s*\(/.test(entry) && hasMarker(entry, markers));
}

async function testedStatuses(route, tree) {
  const statuses = errorStatuses(route.body);
  if (statuses.length === 0) return { statuses, tested: false };
  const pattern = routePattern(route.path);
  const candidates = [...new Set((await tree.search(literalSegment(route.path))).map((hit) => hit.path))].filter(isTestPath);
  for (const file of candidates) {
    const text = (await tree.read(file)) ?? '';
    if (pattern.test(text) && statuses.some((code) => new RegExp(`\\b${code}\\b`).test(text))) return { statuses, tested: true };
  }
  return { statuses, tested: false };
}

export async function evaluate({ changes, tree, config }) {
  const validationMarkers = [...DEFAULT_VALIDATION_MARKERS, ...(config?.validationMarkers ?? [])];
  const authMarkers = [...DEFAULT_AUTH_MARKERS, ...(config?.authMarkers ?? [])];
  const failures = [];
  const sources = changes.filter((change) => !change.binary && change.status !== 'deleted' && !isTestPath(change.path));
  const textOf = new Map(sources.map((change) => [change.path, change.headText ?? '']));
  for (const route of newRoutes(sources)) {
    const target = `${route.file}:${route.line}`;
    const key = routeKey(route);
    if (takesInput(route) && !validates(route, validationMarkers)) {
      failures.push({ target, rule: 'route-unvalidated', detail: `${key} reads input but no validation is visible in its handler` });
    }
    const guardedAbove = guardedByMiddleware(textOf.get(route.file), route.line, authMarkers);
    if (!guardedAbove && !declaredPublic(route.body) && !hasMarker(route.body, authMarkers)) {
      failures.push({ target, rule: 'route-no-auth-decision', detail: `${key} has no auth guard and is not marked "auth: public"` });
    }
    const { statuses, tested } = await testedStatuses(route, tree);
    if (!tested) {
      const detail = statuses.length === 0 ? `${key} sets no error status` : `no test calls ${route.path} and checks ${statuses.join(' or ')}`;
      failures.push({ target, rule: 'route-error-untested', detail });
    }
  }
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'route-hygiene',
  description: 'Each new route validates input at the boundary, states an auth decision and has a tested error status.',
  async run({ repo, baseSha, headSha, config }) {
    const changes = await collectChanges({ repo, baseSha, headSha });
    return evaluate({ changes, tree: await headTree({ repo, headSha }), config });
  },
  async runFixture(fixture) {
    return evaluate({ changes: changesFromFiles(fixture.files), tree: fixtureTree(fixture.files, fixture.paths), config: fixture.config });
  },
};
