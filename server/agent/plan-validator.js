// Strict plan schema + validation (PLAN.md's Milestone 2 / Phase 3). No
// model-produced plan reaches the policy engine unless it passes here.
// SECURITY invariants this file exists to enforce:
//   - every action's tool must already be registered (never invents a tool)
//   - every action's arguments must match that tool's own declared schema
//   - the plan is bounded in breadth (action count) and depth (argument
//     nesting), so a pathological or adversarial response can't blow up
//     downstream processing
//   - only recognized top-level plan keys survive -- an unrecognized key is
//     rejected outright (never silently trusted, never eval'd)
// This is pure data validation: nothing here ever executes model output.
const MAX_ACTIONS = 10;
const MAX_ARG_DEPTH = 4;
const MAX_MEMORY_CANDIDATES = 20;
const KNOWN_PLAN_KEYS = ['reasoning_summary', 'actions', 'memoryCandidates', 'response', 'continue'];
const KNOWN_ACTION_KEYS = ['tool', 'arguments', 'reason', 'dependsOn', 'resultRefs', 'priorResultRefs'];
const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];

export function validatePlan(plan, toolRegistry) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Model returned an invalid plan object');

  for (const key of Object.keys(plan)) {
    if (!KNOWN_PLAN_KEYS.includes(key)) throw new Error(`Model plan contains an unrecognized field "${key}"`);
  }

  if (typeof plan.reasoning_summary !== 'string') throw new Error('Model plan requires reasoning_summary');
  if (!Array.isArray(plan.actions)) throw new Error('Model plan requires an actions array');
  if (plan.actions.length > MAX_ACTIONS) throw new Error(`Model plan exceeds the ${MAX_ACTIONS}-action limit`);

  plan.actions.forEach((action, index) => validateAction(action, index, toolRegistry));

  if (plan.response !== undefined && typeof plan.response !== 'string') {
    throw new Error('Model plan response must be a string');
  }
  if (plan.continue !== undefined && typeof plan.continue !== 'boolean') throw new Error('Model plan continue must be boolean');
  if (plan.memoryCandidates !== undefined) validateMemoryCandidates(plan.memoryCandidates);

  return {
    reasoning_summary: plan.reasoning_summary,
    actions: plan.actions.map((a) => ({ tool: a.tool, arguments: a.arguments, ...(a.reason !== undefined ? { reason: a.reason } : {}), ...(a.dependsOn !== undefined ? { dependsOn: a.dependsOn } : {}), ...(a.resultRefs !== undefined ? { resultRefs: a.resultRefs } : {}), ...(a.priorResultRefs !== undefined ? { priorResultRefs: a.priorResultRefs } : {}) })),
    ...(plan.response !== undefined ? { response: plan.response } : {}),
    ...(plan.continue !== undefined ? { continue: plan.continue } : {}),
    ...(plan.memoryCandidates !== undefined ? { memoryCandidates: plan.memoryCandidates } : {}),
  };
}

/**
 * Attempts EXACTLY ONE bounded, non-fabricating repair pass on a plan that
 * failed strict validation, then re-validates. Per PLAN.md Phase 3: "If a
 * model produces an invalid plan: (1) optionally attempt one bounded repair
 * pass, (2) otherwise fail explicitly." The repair pass only:
 *   - drops unrecognized top-level keys (instead of rejecting the whole plan)
 *   - defaults a missing/null `actions` to an empty array
 *   - wraps a single action object (not wrapped in an array) into one
 *   - defaults a missing/non-string `reasoning_summary` to ''
 * It NEVER invents, drops, or "fixes" an individual action's tool or
 * arguments -- an action with an unregistered tool or missing/invalid
 * arguments still fails validation on the retry, and the ORIGINAL error is
 * what's thrown (the repair attempt is diagnostic, not a way to mask a real
 * problem). Callers that don't want this can pass `attemptRepair: false`.
 */
export function validatePlanWithRepair(plan, toolRegistry, { attemptRepair = true } = {}) {
  try {
    return validatePlan(plan, toolRegistry);
  } catch (originalError) {
    if (!attemptRepair) throw originalError;
    const repaired = boundedRepair(plan);
    if (!repaired) throw originalError;
    try {
      const result = validatePlan(repaired, toolRegistry);
      console.error(`[plan-validator] repaired an invalid plan (original error: ${originalError.message})`);
      return result;
    } catch {
      throw originalError;
    }
  }
}

function boundedRepair(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const repaired = {};
  for (const key of KNOWN_PLAN_KEYS) if (key in plan) repaired[key] = plan[key];
  if (repaired.actions == null) repaired.actions = [];
  else if (!Array.isArray(repaired.actions) && typeof repaired.actions === 'object') repaired.actions = [repaired.actions];
  if (typeof repaired.reasoning_summary !== 'string') repaired.reasoning_summary = '';
  return repaired;
}

