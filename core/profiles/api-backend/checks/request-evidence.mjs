// One real request per new route, sent to the local service started by the repo's verification skill and
// recorded at .mend/evidence/<item>/requests.json as [{ method, url, status, response? }].
import { changesFromFiles, collectChanges, isTestPath } from '../../../checks/changes.mjs';
import { isLocalHost } from '../../../checks/local-url.mjs';
import { evidenceLines, readCaptures } from '../../../checks/capture.mjs';
import { newRoutes, routeKey, routePattern, touchedRoutes } from './routes.mjs';

export const REQUESTS_FILE = 'requests.json';

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
}

export function evaluate({ changes, requests }) {
  const sources = changes.filter((change) => !change.binary && change.status !== 'deleted' && !isTestPath(change.path));
  if (touchedRoutes(sources).length === 0) return { pass: true, failures: [] };
  if (!Array.isArray(requests) || requests.length === 0) {
    return {
      pass: false,
      failures: [{ target: `(evidence)/${REQUESTS_FILE}`, rule: 'request-missing', detail: 'the item changes routes but no request to the running service was recorded' }],
    };
  }
  const failures = [];
  requests.forEach((request, index) => {
    const host = hostOf(request?.url);
    if (!isLocalHost(host)) {
      failures.push({ target: `(evidence)/${REQUESTS_FILE}[${index}]`, rule: 'request-not-local', detail: `${request?.url ?? '(no url)'} is not a local service` });
    }
  });
  for (const route of newRoutes(sources)) {
    const pattern = routePattern(route.path);
    const seen = requests.some((request) => String(request?.method ?? '').toUpperCase() === route.method && pattern.test(pathOf(request?.url)) && Number.isInteger(request?.status));
    if (!seen) failures.push({ target: `${route.file}:${route.line}`, rule: 'request-route-unexercised', detail: `no recorded request with a status reached ${routeKey(route)}` });
  }
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'request-evidence',
  description: 'Changed routes were exercised by real requests against the local service, one per new route.',
  async run({ repo, item, baseSha, headSha }) {
    const changes = await collectChanges({ repo, baseSha, headSha });
    const captures = await readCaptures({ repo, itemId: item?.id, kind: 'request', headSha });
    const requests = captures.filter((capture) => capture.exit === 0).flatMap((capture) => evidenceLines(capture.output));
    return evaluate({ changes, requests });
  },
  async runFixture(fixture) {
    return evaluate({ changes: changesFromFiles(fixture.files), requests: fixture.requests });
  },
};
