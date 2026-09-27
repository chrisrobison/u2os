// Safe expression language for workflow conditions, interpolation and
// package policies (docs/plugin-architecture.md §7).
//
// SECURITY: package workflows are untrusted input. Expressions are parsed
// into a small AST by a recursive-descent parser and interpreted over plain
// data. There is no eval/Function, no method calls, no prototype access,
// only own-property reads, and only the pure functions in FUNCTIONS.
// Length, nesting depth and evaluation work are all bounded.

const MAX_LENGTH = 2_000;
const MAX_DEPTH = 64;
const MAX_STEPS = 20_000;
const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype']);
const KEYWORDS = new Set(['true', 'false', 'null', 'and', 'or', 'not', 'in']);

export class ExpressionError extends Error {
  constructor(message) {
    super(message);
    this.code = 'EXPRESSION_INVALID';
  }
}

// --- tokenizer ------------------------------------------------------------

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
      tokens.push({ type: 'num', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let value = '';
      let j = i + 1;
      for (; j < source.length && source[j] !== ch; j++) {
        if (source[j] === '\\') {
          const next = source[++j];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next ?? '';
        } else value += source[j];
      }
      if (j >= source.length) throw new ExpressionError('Unterminated string');
      tokens.push({ type: 'str', value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i));
      tokens.push({ type: KEYWORDS.has(match[0]) ? 'kw' : 'id', value: match[0] });
      i += match[0].length;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
    if ('<>!+-*/%?:()[],.'.includes(ch)) { tokens.push({ type: 'op', value: ch }); i++; continue; }
    throw new ExpressionError(`Unexpected character "${ch}"`);
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

// --- parser ---------------------------------------------------------------

class Parser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; this.depth = 0; }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  isOp(value) { const t = this.peek(); return t.type === 'op' && t.value === value; }
  isKw(value) { const t = this.peek(); return t.type === 'kw' && t.value === value; }
  expectOp(value) {
    if (!this.isOp(value)) throw new ExpressionError(`Expected "${value}"`);
    this.next();
  }
  enter() { if (++this.depth > MAX_DEPTH) throw new ExpressionError('Expression is nested too deeply'); }
  leave() { this.depth--; }

  parse() {
    const node = this.ternary();
    if (this.peek().type !== 'eof') throw new ExpressionError('Unexpected trailing input');
    return node;
  }

  ternary() {
    this.enter();
    const test = this.or();
    let node = test;
    if (this.isOp('?')) {
      this.next();
      const then = this.ternary();
      this.expectOp(':');
      node = { t: 'cond', test, then, else: this.ternary() };
    }
    this.leave();
    return node;
  }

  or() {
    let left = this.and();
    while (this.isOp('||') || this.isKw('or')) { this.next(); left = { t: 'bin', op: '||', l: left, r: this.and() }; }
    return left;
  }

  and() {
    let left = this.not();
    while (this.isOp('&&') || this.isKw('and')) { this.next(); left = { t: 'bin', op: '&&', l: left, r: this.not() }; }
    return left;
  }

  not() {
    if (this.isOp('!') || (this.isKw('not') && !(this.tokens[this.pos + 1]?.type === 'kw' && this.tokens[this.pos + 1].value === 'in'))) {
      this.next();
      this.enter();
      const node = { t: 'unary', op: '!', arg: this.not() };
      this.leave();
      return node;
    }
    return this.comparison();
  }

  comparison() {
    const left = this.additive();
    const t = this.peek();
    if (t.type === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.value)) {
      this.next();
      return { t: 'bin', op: t.value, l: left, r: this.additive() };
    }
    if (this.isKw('in')) { this.next(); return { t: 'bin', op: 'in', l: left, r: this.additive() }; }
    if (this.isKw('not')) {
      this.next();
      if (!this.isKw('in')) throw new ExpressionError('Expected "in" after "not"');
      this.next();
      return { t: 'unary', op: '!', arg: { t: 'bin', op: 'in', l: left, r: this.additive() } };
    }
    return left;
  }

  additive() {
    let left = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) { const op = this.next().value; left = { t: 'bin', op, l: left, r: this.multiplicative() }; }
    return left;
  }

  multiplicative() {
    let left = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) { const op = this.next().value; left = { t: 'bin', op, l: left, r: this.unary() }; }
    return left;
  }

  unary() {
    if (this.isOp('-') || this.isOp('!')) {
      const op = this.next().value;
      this.enter();
      const node = { t: 'unary', op, arg: this.unary() };
      this.leave();
      return node;
    }
    return this.postfix();
  }

  postfix() {
    let node = this.primary();
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        const name = this.next();
        if (name.type !== 'id' && name.type !== 'kw') throw new ExpressionError('Expected a property name after "."');
        node = { t: 'member', obj: node, prop: { t: 'lit', v: name.value } };
      } else if (this.isOp('[')) {
        this.next();
        this.enter();
        const prop = this.ternary();
        this.leave();
        this.expectOp(']');
        node = { t: 'member', obj: node, prop };
      } else if (this.isOp('(')) {
        if (node.t !== 'id') throw new ExpressionError('Only built-in functions can be called');
        if (!Object.hasOwn(FUNCTIONS, node.name)) throw new ExpressionError(`Unknown function "${node.name}"`);
        this.next();
        const args = [];
        if (!this.isOp(')')) {
          do { this.enter(); args.push(this.ternary()); this.leave(); } while (this.isOp(',') && this.next());
        }
        this.expectOp(')');
        node = { t: 'call', name: node.name, args };
      } else return node;
    }
  }

  primary() {
    const t = this.next();
    if (t.type === 'num' || t.type === 'str') return { t: 'lit', v: t.value };
    if (t.type === 'kw') {
      if (t.value === 'true') return { t: 'lit', v: true };
      if (t.value === 'false') return { t: 'lit', v: false };
      if (t.value === 'null') return { t: 'lit', v: null };
      throw new ExpressionError(`Unexpected "${t.value}"`);
    }
    if (t.type === 'id') return { t: 'id', name: t.value };
    if (t.type === 'op' && t.value === '(') {
      this.enter();
      const node = this.ternary();
      this.leave();
      this.expectOp(')');
      return node;
    }
    if (t.type === 'op' && t.value === '[') {
      const items = [];
      if (!this.isOp(']')) {
        do { this.enter(); items.push(this.ternary()); this.leave(); } while (this.isOp(',') && this.next());
      }
      this.expectOp(']');
      return { t: 'list', items };
    }
    throw new ExpressionError('Unexpected end of expression');
  }
}

