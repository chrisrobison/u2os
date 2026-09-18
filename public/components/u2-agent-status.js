import { escapeHtml } from './util.js';

// PROMPT.md #11's exact status vocabulary, hyphenated per docs/voice.md's
// "Voice status states" section.
const STATE_LABELS = {
  idle: 'Idle',
  listening: 'Listening',
  'owner-speaking': 'Owner speaking',
  'other-speaker': 'Other speaker',
  thinking: 'Thinking...',
  acting: 'Acting',
  speaking: 'Speaking...',
  'waiting-for-approval': 'Waiting for approval',
};

// Real status pill for voice/presence state (Phase 4/5, docs/voice.md).
// Was a Phase-1 placeholder; now a plain property-driven element, never
// self-fetching -- `el.state = 'listening'` and
// `el.speaker = { identity, confidence }` are its entire API. Used both
// standalone (a dashboard status card) and inside <u2-agent>'s own header,
// which is why it owns no fetch/network logic of its own: whoever drives
// the pipeline (public/services/audio.js) or the text-chat request
// lifecycle just sets these two properties.
//
// The speaker line matches PROMPT.md #11's own example format
// (`● Chris — 96%` / `○ Unknown speaker`) -- rendered here as
// `● Owner — 96%` since the pipeline only ever knows "owner" vs "unknown"
// (never a real name), and always includes a percentage, even "0%" for
// the honest Phase-4 stub, per docs/voice.md's explicit note that showing
// "0%" for an unrecognized speaker is the correct and honest thing to do.
export class U2AgentStatus extends HTMLElement {
  constructor() {
    super();
    this._state = 'idle';
    this._speaker = null;
  }

  connectedCallback() {
    this._render();
  }

  set state(value) {
    this._state = value || 'idle';
    if (this.isConnected) this._render();
  }

  get state() {
    return this._state;
  }

  set speaker(value) {
    this._speaker = value || null;
    if (this.isConnected) this._render();
  }

  get speaker() {
    return this._speaker;
  }

  _render() {
    this.classList.add('u2-agent-status');
    const label = STATE_LABELS[this._state] || this._state;
    this.innerHTML = `
      <span class="status-pill" data-state="${escapeHtml(this._state)}">
        <span class="status-pill__dot"></span>
        <span class="status-pill__text">${escapeHtml(label)}</span>
      </span>
      ${this._renderSpeaker()}
    `;
  }

  _renderSpeaker() {
    // No speaker line at all until voice has actually reported one --
    // otherwise a purely text-chat session would show a misleading
    // "Unknown speaker" line for a conversation that never involved a
    // microphone.
    if (!this._speaker) return '';

    const identity = this._speaker.identity;
    const confidence = typeof this._speaker.confidence === 'number' ? this._speaker.confidence : 0;
    const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100);
    const known = !!identity && identity !== 'unknown';
    const dot = known ? '●' : '○';
    const label = known ? 'Owner' : 'Unknown speaker';
    return `<span class="agent-status__speaker mono" data-known="${known}">${dot} ${escapeHtml(label)} — ${pct}%</span>`;
  }
}

customElements.define('u2-agent-status', U2AgentStatus);
