// Deterministic owner presentation, not execution or authorization authority.
// Never turn arbitrary provider error/result text into speech or UI guidance.
const DONE_LABELS = {
  'calendar.reschedule': 'Done. Rescheduled.',
  'calendar.create': 'Done. Added to your calendar.',
  'calendar.cancel': 'Done. Cancelled the event.',
  'email.send': 'Done. Sent.',
  'tasks.create': 'Done. Added the task.',
  'tasks.complete': 'Done. Marked complete.',
  'notifications.send': 'Done. Sent the notification.',
};
const PENDING = new Set(['approved', 'queued', 'leased', 'executing', 'retry_wait']);
const STOPPED = new Set(['failed', 'blocked', 'dead_letter']);
export const UNCERTAIN_GUIDANCE = 'Delivery outcome is uncertain. Check the originally approved account before a new proposal; no automatic retry.';
export function isUncertainOutcome(action) { return action?.errorClass === 'outcome_uncertain'; }
export function actionOutcomeSentence(action) {
  if (isUncertainOutcome(action)) return UNCERTAIN_GUIDANCE;
  if (action?.status === 'executed') return Object.hasOwn(DONE_LABELS, action.tool) ? DONE_LABELS[action.tool] : 'Action completed.';
  if (['rejected', 'cancelled'].includes(action?.status)) return 'Cancelled.';
  if (PENDING.has(action?.status)) return 'Approved; delivery is still pending.';
  if (action?.status === 'pending') return 'Awaiting approval.';
  if (STOPPED.has(action?.status)) return 'Action stopped. Check Operations for the reason.';
  return 'Action status is not confirmed. Check Operations.';
}
export function approvalOutcomeLabel(action) {
  if (isUncertainOutcome(action)) return 'Outcome uncertain';
  if (action?.status === 'executed') return 'Approved and done';
  if (['rejected', 'cancelled'].includes(action?.status)) return 'Cancelled';
  if (PENDING.has(action?.status)) return 'Approved; delivery pending';
  if (STOPPED.has(action?.status)) return 'Action stopped';
  return 'Awaiting confirmation';
}
export function approvalOutcomeGuidance(action) {
  return isUncertainOutcome(action) ? UNCERTAIN_GUIDANCE : STOPPED.has(action?.status) ? 'Action stopped. Check Operations for the reason.' : '';
}
