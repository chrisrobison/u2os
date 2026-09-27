// A deliberately small JSON Schema subset for package-declared capability,
// skill and workflow inputs/outputs (docs/plugin-architecture.md §7).
//
// Package schemas are untrusted input, so the subset is closed: a schema
// using any keyword outside SUPPORTED is rejected at install time rather
// than silently ignored. `pattern` is intentionally unsupported: an
// untrusted regular expression is a denial-of-service surface on every
// invocation (see server/triggers/regex-safety.js).

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const SUPPORTED = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'const', 'minimum', 'maximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'additionalProperties',
  'description', 'title', 'default', 'format', 'examples',
]);
const MAX_DEPTH = 16;
const MAX_ERRORS = 20;

/**
 * Checks that a declared schema only uses the supported subset. Returns a
 * list of error strings (empty when valid).
 */
export function checkSchema(schema, where = 'schema', depth = 0, errors = []) {
  if (depth > MAX_DEPTH) { errors.push(`${where}: nested too deeply`); return errors; }
  if (!isPlainObject(schema)) { errors.push(`${where}: must be a mapping`); return errors; }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) errors.push(`${where}: unsupported keyword "${key}"`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => !TYPES.has(type))) errors.push(`${where}.type: must be one of ${[...TYPES].join(', ')}`);
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) errors.push(`${where}.properties: must be a mapping`);
    else for (const [name, child] of Object.entries(schema.properties)) checkSchema(child, `${where}.properties.${name}`, depth + 1, errors);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string'))) {
    errors.push(`${where}.required: must be a list of property names`);
  }
  if (schema.items !== undefined) checkSchema(schema.items, `${where}.items`, depth + 1, errors);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    checkSchema(schema.additionalProperties, `${where}.additionalProperties`, depth + 1, errors);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) errors.push(`${where}.enum: must be a non-empty list`);
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && typeof schema[key] !== 'number') errors.push(`${where}.${key}: must be a number`);
  }
  return errors;
}

/**
 * validate(schema, value) -> list of error strings. An undefined or empty
 * schema accepts anything.
 */
export function validate(schema, value, where = 'value') {
  const errors = [];
  visit(schema, value, where, 0, errors);
  return errors;
}

export function assertValid(schema, value, where = 'value') {
  const errors = validate(schema, value, where);
  if (errors.length) {
    const error = new Error(`Schema validation failed: ${errors.join('; ')}`);
    error.code = 'SCHEMA_INVALID';
    error.errors = errors;
    throw error;
  }
  return value;
}

function visit(schema, value, where, depth, errors) {
  if (!schema || errors.length >= MAX_ERRORS) return;
  if (depth > MAX_DEPTH) { errors.push(`${where}: nested too deeply`); return; }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      errors.push(`${where}: expected ${types.join(' or ')}`);
      return;
    }
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) errors.push(`${where}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((option) => deepEqual(option, value))) errors.push(`${where}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where}: must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where}: must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${where}: must be at most ${schema.maxLength} characters`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where}: must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${where}: must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => visit(schema.items, item, `${where}[${index}]`, depth + 1, errors));
  }
  if (isPlainObject(value)) {
    for (const name of schema.required || []) {
      if (!Object.hasOwn(value, name) || value[name] === undefined) errors.push(`${where}.${name}: is required`);
    }
    const properties = schema.properties || {};
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) visit(properties[name], child, `${where}.${name}`, depth + 1, errors);
      else if (schema.additionalProperties === false) errors.push(`${where}.${name}: is not allowed`);
      else if (isPlainObject(schema.additionalProperties)) visit(schema.additionalProperties, child, `${where}.${name}`, depth + 1, errors);
    }
  }
}

/** Fills top-level `default`s for missing properties of an object value. */
export function applyDefaults(schema, value) {
  if (!schema?.properties || (value !== undefined && !isPlainObject(value))) return value;
  const result = { ...(value || {}) };
  for (const [name, child] of Object.entries(schema.properties)) {
    if (result[name] === undefined && child && child.default !== undefined) result[name] = structuredClone(child.default);
  }
  return result;
}

function matchesType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: return false;
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
