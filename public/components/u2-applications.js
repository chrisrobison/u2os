import { escapeHtml, formatDateTime } from './util.js';
import * as api from '../services/api.js';

// The job-hunt ledger (docs/job-hunt.md): every application U2OS made or
// prepared in the owner's name, from job-hunt/applications/ in their vault.
// Read-only; the owner edits or deletes a record's file to change it.

const STATUS = {
  applied: ['enabled', 'Applied', 'Submitted and confirmed by the board.'],
  unconfirmed: ['invalid', 'Unconfirmed', 'Submitted, but the board showed no confirmation. Check it yourself; it will not be resubmitted.'],
  needs_owner: ['invalid', 'Needs you', 'The board showed a CAPTCHA or challenge. Finish this application yourself.'],
  needs_answers: ['pending', 'Needs answers', 'Required questions were unanswered, so nothing was sent. Add your answers under answers: in job-hunt/profile.md (matched by words in the question) and the next run uses them.'],
  dry_run: ['paused', 'Dry run', 'Filled but not submitted (submit: false in your profile).'],
  failed: ['invalid', 'Failed', 'The board rejected the form; nothing was sent.'],
  skipped: ['paused', 'Skipped', 'Passed on; searches leave it out.'],
};
const FILTER_ORDER = ['applied', 'needs_owner', 'needs_answers', 'unconfirmed', 'failed', 'dry_run', 'skipped'];

export class U2Applications extends HTMLElement {
  constructor() {
    super();
    this._data = null;
    this._filter = '';
    this._onClick = this._onClick.bind(this);
    this._onEvent = (event) => {
      if (/^jobs\./.test(event.detail?.data?.tool || '')) this._load();
    };
  }

  connectedCallback() {
    this.addEventListener('click', this._onClick);
    window.addEventListener('u2-event', this._onEvent);
    this._load();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    window.removeEventListener('u2-event', this._onEvent);
  }

  async _load() {
    if (!this._data) this.innerHTML = '<div class="empty-state">Loading applications...</div>';
    try {
      this._data = await api.getJobApplications();
      this._render();
    } catch (err) {
      this.innerHTML = `<div class="load-error">Couldn't load applications: ${escapeHtml(err.message)}</div>`;
    }
  }

  _render() {
    const { counts, applications } = this._data;
    const shown = applications.filter((item) => !this._filter || item.status === this._filter);
    const filters = [['', `All (${applications.length})`], ...FILTER_ORDER.filter((status) => counts[status]).map((status) => [status, `${STATUS[status][1]} (${counts[status]})`])];
    this.innerHTML = `
      <div class="workspace__header">
        <div class="workspace__title">Job applications</div>
        <div class="workspace__subtitle">Everything sent or prepared in your name, from job-hunt/applications in your vault.</div>
      </div>
      ${applications.length ? `<div class="folder-toggle" role="group" aria-label="Filter by status">${filters.map(([value, label]) => `<button type="button" data-filter="${value}" class="${value === this._filter ? 'is-active' : ''}" aria-pressed="${value === this._filter}">${escapeHtml(label)}</button>`).join('')}</div>` : ''}
      ${shown.length ? `<div class="trigger-list">${shown.map((item) => this._card(item)).join('')}</div>`
    : `<div class="empty-state">${applications.length ? 'No applications with this status.' : 'No applications yet. Set up job hunting to get started (docs/job-hunt.md).'}</div>`}
    `;
  }

  _card(item) {
    const [tone, label, meaning] = STATUS[item.status] || ['paused', item.status || 'Unknown', ''];
    const when = item.appliedAt ? `Applied ${formatDateTime(item.appliedAt)}` : `Updated ${formatDateTime(item.updatedAt)}`;
    const answered = Object.entries(item.answered || {});
    return `<article class="trigger-row application-card" data-application="${escapeHtml(item.jobId)}">
      <div class="trigger-row__body">
        <div class="trigger-row__heading"><strong>${escapeHtml(item.title || item.jobId)}</strong><span class="trigger-state trigger-state--${tone}">${escapeHtml(label)}</span></div>
        <div class="trigger-row__meta">${escapeHtml(item.company || '')} · ${escapeHtml(when)}${item.url ? ` · <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Posting</a>` : ''}</div>
        ${meaning ? `<div class="trigger-row__next">${escapeHtml(meaning)}${item.reason ? ` ${escapeHtml(item.reason)}` : ''}</div>` : ''}
        ${item.errors.length ? `<ul class="routine-row__error">${item.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>` : ''}
        ${item.openQuestions.length ? `<div class="application-card__section"><div class="application-card__label">Questions to answer</div><ul>${item.openQuestions.map((question) => `<li>${escapeHtml(question.label || question.name)}${question.options?.length ? ` <span class="trigger-row__meta">(${escapeHtml(question.options.join(' / '))})</span>` : ''}</li>`).join('')}</ul></div>` : ''}
        ${answered.length || item.coverLetter ? `<details class="application-card__details"><summary>What was sent</summary>
          ${answered.length ? `<dl>${answered.map(([question, answer]) => `<dt>${escapeHtml(question)}</dt><dd>${escapeHtml(Array.isArray(answer) ? answer.join(', ') : answer)}</dd>`).join('')}</dl>` : ''}
          ${item.coverLetter ? `<div class="application-card__label">Cover letter</div><p class="application-card__letter">${escapeHtml(item.coverLetter)}</p>` : ''}
        </details>` : ''}
        ${item.screenshots.length ? `<div class="application-card__shots">${item.screenshots.map((shot, index) => {
    const src = `/api/job-applications/screenshot?path=${encodeURIComponent(shot)}`;
    const alt = `${index === 0 ? 'Filled form' : 'Result page'} for ${item.title || item.jobId}`;
    return `<a href="${escapeHtml(src)}" target="_blank" rel="noopener"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"></a>`;
  }).join('')}</div>` : ''}
      </div>
    </article>`;
  }

  _onClick(event) {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    this._filter = button.dataset.filter;
    this._render();
  }
}

customElements.define('u2-applications', U2Applications);
