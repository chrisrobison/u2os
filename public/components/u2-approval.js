import { escapeHtml, formatDateTime, humanizeKey } from './util.js';
import { approveAction, rejectAction, reproposeAction, getRememberPreview } from '../services/api.js';
import { isUncertainOutcome, approvalOutcomeLabel, approvalOutcomeGuidance } from './action-outcome.js';
import './u2-why.js';

// Humanized verb for the approval headline. Falls back to a readable
// "domain verb" for anything not in this table (e.g. "web search").
const TOOL_LABELS = {
  'calendar.reschedule': 'reschedule a calendar event',
  'calendar.create': 'create a calendar event',
  'calendar.cancel': 'cancel a calendar event',
  'email.send': 'send an email',
  'tasks.create': 'create a task',
  'tasks.complete': 'complete a task',
  'contacts.search': 'search your contacts',
  'notifications.send': 'send a notification',
  'web.search': 'search the web',
};

function humanizeTool(tool) {
  if (!tool) return 'take an action';
  return TOOL_LABELS[tool] || tool.replace(/[._-]+/g, ' ');
}

// `action` may be either shape confirmed live:
//   - inline, from POST /api/agent/message actions[]:
//     { id, status, tool, arguments, reason }
//   - full, from GET /api/actions/pending or GET /api/actions/:id:
//     { id, requested_by, request_text, model, tool, arguments,
//       reasoning_summary, policy_domain, policy_rule, autonomy_level,
//       requires_approval, status, approved_by, approved_at, result,
//       correlation_id, created_at, updated_at }
function normalize(raw) {
  return {
    id: raw?.id ?? null,
    tool: raw?.tool ?? null,
    arguments: raw?.arguments ?? {},
    reason: raw?.reason ?? raw?.reasoning_summary ?? '',
    policyDomain: raw?.policy_domain ?? null,
    policyRule: raw?.policy_rule ?? null,
    status: raw?.status ?? 'pending',
    result: raw?.result ?? null,
    errorClass: raw?.errorClass === 'outcome_uncertain' ? 'outcome_uncertain' : null,
    accountBinding: raw?.accountBinding ?? null,
  };
}

// email.send attachments are staged references (outbox/<sha256>/<filename>):
// show the file name and the start of the content hash the send is pinned to.
function renderAttachments(refs) {
  const items = refs.map((ref) => {
    const parts = String(ref).split('/');
    const named = parts.length === 3 && /^[0-9a-f]{64}$/.test(parts[1]);
    return named
      ? `<li>${escapeHtml(parts[2])} <span class="u2-approval__hash">sha256 ${escapeHtml(parts[1].slice(0, 12))}…</span></li>`
      : `<li>${escapeHtml(String(ref))}</li>`;
  });
  return `<div class="u2-approval__args"><dt>Attachments</dt></div><ul class="u2-approval__attachments">${items.join('')}</ul>`;
}

function renderArgs(tool, args) {
  if (tool === 'email.send' && Array.isArray(args?.attachments)) {
    const { attachments, ...rest } = args;
    return renderArgs(tool, rest) + renderAttachments(attachments);
  }
  if (tool === 'calendar.reschedule') {
    const rows = [];
    if (args.eventId) rows.push(['Event', args.eventId]);
    if (args.newStartAt) rows.push(['New start', formatDateTime(args.newStartAt)]);
    if (args.newEndAt) rows.push(['New end', formatDateTime(args.newEndAt)]);
    if (rows.length) {
      return `<dl class="u2-approval__args">${rows
        .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
        .join('')}</dl>`;
    }
  }

  const entries = Object.entries(args || {});
  if (!entries.length) return '';

  const simple = entries.filter(([, v]) => typeof v !== 'object' || v === null);
  const complex = entries.filter(([, v]) => typeof v === 'object' && v !== null);

  let html = '';
  if (simple.length) {
    html += `<dl class="u2-approval__args">${simple
      .map(([k, v]) => `<dt>${escapeHtml(humanizeKey(k))}</dt><dd>${escapeHtml(String(v))}</dd>`)
      .join('')}</dl>`;
  }
  for (const [k, v] of complex) {
    html += `<div class="u2-approval__args"><dt>${escapeHtml(humanizeKey(k))}</dt></div><pre>${escapeHtml(
      JSON.stringify(v, null, 2)
    )}</pre>`;
  }
  return html;
}

const STALE_ACTION_ERROR = 'Action is stale and requires owner review';

export class U2Approval extends HTMLElement {
  set action(raw) {
    this._raw = raw;
    this._normalized = normalize(raw);
    this._render();
  }

  get action() {
    return this._raw;
  }

  connectedCallback() {
    if (this._normalized) this._render();
  }

