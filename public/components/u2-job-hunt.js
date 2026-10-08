import { escapeHtml, formatDateTime } from './util.js';
import * as api from '../services/api.js';

// The job hunt pipeline (docs/job-hunt.md): jobs discovered on Hacker News,
// ranked against the owner, with the tailored materials and outreach email
// ready to send. Sending only ever proposes the action: it goes through the
// approval gate and the owner approves it in Approvals.

const STATUS_TONE = { contacted: 'enabled', applied: 'enabled', interview: 'enabled', needs_input: 'pending', uncertain: 'invalid', error: 'invalid', rejected: 'paused', skipped: 'paused' };
const LABEL_TONE = { exceptional: 'enabled', strong: 'enabled', plausible: 'pending', weak: 'paused', skip: 'paused' };
const FILTERS = [['ready', 'Ready to send'], ['needs_input', 'Needs you'], ['contacted', 'Contacted'], ['strong', 'Strong (80+)'], ['all', 'All scored']];
const ROUTES = [['apple_mail', 'Send with Mail'], ['gmail', 'Send with Gmail'], ['apple_mail_draft', 'Save draft in Mail']];

const active = (job) => job.emails.some((email) => email.kind === 'application' && ['proposing', 'proposed', 'sent', 'uncertain'].includes(email.status));

export class U2JobHunt extends HTMLElement {
  constructor() {
    super();
    this._data = null;
    this._filter = 'ready';
    this._notice = null;
    this._busy = false;
    this._autopilot = null;
    this._confirmLive = false;
    this._onClick = this._onClick.bind(this);
    this._onEvent = (event) => { if (/^agent\.action\./.test(event.detail?.type || '')) this._load(); };
  }

  connectedCallback() {
    this.addEventListener('click', this._onClick);
    window.addEventListener('u2-event', this._onEvent);
    // The autopilot works in the background, so keep the page current.
    this._poll = setInterval(() => { if (!this._busy) this._load(); }, 20_000);
    this._load();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    window.removeEventListener('u2-event', this._onEvent);
    clearInterval(this._poll);
  }

  async _load() {
    if (!this._data) this.innerHTML = '<div class="empty-state">Loading jobs...</div>';
    try {
      const [data, autopilot] = await Promise.all([api.getJobHuntJobs({ min_score: 60, limit: 150 }), api.getAutopilot().catch(() => null)]);
      this._data = data;
      this._autopilot = autopilot;
      this._render();
    } catch (err) {
      this.innerHTML = `<div class="load-error">Couldn't load the job hunt: ${escapeHtml(err.message)}</div>`;
    }
  }

  _visible() {
    const jobs = this._data.jobs;
    switch (this._filter) {
      case 'ready': return jobs.filter((job) => job.draft && !job.draft.needsInput.length && !active(job) && !['contacted', 'applied', 'interview', 'rejected'].includes(job.status));
      case 'needs_input': return jobs.filter((job) => job.draft?.needsInput.length);
      case 'contacted': return jobs.filter((job) => ['contacted', 'interview'].includes(job.status) || active(job));
      case 'strong': return jobs.filter((job) => (job.score?.score ?? 0) >= 80);
      default: return jobs;
    }
  }

  _render() {
    const { jobs, counts, minimumScore } = this._data;
    const shown = this._visible();
    this.innerHTML = `
      <div class="workspace__header">
        <div class="workspace__title">Job hunt</div>
        <div class="workspace__subtitle">Ranked against your resume, projects and preferences. Autonomous threshold ${minimumScore}. ${Object.values(counts).reduce((a, b) => a + b, 0)} jobs discovered.</div>
      </div>
      <div class="trigger-row__actions">
        <button type="button" class="btn" data-draft-all ${this._busy || !this._data.sendRoutes.apple_mail_draft ? 'disabled' : ''}>Save Mail drafts for all ready jobs</button>
        <span class="trigger-row__meta">Nothing is sent. Each draft is proposed to Approvals; review and send it from Mail, then mark it sent here.</span>
      </div>
      ${this._autopilotPanel()}
      ${this._notice ? `<div class="load-error" role="status">${escapeHtml(this._notice)}</div>` : ''}
      <div class="folder-toggle" role="group" aria-label="Filter">${FILTERS.map(([value, label]) => `<button type="button" data-filter="${value}" class="${value === this._filter ? 'is-active' : ''}" aria-pressed="${value === this._filter}">${escapeHtml(label)}</button>`).join('')}</div>
      ${shown.length ? `<div class="trigger-list">${shown.map((job) => this._card(job)).join('')}</div>` : `<div class="empty-state">${jobs.length ? 'Nothing here.' : 'No scored jobs yet. Run: npm run u2 -- job discover hn, then job score.'}</div>`}`;
  }

