// Declarative workflow definitions (docs/plugin-architecture.md §7):
// validation and helpers. Execution lives in workflow-engine.js.
//
// The step vocabulary is intentionally small. Anything that is not listed
// here is rejected rather than interpreted.
import { checkExpression, checkTemplate } from './expression.js';
import { checkSchema, isPlainObject } from './json-schema.js';
import { CAPABILITY_ID, LOCAL_ID } from './ids.js';
import { isValidEventType } from './events.js';

export const STEP_KINDS = Object.freeze(['capability', 'skill', 'transform', 'filter', 'emit', 'state', 'sleep', 'wait']);
export const AUTOMATION_ONLY_KINDS = Object.freeze(['state', 'sleep', 'wait']);
const STEP_KEYS = new Set(['id', 'description', 'use', 'with', 'when', 'foreach', 'retry', 'timeout', 'policy', 'onError']);
const WORKFLOW_KEYS = new Set(['id', 'description', 'inputs', 'steps', 'output']);
const STEP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const MAX_STEPS = 100;
export const MAX_RETRY_ATTEMPTS = 5;
const MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_SLEEP_MS = 366 * 86_400_000;

const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30s" -> 30000. Returns null for anything else. */
export function parseDuration(text) {
  if (typeof text === 'number' && Number.isInteger(text) && text >= 0) return text;
  const match = /^(\d{1,9})(ms|s|m|h|d)$/.exec(String(text ?? '').trim());
  return match ? Number(match[1]) * UNITS[match[2]] : null;
}

/** Parses `use:` into { kind, target }. Returns null when malformed. */
export function parseUse(use) {
  if (typeof use !== 'string') return null;
  const match = /^(capability|skill):(.+)$/.exec(use);
  if (match) return { kind: match[1], target: match[2] };
  return STEP_KINDS.includes(use) && use !== 'capability' && use !== 'skill' ? { kind: use, target: null } : null;
}

/** Strips an optional surrounding {{ }} from a condition expression. */
export function conditionSource(text) {
  const match = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(String(text));
  return (match ? match[1] : String(text)).trim();
}

/**
 * validateWorkflow(workflow, { kind: 'skill'|'automation', policies, emits, where })
 *   -> list of errors
 * `policies` (names) and `emits` (event types) come from the package
 * manifest so references can be checked at install time.
 */
export function validateWorkflow(workflow, { kind = 'skill', policies = null, emits = null, where = 'workflow' } = {}) {
  const errors = [];
  if (!isPlainObject(workflow)) return [`${where}: must be a mapping`];
  for (const key of Object.keys(workflow)) if (!WORKFLOW_KEYS.has(key)) errors.push(`${where}.${key}: unknown key`);
  if (workflow.inputs !== undefined) {
    if (!isPlainObject(workflow.inputs)) errors.push(`${where}.inputs: must map input names to schemas`);
    else for (const [name, schema] of Object.entries(workflow.inputs)) checkSchema(schema, `${where}.inputs.${name}`, 0, errors);
  }
  if (!Array.isArray(workflow.steps) || !workflow.steps.length) {
    errors.push(`${where}.steps: must be a non-empty list`);
    return errors;
  }
  if (workflow.steps.length > MAX_STEPS) errors.push(`${where}.steps: at most ${MAX_STEPS} steps`);
  const seen = new Set();
  workflow.steps.forEach((step, index) => {
    const at = `${where}.steps[${index}]`;
    if (!isPlainObject(step)) { errors.push(`${at}: must be a mapping`); return; }
    for (const key of Object.keys(step)) if (!STEP_KEYS.has(key)) errors.push(`${at}.${key}: unknown key`);
    if (typeof step.id !== 'string' || !STEP_ID.test(step.id)) errors.push(`${at}.id: required, letters/digits/-/_`);
    else if (seen.has(step.id)) errors.push(`${at}.id: duplicate step id "${step.id}"`);
    else seen.add(step.id);
    const use = parseUse(step.use);
    if (!use) { errors.push(`${at}.use: must be capability:<id>, skill:<id> or one of ${STEP_KINDS.slice(2).join(', ')}`); return; }
    if (use.kind === 'capability' && !CAPABILITY_ID.test(use.target)) errors.push(`${at}.use: invalid capability id "${use.target}"`);
    if (use.kind === 'skill' && !LOCAL_ID.test(use.target)) errors.push(`${at}.use: invalid skill id "${use.target}"`);
    if (kind !== 'automation' && AUTOMATION_ONLY_KINDS.includes(use.kind)) errors.push(`${at}.use: "${use.kind}" steps are only allowed in automations`);
    if (step.with !== undefined && !isPlainObject(step.with)) errors.push(`${at}.with: must be a mapping`);
    const input = isPlainObject(step.with) ? step.with : {};
    checkTemplate(input, `${at}.with`, errors);
    for (const key of ['when']) {
      if (step[key] === undefined) continue;
      const problem = typeof step[key] === 'string' ? checkExpression(conditionSource(step[key])) : 'must be an expression';
      if (problem) errors.push(`${at}.${key}: ${problem}`);
    }
    if (step.foreach !== undefined) {
      if (typeof step.foreach !== 'string') errors.push(`${at}.foreach: must be an expression`);
      else checkTemplate(step.foreach, `${at}.foreach`, errors);
    }
    if (step.retry !== undefined) {
      if (!isPlainObject(step.retry)) errors.push(`${at}.retry: must be { attempts, backoff }`);
      else {
        if (!Number.isInteger(step.retry.attempts) || step.retry.attempts < 1 || step.retry.attempts > MAX_RETRY_ATTEMPTS) errors.push(`${at}.retry.attempts: 1 to ${MAX_RETRY_ATTEMPTS}`);
        if (step.retry.backoff !== undefined && !withinDuration(step.retry.backoff, MAX_TIMEOUT_MS)) errors.push(`${at}.retry.backoff: a duration such as 5s, at most 1h`);
        for (const key of Object.keys(step.retry)) if (key !== 'attempts' && key !== 'backoff') errors.push(`${at}.retry.${key}: unknown key`);
      }
    }
    if (step.timeout !== undefined && !withinDuration(step.timeout, MAX_TIMEOUT_MS, 1)) errors.push(`${at}.timeout: a duration such as 30s, at most 1h`);
    if (step.onError !== undefined && step.onError !== 'fail' && step.onError !== 'continue') errors.push(`${at}.onError: use fail or continue`);
    if (step.policy !== undefined) {
      if (use.kind !== 'capability') errors.push(`${at}.policy: only capability steps take a policy`);
      else if (typeof step.policy !== 'string') errors.push(`${at}.policy: must be a policy name`);
      else if (policies && !policies.includes(step.policy)) errors.push(`${at}.policy: "${step.policy}" is not defined in the package's policies`);
    }
    validateStepInput(use.kind, input, at, { emits }, errors);
  });
  if (workflow.output !== undefined) checkTemplate(workflow.output, `${where}.output`, errors);
  return errors;
}

