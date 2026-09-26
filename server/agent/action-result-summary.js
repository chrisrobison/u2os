// Deterministic owner-facing counts only. Never copy provider errors, result
// bodies or model instructions into the explanation of incomplete work.
export function summarizeIncompleteActions(results, { always = false } = {}) {
  const incomplete = results.filter((result) => result.status !== 'executed');
  if (!incomplete.length && !always) return null;
  const completed = results.length - incomplete.length;
  const pending = incomplete.filter((result) => ['pending', 'waiting_for_approval'].includes(result.status));
  const waiting = incomplete.filter((result) => ['waiting_for_action', 'approved', 'queued', 'leased', 'executing', 'running', 'retrying', 'retry_wait'].includes(result.status));
  const notAttempted = incomplete.filter((result) => ['planned', 'skipped', 'blocked', 'rejected', 'cancelled', 'waiting_dependency'].includes(result.status));
  const attention = incomplete.length - pending.length - waiting.length - notAttempted.length;
  const uncertain = incomplete.filter((result) => result.status === 'outcome_uncertain').length;
  const recipients = pending.filter((result) => result.tool === 'email.send' && typeof result.arguments?.to === 'string')
    .map((result) => result.arguments.to.slice(0, 120));
  return `${completed} action(s) completed; ${pending.length} awaiting approval${recipients.length ? ` (email to ${recipients.join(', ')})` : ''}; ${waiting.length} queued or running; ${notAttempted.length} not attempted; ${attention} failed or needing attention.${uncertain ? ` ${uncertain} action(s): outcome uncertain. Check the originally bound account/provider before any new proposal; no automatic retry.` : ''} The objective is not verified.`;
}

// Recognize runtime-generated counts, including older releases and summaries
// prefixed with a stop reason. Grounded final/model or clarification responses
// without this fixed signature remain untouched after confirmed completion.
export function isActionSummaryResponse(response) {
  return typeof response === 'string' && /(?:^| )\d+ action\(s\) completed; \d+ awaiting approval/.test(response);
}
