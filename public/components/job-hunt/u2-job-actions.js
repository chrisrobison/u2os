import * as api from '../../services/api.js';
import { el } from './jh-util.js';
import { answerableQuestions, openAnswersDialog } from './jh-answers.js';
import { isReadyToSubmit } from './u2-job-submit.js';

// The button bar at the top of the Job details page: Open and Pre-fill, Apply Online, Apply via
// Email, Prepare Email, Reject and Answer Questions. Every button says why it
// is unavailable instead of silently doing nothing. Set `job` to the job detail
// from GET /api/job-hunt/jobs/:id; the component fires `jh-job-updated` with the
// refreshed job after anything that changes it. Nothing here bypasses the gate:
// sending is proposed through the same policy and approval as every other action,
// and an online application still needs the owner's two-step approval.

const SETTLED = new Set(['applied', 'contacted', 'followup_due', 'screening', 'interview', 'offer', 'rejected', 'withdrawn', 'closed', 'skipped', 'uncertain']);
const EMAIL_BLOCKING = new Set(['proposing', 'proposed', 'sent', 'uncertain']);

/** What each button can do for this job, and the reason when it cannot. */
export function jobActions(job) {
  if (!job) return {};
  const routes = job.sendRoutes ?? {};
  const settled = SETTLED.has(job.status);
  const settledWhy = `This job is ${String(job.status).replace(/_/g, ' ')}.`;
  const hasEmail = (job.contactEmails?.length ?? 0) > 0 || Boolean(job.draft);
  const emailBlock = (job.emails ?? []).find((email) => email.kind === 'application' && EMAIL_BLOCKING.has(email.status));
  const draftBlock = (job.emails ?? []).find((email) => email.kind === 'draft' && ['proposing', 'proposed', 'drafted'].includes(email.status));
  const questions = answerableQuestions(job).length;
  const reason = (conditions) => conditions.find(([bad]) => bad)?.[1] ?? null;
  return {
    online: { why: reason([[settled, settledWhy], [!(job.applicationUrls?.length), 'This listing has no application link.'], [isReadyToSubmit(job), 'The application is planned and ready: approve it below.']]) },
    send: { why: reason([[settled, settledWhy], [!hasEmail, 'This listing has no email address.'], [!routes.apple_mail && !routes.gmail, 'No email route is available: enable the Apple add-on or connect Gmail.'], [Boolean(emailBlock), `An email to ${emailBlock?.to} is already ${emailBlock?.status}.`]]) },
    draft: { why: reason([[settled, settledWhy], [!hasEmail, 'This listing has no email address.'], [!routes.apple_mail_draft, 'Drafts need the Apple add-on (macOS), enabled on the Add-ons page.'], [Boolean(draftBlock), `A draft to ${draftBlock?.to} is already ${draftBlock?.status}.`]]) },
    prefill: { why: reason([[settled, settledWhy], [!(job.applicationUrls?.length), 'This listing has no application link.']]) },
    applied: { why: reason([[settled, settledWhy]]) },
    reject: { why: reason([[job.status === 'rejected', 'Already rejected.'], [['withdrawn', 'closed', 'skipped', 'offer'].includes(job.status), settledWhy]]) },
    answers: { why: questions ? null : 'Nothing is waiting for an answer.', count: questions },
    via: routes.apple_mail ? 'Apple Mail' : 'Gmail',
  };
}

