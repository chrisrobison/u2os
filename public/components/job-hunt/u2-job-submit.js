import * as api from '../../services/api.js';
import { el, safeUrl } from './jh-util.js';

// "Ready to submit": what will be sent for a planned application, and the
// owner's two-step approval to send it (an Approve click, then an explicit
// "Yes, submit this application"). Shared by the Job details page and the
// dashboard's Approve dialog. Set `job` to the job detail from
// GET /api/job-hunt/jobs/:id; the component fires `jh-job-updated` with the
// refreshed job after a submit attempt.

export const answersTable = (plan) => el('table', { class: 'jh-page__table' }, el('tbody', {}, plan.fields.map((field) => el('tr', {}, el('th', { scope: 'row', text: `${field.label}${field.required ? ' *' : ''}` }), el('td', { text: field.file ? `[file] ${field.file}` : String(field.value ?? '') })))));
const list = (items) => el('ul', { class: 'jh-list' }, items.map((item) => el('li', { text: item })));

/** The latest application is planned and ready, so it can be approved. */
export const isReadyToSubmit = (job) => { const attempt = job?.applications?.[0]; return Boolean(attempt && attempt.status === 'planned' && attempt.plan?.ready); };

export class U2JobSubmit extends HTMLElement {
  constructor() {
    super();
    this._job = null;
    this._confirming = false;
    this._busy = false;
    this._notice = null;
  }

  set job(value) { this._job = value; this._render(); }
  get job() { return this._job; }

  /** True while a submit is running: the host should not close the view meanwhile. */
  get busy() { return this._busy; }

  connectedCallback() { this._render(); }

  _render() {
    this.textContent = '';
    const job = this._job;
    if (!job) return;
    const attempt = job.applications?.[0];
    if (!isReadyToSubmit(job)) {
      // The box goes away once the application is sent; its result stays visible.
      const message = this._notice
        ? el('p', { class: this._notice.error ? 'load-error' : 'jh-page__ok', role: this._notice.error ? 'alert' : 'status', 'data-submit-notice': '', text: this._notice.text })
        : this.hasAttribute('standalone') ? el('p', { class: 'jh-page__ok', text: 'This application is not ready to submit any more. Open the job to see why.' }) : null;
      if (message) this.append(message); // append(null) would add the text "null"
      return;
    }
    const rejected = job.reviews?.[0]?.decision === 'reject' ? job.reviews[0] : null;
    const blocking = (rejected?.concerns ?? []).filter((concern) => concern.severity === 'blocking').map((concern) => concern.text);
    const url = safeUrl(attempt.url);
    const box = el('section', { class: 'jh-page__submit', role: 'region', 'aria-label': 'Ready to submit', 'data-submit-box': '' },
      el('h3', { class: 'jh-page__attention-title', text: 'Ready to submit' }),
      el('p', { text: `The form for ${job.role || 'this role'} at ${job.company} is planned. Check what will be sent:` }),
      attempt.plan.fields.length ? answersTable(attempt.plan) : null,
      url ? el('p', {}, el('a', { class: 'jh-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'The application form ↗' })) : null,
      rejected ? el('div', { class: 'jh-page__override', 'data-override': '' },
        el('strong', { text: `The review agent said no (${rejected.kind}).` }),
        blocking.length ? list(blocking) : (rejected.notes ? el('p', { text: rejected.notes }) : null),
        el('p', { text: 'Approving here overrides that judgement. The rules (limits, duplicates, blocklist) still apply.' })) : null);
    if (this._confirming) {
      const yes = el('button', { type: 'button', class: 'btn jh-page__danger', 'data-confirm-submit': '', text: 'Yes, submit this application' });
      const no = el('button', { type: 'button', class: 'btn', text: 'Cancel' });
      yes.disabled = this._busy; no.disabled = this._busy;
      yes.addEventListener('click', () => this._submit(job, attempt));
      no.addEventListener('click', () => { this._confirming = false; this._render(); });
      box.append(el('p', { class: 'jh-page__action', text: `This sends your application to ${job.company} now, from a browser window on this computer. It cannot be undone.` }), el('div', { class: 'jh-page__buttons' }, yes, no));
    } else {
      const start = el('button', { type: 'button', class: 'btn', 'data-approve-submit': '', text: 'Approve and submit…' });
      start.disabled = this._busy;
      start.addEventListener('click', () => { this._confirming = true; this._notice = null; this._render(); });
      box.append(start);
    }
    if (this._notice) box.append(el('p', { class: this._notice.error ? 'load-error' : 'jh-page__ok', role: this._notice.error ? 'alert' : 'status', text: this._notice.text }));
    this.append(box);
  }

  async _submit(job, attempt) {
    this._busy = true; this._notice = { text: 'Submitting... a browser window opens on this computer. This can take a minute.' }; this._render();
    let updated = null;
    try {
      const result = await api.approveAndSubmitJobHuntJob(job.id, attempt.planHash);
      updated = result.job ?? null;
      this._confirming = false;
      const messages = {
        submitted: { text: `Submitted to ${job.company}. The board showed its confirmation.` },
        unconfirmed: { error: true, text: 'The form was sent but the board showed no confirmation. Check your email before anything else: U2OS will not send it again.' },
        failed: { error: true, text: `The board showed errors and nothing was sent${result.errors?.length ? `: ${result.errors.join('; ')}` : '.'}` },
      };
      this._notice = messages[result.status] ?? { error: result.status !== 'dry_run', text: `Result: ${result.status}${result.reason ? ` (${result.reason})` : ''}.` };
    } catch (error) {
      this._confirming = false;
      this._notice = { error: true, text: error.message };
    }
    this._busy = false;
    if (updated) this._job = updated;
    this._render();
    if (updated) this.dispatchEvent(new CustomEvent('jh-job-updated', { bubbles: true, detail: { job: updated } }));
  }
}

if (!customElements.get('u2-job-submit')) customElements.define('u2-job-submit', U2JobSubmit);
