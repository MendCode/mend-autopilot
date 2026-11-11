// A small JSON Schema validator for the keywords the evidence card schema uses, so cards can be checked
// with the standard library only. An unknown keyword is refused rather than ignored, so the schema
// cannot grow a rule that nothing enforces.

const ANNOTATIONS = new Set(['$schema', '$id', '$defs', 'title', 'description', 'examples', 'default', 'format']);
const ASSERTIONS = new Set([
  '$ref', 'type', 'enum', 'const', 'minLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'required', 'properties', 'additionalProperties',
  'propertyNames', 'minProperties', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
]);

function typeMatches(type, value) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((name) => {
    if (name === 'null') return value === null;
    if (name === 'array') return Array.isArray(value);
    if (name === 'integer') return Number.isInteger(value);
    if (name === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    return typeof value === name;
  });
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Returns a list of { path, message }; empty when value is valid. Throws TypeError on an unknown keyword. */
export function validateSchema(root, value) {
  const resolve = (ref) => {
    if (!ref.startsWith('#/')) throw new TypeError(`[SCHEMA]: only local $ref is supported, got ${ref}`);
    return ref.slice(2).split('/').reduce((node, key) => node?.[key], root);
  };
  const errors = [];
  const passes = (schema, instance) => {
    const local = [];
    visit(schema, instance, '', local);
    return local.length === 0;
  };
  function visit(schema, instance, where, out) {
    if (schema === true) return;
    if (schema === false) {
      out.push({ path: where, message: 'no value is allowed here' });
      return;
    }
    for (const keyword of Object.keys(schema)) {
      if (!ANNOTATIONS.has(keyword) && !ASSERTIONS.has(keyword)) throw new TypeError(`[SCHEMA]: unsupported keyword "${keyword}" at ${where || '/'}`);
    }
    if (schema.$ref) {
      const target = resolve(schema.$ref);
      if (target === undefined) throw new TypeError(`[SCHEMA]: unresolved $ref ${schema.$ref}`);
      visit(target, instance, where, out);
    }
    if (schema.type && !typeMatches(schema.type, instance)) {
      out.push({ path: where, message: `must be ${[].concat(schema.type).join(' or ')}` });
      return;
    }
    if (schema.enum && !schema.enum.some((option) => same(option, instance))) out.push({ path: where, message: `must be one of ${schema.enum.join(', ')}` });
    if ('const' in schema && !same(schema.const, instance)) out.push({ path: where, message: `must be ${JSON.stringify(schema.const)}` });
    if (typeof instance === 'string') {
      if (schema.minLength !== undefined && instance.length < schema.minLength) out.push({ path: where, message: `shorter than ${schema.minLength}` });
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(instance)) out.push({ path: where, message: `does not match ${schema.pattern}` });
    }
    if (typeof instance === 'number') {
      if (schema.minimum !== undefined && instance < schema.minimum) out.push({ path: where, message: `below ${schema.minimum}` });
      if (schema.maximum !== undefined && instance > schema.maximum) out.push({ path: where, message: `above ${schema.maximum}` });
      if (schema.exclusiveMinimum !== undefined && instance <= schema.exclusiveMinimum) out.push({ path: where, message: `not above ${schema.exclusiveMinimum}` });
    }
    if (Array.isArray(instance)) {
      if (schema.minItems !== undefined && instance.length < schema.minItems) out.push({ path: where, message: `fewer than ${schema.minItems} items` });
      if (schema.maxItems !== undefined && instance.length > schema.maxItems) out.push({ path: where, message: `more than ${schema.maxItems} items` });
      if (schema.uniqueItems && new Set(instance.map((entry) => JSON.stringify(entry))).size !== instance.length) out.push({ path: where, message: 'items repeat' });
      if (schema.items) instance.forEach((entry, index) => visit(schema.items, entry, `${where}/${index}`, out));
      if (schema.contains && !instance.some((entry) => passes(schema.contains, entry))) out.push({ path: where, message: 'no item matches contains' });
    }
    if (typeMatches('object', instance)) {
      for (const key of schema.required ?? []) if (!(key in instance)) out.push({ path: where, message: `missing ${key}` });
      if (schema.minProperties !== undefined && Object.keys(instance).length < schema.minProperties) out.push({ path: where, message: `fewer than ${schema.minProperties} properties` });
      for (const [key, entry] of Object.entries(instance)) {
        if (schema.propertyNames) visit(schema.propertyNames, key, `${where}/<${key}>`, out);
        if (schema.properties && key in schema.properties) visit(schema.properties[key], entry, `${where}/${key}`, out);
        else if (schema.additionalProperties === false) out.push({ path: where, message: `unexpected property ${key}` });
        else if (typeof schema.additionalProperties === 'object') visit(schema.additionalProperties, entry, `${where}/${key}`, out);
      }
    }
    for (const part of schema.allOf ?? []) visit(part, instance, where, out);
    if (schema.anyOf && !schema.anyOf.some((part) => passes(part, instance))) out.push({ path: where, message: 'matches none of anyOf' });
    if (schema.oneOf) {
      const matched = schema.oneOf.filter((part) => passes(part, instance)).length;
      if (matched !== 1) out.push({ path: where, message: `matches ${matched} of oneOf, expected 1` });
    }
    if (schema.not && passes(schema.not, instance)) out.push({ path: where, message: 'matches a forbidden shape' });
    if (schema.if) {
      if (passes(schema.if, instance)) {
        if (schema.then) visit(schema.then, instance, where, out);
      } else if (schema.else) visit(schema.else, instance, where, out);
    }
  }
  visit(root, value, '', errors);
  return errors;
}
