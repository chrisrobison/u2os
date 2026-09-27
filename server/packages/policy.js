// Package policies (docs/plugin-architecture.md §6): whether a specific
// action may happen automatically. Evaluated by deterministic code over
// structured facts; a model may supply facts (a score) but never the
// decision. The result can only TIGHTEN the policies.yaml decision made by
// server/policy/policy-engine.js -- see Agent.evaluateAndMaybeExecute().
import { checkExpression, evaluate, truthy } from './expression.js';
import { isPlainObject } from './json-schema.js';

export const APPROVAL_MODES = Object.freeze(['automatic', 'required', 'never']);
const POLICY_KEYS = new Set(['description', 'all', 'any', 'require', 'approval']);
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function validatePolicies(policies, errors = []) {
  if (policies === undefined) return errors;
  if (!isPlainObject(policies)) { errors.push('policies: must be a mapping of policy names'); return errors; }
  for (const [name, policy] of Object.entries(policies)) {
    const where = `policies.${name}`;
    if (!NAME.test(name)) errors.push(`${where}: invalid policy name`);
    if (!isPlainObject(policy)) { errors.push(`${where}: must be a mapping`); continue; }
    for (const key of Object.keys(policy)) if (!POLICY_KEYS.has(key)) errors.push(`${where}.${key}: unknown key`);
    if (policy.description !== undefined && typeof policy.description !== 'string') errors.push(`${where}.description: must be text`);
    if (policy.approval !== undefined && !APPROVAL_MODES.includes(policy.approval)) errors.push(`${where}.approval: use ${APPROVAL_MODES.join(', ')}`);
    for (const key of ['all', 'any', 'require']) {
      if (policy[key] === undefined) continue;
      if (!Array.isArray(policy[key]) || !policy[key].length) { errors.push(`${where}.${key}: must be a non-empty list of conditions`); continue; }
      policy[key].forEach((condition, index) => {
        const problem = typeof condition === 'string' ? checkExpression(condition) : 'must be an expression string';
        if (problem) errors.push(`${where}.${key}[${index}]: ${problem}`);
      });
    }
  }
  return errors;
}

/**
 * evaluatePackagePolicy(name, policy, facts, { approvalOverride, now }) ->
 *   { name, decision: 'automatic'|'approval'|'deny', approval, reasons }
 *
 * Unknown policies, failing conditions and conditions that cannot be
 * evaluated all fail closed to 'deny'.
 */
export function evaluatePackagePolicy(name, policy, facts = {}, { approvalOverride = null, now } = {}) {
  if (!policy) return { name, decision: 'deny', approval: null, reasons: [`policy "${name}" is not defined`] };
  const reasons = [];
  let met = true;
  const check = (condition) => {
    try { return truthy(evaluate(condition, facts, { now })); } catch (error) {
      reasons.push(`condition could not be evaluated: ${condition} (${error.message})`);
      return false;
    }
  };
  for (const condition of [...(policy.require || []), ...(policy.all || [])]) {
    if (!check(condition)) { met = false; reasons.push(`not met: ${condition}`); }
  }
  if (policy.any) {
    if (!policy.any.some(check)) { met = false; reasons.push(`none met: ${policy.any.join(' | ')}`); }
  }
  const approval = APPROVAL_MODES.includes(approvalOverride) ? approvalOverride : policy.approval || 'required';
  if (!met) return { name, decision: 'deny', approval, reasons };
  if (approval === 'never') return { name, decision: 'deny', approval, reasons: [...reasons, 'approval: never'] };
  if (approval === 'required') return { name, decision: 'approval', approval, reasons: [...reasons, 'approval: required'] };
  return { name, decision: 'automatic', approval, reasons: [...reasons, 'conditions met; approval: automatic'] };
}

/** A short owner-facing summary of a policy, for install review and the UI. */
export function summarizePolicy(name, policy, approvalOverride = null) {
  const approval = APPROVAL_MODES.includes(approvalOverride) ? approvalOverride : policy?.approval || 'required';
  const conditions = [...(policy?.require || []), ...(policy?.all || [])];
  if (policy?.any) conditions.push(`any of (${policy.any.join(' | ')})`);
  return { name, description: policy?.description || '', approval, conditions, overridden: APPROVAL_MODES.includes(approvalOverride) };
}
