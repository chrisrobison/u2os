import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import yaml from 'js-yaml';
import { validatePolicies, vaultPoliciesPath, VAULT_POLICY_INVALID } from './policies-loader.js';

// "Approve and always allow" (#618). An explicit owner click may loosen ONE
// `confirm` rule to `autonomous` in the vault policies.yaml. Nothing learned,
// model-authored or automatic ever reaches this module: the caller is an
// owner-authenticated approval route.
//
// Deliberately narrow:
//   - only `domain.operation:confirm` (a plain level), `domain.operation.<sub>:confirm`
//     (one named sub-category) and `domain.operation:missing` (no rule yet);
//   - never `default`, `fallback-confirm`, `never`, an invalid vault policy,
//     or any gate other than the plain policy rule (voice, goal, account,
//     package), because for those "confirm" is not what stopped the action.
// The write is a minimal text edit so the owner's comments and layout survive;
// the result is re-parsed and compared with the intended change before it is
// written, and any layout the patcher does not understand is refused.

const RULE = /^([^.:\s]+)\.([^.:\s]+?)(?:\.([^.:\s]+))?:(confirm|missing)$/;
const NAME = /^[A-Za-z0-9_-]+$/;
const HEADER = '# What U2OS may do on your behalf (docs/policies.md).\n# Levels: always, autonomous (act without asking), confirm (ask first), never.\n# This file overrides U2OS_HOME/policies/policies.yaml per domain operation.\n\n';

/**
 * @returns {{ok:true, domain:string, operation:string, subCategory:string|null, level:'autonomous', description:string}
 *          |{ok:false, reason:string}}
 */
export function planRemember({ action, evaluation, policies }) {
  const refuse = (reason) => ({ ok: false, reason });
  if (!action || action.status !== 'pending') return refuse('Only an action that is waiting for approval can be remembered.');
  if (action.packageContext) return refuse('Package actions follow the package policy and cannot be remembered here.');
  if (policies?.[VAULT_POLICY_INVALID]) return refuse('Your vault policies.yaml is invalid. Fix it before remembering approvals.');
  if (!evaluation || evaluation.blocked || !evaluation.requiresApproval) return refuse('This action is not waiting on a plain confirm rule.');
  // A stricter gate (voice, goal, account binding) changed the rule at proposal time.
  if (action.policy_rule && action.policy_rule !== evaluation.rule) return refuse('A stricter rule applied when this was proposed, so it cannot be remembered.');

  const match = RULE.exec(evaluation.rule || '');
  if (!match) return refuse('This rule cannot be remembered automatically.');
  const [, domain, operation, subCategory = null, kind] = match;
  if (!NAME.test(domain) || !NAME.test(operation) || (subCategory !== null && !NAME.test(subCategory))) return refuse('This rule cannot be remembered automatically.');
  if (subCategory === 'default') return refuse('This applies to every category without its own rule. Edit policies.yaml deliberately to change it.');

  const current = policies?.[domain]?.[operation];
  if (kind === 'missing') {
    if (current !== undefined || subCategory !== null) return refuse('This rule cannot be remembered automatically.');
  } else if (subCategory === null) {
    if (current !== 'confirm') return refuse('This rule cannot be remembered automatically.');
  } else if (!isMapping(current) || current[subCategory] !== 'confirm') {
    return refuse('This rule cannot be remembered automatically.');
  }

  const scope = subCategory ? `${domain}.${operation} for ${subCategory}` : `${domain}.${operation}`;
  return {
    ok: true, domain, operation, subCategory, level: 'autonomous',
    description: `Always allow ${scope} without asking. This writes "autonomous" to policies.yaml in your vault; change it back to "confirm" there to be asked again.`,
  };
}

/**
 * Writes the planned rule into the vault policies.yaml. `effective` is the
 * merged policy in force (needed because a vault operation replaces the
 * home operation wholesale, so a sub-category rule must carry its siblings).
 */