  _autopilotPanel() {
    const a = this._autopilot;
    if (!a) return '';
    if (a.error) return `<div class="load-error">Autopilot settings are invalid: ${escapeHtml(a.error)}</div>`;
    const c = a.config;
    const report = a.lastReport;
    const live = c.mode === 'live';
    const policy = a.policy || {};
    const tool = (entry, name) => (!entry?.available ? `${name}: tool not set up` : entry.autonomous ? `${name}: runs without asking` : `${name}: waits for your approval`);
    return `<section class="application-card" aria-label="Autopilot"><div class="trigger-row__body">
      <div class="trigger-row__heading"><strong>Autopilot</strong>
        <span class="trigger-state trigger-state--${c.enabled ? 'enabled' : 'paused'}">${c.enabled ? 'running' : 'off'}</span>
        <span class="trigger-state trigger-state--${live ? 'invalid' : 'pending'}">${live ? 'LIVE: sends and submits' : 'dry run: sends nothing'}</span></div>
      <div class="trigger-row__meta">Every ${Math.round(c.interval_seconds / 60)} min: find jobs, score, prepare, review, then ${live ? 'act' : 'record what it would do'}. Limits: ${c.limits.applications_per_day} applications and ${c.limits.emails_per_day} emails a day. ${escapeHtml(tool(policy.email, 'Email'))}; ${escapeHtml(tool(policy.form, 'Forms'))}.</div>
      <div class="trigger-row__actions">
        <button type="button" class="btn" data-ap="toggle" ${this._busy ? 'disabled' : ''}>${c.enabled ? 'Turn off' : 'Turn on'}</button>
        ${live ? '<button type="button" class="btn" data-ap="dry" ' + (this._busy ? 'disabled' : '') + '>Back to dry run</button>'
    : this._confirmLive ? '<button type="button" class="btn" data-ap="live-confirm">Yes: let it email and apply without asking</button> <button type="button" class="btn" data-ap="live-cancel">Cancel</button>'
      : '<button type="button" class="btn" data-ap="live" ' + (this._busy ? 'disabled' : '') + '>Go live...</button>'}
        <button type="button" class="btn" data-ap="run" ${this._busy || a.running ? 'disabled' : ''}>${a.running ? 'Running...' : 'Run a cycle now'}</button>
      </div>
      ${report ? `<div class="trigger-row__meta">Last cycle ${escapeHtml(formatDateTime(report.finishedAt || report.startedAt))} (${escapeHtml(report.mode)}): ${Object.entries(report.steps || {}).map(([name, step]) => `${name} ${step.error ? 'failed' : escapeHtml(Object.values(step).filter((v) => typeof v === 'number').join('/') || 'ok')}`).join(' · ')}</div>
        ${report.actions?.length ? `<ul>${report.actions.slice(0, 8).map((item) => `<li>${escapeHtml(item.job)}: ${escapeHtml(item.result)}</li>`).join('')}</ul>` : ''}
        ${report.needsYou?.length ? `<div class="application-card__label">Needs you</div><ul>${report.needsYou.slice(0, 8).map((item) => `<li>${escapeHtml(item.job)}: ${escapeHtml(item.why)}</li>`).join('')}</ul>` : ''}
        ${report.errors?.length ? `<ul class="routine-row__error">${report.errors.slice(0, 5).map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>` : ''}` : '<div class="trigger-row__meta">No cycle has run yet.</div>'}
    </div></section>`;
  }

