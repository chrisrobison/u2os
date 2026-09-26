import { getModelStatus, createConversation, listConversations, getConversationTurns, sendAgentMessage, sendVoiceMessage } from '../services/api.js';
import { AudioPipeline } from '../services/audio.js';
import { VoiceprintService } from '../services/voiceprint.js';
import { actionOutcomeSentence, isUncertainOutcome } from './action-outcome.js';
import './u2-approval.js';
import './u2-agent-status.js';

const CONVERSATION_KEY = 'u2os.conversationId';

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
    if (!this._onModelSaved) this._onModelSaved = () => { this._disablePlanner(); this._loadPlannerStatus(); };
    window.addEventListener('u2-model-configuration-saved', this._onModelSaved);
    if (this._built) return;
    this._built = true;
    this._render();
    this._restorePromise = this._restoreConversation();
    this._loadPlannerStatus();
  }

  disconnectedCallback() { window.removeEventListener('u2-model-configuration-saved', this._onModelSaved); }

  _disablePlanner() {
    this._plannerUnavailable = true;
    this._input.disabled = true; this._sendBtn.disabled = true; this._micBtn.disabled = true;
    if (this._voiceMode) this._stopVoice();
  }

  async _loadPlannerStatus() {
    const generation = this._modelStatusGeneration = (this._modelStatusGeneration || 0) + 1;
    try {
      const model = await getModelStatus();
      if (!this.isConnected || generation !== this._modelStatusGeneration) return;
      if (model.restartRequired || (model.runtimePlannerStatus || model.plannerStatus) === 'configuration-required') {
        this._disablePlanner();
        this._notice.textContent = model.restartRequired ? 'Model settings changed. Restart U2OS before planning with saved settings. Review ' : 'Planner unavailable. Configure a local or remote model in ';
        const setup = document.createElement('a'); setup.href = '#/model'; setup.textContent = 'Model setup';
        this._notice.append(setup, ', then restart U2OS.');
        this._notice.hidden = false;
      } else if (model.plannerStatus === 'demo') {
        this._notice.textContent = 'Demo planner: responses and actions use deterministic fixtures, not personal reasoning.';
        this._notice.hidden = false;
      }
    } catch {
      if (!this.isConnected || generation !== this._modelStatusGeneration) return;
      this._disablePlanner();
      this._notice.textContent = 'Planner status unavailable; check the server connection before sending a request.';
      this._notice.hidden = false;
    }
  }

  // Trusted workflow entry points can use the same composer lifecycle as a
  // typed request without duplicating the agent API call. Returns false
  // while another request is already in flight.
  submitPrompt(text) {
    const prompt = String(text || '').trim();
    if (!prompt || !this._input || this._input.disabled) return false;
    this._input.value = prompt;
    return this._send();
  }

  _render() {
    this.innerHTML = `
      <div class="agent-panel">
        <div class="agent-panel__header">
          <span class="agent-panel__title">Agent</span>
          <select class="agent-panel__conversations" aria-label="Saved conversations"><option value="">New conversation</option></select>
          <button type="button" class="btn agent-panel__new-chat" title="Start a new conversation">New chat</button>
          <u2-agent-status></u2-agent-status>
        </div>
        <div class="agent-panel__transcript"></div>
        <p class="agent-panel__notice" hidden></p>
        <form class="agent-panel__composer">
          <textarea class="agent-panel__input" rows="1" placeholder="Ask U2OS..."></textarea>
          <button type="button" class="icon-btn agent-panel__mic" data-action="mic-toggle" title="Voice input">&#127908;</button>
          <button type="submit" class="btn btn-primary">Send</button>
        </form>
      </div>
    `;

    this._transcript = this.querySelector('.agent-panel__transcript');
    this._notice = this.querySelector('.agent-panel__notice');
    this._statusEl = this.querySelector('u2-agent-status');
    this._input = this.querySelector('.agent-panel__input');
    this._sendBtn = this.querySelector('button[type="submit"]');
    this._micBtn = this.querySelector('[data-action="mic-toggle"]');
    this._newChatBtn = this.querySelector('.agent-panel__new-chat');
    this._conversationPicker = this.querySelector('.agent-panel__conversations');
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
    this._newChatBtn.addEventListener('click', () => this._startNewChat());
    this._conversationPicker.addEventListener('change', () => {
      const id = this._conversationPicker.value;
      if (id) this._restorePromise = this._openConversation(id);
      else this._startNewChat();
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
    await this._restorePromise;
    const text = this._input.value.trim();
    if (!text) return;
    const generation = this._restoreGeneration || 0;

    this._input.value = '';
    this._appendBubble('user', text);
    this._setStatus('thinking');
    this._sendBtn.disabled = true;
    this._input.disabled = true;

    try {
      const conversationId = await this._ensureConversation(generation);
      const res = await sendAgentMessage(text, conversationId);
      if (generation !== (this._restoreGeneration || 0)) return;
      this._renderAgentResponse(res);
      this._loadConversations();
      if (res.conversationSaved === false) this._appendBubble('system', 'The action result was returned, but this reply could not be saved to conversation history.');
      this._setStatus((res.pendingActionIds || []).length ? 'waiting-for-approval' : 'idle');
    } catch (err) {
      if (generation !== (this._restoreGeneration || 0)) return;
      this._appendBubble('system', `Something went wrong: ${err.message}`);
      this._setStatus('idle');
    } finally {
      if (generation === (this._restoreGeneration || 0)) {
        this._sendBtn.disabled = Boolean(this._plannerUnavailable);
        this._input.disabled = Boolean(this._plannerUnavailable);
        if (!this._plannerUnavailable) this._input.focus();
      }
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
    await this._restorePromise;
    if (!text || this._plannerUnavailable) return;
    const generation = this._restoreGeneration || 0;
    this._appendBubble('user', text);
    this._pipeline.setBusy('thinking');

    try {
      const conversationId = await this._ensureConversation(generation);
      const res = await sendVoiceMessage(text, speaker, conversationId);
      if (generation !== (this._restoreGeneration || 0)) return;
      this._renderAgentResponse(res);
      this._loadConversations();
      if (res.conversationSaved === false) this._appendBubble('system', 'The reply could not be saved to conversation history.');

      const hasPending = (res.pendingActionIds || []).length > 0;
      if (hasPending) {
        this._pipeline.setBusy('waiting-for-approval');
      } else {
        this._speak(res.response || res.reasoning_summary);
      }
    } catch (err) {
      if (generation !== (this._restoreGeneration || 0)) return;
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
    this._appendBubble('agent', res.response || res.reasoning_summary || "I don't have anything to add.");
    const actions = res.actions || [];
    if (actions.length) {
      const list = document.createElement('div');
      list.className = 'approval-list';
      for (const action of actions) {
        if (action.status === 'pending') this._pendingActionIds.add(action.id);
        const el = document.createElement('u2-approval');
        el.action = action;
        list.appendChild(el);
      }
      this._appendNode(list);
    }
  }

  async _ensureConversation(generation = this._restoreGeneration || 0) {
    if (this._conversationId) return this._conversationId;
    const created = await createConversation();
    if (generation === (this._restoreGeneration || 0)) {
      this._conversationId = created.conversationId;
      try { localStorage.setItem(CONVERSATION_KEY, this._conversationId); } catch { /* storage may be disabled */ }
      this._loadConversations();
    }
    return created.conversationId;
  }

  _startNewChat() {
    this._restoreGeneration = (this._restoreGeneration || 0) + 1;
    this._conversationId = null;
    try { localStorage.removeItem(CONVERSATION_KEY); } catch { /* storage may be disabled */ }
    this._pendingActionIds.clear();
    this._transcript.replaceChildren();
    this._setStatus('idle');
    this._sendBtn.disabled = Boolean(this._plannerUnavailable);
    this._input.disabled = Boolean(this._plannerUnavailable);
    this._conversationPicker.disabled = false;
    this._conversationPicker.value = '';
    this._loadConversations();
  }

  async _restoreConversation() {
    let id;
    try { id = localStorage.getItem(CONVERSATION_KEY); } catch { return; }
    if (!id) { await this._loadConversations(); return; }
    await this._openConversation(id);
    await this._loadConversations();
  }

  async _openConversation(id) {
    const previousId = this._conversationId;
    const generation = this._restoreGeneration = (this._restoreGeneration || 0) + 1;
    this._conversationPicker.disabled = true;
    try {
      const { turns } = await getConversationTurns(id);
      if (generation !== this._restoreGeneration) return;
      this._conversationId = id;
      try { localStorage.setItem(CONVERSATION_KEY, id); } catch { /* storage may be disabled */ }
      this._pendingActionIds.clear();
      this._setStatus('idle');
      this._sendBtn.disabled = Boolean(this._plannerUnavailable);
      this._input.disabled = Boolean(this._plannerUnavailable);
      this._transcript.replaceChildren();
      for (const turn of turns) this._appendBubble(turn.role === 'assistant' ? 'agent' : turn.role, turn.content + (turn.truncated ? '…' : ''));
      this._conversationPicker.value = id;
      if (this._notice.textContent.startsWith('That conversation is unavailable.')) this._notice.hidden = true;
    } catch {
      if (generation !== this._restoreGeneration) return;
      this._conversationPicker.value = previousId || '';
      if (!previousId) {
        try { localStorage.removeItem(CONVERSATION_KEY); } catch { /* storage may be disabled */ }
        this._conversationId = null;
      }
      this._notice.textContent = 'That conversation is unavailable. Choose another saved conversation.';
      this._notice.hidden = false;
      await this._loadConversations();
    } finally {
      if (generation === this._restoreGeneration) this._conversationPicker.disabled = false;
    }
  }

  async _loadConversations() {
    const generation = this._restoreGeneration || 0;
    try {
      const { conversations } = await listConversations();
      if (generation !== (this._restoreGeneration || 0)) return;
      this._conversationPicker.replaceChildren(new Option('New conversation', ''));
      for (const conversation of conversations) {
        const label = String(conversation.label || 'Untitled conversation').replace(/\s+/g, ' ').slice(0, 80);
        this._conversationPicker.add(new Option(label, conversation.id));
      }
      this._conversationPicker.value = this._conversationId || '';
    } catch {
      // A list outage must not discard the current conversation or transcript.
    }
  }

  _onActionResolved(detail) {
    if (detail.status === 'pending' && !isUncertainOutcome(detail)) this._pendingActionIds.add(detail.id);
    else this._pendingActionIds.delete(detail.id);
    const label = actionOutcomeSentence(detail);
    this._appendBubble('system', label);

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
