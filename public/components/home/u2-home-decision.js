import { approveAction, rejectAction } from '../../services/api.js';
import { approvalOutcomeLabel, isUncertainOutcome } from '../action-outcome.js';
import { el } from './home-util.js';
import '../u2-why.js';

// One "Needs your decision" card. Approve and Reject call the same API
// functions as <u2-approval> (POST /api/actions/:id/approve|reject), so the
// server's policy engine decides what happens; this component adds no approval
// logic. It announces the result through the bubbling `u2-action-resolved`
// event, the same event <u2-approval> emits.

export class U2HomeDecision extends HTMLElement {
  set card(value) { this._card = value; if (this.isConnected) this._render(); }
  get card() { return this._card; }

  connectedCallback() { this.classList.add('home-decision'); if (this._card) this._render(); }

  _render() {
    const card = this._card;
    if (!card) return;
    this._error = el('p', { class: 'home-decision__error', role: 'alert', hidden: true });
    this._buttons = [
      el('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'approve', text: 'Approve', onclick: () => this._resolve('approve') }),
      el('button', { type: 'button', class: 'btn', 'data-action': 'reject', text: 'Reject', onclick: () => this._resolve('reject') }),
    ];
    const why = el('u2-why');
    why.setAttribute('action-id', card.id);
    this._actions = el('div', { class: 'home-decision__actions' }, ...this._buttons, why);
    this.replaceChildren(
      el('h3', { class: 'home-decision__title', text: card.title }),
      card.reason && el('p', { class: 'home-decision__reason', text: card.reason }),
      card.policy && el('p', { class: 'home-decision__policy', text: `Policy: ${card.policy}` }),
      this._error,
      this._actions,
    );
  }

  async _resolve(kind) {
    const card = this._card;
    this._buttons.forEach((b) => { b.disabled = true; });
    this._error.hidden = true;
    try {
      const result = kind === 'approve' ? await approveAction(card.id) : await rejectAction(card.id);
      const status = result?.status || (kind === 'approve' ? 'approved' : 'rejected');
      const outcome = { status, errorClass: result?.errorClass === 'outcome_uncertain' ? 'outcome_uncertain' : null, result: result?.result ?? null };
      const label = approvalOutcomeLabel(outcome);
      this._actions.replaceChildren(el('span', { class: 'home-decision__status', 'data-status': status, text: label }));
      this.dispatchEvent(new CustomEvent('u2-action-resolved', {
        bubbles: true, composed: true,
        detail: { id: card.id, tool: card.tool, status, errorClass: outcome.errorClass, uncertain: isUncertainOutcome(outcome), title: card.title, label },
      }));
    } catch {
      this._buttons.forEach((b) => { b.disabled = false; });
      this._error.hidden = false;
      this._error.textContent = kind === 'approve'
        ? "Couldn't confirm approval. Delivery may still be pending; check Operations before trying again."
        : "Couldn't confirm the rejection. Check Operations for its current status before trying again.";
    }
  }
}

customElements.define('u2-home-decision', U2HomeDecision);