function validateAction(action, index, toolRegistry) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Model returned a malformed action');
  for (const key of Object.keys(action)) {
    if (!KNOWN_ACTION_KEYS.includes(key)) throw new Error(`Model action contains an unrecognized field "${key}"`);
  }
  if (typeof action.tool !== 'string' || !plainObject(action.arguments)) throw new Error('Model returned a malformed action');

  const tool = toolRegistry.get(action.tool); // fail closed on unregistered/invented tools
  if (exceedsDepth(action.arguments, MAX_ARG_DEPTH)) {
    throw new Error(`Model action ${action.tool} arguments exceed the maximum nesting depth (${MAX_ARG_DEPTH})`);
  }
  validateArguments(action.arguments, tool.schema, action.tool);
  if (action.resultRefs !== undefined) validateResultRefs(action.resultRefs, action.arguments, action.tool);
  if (action.priorResultRefs !== undefined) validatePriorResultRefs(action.priorResultRefs, action.arguments, action.tool);
  if (action.resultRefs && action.priorResultRefs && Object.keys(action.resultRefs).some((key) => Object.hasOwn(action.priorResultRefs, key))) {
    throw new Error(`Model action ${action.tool} cannot use two references for one argument`);
  }

  if (action.reason !== undefined && typeof action.reason !== 'string') {
    throw new Error(`Model action ${action.tool}.reason must be a string`);
  }
  if (action.dependsOn !== undefined) {
    if (!Array.isArray(action.dependsOn) || action.dependsOn.length > MAX_ACTIONS) {
      throw new Error(`Model action ${action.tool}.dependsOn must be a bounded array`);
    }
    for (const dep of action.dependsOn) {
      // Only backward references within the same plan are meaningful, and
      // this also makes a dependency cycle structurally impossible.
      if (!Number.isInteger(dep) || dep < 0 || dep >= index) {
        throw new Error(`Model action ${action.tool}.dependsOn contains an invalid reference (must be an earlier action's index)`);
      }
    }
  }
}

function validateResultRefs(refs, args, toolName) {
  if (!plainObject(refs) || Object.keys(refs).length > 8) throw new Error(`Model action ${toolName}.resultRefs must be a bounded object`);
  for (const [argument, ref] of Object.entries(refs)) {
    if (!Object.hasOwn(args, argument) || ['__proto__', 'prototype', 'constructor'].includes(argument) ||
        !plainObject(ref) || Object.keys(ref).some((key) => !['stepIndex', 'itemIndex', 'path'].includes(key))) {
      throw new Error(`Model action ${toolName}.resultRefs contains an invalid reference`);
    }
    if (!Number.isInteger(ref.stepIndex) || ref.stepIndex < 0 || !Number.isInteger(ref.itemIndex) || ref.itemIndex < 0 ||
        typeof ref.path !== 'string' || ref.path.length > 128 || !/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\.[0-9]+){0,2}$/.test(ref.path) ||
        ref.path.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) {
      throw new Error(`Model action ${toolName}.resultRefs contains an invalid reference`);
    }
  }
}

function validatePriorResultRefs(refs, args, toolName) {
  if (!plainObject(refs) || Object.keys(refs).length > 2) throw new Error(`Model action ${toolName}.priorResultRefs must be a bounded object`);
  for (const [argument, ref] of Object.entries(refs)) {
    if (!Object.hasOwn(args, argument) || ['__proto__', 'prototype', 'constructor'].includes(argument) ||
        !plainObject(ref) || Object.keys(ref).some((key) => !['actionId', 'itemIndex', 'path'].includes(key)) ||
        typeof ref.actionId !== 'string' || !/^act_[a-zA-Z0-9_]{1,100}$/.test(ref.actionId) ||
        !Number.isInteger(ref.itemIndex) || ref.itemIndex < 0 || ref.itemIndex > 11 ||
        typeof ref.path !== 'string' || ref.path.length > 128 ||
        !/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\.[0-9]+){0,2}$/.test(ref.path) ||
        ref.path.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) {
      throw new Error(`Model action ${toolName}.priorResultRefs contains an invalid reference`);
    }
  }
}

function validateMemoryCandidates(candidates) {
  if (!Array.isArray(candidates)) throw new Error('Model plan memoryCandidates must be an array');
  if (candidates.length > MAX_MEMORY_CANDIDATES) throw new Error(`Model plan exceeds the ${MAX_MEMORY_CANDIDATES}-memoryCandidates limit`);
  for (const candidate of candidates) {
    if (!plainObject(candidate)) throw new Error('Model plan memoryCandidates entries must be objects');
    if (typeof candidate.content !== 'string' || !candidate.content.trim()) {
      throw new Error('Model plan memoryCandidates entry requires non-empty string content');
    }
    if (candidate.confidence !== undefined && !CONFIDENCE_LEVELS.includes(candidate.confidence)) {
      throw new Error(`Model plan memoryCandidates entry confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
    }
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exceedsDepth(value, limit, depth = 0) {
  if (depth > limit) return true;
  if (Array.isArray(value)) return value.some((v) => exceedsDepth(v, limit, depth + 1));
  if (plainObject(value)) return Object.values(value).some((v) => exceedsDepth(v, limit, depth + 1));
  return false;
}

function validateArguments(args, schema = {}, toolName) {
  for (const key of schema.required || []) if (!(key in args)) throw new Error(`Model action ${toolName} is missing required argument ${key}`);
  const properties = schema.properties || {};
  for (const [key, value] of Object.entries(args)) {
    if (!(key in properties)) throw new Error(`Model action ${toolName} contains unknown argument ${key}`);
    const type = properties[key]?.type;
    if (type && !matchesType(value, type)) throw new Error(`Model action ${toolName}.${key} must be ${type}`);
  }
}
function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return plainObject(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}