  _card(job) {
    const score = job.score;
    const draft = job.draft;
    const blocked = active(job) || ['contacted', 'applied', 'interview', 'rejected', 'uncertain'].includes(job.status);
    const canSend = draft && !draft.needsInput.length && !blocked;
    const below = score && score.score < this._data.minimumScore;
    const where = [job.locations.join('; '), job.remote === true ? 'remote' : job.remote === false ? 'on-site' : '', job.salary].filter(Boolean).join(' · ');
    return `<article class="trigger-row application-card" data-job="${escapeHtml(job.id)}">
      <div class="trigger-row__body">
        <div class="trigger-row__heading"><strong>${escapeHtml(job.role || '(no role stated)')} at ${escapeHtml(job.company)}</strong>
          ${score ? `<span class="trigger-state trigger-state--${LABEL_TONE[score.label] || 'paused'}">${score.score} ${escapeHtml(score.label)}</span>` : ''}
          <span class="trigger-state trigger-state--${STATUS_TONE[job.status] || 'paused'}">${escapeHtml(job.status.replace(/_/g, ' '))}</span></div>
        <div class="trigger-row__meta">${escapeHtml(where)}${score ? ` · ${escapeHtml(score.narrative)}` : ''} · ${escapeHtml(job.strategy.name.replace(/_/g, ' ').toLowerCase())}</div>
        ${score?.reasons.length ? `<div class="trigger-row__next">${score.reasons.slice(0, 2).map(escapeHtml).join(' · ')}</div>` : ''}
        ${score?.concerns.length ? `<ul class="routine-row__error">${score.concerns.slice(0, 3).map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
        ${draft?.needsInput.length ? `<div class="application-card__section"><div class="application-card__label">The listing asks for things your facts do not cover</div><ul>${draft.needsInput.map((ask) => `<li>${escapeHtml(ask)}</li>`).join('')}</ul><div class="trigger-row__meta">Add what is true to job-hunt/facts.md, then run: npm run u2 -- job materials ${escapeHtml(job.id)} --force</div></div>` : ''}
        ${draft ? `<details class="application-card__details"><summary>Email to ${escapeHtml(draft.to)}</summary>
          <div class="application-card__label">Subject</div><p>${escapeHtml(draft.subject)}</p>
          <div class="application-card__label">Body</div><p class="application-card__letter">${escapeHtml(draft.text)}</p>
          <div class="application-card__label">Attachments</div><p>${draft.attachments.length ? draft.attachments.map(escapeHtml).join(', ') : 'none staged'}</p></details>` : ''}
        ${job.emails.length ? `<div class="trigger-row__meta">${job.emails.map((email) => `${escapeHtml(email.kind === 'draft' ? 'Draft' : 'Email')} to ${escapeHtml(email.to)}: ${escapeHtml(email.status)}${email.followUpAfter ? ` (follow up after ${escapeHtml(formatDateTime(email.followUpAfter))})` : ''}`).join(' · ')}</div>` : ''}
        ${draft && !blocked && job.status !== 'contacted' ? `<div class="trigger-row__actions"><button type="button" class="btn" data-mark-sent data-job-id="${escapeHtml(job.id)}" ${this._busy ? 'disabled' : ''}>I sent this myself</button></div>` : ''}
        ${canSend ? `<div class="trigger-row__actions">${ROUTES.map(([via, label]) => `<button type="button" class="btn" data-send="${via}" data-job-id="${escapeHtml(job.id)}" data-force="${below ? 'true' : 'false'}" ${this._data.sendRoutes[via] ? '' : 'disabled title="Not available: enable the Apple add-on (macOS) or connect Gmail"'} ${this._busy ? 'disabled' : ''}>${escapeHtml(label)}${below && via !== 'apple_mail_draft' ? ' anyway' : ''}</button>`).join(' ')}
          ${below ? `<div class="trigger-row__meta">Score ${score.score} is below your threshold ${this._data.minimumScore}; sending is your explicit choice.</div>` : ''}</div>` : ''}
      </div></article>`;
  }

  async _onClick(event) {
    const filter = event.target.closest('[data-filter]');
    if (filter) { this._filter = filter.dataset.filter; this._notice = null; this._render(); return; }
    if (this._busy) return;
    const ap = event.target.closest('[data-ap]');
    if (ap) {
      const kind = ap.dataset.ap;
      if (kind === 'live') { this._confirmLive = true; this._render(); return; }
      if (kind === 'live-cancel') { this._confirmLive = false; this._render(); return; }
      this._busy = true; this._notice = null; this._render();
      try {
        const c = this._autopilot.config;
        if (kind === 'toggle') await api.setAutopilot({ enabled: !c.enabled });
        else if (kind === 'dry') await api.setAutopilot({ mode: 'dry_run' });
        else if (kind === 'live-confirm') { await api.setAutopilot({ mode: 'live', enabled: true }); this._confirmLive = false; }
        else if (kind === 'run') { await api.runAutopilot(); this._notice = 'A cycle started. The page updates when it finishes.'; }
      } catch (err) { this._notice = err.message; }
      this._busy = false;
      await this._load();
      return;
    }
    const all = event.target.closest('[data-draft-all]');
    const mark = event.target.closest('[data-mark-sent]');
    if (all || mark) {
      this._busy = true; this._notice = null; this._render();
      try {
        if (all) {
          const result = await api.draftAllJobEmails({});
          this._notice = `${result.proposed.length} draft(s) proposed. Approve them in Approvals${result.skipped.length ? `; ${result.skipped.length} skipped (no email route, no materials, or already handled)` : ''}${result.failed.length ? `; ${result.failed.length} failed` : ''}.`;
        } else {
          await api.markJobSent(mark.dataset.jobId);
          this._notice = 'Recorded as emailed. It will not be proposed again.';
        }
      } catch (err) { this._notice = err.message; }
      this._busy = false;
      await this._load();
      return;
    }
    const button = event.target.closest('[data-send]');
    if (!button) return;
    this._busy = true;
    this._notice = null;
    this._render();
    try {
      const result = await api.sendJobEmail(button.dataset.jobId, { via: button.dataset.send, force: button.dataset.force === 'true' });
      this._notice = result.status === 'pending' ? 'Proposed. Approve it in Approvals to send it.' : result.status === 'executed' ? 'Done.' : `Not sent: ${result.reason || result.status}`;
    } catch (err) {
      this._notice = err.message;
    }
    this._busy = false;
    await this._load();
  }
}

customElements.define('u2-job-hunt', U2JobHunt);
