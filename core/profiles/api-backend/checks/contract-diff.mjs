// API surface at base and head, from the repo's own source of truth, classified per operation as additive,
// breaking or internal. Sources, in order: OpenAPI JSON files in the repo; a surface record the owner
// produced with a repo command (.mend/evidence/<item>/surface.json as { base, head } in the normalized shape
// below). No source means BLOCKED with the missing input named, never a silent PASS.
// With an approved proposal (.mend/evidence/<item>/contract.json) the same comparison is the integration diff.
//
// Normalized surface: { "<METHOD> <path>": { params: { "<in>:<name>": { required } }, requestRequired: [field],
//                                             responses: { "<code>": [field] } } }
import { matchesGlobs } from '../../../checks/changes.mjs';
import { listFilesAt, readFileAt, readItemEvidence } from '../../../checks/repo-read.mjs';

export const DEFAULT_OPENAPI_GLOBS = ['openapi.json', '**/openapi.json', '**/openapi.*.json', '**/swagger.json'];
export const SURFACE_FILE = 'surface.json';
export const PROPOSAL_FILE = 'contract.json';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_REF_DEPTH = 8;

function resolveRef(document, value, depth = 0) {
  if (!value || typeof value !== 'object' || typeof value.$ref !== 'string') return value;
  if (depth > MAX_REF_DEPTH || !value.$ref.startsWith('#/')) return {};
  const target = value.$ref
    .slice(2)
    .split('/')
    .reduce((node, key) => (node && typeof node === 'object' ? node[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), document);
  return resolveRef(document, target ?? {}, depth + 1);
}

function schemaFields(document, schema) {
  const resolved = resolveRef(document, schema) ?? {};
  const body = resolved.type === 'array' ? resolveRef(document, resolved.items) ?? {} : resolved;
  return Object.keys(body.properties ?? {}).sort();
}

function jsonSchemaOf(document, holder) {
  const resolved = resolveRef(document, holder) ?? {};
  const content = resolved.content ?? {};
  const media = content['application/json'] ?? Object.values(content)[0];
  return media?.schema ?? null;
}

/** Normalized surface of one OpenAPI document (JSON). */
export function surfaceFromOpenApi(document) {
  if (!document || typeof document !== 'object' || typeof document.paths !== 'object') throw new TypeError('[CONTRACT-DIFF]: not an OpenAPI document (no paths)');
  const surface = {};
  for (const [routePath, item] of Object.entries(document.paths)) {
    const shared = Array.isArray(item?.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const operation = item?.[method];
      if (!operation) continue;
      const params = {};
      for (const raw of [...shared, ...(operation.parameters ?? [])]) {
        const parameter = resolveRef(document, raw);
        if (parameter?.name && parameter?.in) params[`${parameter.in}:${parameter.name}`] = { required: parameter.required === true || parameter.in === 'path' };
      }
      const requestSchema = jsonSchemaOf(document, operation.requestBody);
      const requestRequired = requestSchema ? [...(resolveRef(document, requestSchema)?.required ?? [])].sort() : [];
      const responses = {};
      for (const [code, response] of Object.entries(operation.responses ?? {})) {
        const schema = jsonSchemaOf(document, response);
        responses[code] = schema ? schemaFields(document, schema) : [];
      }
      surface[`${method.toUpperCase()} ${routePath}`] = { params, requestRequired, responses };
    }
  }
  return surface;
}

function mergeSurfaces(surfaces) {
  return Object.assign({}, ...surfaces);
}

/** Every difference between two surfaces: [{ operation, kind: additive|breaking|internal, change }]. */
export function classifyChanges(base, head) {
  const changes = [];
  const push = (operation, kind, change) => changes.push({ operation, kind, change });
  for (const operation of Object.keys(base)) if (!(operation in head)) push(operation, 'breaking', 'operation removed');
  for (const operation of Object.keys(head)) if (!(operation in base)) push(operation, 'additive', 'operation added');
  for (const operation of Object.keys(head).filter((key) => key in base)) {
    const before = base[operation];
    const after = head[operation];
    for (const [name, param] of Object.entries(before.params ?? {})) {
      const now = after.params?.[name];
      if (!now) push(operation, 'breaking', `parameter ${name} removed`);
      else if (!param.required && now.required) push(operation, 'breaking', `parameter ${name} became required`);
      else if (param.required && !now.required) push(operation, 'additive', `parameter ${name} became optional`);
    }
    for (const [name, param] of Object.entries(after.params ?? {})) {
      if (before.params?.[name]) continue;
      push(operation, param.required ? 'breaking' : 'additive', `${param.required ? 'required' : 'optional'} parameter ${name} added`);
    }
    const requiredBefore = new Set(before.requestRequired ?? []);
    for (const field of after.requestRequired ?? []) if (!requiredBefore.has(field)) push(operation, 'breaking', `request field ${field} became required`);
    for (const [code, fields] of Object.entries(before.responses ?? {})) {
      const now = after.responses?.[code];
      if (!now) {
        push(operation, code.startsWith('2') ? 'breaking' : 'internal', `response ${code} removed`);
        continue;
      }
      const kept = new Set(now);
      for (const field of fields) if (!kept.has(field)) push(operation, 'breaking', `response ${code} field ${field} removed`);
      const had = new Set(fields);
      for (const field of now) if (!had.has(field)) push(operation, 'additive', `response ${code} field ${field} added`);
    }
    for (const code of Object.keys(after.responses ?? {})) if (!before.responses?.[code]) push(operation, 'additive', `response ${code} added`);
  }
  return changes;
}

function sameChange(a, b) {
  return a.operation === b.operation && a.change === b.change;
}

/**
 * base/head: normalized surfaces, or null when no source of truth exists.
 * proposal: { approved, changes: [{ operation, change }] } or null. declaredBreaking: operations the item says may break.
 */
export function evaluate({ base, head, proposal, declaredBreaking = [] }) {
  if (!base || !head) {
    return {
      pass: false,
      blocked: true,
      changes: [],
      failures: [{
        target: '(api surface)',
        rule: 'surface-unknown',
        detail: `BLOCKED: no OpenAPI JSON in the repo and no ${SURFACE_FILE} record from a repo command; the critique lens reviews the surface by hand`,
      }],
    };
  }
  const changes = classifyChanges(base, head);
  const approved = proposal?.approved === true ? proposal.changes ?? [] : null;
  const failures = [];
  for (const entry of changes) {
    const inProposal = approved?.some((proposed) => sameChange(proposed, entry)) ?? false;
    if (entry.kind === 'breaking' && !inProposal && !declaredBreaking.includes(entry.operation)) {
      failures.push({ target: entry.operation, rule: 'breaking-unflagged', detail: `${entry.change}; not in the approved contract and not declared breaking by the item` });
    } else if (approved && !inProposal && entry.kind !== 'internal') {
      failures.push({ target: entry.operation, rule: 'contract-unapproved-change', detail: `${entry.change} is not in the approved contract` });
    }
  }
  for (const proposed of approved ?? []) {
    if (!changes.some((entry) => sameChange(proposed, entry))) {
      failures.push({ target: proposed.operation, rule: 'contract-change-missing', detail: `approved change "${proposed.change}" is not in the integrated surface` });
    }
  }
  return { pass: failures.length === 0, changes, failures };
}

function parseDocuments(texts, label) {
  return texts.map(({ path: filePath, text }) => {
    try {
      return surfaceFromOpenApi(JSON.parse(text));
    } catch (error) {
      throw new TypeError(`[CONTRACT-DIFF]: ${label} ${filePath}: ${error.message}`);
    }
  });
}

/** Surfaces from fixture files or commit texts: { base, head } or nulls when no OpenAPI file exists on a side. */
export function surfacesFromTexts({ baseTexts, headTexts, recorded }) {
  if (headTexts.length > 0 || baseTexts.length > 0) {
    return {
      base: baseTexts.length > 0 ? mergeSurfaces(parseDocuments(baseTexts, 'base')) : {},
      head: headTexts.length > 0 ? mergeSurfaces(parseDocuments(headTexts, 'head')) : {},
    };
  }
  if (recorded?.base && recorded?.head) return { base: recorded.base, head: recorded.head };
  return { base: null, head: null };
}

async function textsAt(repo, sha, globs) {
  const paths = (await listFilesAt({ repo, sha })).filter((filePath) => matchesGlobs(filePath, globs));
  const texts = [];
  for (const filePath of paths) texts.push({ path: filePath, text: await readFileAt({ repo, sha, filePath }) });
  return texts;
}

export default {
  id: 'contract-diff',
  description: 'API surface changes between base and head are classified; breaking ones need the item or the approved contract to name them.',
  async run({ repo, item, baseSha, headSha, config }) {
    const globs = config?.openapiGlobs ?? DEFAULT_OPENAPI_GLOBS;
    const recorded = await readItemEvidence({ repo, itemId: item?.id, name: SURFACE_FILE });
    const { base, head } = surfacesFromTexts({ baseTexts: await textsAt(repo, baseSha, globs), headTexts: await textsAt(repo, headSha, globs), recorded });
    const proposal = await readItemEvidence({ repo, itemId: item?.id, name: PROPOSAL_FILE });
    return evaluate({ base, head, proposal, declaredBreaking: item?.breaking ?? [] });
  },
  async runFixture(fixture) {
    const globs = fixture.config?.openapiGlobs ?? DEFAULT_OPENAPI_GLOBS;
    const files = (fixture.files ?? []).filter((file) => matchesGlobs(file.path, globs));
    const baseTexts = files.filter((file) => file.base !== null && file.base !== undefined).map((file) => ({ path: file.path, text: file.base }));
    const headTexts = files.filter((file) => file.head !== null && file.head !== undefined).map((file) => ({ path: file.path, text: file.head }));
    // Fixtures may give the OpenAPI documents as objects instead of escaped text.
    if (fixture.openapi?.base) baseTexts.push({ path: 'openapi.json', text: JSON.stringify(fixture.openapi.base) });
    if (fixture.openapi?.head) headTexts.push({ path: 'openapi.json', text: JSON.stringify(fixture.openapi.head) });
    const { base, head } = surfacesFromTexts({ baseTexts, headTexts, recorded: fixture.surface });
    return evaluate({ base, head, proposal: fixture.proposal ?? null, declaredBreaking: fixture.item?.breaking ?? [] });
  },
};
