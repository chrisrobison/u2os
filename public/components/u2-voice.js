import { escapeHtml, formatDateTime } from './util.js';
import { VoiceprintService } from '../services/voiceprint.js';
import { deleteVoiceEnrollment } from '../services/api.js';
import './u2-card.js';

const SAMPLE_COUNT = 4;

// Phase 5 voice enrollment page (#/voice, docs/voice.md). Self-fetching,
// same "settings page owns its own data + state" pattern as
// <u2-connectors> -- u2-app just mounts <u2-voice> and gets out of the way.
//
// HONESTY NOTE (docs/voice.md's "Honesty about scope" -- said here too,
// not just in code comments, because PROMPT.md explicitly requires
// labeling mocked/simplified components wherever they show up): the
// "voiceprint" enrolled here is a lightweight spectral/DSP fingerprint --
// a band-energy distribution across a small number of frequency bins,
// averaged over a few short samples and compared later by simple cosine
// similarity. It is NOT a trained neural speaker-embedding model. It is a
// real, working comparison, just a much cruder one than commercial
// speaker verification.
export class U2Voice extends HTMLElement {
  constructor() {
    super();
    this._service = new VoiceprintService();
    this._status = null; // { enrolled, enrolledAt }
    this._enrolling = false;
    this._sampleProgress = null; // { index, count }
    this._message = null; // { text, isError }
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.addEventListener('click', (e) => this._onClick(e));
    this._load();
  }

  async _load() {
    this.innerHTML = `<div class="empty-state">Loading voice enrollment status...</div>`;
    this._status = await this._service.loadStatus();
    this._render();
  }

  _render() {
    const supported = VoiceprintService.supported;
    const status = this._status || { enrolled: false, enrolledAt: null };

    const statusLine = status.enrolled
      ? `<span class="status-dot is-connected"></span> Enrolled${
          status.enrolledAt ? ` <span class="mono">(${escapeHtml(formatDateTime(status.enrolledAt))})</span>` : ''
        }`
      : `<span class="status-dot is-disconnected"></span> Not enrolled`;

    const progressLine = this._sampleProgress
      ? `<div class="connector-meta">Recording sample ${this._sampleProgress.index + 1} of ${this._sampleProgress.count} -- say a few natural words...</div>`
      : '';

    const messageLine = this._message
      ? `<div class="connector-inline-message${this._message.isError ? ' is-error' : ''}">${escapeHtml(this._message.text)}</div>`
      : '';

    const actionsHtml = !supported
      ? `<div class="load-error">Voice enrollment needs microphone access and the Web Audio API, which this browser/context does not provide.</div>`
      : `
        <div class="connector-controls">
          <button type="button" class="btn btn-primary" data-action="enroll" ${this._enrolling ? 'disabled' : ''}>
            ${this._enrolling ? 'Enrolling...' : status.enrolled ? 'Re-enroll' : 'Enroll my voice'}
          </button>
          ${
            status.enrolled
              ? `<button type="button" class="btn" data-action="clear" ${this._enrolling ? 'disabled' : ''}>Clear enrollment</button>`
              : ''
          }
        </div>
      `;

    this.innerHTML = `
      <div class="workspace__header">
        <div class="workspace__title">Voice</div>
        <div class="workspace__subtitle">Enroll your voice so U2OS can tell you apart from anyone else talking near the microphone</div>
      </div>
      <u2-card title="Enrollment status">
        <div class="connector-status">${statusLine}</div>
        ${progressLine}
        ${actionsHtml}
        ${messageLine}
      </u2-card>
      <p class="connectors__intro">
        Enrollment captures ${SAMPLE_COUNT} short samples of your voice and averages them into one stored
        "voiceprint" -- a lightweight spectral fingerprint (band energy across a few frequency ranges), <em>not</em>
        a trained neural speaker-embedding model. Later, U2OS compares each recognized utterance against this
        fingerprint with simple cosine similarity to decide how confident it is that you're the one talking. It's a
        real, working comparison, just a much cruder one than commercial speaker verification -- see
        <span class="mono">docs/voice.md</span> for the full honesty note. Until you enroll, every speaker is
        reported as an honest "unknown" at 0% confidence, and voice alone is never enough on its own to authorize
        anything consequential -- see <span class="mono">docs/policies.md</span> for how confirmation still works
        underneath it.
      </p>
    `;
  }

  _onClick(e) {
    if (e.target.closest('[data-action="enroll"]')) {
      this._enroll();
    } else if (e.target.closest('[data-action="clear"]')) {
      this._clear();
    }
  }

  async _enroll() {
    if (this._enrolling) return;
    this._enrolling = true;
    this._message = null;
    this._render();

    const result = await this._service.enroll({
      onSampleStart: (index) => {
        this._sampleProgress = { index, count: SAMPLE_COUNT };
        this._render();
      },
    });

    this._enrolling = false;
    this._sampleProgress = null;

    if (!result.supported) {
      this._message = { text: result.reason, isError: true };
      this._render();
      return;
    }

    this._message = { text: 'Enrolled. U2OS will now try to recognize your voice in voice conversations.', isError: false };
    this._status = await this._service.loadStatus();
    this._render();
  }

  async _clear() {
    this._message = null;
    try {
      await deleteVoiceEnrollment();
      this._status = await this._service.loadStatus();
      this._message = { text: 'Enrollment cleared.', isError: false };
    } catch (err) {
      this._message = { text: err.message, isError: true };
    }
    this._render();
  }
}

customElements.define('u2-voice', U2Voice);
