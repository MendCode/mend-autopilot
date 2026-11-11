// Reading the exported surface of a source file without a parser: JavaScript/TypeScript export forms and
// Python top-level names (or __all__ when present), each with its parameter list when it is a function.
// Not a check: check-profiles loads only listed ids.

const JS_FILE = /\.(?:[cm]?[jt]sx?)$/;
const PY_FILE = /\.py$/;
const JS_DECLARATION = /^[ \t]*export[ \t]+(default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(function\*?|class|const|let|var|type|interface|enum|namespace)[ \t]+([A-Za-z_$][\w$]*)/gm;
const JS_DEFAULT = /^[ \t]*export[ \t]+default\b/gm;
const JS_LIST = /^[ \t]*export[ \t]+(?:type[ \t]+)?\{([^}]*)\}/gm;
const JS_STAR = /^[ \t]*export[ \t]+\*[ \t]+(?:as[ \t]+([A-Za-z_$][\w$]*)[ \t]+)?from[ \t]+['"]([^'"]+)['"]/gm;
const CJS_OBJECT = /\bmodule\.exports[ \t]*=[ \t]*\{([^}]*)\}/g;
const CJS_NAMED = /^[ \t]*(?:module\.)?exports\.([A-Za-z_$][\w$]*)[ \t]*=/gm;
const PY_TOP = /^(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)|^([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)/gm;
const PY_ALL = /^__all__[ \t]*=[ \t]*[[(]([^\])]*)[\])]/m;

export function hasSurface(filePath) {
  return JS_FILE.test(filePath) || PY_FILE.test(filePath);
}

// What may sit between a declared name and its "(": generics for functions, "= async" for arrow functions.
const FUNCTION_GAP = /^[\w$\s<>,*[\].]*$/;
const ARROW_GAP = /^\s*(?::[^=\n]+)?=\s*(?:async\s*)?$/;
const ARROW_AFTER = /^\s*(?::[^=\n]+)?=>/;

/** The balanced parameter list at the first "(" after index when the gap before it matches, whitespace collapsed. */
function parametersAt(text, index, gap) {
  const open = text.indexOf('(', index);
  if (open < 0 || !gap.test(text.slice(index, open))) return null;
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '(') depth += 1;
    else if (text[at] === ')') {
      depth -= 1;
      if (depth > 0) continue;
      if (gap === ARROW_GAP && !ARROW_AFTER.test(text.slice(at + 1))) return null;
      return text.slice(open, at + 1).replace(/\s+/g, ' ').replace(/\(\s+/, '(').replace(/,?\s*\)$/, ')');
    }
  }
  return null;
}

function jsExports(text) {
  const surface = new Map();
  for (const _match of text.matchAll(JS_DEFAULT)) surface.set('default', null);
  for (const match of text.matchAll(JS_DECLARATION)) {
    const kind = match[2];
    const name = match[1] ? 'default' : match[3];
    const end = match.index + match[0].length;
    let parameters = null;
    if (kind.startsWith('function')) parameters = parametersAt(text, end, FUNCTION_GAP);
    else if (['const', 'let', 'var'].includes(kind)) parameters = parametersAt(text, end, ARROW_GAP);
    surface.set(name, parameters);
  }
  for (const match of text.matchAll(JS_LIST)) {
    for (const part of match[1].split(',').map((entry) => entry.trim()).filter(Boolean)) {
      const pieces = part.replace(/^type\s+/, '').split(/\s+as\s+/);
      surface.set(pieces[pieces.length - 1], null);
    }
  }
  for (const match of text.matchAll(JS_STAR)) surface.set(match[1] ?? `* from ${match[2]}`, null);
  for (const match of text.matchAll(CJS_OBJECT)) {
    for (const part of match[1].split(',').map((entry) => entry.trim()).filter(Boolean)) surface.set(part.split(':')[0].trim(), null);
  }
  for (const match of text.matchAll(CJS_NAMED)) surface.set(match[1], null);
  return surface;
}

function pyExports(text) {
  const surface = new Map();
  for (const match of text.matchAll(PY_TOP)) {
    const name = match[2] ?? match[3];
    if (name.startsWith('_')) continue;
    surface.set(name, match[1] === 'def' ? parametersAt(text, match.index + match[0].length, FUNCTION_GAP) : null);
  }
  const declared = text.match(PY_ALL);
  if (!declared) return surface;
  const listed = [...declared[1].matchAll(/['"](\w+)['"]/g)].map((match) => match[1]);
  return new Map(listed.map((name) => [name, surface.get(name) ?? null]));
}

/** Map of exported name -> parameter list (functions) or null. Empty for files without a known surface. */
export function exportsOf(filePath, text) {
  if (text === null || text === undefined) return new Map();
  if (JS_FILE.test(filePath)) return jsExports(text);
  if (PY_FILE.test(filePath)) return pyExports(text);
  return new Map();
}

/** Differences between two export maps: [{ name, change: 'removed' | 'added' | 'signature', before, after }]. */
export function compareExports(before, after) {
  const differences = [];
  for (const [name, parameters] of before) {
    if (!after.has(name)) differences.push({ name, change: 'removed', before: parameters, after: null });
    else if (parameters !== null && after.get(name) !== null && parameters !== after.get(name)) {
      differences.push({ name, change: 'signature', before: parameters, after: after.get(name) });
    }
  }
  for (const [name, parameters] of after) if (!before.has(name)) differences.push({ name, change: 'added', before: null, after: parameters });
  return differences;
}
