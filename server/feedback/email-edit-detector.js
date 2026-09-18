// Phase 7 / docs/feedback.md: auto-detected "user edited a drafted email
// before sending it" -> outcome 'edited', no separate UI action needed.
//
// KNOWN LIMITATION -- be honest about what this actually catches. It only
// ever fires when the email.send call explicitly carries a `draftId`
// argument naming the exact draft it originates from (see
// server/tools/email-tools.js's EmailSendTool schema and
// mock-email-provider.js's getDraftById()). No draftId means no detection
// -- a false negative, never a guess. This reliably catches a draft and a
// send proposed together within ONE plan/turn where the model explicitly
// threads the draft's id through, but it does NOT catch the far more
// common real workflow -- draft in one turn, edit the body via the UI,
// send in a later, separate turn -- unless the frontend/API for that flow
// is built to carry the original draftId forward (it isn't yet, anywhere
// in this codebase). Making that workflow detectable is future work; it is
// NOT solved here by guessing which past draft a send "probably" came from
// (an earlier version of this file did exactly that by matching on
// correlationId alone, and security review found it produces false
// positives the moment more than one draft shares a correlation id --
// fixed by requiring an explicit, unambiguous draftId instead).
// See tests/feedback.test.js for a test of both the case where this fires
// and a test documenting the case where it deliberately does not.
import * as mockEmailProvider from '../integrations/mock-email-provider.js';
import { recordFeedback } from './feedback-store.js';

/**
 * detectEmailEdit({ actionId, correlationId, args, eventBus }) -> feedback
 * row, or null if nothing was recorded (no `args.draftId` given, the named
 * draft doesn't exist/was already sent, or no fields actually differ).
 * `actionId` is the agent_actions row id for this email.send call -- every
 * proposed action gets one regardless of autonomy level, so 'agent_action'
 * is the correct, always-available subject_type.
 */
export function detectEmailEdit({ actionId, correlationId, args, eventBus } = {}) {
  if (!actionId || !args?.draftId) return null;

  // Only the mock email provider stores drafts locally (see
  // mock-email-provider.js's comment); a real Gmail draft would not be
  // found here and this naturally, harmlessly returns null rather than
  // guessing.
  const draft = mockEmailProvider.getDraftById(args.draftId);
  if (!draft) return null;

  const editedFields = diffDraftAgainstSend(draft, args);
  if (!editedFields.length) return null;

  return recordFeedback({
    subjectType: 'agent_action',
    subjectId: actionId,
    outcome: 'edited',
    detail: { tool: 'email.send', domain: 'email', editedFields, draftId: draft.id },
    correlationId,
    eventBus,
  });
}

function diffDraftAgainstSend(draft, sentArgs) {
  const fields = [];
  if (normalizeRecipients(draft.to_addr) !== normalizeRecipients(sentArgs?.to)) fields.push('to');
  if ((draft.subject || '') !== (sentArgs?.subject || '')) fields.push('subject');
  if ((draft.body || '') !== (sentArgs?.body || '')) fields.push('body');
  return fields;
}

function normalizeRecipients(value) {
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v).trim().toLowerCase())
    .sort()
    .join(',');
}