  _render() {
    const a = this._normalized;
    if (!a) return;

    this.classList.add('u2-approval');
    this.dataset.status = a.status;

    const stale = a.status === 'failed' && a.result?.error === STALE_ACTION_ERROR && !a.result?.reproposedAs;
    const resolved = isUncertainOutcome(a) || !['pending', undefined, null].includes(a.status);
    const guidance = approvalOutcomeGuidance(a);
    const policyLine = a.policyDomain || a.policyRule
      ? `Policy: ${escapeHtml(a.policyDomain || '')}${a.policyRule ? ` &middot; ${escapeHtml(a.policyRule)}` : ''}`
      : '';

    this.innerHTML = `
      <div class="u2-approval__title">U2OS wants to ${escapeHtml(humanizeTool(a.tool))}</div>
      ${renderArgs(a.tool, a.arguments)}
      ${a.accountBinding ? `<div class="u2-approval__policy">Account: ${escapeHtml(a.accountBinding.label)} (${escapeHtml(a.accountBinding.providerId)})</div>` : ''}
      ${a.accountBinding?.smtpIdentity ? `<div class="u2-approval__policy">SMTP sender: ${escapeHtml(a.accountBinding.smtpIdentity.label)} (${escapeHtml(a.accountBinding.smtpIdentity.from)})</div>` : ''}
      ${a.reason ? `<div class="u2-approval__reason">${escapeHtml(a.reason)}</div>` : ''}
      ${policyLine ? `<div class="u2-approval__policy">${policyLine}</div>` : ''}
      ${guidance ? `<p class="u2-approval__policy u2-approval__guidance">${escapeHtml(guidance)}</p>` : ''}
      ${a.id ? `<u2-why action-id="${escapeHtml(a.id)}"></u2-why>` : ''}
      <div class="u2-approval__actions">
        ${
          resolved
            ? `<span class="u2-approval__status" data-status="${escapeHtml(a.status)}">${escapeHtml(approvalOutcomeLabel(a))}</span>
               ${stale && a.id ? '<button type="button" class="btn btn-primary" data-action="repropose">Review again</button>' : ''}`
            : `<button type="button" class="btn btn-ghost" data-action="reject">Cancel</button>
               <button type="button" class="btn btn-primary" data-action="approve">Approve</button>
               <button type="button" class="btn btn-ghost" data-action="remember" hidden>Approve &amp; always allow</button>`
        }
      </div>
      <div class="u2-approval__policy u2-approval__note" data-role="note" hidden></div>
    `;

    if (stale && a.id) this.querySelector('[data-action="repropose"]').addEventListener('click', () => this._repropose());
    if (!resolved) {
      this._loadRememberPreview(a.id);
      this.querySelector('[data-action="remember"]').addEventListener('click', () => this._resolve('approve', { remember: true }));
      this.querySelector('[data-action="approve"]').addEventListener('click', () => this._resolve('approve'));
      this.querySelector('[data-action="reject"]').addEventListener('click', () => this._resolve('reject'));
    }
  }

  // Shows "Approve & always allow" only when the server can remember this
  // exact rule, and says what it would store. Failure just leaves it hidden.
  async _loadRememberPreview(id) {
    if (!id) return;
    try {
      const preview = await getRememberPreview(id);
      const button = this.querySelector('[data-action="remember"]');
      if (!preview?.rememberable || !button || this._normalized.id !== id) return;
      button.hidden = false;
      button.title = preview.description;
      const note = this.querySelector('[data-role="note"]');
      note.textContent = preview.description;
      note.hidden = false;
    } catch { /* optional affordance */ }
  }

  async _repropose() {
    const button = this.querySelector('[data-action="repropose"]');
    button.disabled = true;
    try {
      const next = await reproposeAction(this._normalized.id);
      this.action = next;
    } catch (error) {
      button.disabled = false;
      const note = this.querySelector('[data-role="note"]');
      note.textContent = `Couldn't review again: ${error?.message || 'try again from Operations'}`;
      note.hidden = false;
    }
  }

  async _resolve(kind, { remember = false } = {}) {
    const buttons = this.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));

    try {
      const result = kind === 'approve' ? await approveAction(this._normalized.id, { remember }) : await rejectAction(this._normalized.id);
      const status = result?.status || (kind === 'approve' ? 'approved' : 'rejected');
      this._normalized = { ...this._normalized, status, result: result?.result ?? null,
        errorClass: result?.errorClass === 'outcome_uncertain' ? 'outcome_uncertain' : null };
      this._render();
      const message = result?.remembered ? result.description : result?.note;
      if (message) {
        const note = this.querySelector('[data-role="note"]');
        note.textContent = message;
        note.hidden = false;
      }
      this.dispatchEvent(
        new CustomEvent('u2-action-resolved', {
          bubbles: true,
          composed: true,
          detail: { id: this._normalized.id, tool: this._normalized.tool, status, result: this._normalized.result, errorClass: this._normalized.errorClass },
        })
      );
    } catch {
      buttons.forEach((b) => (b.disabled = false));
      const actions = this.querySelector('.u2-approval__actions');
      let errEl = this.querySelector('.load-error');
      if (!errEl) {
        errEl = document.createElement('div');
        errEl.className = 'load-error';
        actions.insertAdjacentElement('beforebegin', errEl);
      }
      errEl.textContent = kind === 'approve'
        ? "Couldn't confirm approval. Delivery may still be pending; check Operations before trying again."
        : "Couldn't confirm cancellation. Reload and check current status before trying again.";
    }
  }
}

customElements.define('u2-approval', U2Approval);