const cache = new Map();

/** Parses an expression into an AST (cached). Throws ExpressionError. */
export function compile(source) {
  if (typeof source !== 'string') throw new ExpressionError('Expression must be a string');
  if (source.length > MAX_LENGTH) throw new ExpressionError(`Expression is longer than ${MAX_LENGTH} characters`);
  const cached = cache.get(source);
  if (cached) return cached;
  const ast = new Parser(tokenize(source)).parse();
  if (cache.size > 1_000) cache.clear();
  cache.set(source, ast);
  return ast;
}

/** Returns an error message for an invalid expression, or null. */
export function checkExpression(source) {
  try { compile(source); return null; } catch (error) { return error.message; }
}

// --- interpreter ----------------------------------------------------------

/**
 * evaluate(source, scope, { now }) -> value. `scope` is plain data. Unknown
 * identifiers and missing properties evaluate to undefined (never throw), so
 * conditions over optional data stay simple.
 */
export function evaluate(source, scope = {}, options = {}) {
  const ast = typeof source === 'string' ? compile(source) : source;
  const state = { steps: 0, now: options.now ? new Date(options.now) : new Date() };
  return run(ast, scope, state);
}

function run(node, scope, state) {
  if (++state.steps > MAX_STEPS) throw new ExpressionError('Expression evaluation exceeded its budget');
  switch (node.t) {
    case 'lit': return node.v;
    case 'id': return readProperty(scope, node.name);
    case 'list': return node.items.map((item) => run(item, scope, state));
    case 'member': return readProperty(run(node.obj, scope, state), run(node.prop, scope, state));
    case 'call': return FUNCTIONS[node.name](state, ...node.args.map((arg) => run(arg, scope, state)));
    case 'unary': {
      const value = run(node.arg, scope, state);
      if (node.op === '!') return !truthy(value);
      return typeof value === 'number' ? -value : null;
    }
    case 'cond': return truthy(run(node.test, scope, state)) ? run(node.then, scope, state) : run(node.else, scope, state);
    case 'bin': {
      if (node.op === '&&') { const l = run(node.l, scope, state); return truthy(l) ? run(node.r, scope, state) : l; }
      if (node.op === '||') { const l = run(node.l, scope, state); return truthy(l) ? l : run(node.r, scope, state); }
      return binary(node.op, run(node.l, scope, state), run(node.r, scope, state));
    }
    default: throw new ExpressionError('Invalid expression');
  }
}

function readProperty(target, key) {
  if (target === null || target === undefined) return undefined;
  if (typeof key !== 'string' && typeof key !== 'number') return undefined;
  const name = String(key);
  if (FORBIDDEN_PROPERTIES.has(name)) throw new ExpressionError(`Access to "${name}" is not allowed`);
  if ((Array.isArray(target) || typeof target === 'string') && name === 'length') return target.length;
  if (typeof target !== 'object') return undefined;
  return Object.hasOwn(target, name) ? target[name] : undefined;
}

