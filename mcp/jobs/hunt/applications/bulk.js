import { listJobViews } from '../view.js';
import { SEND_TOOLS, proposeApplicationEmail } from './send.js';
import { contactEmailsFor } from './strategy.js';

/**
 * Proposes a Mail draft for every ready job that has an email route. Only
 * proposes: each draft still passes the gate, and nothing is sent. Idempotent:
 * a job that already has a draft proposed or in Mail, or that is contacted, is
 * skipped.
 */
export async function proposeBulkDrafts({ store, candidateEmail, minimumScore, minScore = 70, propose, limit = 500 }) {
  const result = { proposed: [], skipped: [], failed: [] };
  for (const view of listJobViews(store, { minScore, limit, minimumScore })) {
    // Whether there is somewhere to email does not depend on the score; the score only decides sending, not drafting.
    const emailRoute = contactEmailsFor(view).length > 0;
    if (!emailRoute || !view.draft || view.draft.needsInput.length) {
      result.skipped.push({ id: view.id, company: view.company, reason: !emailRoute ? 'no email route' : !view.draft ? 'no materials yet' : 'needs your input' });
      continue;
    }
    try {
      // force: a draft below the autonomous threshold is still only a draft.
      const outcome = await proposeApplicationEmail({ store, job: store.getJob(view.id), candidateEmail, minimumScore, tool: SEND_TOOLS.apple_mail_draft, force: true, propose });
      result.proposed.push({ id: view.id, company: view.company, status: outcome.outcome.status, actionId: outcome.outcome.id });
    } catch (error) {
      (error.code === 'BLOCKED' ? result.skipped : result.failed).push({ id: view.id, company: view.company, reason: String(error.message).slice(0, 200) });
    }
  }
  return result;
}