/** A small confirmation dialog. Resolves true only on the confirm button. */
export function confirmDialog({ title, body, confirmText, danger = false, opener = null }) {
  return new Promise((resolve) => {
    const yes = el('button', { type: 'button', class: danger ? 'btn jh-page__danger' : 'btn', 'data-confirm': '', text: confirmText });
    const no = el('button', { type: 'button', class: 'btn', text: 'Cancel' });
    const dialog = el('dialog', { class: 'jh-approve-dialog', 'aria-labelledby': 'jh-confirm-title', 'data-confirm-dialog': '' },
      el('div', { class: 'jh-approve-dialog__head' }, el('h2', { id: 'jh-confirm-title', class: 'jh-approve-dialog__title', text: title })),
      ...[].concat(body).map((line) => el('p', { text: line })), el('div', { class: 'jh-page__buttons' }, yes, no));
    let answer = false;
    yes.addEventListener('click', () => { answer = true; dialog.close(); });
    no.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); if (opener?.isConnected) opener.focus(); resolve(answer); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

const settleText = (job) => `${job.role || 'this role'} at ${job.company}`;

/**
 * What each action does, shared by the Job details button bar and the per-listing menu. `confirm` (optional) asks first and
 * resolves false on cancel; `run` does the work and resolves { job, notice } where job is the refreshed detail.
 */
export const jobTasks = {
  online: {
    working: 'Reading the application form and planning every answer. This can take a minute...',
    async run(job) {
      const result = await api.planJobHuntForm(job.id);
      const view = result.job;
      if (result.ready) return { job: view, notice: { text: 'The application is planned. Review it on the job page, then approve and submit.' } };
      const open = answerableQuestions(view).length;
      return { job: view, notice: open ? { error: true, text: `${open} question${open === 1 ? ' needs' : 's need'} your answer before this can be submitted. Use Answer Questions.` } : { error: true, text: `The application is not ready (${result.status}). See the attempt on the job page.` } };
    },
  },
  prefill: {
    working: 'Planning the answers, then opening the application in a browser window and filling it in. This can take a minute...',
    async run(job) {
      const result = await api.prefillJobHuntForm(job.id);
      if (result.status === 'needs_input') {
        const open = answerableQuestions(result.job).length;
        return { job: result.job, notice: { error: true, text: open ? `${open} question${open === 1 ? ' needs' : 's need'} your answer first, so nothing was opened. Use Answer Questions.` : 'The form asks something U2OS cannot answer for you, so nothing was opened. See the job page.' } };
      }
      const blocked = { manual_required: `The page needs you first (${String(result.reason ?? 'a login or CAPTCHA').replace(/_/g, ' ')}); the window is open for you.`, fill_incomplete: `Some fields could not be filled${result.missing?.length ? ` (${result.missing.slice(0, 3).join(', ')})` : ''}; the window is open so you can finish them.`, schema_changed: 'The form changed since it was planned. Use Apply Online to plan it again.', files_changed: 'The resume changed since it was planned. Use Apply Online to plan it again.' }[result.status];
      if (blocked) return { job: result.job, notice: { error: result.status === 'schema_changed' || result.status === 'files_changed', text: blocked } };
      return { job: result.job, notice: { text: `Filled in and left open in a browser window. Check it, submit it yourself, then Mark Applied. Nothing was sent.` } };
    },
  },
  send: {
    working: 'Writing the email and sending it...',
    confirm: ({ job, actions, opener }) => confirmDialog({ title: 'Apply via email', confirmText: 'Send application', opener,
      body: [`Send your application for ${job.role || 'this role'} at ${job.company} to ${job.contactEmails?.[0] ?? job.draft?.to ?? 'the listed address'} from ${actions.via}, with your resume attached.`, 'A copy is Bcc\'d to you. If your policy asks for approval first, it waits on the Approvals page.'] }),
    run: (job) => emailTask(job, 'send'),
  },
  draft: {
    working: 'Writing the email and saving it to Drafts...',
    run: (job) => emailTask(job, 'draft'),
  },
  applied: {
    working: 'Marking applied...',
    confirm: ({ job, opener }) => confirmDialog({ title: 'Mark as applied', confirmText: 'Mark Applied', opener,
      body: [`Record that you applied for ${settleText(job)} yourself. Nothing is sent, and the autopilot will not apply to it again.`] }),
    async run(job) {
      await api.moveJobHuntJob(job.id, 'applied');
      return { job: await api.getJobHuntJob(job.id), notice: { text: 'Marked as applied.' } };
    },
  },
  reject: {
    working: 'Rejecting...',
    confirm: ({ job, opener }) => confirmDialog({ title: 'Reject this job', confirmText: 'Reject', danger: true, opener,
      body: [`Move ${settleText(job)} to Rejected. Nothing is sent to the company, and the autopilot will not pick it up again.`] }),
    async run(job) {
      await api.moveJobHuntJob(job.id, 'rejected');
      return { job: await api.getJobHuntJob(job.id), notice: { text: 'Rejected.' } };
    },
  },
};

async function emailTask(job, mode) {
  const result = await api.emailJobHuntJob(job.id, mode);
  const where = result.via === 'gmail' ? 'Gmail' : 'Apple Mail';
  const text = {
    executed: mode === 'draft' ? `Saved to the Drafts folder in ${where}: ${result.email.to}.` : `Sent to ${result.email.to} from ${where}. A copy is Bcc'd to you.`,
    pending: 'Waiting for your approval on the Approvals page. Nothing has been sent yet.',
    blocked: `Policy blocked it${result.reason ? `: ${result.reason}` : '.'}`,
  }[result.status];
  return { job: result.job, notice: text ? { error: result.status === 'blocked', text } : { error: true, text: `Result: ${result.status}${result.reason ? ` (${result.reason})` : ''}.` } };
}

export class U2JobActions extends HTMLElement {
  constructor() {
    super();
    this._job = null;
    this._busy = null;
    this._notice = null;
  }

  set job(value) { this._job = value; this._render(); }
  get job() { return this._job; }
  connectedCallback() { this._render(); }

  _render() {
    this.textContent = '';
    const job = this._job;
    if (!job) return;
    const actions = jobActions(job);
    const button = (key, label, run, { danger = false } = {}) => {
      const state = actions[key];
      const busy = this._busy === key;
      const node = el('button', { type: 'button', class: danger ? 'btn jh-page__danger' : 'btn', 'data-action': key, title: state.why ?? undefined, 'aria-busy': busy ? 'true' : undefined, text: busy ? `${label}...` : label });
      node.disabled = Boolean(state.why) || this._busy !== null;
      node.addEventListener('click', () => run(node));
      return node;
    };
    const answers = button('answers', actions.answers.count ? `Answer Questions (${actions.answers.count})` : 'Answer Questions', (opener) => openAnswersDialog(job, { opener, onSaved: (fresh) => this._updated(fresh) }));
    const task = (key, label, options) => button(key, label, (opener) => this.start(key, opener), options);
    this.append(el('div', { class: 'jh-page__actions', role: 'group', 'aria-label': 'Job actions' },
      task('prefill', 'Open and Pre-fill'),
      task('online', 'Apply Online'),
      task('send', 'Apply via Email'),
      task('draft', 'Prepare Email'),
      answers,
      task('applied', 'Mark Applied'),
      task('reject', 'Reject', { danger: true })));
    if (this._notice) this.append(el('p', { class: this._notice.error ? 'load-error' : 'jh-page__ok', role: this._notice.error ? 'alert' : 'status', 'data-action-notice': '', text: this._notice.text }));
  }

  _updated(job) {
    if (!job) return;
    this._job = job;
    this._render();
    this.dispatchEvent(new CustomEvent('jh-job-updated', { bubbles: true, detail: { job } }));
  }

  async _run(key, working, task) {
    this._busy = key; this._notice = { text: working }; this._render();
    let fresh = null;
    try {
      const outcome = await task();
      fresh = outcome.job ?? null;
      this._notice = outcome.notice;
    } catch (error) {
      this._notice = { error: true, text: error.message };
    }
    this._busy = null;
    if (fresh) this._updated(fresh); else this._render();
  }

  /** Runs one of the shared tasks (after its confirmation, if it has one) for the current job. */
  async start(key, opener) {
    const job = this._job;
    const task = jobTasks[key];
    if (!job || !task || this._busy) return;
    if (task.confirm && !(await task.confirm({ job, actions: jobActions(job), opener }))) return;
    await this._run(key, task.working, () => task.run(job));
  }
}

if (!customElements.get('u2-job-actions')) customElements.define('u2-job-actions', U2JobActions);