function binary(op, l, r) {
  switch (op) {
    case '==': return equals(l, r);
    case '!=': return !equals(l, r);
    case '<': case '<=': case '>': case '>=': {
      if (!((typeof l === 'number' && typeof r === 'number') || (typeof l === 'string' && typeof r === 'string'))) return false;
      return op === '<' ? l < r : op === '<=' ? l <= r : op === '>' ? l > r : l >= r;
    }
    case 'in':
      if (Array.isArray(r)) return r.some((item) => equals(item, l));
      if (typeof r === 'string') return typeof l === 'string' && r.includes(l);
      if (r && typeof r === 'object') return (typeof l === 'string' || typeof l === 'number') && Object.hasOwn(r, String(l));
      return false;
    case '+':
      if (typeof l === 'number' && typeof r === 'number') return l + r;
      if (typeof l === 'string' || typeof r === 'string') return toText(l) + toText(r);
      return null;
    case '-': case '*': case '/': case '%': {
      if (typeof l !== 'number' || typeof r !== 'number') return null;
      if ((op === '/' || op === '%') && r === 0) return null;
      return op === '-' ? l - r : op === '*' ? l * r : op === '/' ? l / r : l % r;
    }
    default: throw new ExpressionError(`Unknown operator ${op}`);
  }
}

function equals(a, b) {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function truthy(value) {
  return Boolean(value);
}

const FUNCTIONS = Object.freeze({
  len: (_s, value) => (Array.isArray(value) || typeof value === 'string' ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0),
  lower: (_s, value) => (typeof value === 'string' ? value.toLowerCase() : value),
  upper: (_s, value) => (typeof value === 'string' ? value.toUpperCase() : value),
  contains: (_s, haystack, needle) => binary('in', typeof haystack === 'string' && typeof needle === 'string' ? needle.toLowerCase() : needle,
    typeof haystack === 'string' && typeof needle === 'string' ? haystack.toLowerCase() : haystack),
  startsWith: (_s, value, prefix) => typeof value === 'string' && typeof prefix === 'string' && value.startsWith(prefix),
  endsWith: (_s, value, suffix) => typeof value === 'string' && typeof suffix === 'string' && value.endsWith(suffix),
  min: (_s, ...values) => numeric(values.flat(), Math.min),
  max: (_s, ...values) => numeric(values.flat(), Math.max),
  abs: (_s, value) => (typeof value === 'number' ? Math.abs(value) : null),
  round: (_s, value, digits = 0) => (typeof value === 'number' ? Math.round(value * 10 ** digits) / 10 ** digits : null),
  floor: (_s, value) => (typeof value === 'number' ? Math.floor(value) : null),
  ceil: (_s, value) => (typeof value === 'number' ? Math.ceil(value) : null),
  coalesce: (_s, ...values) => values.find((value) => value !== null && value !== undefined) ?? null,
  join: (_s, value, separator = ', ') => (Array.isArray(value) ? value.map(toText).join(toText(separator)) : toText(value)),
  keys: (_s, value) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []),
  concat: (_s, ...lists) => lists.flatMap((list) => (Array.isArray(list) ? list : list === null || list === undefined ? [] : [list])),
  pluck: (_s, list, key) => (Array.isArray(list) ? list.map((item) => readProperty(item, key)) : []),
  unique: (_s, list) => (Array.isArray(list) ? list.filter((item, index) => list.findIndex((other) => equals(other, item)) === index) : []),
  slice: (_s, value, start = 0, end) => (Array.isArray(value) || typeof value === 'string' ? value.slice(start, end) : null),
  now: (state) => state.now.toISOString(),
  daysSince: (state, value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) ? Math.floor((state.now.getTime() - time) / 86_400_000) : null;
  },
});

function numeric(values, fn) {
  const numbers = values.filter((value) => typeof value === 'number');
  return numbers.length ? fn(...numbers) : null;
}

export function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// --- interpolation --------------------------------------------------------

const WHOLE = /^\s*\{\{([\s\S]*?)\}\}\s*$/;
const PART = /\{\{([\s\S]*?)\}\}/g;

/** Validates every {{ }} expression within a (possibly nested) template. */
export function checkTemplate(template, where = 'value', errors = []) {
  if (typeof template === 'string') {
    for (const match of template.matchAll(PART)) {
      const problem = checkExpression(match[1].trim());
      if (problem) errors.push(`${where}: ${problem}`);
    }
    if (/\{\{/.test(template.replace(PART, ''))) errors.push(`${where}: unclosed "{{"`);
  } else if (Array.isArray(template)) {
    template.forEach((item, index) => checkTemplate(item, `${where}[${index}]`, errors));
  } else if (template && typeof template === 'object') {
    for (const [key, value] of Object.entries(template)) checkTemplate(value, `${where}.${key}`, errors);
  }
  return errors;
}

/**
 * Resolves {{ expr }} templates recursively. A string consisting of exactly
 * one expression yields its raw value (so objects and numbers pass through);
 * otherwise each expression is stringified into the surrounding text.
 */
export function resolveTemplate(template, scope, options = {}) {
  if (typeof template === 'string') {
    const whole = WHOLE.exec(template);
    if (whole && !whole[1].includes('}}')) return evaluate(whole[1].trim(), scope, options);
    return template.replace(PART, (_m, expr) => toText(evaluate(expr.trim(), scope, options)));
  }
  if (Array.isArray(template)) return template.map((item) => resolveTemplate(item, scope, options));
  if (template && typeof template === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(template)) result[key] = resolveTemplate(value, scope, options);
    return result;
  }
  return template;
}
