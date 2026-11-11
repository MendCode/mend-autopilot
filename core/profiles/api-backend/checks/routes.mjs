// Route discovery for the api-backend checks. Line-based patterns for common server styles
// (chained router calls, Python decorators, file-based route handlers); no parser dependency.
// Not a check: check-profiles only loads the ids a profile lists.

export const MAX_HANDLER_LINES = 30;

const RECEIVER = '(?:app|api|router|routes|route|server|fastify|hono|r|v\\d+|[a-z][A-Za-z0-9]*(?:Router|Routes|App|Api))';
const CHAINED = new RegExp(`\\b${RECEIVER}\\s*\\.\\s*(get|post|put|patch|delete)\\s*\\(\\s*(['"\`])(\\/[^'"\`]*)\\2`, 'i');
const DECORATOR = /^\s*@\s*[A-Za-z_][\w.]*\.(get|post|put|patch|delete|route|api_route)\s*\(\s*(['"])(\/[^'"]*)\2(.*)$/i;
const FILE_HANDLER = /^\s*export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/;
const FILE_ROUTE_PATH = /(?:^|\/)app\/(.*?)\/?route\.[cm]?[jt]sx?$/;
const DECORATOR_METHODS = /methods\s*=\s*\[([^\]]*)\]/i;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const PARAM = /:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)(?::[^}]*)?\}|\[(?:\.\.\.)?([A-Za-z_]\w*)\]|<(?:[a-z]+:)?([A-Za-z_]\w*)>/g;
const ERROR_STATUS = [
  /\bstatus\s*\(\s*(\d{3})/g,
  /\bsendStatus\s*\(\s*(\d{3})/g,
  /\bstatus(?:Code|_code)?\s*[:=]\s*(\d{3})/g,
  /\babort\s*\(\s*(\d{3})/g,
  /\bHTTPException\s*\(\s*(?:status_code\s*=\s*)?(\d{3})/g,
  /\bHTTP_(\d{3})_[A-Z_]+/g,
];

function filePathRoute(filePath) {
  const match = filePath.match(FILE_ROUTE_PATH);
  if (!match) return null;
  const segments = match[1].split('/').filter((segment) => segment && !/^\(.*\)$/.test(segment));
  return `/${segments.join('/')}`;
}

function decoratorMethods(verb, rest) {
  if (!['route', 'api_route'].includes(verb.toLowerCase())) return [verb.toUpperCase()];
  const listed = rest.match(DECORATOR_METHODS);
  if (!listed) return ['GET'];
  const methods = [...listed[1].matchAll(/['"]([A-Za-z]+)['"]/g)].map((entry) => entry[1].toUpperCase());
  return methods.length > 0 ? methods : ['GET'];
}

/** Route starts in a file's text: [{ method, path, line }], 1-based lines. */
function routeStarts(filePath, lines) {
  const starts = [];
  const fileRoute = filePathRoute(filePath);
  lines.forEach((text, index) => {
    const line = index + 1;
    const chained = text.match(CHAINED);
    if (chained) {
      starts.push({ method: chained[1].toUpperCase(), path: chained[3], line });
      return;
    }
    const decorated = text.match(DECORATOR);
    if (decorated) {
      for (const method of decoratorMethods(decorated[1], decorated[4])) starts.push({ method, path: decorated[3], line });
      return;
    }
    const handler = fileRoute === null ? null : text.match(FILE_HANDLER);
    if (handler) starts.push({ method: handler[1], path: fileRoute, line });
  });
  return starts;
}

/** Every route in a file with the handler window that follows it. */
export function routesIn(filePath, text) {
  if (typeof text !== 'string' || text === '') return [];
  const lines = text.split('\n');
  const starts = routeStarts(filePath, lines);
  const nextStartAfter = (line) => starts.find((start) => start.line > line)?.line ?? Infinity;
  return starts.map((start) => {
    const end = Math.min(start.line + MAX_HANDLER_LINES - 1, nextStartAfter(start.line) - 1, lines.length);
    return { ...start, file: filePath, end, body: lines.slice(start.line - 1, end).join('\n') };
  });
}

export function pathParams(routePath) {
  return [...routePath.matchAll(PARAM)].map((match) => match[1] ?? match[2] ?? match[3] ?? match[4]);
}

/** Canonical key: method plus path with every parameter written as {name}. */
export function routeKey(route) {
  return `${route.method} ${route.path.replace(PARAM, (_, a, b, c, d) => `{${a ?? b ?? c ?? d}}`)}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches a concrete URL of the route in test code or a recorded request (parameters become one path segment). */
export function routePattern(routePath) {
  let pattern = '';
  let last = 0;
  for (const match of routePath.matchAll(PARAM)) {
    pattern += escapeRegExp(routePath.slice(last, match.index));
    pattern += '[^/?#\'"`\\s]+';
    last = match.index + match[0].length;
  }
  pattern += escapeRegExp(routePath.slice(last));
  return new RegExp(`${pattern}(?![\\w/-])`);
}

/** The longest literal segment of a route path, used to narrow a text search before the full pattern runs. */
export function literalSegment(routePath) {
  const literals = routePath.split(PARAM).filter((part, index) => index % 5 === 0 && part);
  const longest = literals.sort((a, b) => b.length - a.length)[0] ?? routePath;
  return longest.replace(/\/+$/, '') || routePath;
}

export function errorStatuses(body) {
  const codes = new Set();
  for (const pattern of ERROR_STATUS) {
    for (const match of body.matchAll(pattern)) {
      const code = Number(match[1]);
      if (code >= 400 && code <= 599) codes.add(code);
    }
  }
  return [...codes].sort();
}

export function takesInput(route) {
  if (WRITE_METHODS.has(route.method)) return true;
  if (pathParams(route.path).length > 0) return true;
  return /\b(?:req|request|ctx)\.(?:query|body|params)\b|\bsearchParams\b|\brequest\.(?:args|form|json)\b|\bQuery\s*\(/.test(route.body);
}

export function isWrite(route) {
  return WRITE_METHODS.has(route.method);
}

function addedSet(change) {
  return new Set(change.added.map((entry) => entry.line));
}

/** Routes whose start line is new in this change. */
export function newRoutes(changes) {
  return changes.flatMap((change) => {
    const added = addedSet(change);
    return routesIn(change.path, change.headText).filter((route) => added.has(route.line));
  });
}

/** Routes whose handler window contains at least one new line. */
export function touchedRoutes(changes) {
  return changes.flatMap((change) => {
    const added = [...addedSet(change)];
    return routesIn(change.path, change.headText).filter((route) => added.some((line) => line >= route.line && line <= route.end));
  });
}

/** Whether any marker appears in the text; markers are literal substrings. */
export function hasMarker(text, markers) {
  return markers.some((marker) => text.includes(marker));
}

/** An explicit public decision written next to the route. */
export function declaredPublic(body) {
  return /\bauth\s*:\s*public\b|@public\b|\bpublic\s*:\s*true\b/i.test(body);
}
