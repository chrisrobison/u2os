import { escapeHtml, formatDateTime, humanizeKey } from './util.js';
import { approveAction, rejectAction } from '../services/api.js';
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
    accountBinding: raw?.accountBinding ?? null,
  };
}

function renderArgs(tool, args) {
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

    const resolved = !['pending', undefined, null].includes(a.status);
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
      ${a.id ? `<u2-why action-id="${escapeHtml(a.id)}"></u2-why>` : ''}
      <div class="u2-approval__actions">
        ${
          resolved
            ? `<span class="u2-approval__status" data-status="${escapeHtml(a.status)}">${escapeHtml(statusLabel(a.status))}</span>`
            : `<button type="button" class="btn btn-ghost" data-action="reject">Cancel</button>
               <button type="button" class="btn btn-primary" data-action="approve">Approve</button>`
        }
      </div>
    `;

    if (!resolved) {
      this.querySelector('[data-action="approve"]').addEventListener('click', () => this._resolve('approve'));
      this.querySelector('[data-action="reject"]').addEventListener('click', () => this._resolve('reject'));
    }
  }

  async _resolve(kind) {
    const buttons = this.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));

    try {
      const result = kind === 'approve' ? await approveAction(this._normalized.id) : await rejectAction(this._normalized.id);
      const status = result?.status || (kind === 'approve' ? 'approved' : 'rejected');
      this._normalized = { ...this._normalized, status, result: result?.result ?? null };
      this._render();
      this.dispatchEvent(
        new CustomEvent('u2-action-resolved', {
          bubbles: true,
          composed: true,
          detail: { id: this._normalized.id, tool: this._normalized.tool, status, result: this._normalized.result },
        })
      );
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      const actions = this.querySelector('.u2-approval__actions');
      let errEl = this.querySelector('.load-error');
      if (!errEl) {
        errEl = document.createElement('div');
        errEl.className = 'load-error';
        actions.insertAdjacentElement('beforebegin', errEl);
      }
      errEl.textContent = `Couldn't ${kind === 'approve' ? 'approve' : 'cancel'}: ${err.message}`;
    }
  }
}

function statusLabel(status) {
  switch (status) {
    case 'executed':
      return 'Approved and done';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

customElements.define('u2-approval', U2Approval);
