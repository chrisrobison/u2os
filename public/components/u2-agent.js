import { sendAgentMessage, sendVoiceMessage } from '../services/api.js';
import { AudioPipeline } from '../services/audio.js';
import { VoiceprintService } from '../services/voiceprint.js';
import './u2-approval.js';
import './u2-agent-status.js';

const DONE_LABELS = {
  'calendar.reschedule': 'Done. Rescheduled.',
  'calendar.create': 'Done. Added to your calendar.',
  'calendar.cancel': 'Done. Cancelled the event.',
  'email.send': 'Done. Sent.',
  'tasks.create': 'Done. Added the task.',
  'tasks.complete': 'Done. Marked complete.',
  'notifications.send': 'Done. Sent the notification.',
};

// Right-hand conversation panel. Owns the request lifecycle status pill
// (delegated to <u2-agent-status>, Phase 4/5's real replacement for the
// Phase-1 placeholder), the transcript, the composer, and -- new in Phase
// 4/5 -- the mic toggle that drives the real client-side voice pipeline
// (public/services/audio.js). `<u2-approval>` cards it renders bubble
// `u2-action-resolved` back up to it so the pill and transcript can react
// without the approval card knowing anything about the panel.
//
// Voice mode reuses the exact same transcript/approval-rendering code as
// typed text -- the only difference is which API call produces the
// response (sendVoiceMessage() with speaker metadata vs. sendAgentMessage())
// and that a voice-mode response gets spoken back via TTS.
export class U2Agent extends HTMLElement {
  constructor() {
    super();
    this._pendingActionIds = new Set();
    this._status = 'idle';
    this._pipeline = null;
    this._voiceprint = new VoiceprintService();
    this._voiceMode = false;
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
          <u2-agent-status></u2-agent-status>
        </div>
        <div class="agent-panel__transcript"></div>
        <form class="agent-panel__composer">
          <textarea class="agent-panel__input" rows="1" placeholder="Ask U2OS..."></textarea>
          <button type="button" class="icon-btn agent-panel__mic" data-action="mic-toggle" title="Voice input">&#127908;</button>
          <button type="submit" class="btn btn-primary">Send</button>
        </form>
      </div>
    `;

    this._transcript = this.querySelector('.agent-panel__transcript');
    this._statusEl = this.querySelector('u2-agent-status');
    this._input = this.querySelector('.agent-panel__input');
    this._sendBtn = this.querySelector('button[type="submit"]');
    this._micBtn = this.querySelector('[data-action="mic-toggle"]');
    this._form = this.querySelector('.agent-panel__composer');

    this._setupMicSupport();

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

    this._micBtn.addEventListener('click', () => this._toggleVoice());

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

  // ---- feature detection: a disabled button with an explanatory title,
  // never a silently-broken one (this environment/browser combination may
  // simply not support getUserMedia/SpeechRecognition at all). ----
  _setupMicSupport() {
    const support = AudioPipeline.supported;
    if (!support.mic) {
      this._micBtn.disabled = true;
      this._micBtn.title = 'Voice input needs microphone access (getUserMedia), which this browser/context does not provide.';
    } else if (!support.audioContext) {
      this._micBtn.disabled = true;
      this._micBtn.title = 'Voice input needs the Web Audio API (AudioContext), which this browser does not provide.';
    } else if (!support.recognition) {
      this._micBtn.disabled = true;
      this._micBtn.title = 'Voice input needs SpeechRecognition, which this browser does not support.';
    } else {
      this._micBtn.title = support.synthesis
        ? 'Turn on voice mode'
        : 'Turn on voice mode (this browser cannot speak responses back -- no speechSynthesis)';
    }
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
      this._renderAgentResponse(res);
      this._setStatus((res.pendingActionIds || []).length ? 'waiting-for-approval' : 'idle');
    } catch (err) {
      this._appendBubble('system', `Something went wrong: ${err.message}`);
      this._setStatus('idle');
    } finally {
      this._sendBtn.disabled = false;
      this._input.disabled = false;
      this._input.focus();
    }
  }

  // ---- voice mode ----

  async _toggleVoice() {
    if (this._voiceMode) {
      this._stopVoice();
      return;
    }

    if (!this._pipeline) {
      this._pipeline = new AudioPipeline({
        identifySpeaker: (frames) => this._voiceprint.identifySpeaker(frames),
      });
      this._pipeline.addEventListener('state', (e) => {
        this._statusEl.state = e.detail.state;
        this._statusEl.speaker = e.detail.speaker;
      });
      this._pipeline.addEventListener('transcript', (e) => this._onVoiceTranscript(e.detail));
      this._pipeline.addEventListener('error', (e) => {
        this._appendBubble('system', `Voice: ${e.detail.reason}`);
      });
    }

    // Best-effort: load any existing Phase 5 enrollment so
    // identifySpeaker() has something real to compare against instead of
    // always the Phase 4 stub. Silently keeps the stub if this fails or
    // nothing is enrolled yet -- enrollment is entirely optional.
    try {
      await this._voiceprint.loadStatus();
    } catch {
      /* stub fallback is fine */
    }

    const result = await this._pipeline.start();
    if (!result.supported) {
      this._appendBubble('system', `Couldn't start voice mode: ${result.reason}`);
      this._micBtn.disabled = true;
      this._micBtn.title = result.reason;
      return;
    }

    this._voiceMode = true;
    this._micBtn.classList.add('is-active');
    this._micBtn.title = 'Turn off voice mode';
  }

  _stopVoice() {
    this._pipeline?.stop();
    this._voiceMode = false;
    this._micBtn.classList.remove('is-active');
    this._micBtn.title = 'Turn on voice mode';
    this._statusEl.state = 'idle';
    this._statusEl.speaker = null;
  }

  async _onVoiceTranscript({ text, speaker }) {
    if (!text) return;
    this._appendBubble('user', text);
    this._pipeline.setBusy('thinking');

    try {
      const res = await sendVoiceMessage(text, speaker);
      this._renderAgentResponse(res);

      const hasPending = (res.pendingActionIds || []).length > 0;
      if (hasPending) {
        this._pipeline.setBusy('waiting-for-approval');
      } else {
        this._speak(res.reasoning_summary);
      }
    } catch (err) {
      this._appendBubble('system', `Something went wrong: ${err.message}`);
      this._pipeline.setBusy('listening');
    }
  }

  // Speaks `text` via the pipeline's TTS when voice mode is on; a no-op
  // (not a crash) when it's off or synthesis is unsupported --
  // AudioPipeline.speak() already degrades gracefully on its own.
  _speak(text) {
    if (!this._voiceMode || !this._pipeline || !text) return;
    this._pipeline.speak(text, {
      onend: () => this._pipeline.setBusy('listening'),
    });
  }

  // ---- shared rendering (typed text and voice both funnel through this) ----

  _renderAgentResponse(res) {
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
  }

  _onActionResolved(detail) {
    this._pendingActionIds.delete(detail.id);
    const label = detail.status === 'rejected' ? 'Cancelled.' : DONE_LABELS[detail.tool] || 'Done.';
    this._appendBubble('system', detail.status === 'failed' ? "That didn't go through." : label);

    const nextState = this._pendingActionIds.size ? 'waiting-for-approval' : this._voiceMode ? 'listening' : 'idle';
    if (this._voiceMode) {
      this._pipeline.setBusy(nextState);
      if (!this._pendingActionIds.size) this._speak(label);
    } else {
      this._setStatus(nextState);
    }
  }

  _setStatus(state) {
    this._status = state;
    if (this._statusEl) this._statusEl.state = state;
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