export function applyRememberedRule(plan, { effective, file = vaultPoliciesPath() } = {}) {
  if (!plan?.ok) throw new Error(plan?.reason || 'Nothing to remember');
  let text = null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('policies.yaml in your vault is not a regular file under 64 KiB');
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const before = text === null ? {} : (yaml.load(text, { schema: yaml.CORE_SCHEMA }) ?? {});
  validatePolicies(before);
  const expected = structuredClone(before);
  const base = before[plan.domain]?.[plan.operation] !== undefined ? before[plan.domain][plan.operation] : effective?.[plan.domain]?.[plan.operation];
  const operationValue = plan.subCategory ? { ...(isMapping(base) ? base : {}), [plan.subCategory]: plan.level } : plan.level;
  expected[plan.domain] = { ...(isMapping(expected[plan.domain]) ? expected[plan.domain] : {}), [plan.operation]: operationValue };

  const patched = text === null
    ? `${HEADER}${renderDomain(plan.domain, plan.operation, operationValue)}`
    : patchPoliciesText(text, plan, operationValue, before);
  if (patched === null) throw new Error('policies.yaml has a layout U2OS will not edit automatically; set the rule there by hand');

  const after = yaml.load(patched, { schema: yaml.CORE_SCHEMA }) ?? {};
  validatePolicies(after);
  if (!isDeepStrictEqual(after, expected)) throw new Error('Refused to edit policies.yaml: the change would not be exactly the remembered rule');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const mode = text === null ? 0o600 : fs.statSync(file).mode & 0o777;
  fs.writeFileSync(temp, patched, { mode });
  fs.renameSync(temp, file);
  return { path: file, created: text === null };
}

function renderDomain(domain, operation, value) {
  return `${domain}:\n${renderOperation('  ', operation, value)}`;
}

function renderOperation(indent, operation, value) {
  if (!isMapping(value)) return `${indent}${operation}: ${value}\n`;
  return `${indent}${operation}:\n${Object.entries(value).map(([key, level]) => `${indent}  ${key}: ${level}\n`).join('')}`;
}

// Text-level patch. Returns null when the layout is not the plain two-space
// block style this understands (flow mappings, odd indentation, ...).
export function patchPoliciesText(text, plan, operationValue, parsed = yaml.load(text, { schema: yaml.CORE_SCHEMA }) ?? {}) {
  const lines = text.split('\n');
  const domainIndex = lines.findIndex((line) => new RegExp(`^${plan.domain}:\\s*(#.*)?$`).test(line));

  if (domainIndex === -1) {
    if (parsed[plan.domain] !== undefined) return null;
    const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return `${text}${separator}${renderDomain(plan.domain, plan.operation, operationValue)}`;
  }

  let end = domainIndex + 1;
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]) || lines[end].startsWith('#'))) end += 1;
  while (end > domainIndex + 1 && (lines[end - 1] === '' || lines[end - 1].startsWith('#'))) end -= 1;

  const childIndent = lines.slice(domainIndex + 1, end).map((line) => /^( +)\S/.exec(line)?.[1]).find((indent) => indent !== undefined) ?? '  ';
  if (childIndent !== '  ') return null;
  const operationPattern = new RegExp(`^${childIndent}${plan.operation}:(.*)$`);
  const operationIndex = lines.findIndex((line, i) => i > domainIndex && i < end && operationPattern.test(line));

  if (operationIndex === -1) {
    if (parsed[plan.domain]?.[plan.operation] !== undefined) return null;
    lines.splice(domainIndex + 1, 0, ...renderOperation(childIndent, plan.operation, operationValue).replace(/\n$/, '').split('\n'));
    return lines.join('\n');
  }

  const rest = operationPattern.exec(lines[operationIndex])[1];
  if (plan.subCategory === null) {
    const scalar = /^\s+[A-Za-z]+(\s+#.*)?$/.exec(rest);
    if (!scalar) return null;
    lines[operationIndex] = `${childIndent}${plan.operation}: ${plan.level}${scalar[1] || ''}`;
    return lines.join('\n');
  }

  if (!/^\s*(#.*)?$/.test(rest)) return null;
  let stop = operationIndex + 1;
  while (stop < end && (lines[stop] === '' || lines[stop].startsWith(`${childIndent} `) || /^\s*#/.test(lines[stop]))) stop += 1;
  const subPattern = new RegExp(`^${childIndent}  ${plan.subCategory}:(\\s+)[A-Za-z]+(\\s+#.*)?$`);
  const subIndex = lines.findIndex((line, i) => i > operationIndex && i < stop && subPattern.test(line));
  if (subIndex === -1) return null;
  const sub = subPattern.exec(lines[subIndex]);
  lines[subIndex] = `${childIndent}  ${plan.subCategory}:${sub[1]}${plan.level}${sub[2] || ''}`;
  return lines.join('\n');
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
