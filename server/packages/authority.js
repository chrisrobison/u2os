// Package authority overlay for the action gate
// (docs/plugin-architecture.md §6). Applied by
// Agent.evaluateAndMaybeExecute() on top of the policies.yaml evaluation,
// exactly like the voice gate (server/voice/authorize.js): it can only
// TIGHTEN a decision -- block it, or require approval -- and never sets
// blocked:false or requiresApproval:false.

/**
 * applyPackageAuthority({ evaluation, authority }) -> evaluation
 * `authority` is undefined for owner/agent actions, which pass through
 * untouched (same reference).
 */
export function applyPackageAuthority({ evaluation, authority }) {
  if (!authority) return evaluation;
  if (evaluation.blocked) return evaluation;

  const permission = authority.permission;
  if (!permission || permission.allowed !== true) {
    const missing = permission?.reason || describeMissing(permission);
    return {
      ...evaluation,
      blocked: true,
      requiresApproval: false,
      rule: 'package-permission',
      reason: `Package ${authority.packageId} may not do this: ${missing}.`,
    };
  }

  const policy = authority.policy;
  if (policy && policy.decision === 'deny') {
    return {
      ...evaluation,
      blocked: true,
      requiresApproval: false,
      rule: `package-policy:${policy.name}`,
      reason: `Package policy ${policy.name} does not allow this action (${(policy.reasons || []).join('; ') || 'denied'}).`,
    };
  }
  if (policy && policy.decision !== 'automatic' && !evaluation.requiresApproval) {
    // 'approval', or anything unrecognized: fail toward asking.
    return {
      ...evaluation,
      requiresApproval: true,
      autonomyLevel: Math.max(evaluation.autonomyLevel ?? 3, 3),
      rule: `${evaluation.rule}+package-policy:${policy.name}`,
      reason: `${evaluation.reason} Package policy ${policy.name} requires your approval.`,
    };
  }
  return evaluation;
}

function describeMissing(permission) {
  if (!permission) return 'no permission decision was made';
  const parts = [];
  if (permission.missingDeclared?.length) parts.push(`not declared: ${permission.missingDeclared.join(', ')}`);
  if (permission.missingGrant?.length) parts.push(`not granted: ${permission.missingGrant.join(', ')}`);
  return parts.join('; ') || 'permission denied';
}

/** The JSON stored in agent_actions.package_context. */
export function packageContextRecord(authority) {
  if (!authority) return null;
  return {
    package: authority.packageId,
    automation: authority.automationId || null,
    skill: authority.skillId || null,
    run: authority.workflowRunId || null,
    rootRun: authority.rootRunId || authority.workflowRunId || null,
    step: authority.stepId || null,
    capability: authority.capabilityId || null,
    provider: authority.providerId || null,
    permission: authority.permission
      ? { allowed: authority.permission.allowed === true, required: authority.permission.required || [], missingDeclared: authority.permission.missingDeclared || [], missingGrant: authority.permission.missingGrant || [], ...(authority.permission.reason ? { reason: authority.permission.reason } : {}) }
      : null,
    policy: authority.policy ? { name: authority.policy.name, decision: authority.policy.decision, reasons: authority.policy.reasons || [] } : null,
  };
}
