import { sendAgentMessage } from '../services/api.js';
import './u2-approval.js';

const STATUS_LABELS = {
  idle: 'Idle',
  thinking: 'Thinking...',
  waiting: 'Waiting for approval',
  acting: 'Acting',
};

const DONE_LABELS = {
  'calendar.reschedule': 'Done. Rescheduled.',
  'calendar.create': 'Done. Added to your calendar.',
  'calendar.cancel': 'Done. Cancelled the event.',
  'email.send': 'Done. Sent.',
  'tasks.create': 'Done. Added the task.',
  'tasks.complete': 'Done. Marked complete.',
  'notifications.send': 'Done. Sent the notification.',
};

// Right-hand conversation panel. Owns the request lifecycle status pill,
// the transcript, and the composer. `<u2-approval>` cards it renders
// bubble `u2-action-resolved` back up to it so the pill and transcript can
// react without the approval card knowing anything about the panel.
export class U2Agent extends HTMLElement {
  constructor() {
    super();
    this._pendingActionIds = new Set();
    this._status = 'idle';
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this._render();
  }

  _render() {
    this.innerHTML = `
      <div class="agent-panel">
        <div class="agent-panel__header">
          <span class="agent-panel__title">Agent</span>
          <span class="status-pill" data-state="idle">
            <span class="status-pill__dot"></span>
            <span class="status-pill__text">Idle</span>
          </span>
        </div>
        <div class="agent-panel__transcript"></div>
        <form class="agent-panel__composer">
          <textarea class="agent-panel__input" rows="1" placeholder="Ask U2OS..."></textarea>
          <button type="submit" class="btn btn-primary">Send</button>
        </form>
      </div>
    `;

    this._transcript = this.querySelector('.agent-panel__transcript');
    this._pill = this.querySelector('.status-pill');
    this._pillText = this.querySelector('.status-pill__text');
    this._input = this.querySelector('.agent-panel__input');
    this._sendBtn = this.querySelector('button[type="submit"]');
    this._form = this.querySelector('.agent-panel__composer');

    this._form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._send();
    });

    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });

    // Optimistic: the moment an approval button is pressed, something is
    // about to be executed by the tool layer -- reflect that immediately
    // rather than waiting for the network round trip to resolve.
    this._transcript.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="approve"], [data-action="reject"]')) {
        this._setStatus('acting');
      }
    });

    this.addEventListener('u2-action-resolved', (e) => this._onActionResolved(e.detail));
  }

  async _send() {
    const text = this._input.value.trim();
    if (!text) return;

    this._input.value = '';
    this._appendBubble('user', text);
    this._setStatus('thinking');
    this._sendBtn.disabled = true;
    this._input.disabled = true;

    try {
      const res = await sendAgentMessage(text);
      this._appendBubble('agent', res.reasoning_summary || "I don't have anything to add.");

      const actions = res.actions || [];
      if (actions.length) {
        const list = document.createElement('div');
        list.className = 'approval-list';
        for (const action of actions) {
          this._pendingActionIds.add(action.id);
          const el = document.createElement('u2-approval');
          el.action = action;
          list.appendChild(el);
        }
        this._appendNode(list);
      }

      this._setStatus((res.pendingActionIds || []).length ? 'waiting' : 'idle');
    } catch (err) {
      this._appendBubble('system', `Something went wrong: ${err.message}`);
      this._setStatus('idle');
    } finally {
      this._sendBtn.disabled = false;
      this._input.disabled = false;
      this._input.focus();
    }
  }

  _onActionResolved(detail) {
    this._pendingActionIds.delete(detail.id);
    const label = detail.status === 'rejected' ? 'Cancelled.' : DONE_LABELS[detail.tool] || 'Done.';
    this._appendBubble('system', detail.status === 'failed' ? "That didn't go through." : label);
    this._setStatus(this._pendingActionIds.size ? 'waiting' : 'idle');
  }

  _setStatus(state) {
    this._status = state;
    this._pill.dataset.state = state;
    this._pillText.textContent = STATUS_LABELS[state] || state;
  }

  _appendBubble(kind, text) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble is-${kind}`;
    bubble.textContent = text;
    this._appendNode(bubble);
  }

  _appendNode(node) {
    this._transcript.appendChild(node);
    this._transcript.scrollTop = this._transcript.scrollHeight;
  }
}

customElements.define('u2-agent', U2Agent);