function validateStepInput(kind, input, at, { emits }, errors) {
  const require = (key) => { if (input[key] === undefined) errors.push(`${at}.with.${key}: is required for ${kind} steps`); };
  switch (kind) {
    case 'transform': require('value'); break;
    case 'filter':
      require('source');
      if (typeof input.where !== 'string') errors.push(`${at}.with.where: is required for filter steps`);
      else { const problem = checkExpression(conditionSource(input.where)); if (problem) errors.push(`${at}.with.where: ${problem}`); }
      break;
    case 'emit':
      if (typeof input.type !== 'string' || !isValidEventType(input.type)) errors.push(`${at}.with.type: a literal event type such as job.candidate`);
      else if (emits && !emits.includes(input.type)) errors.push(`${at}.with.type: "${input.type}" is not declared in events.emits`);
      break;
    case 'state':
      if (!isPlainObject(input.set)) errors.push(`${at}.with.set: must map state keys to values`);
      break;
    case 'sleep':
      if ((input.duration === undefined) === (input.until === undefined)) errors.push(`${at}.with: sleep takes exactly one of duration or until`);
      if (input.duration !== undefined && !(typeof input.duration === 'string' && input.duration.includes('{{')) && !withinDuration(input.duration, MAX_SLEEP_MS)) {
        errors.push(`${at}.with.duration: a duration such as 10m, at most 366d`);
      }
      break;
    case 'wait':
      if (typeof input.event !== 'string' || !isValidEventType(input.event)) errors.push(`${at}.with.event: a literal event type to wait for`);
      if (input.where !== undefined) {
        const problem = typeof input.where === 'string' ? checkExpression(conditionSource(input.where)) : 'must be an expression';
        if (problem) errors.push(`${at}.with.where: ${problem}`);
      }
      if (input.timeout !== undefined && !withinDuration(input.timeout, MAX_SLEEP_MS, 1)) errors.push(`${at}.with.timeout: a duration such as 1d`);
      break;
    default: break;
  }
}

function withinDuration(value, max, min = 0) {
  const ms = parseDuration(value);
  return ms !== null && ms >= min && ms <= max;
}

/** Capabilities and skills a workflow invokes directly. */
export function workflowReferences(workflow) {
  const capabilities = new Set();
  const skills = new Set();
  for (const step of workflow?.steps || []) {
    const use = parseUse(step?.use);
    if (use?.kind === 'capability') capabilities.add(use.target);
    if (use?.kind === 'skill') skills.add(use.target);
  }
  return { capabilities: [...capabilities], skills: [...skills] };
}
