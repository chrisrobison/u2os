// Phase 4/5 client-side voice pipeline (docs/voice.md, PROMPT.md #6/#8).
// This is REAL, working DSP/browser-API code -- real mic capture, a real
// energy-based VAD, the real Web Speech API for STT/TTS, and real
// barge-in -- not a mock. The one honest stub in here is speaker identity:
// by default `identifySpeaker` always returns
// `{ cluster: 0, identity: 'unknown', confidence: 0 }` (Phase 4, no
// enrolled voiceprint exists yet). Pass a real one (see
// public/services/voiceprint.js, Phase 5) via the constructor option once
// there's something to compare against.
//
// Voice devices belong to the client, never the server (docs/voice.md's
// opening line) -- this module never talks to the network itself; it only
// emits state transitions and recognized-text events for a consumer (see
// public/components/u2-agent.js) to act on.
//
// Shape: an EventTarget-based small service class, the same "self-
// contained class with a narrow public surface" style as EventsService in
// events.js, but exposing CustomEvents on the instance itself rather than
// on `window` (there can be more than one caller interested in a given
// pipeline instance's state).
//
//   const pipeline = new AudioPipeline();
//   pipeline.addEventListener('state', (e) => ...);      // { state, speaker }
//   pipeline.addEventListener('transcript', (e) => ...); // { text, speaker }
//   pipeline.addEventListener('error', (e) => ...);      // { reason }
//   await pipeline.start();  // -> { supported: true } | { supported: false, reason }
//   pipeline.speak('...', { onstart, onend });
//   pipeline.stop();
//
// States emitted are exactly PROMPT.md #11's vocabulary, hyphenated per
// docs/voice.md: idle | listening | thinking | acting | speaking |
// waiting-for-approval | owner-speaking | other-speaker. This module only
// ever emits idle/listening/owner-speaking/other-speaker/speaking on its
// own -- 'thinking'/'acting'/'waiting-for-approval' are request-lifecycle
// states the consumer owns (mirrors <u2-agent>'s existing status pill), so
// call `setBusy(state)` to fold those into the same stream.

const SpeechRecognitionCtor =
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined;

// RMS is computed on samples normalized to -1..1 (see computeRms), so this
// threshold is on that same 0..1 energy scale, not raw byte values.
const DEFAULT_VAD_THRESHOLD = 0.02;
// Keep a segment "active" this long after energy drops below threshold --
// avoids choppy segment boundaries from brief pauses mid-sentence.
const DEFAULT_VAD_HANGOVER_MS = 600;
const ANALYSER_FFT_SIZE = 2048;

export class AudioPipeline extends EventTarget {
  constructor({ identifySpeaker, vadThreshold, vadHangoverMs } = {}) {
    super();
    this._identifySpeaker = identifySpeaker || defaultIdentifySpeaker;
    this._vadThreshold = vadThreshold ?? DEFAULT_VAD_THRESHOLD;
    this._vadHangoverMs = vadHangoverMs ?? DEFAULT_VAD_HANGOVER_MS;

    this._state = 'idle';
    this._lastSpeaker = null;

    this._stream = null;
    this._audioCtx = null;
    this._gatedAnalyser = null; // gates SpeechRecognition start/stop
    this._bargeInAnalyser = null; // separate always-on tap, read only while speaking

    this._recognition = null;
    this._recognitionActive = false;
    this._speechActive = false;
    this._hangoverTimer = null;
    this._segmentFrames = []; // frequency-bin snapshots captured during the current segment

    this._speaking = false; // TTS currently playing
    this._vadRafId = null;
    this._bargeRafId = null;
  }

  get state() {
    return this._state;
  }

  // Feature detection, exposed statically so a UI can decide whether to
  // even offer voice controls before ever constructing a pipeline.
  static get supported() {
    return {
      mic: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
      audioContext: typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext),
      recognition: !!SpeechRecognitionCtor,
      synthesis: typeof window !== 'undefined' && !!window.speechSynthesis,
    };
  }

  /**
   * Acquires the microphone and starts the always-on energy VAD loop.
   * Never throws -- every failure mode (permission denied, no device, no
   * mediaDevices/AudioContext at all, insecure context) is reported via an
   * 'error' event and returns `{ supported: false, reason }` instead of a
   * rejected promise, so callers can show a clear "not supported" UI state
   * rather than crash.
   */
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return this._unsupported(
        'This browser has no navigator.mediaDevices.getUserMedia (unsupported browser, or an insecure/non-HTTPS context).'
      );
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      return this._unsupported('This browser has no AudioContext (Web Audio API unavailable).');
    }

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      return this._unsupported(describeGetUserMediaError(err));
    }

    this._audioCtx = new AudioContextCtor();
    if (this._audioCtx.state === 'suspended') {
      try {
        await this._audioCtx.resume();
      } catch {
        // Some browsers require a fresh user gesture to resume; start()
        // itself is always called from one (the mic button click), so
        // this is defensive, not expected to actually fire.
      }
    }

    const source = this._audioCtx.createMediaStreamSource(this._stream);

    // Two independent taps on the same source: the gated one drives
    // SpeechRecognition start/stop and is only read while not speaking;
    // the barge-in one is always-on but only read while TTS is playing
    // (docs/voice.md's barge-in section).
    this._gatedAnalyser = this._audioCtx.createAnalyser();
    this._gatedAnalyser.fftSize = ANALYSER_FFT_SIZE;
    source.connect(this._gatedAnalyser);

    this._bargeInAnalyser = this._audioCtx.createAnalyser();
    this._bargeInAnalyser.fftSize = ANALYSER_FFT_SIZE;
    source.connect(this._bargeInAnalyser);

    this._setupRecognition();

    this._setState('listening');
    this._runVadLoop();
    return { supported: true };
  }

  stop() {
    this._cancelVadLoop();
    this._cancelBargeLoop();
    if (this._recognition && this._recognitionActive) {
      try {
        this._recognition.stop();
      } catch {
        /* already stopped */
      }
    }
    this._recognitionActive = false;
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
    if (this._audioCtx) {
      try {
        this._audioCtx.close();
      } catch {
        /* already closed */
      }
      this._audioCtx = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this._speaking = false;
    this._lastSpeaker = null;
    this._setState('idle');
  }

  /**
   * Speaks `text` via the Web Speech API. Never throws when synthesis is
   * unsupported -- returns `{ supported: false }` and emits an 'error'
   * event instead. While speaking, the always-on barge-in tap watches for
   * speech onset and immediately cancels + returns to listening.
   */
  speak(text, { onstart, onend } = {}) {
    if (!window.speechSynthesis) {
      this._emitError('This browser has no speechSynthesis -- voice output is unsupported here.');
      return { supported: false };
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onstart = () => {
      this._speaking = true;
      this._setState('speaking');
      this._runBargeInLoop();
      onstart?.();
    };
    const finish = () => {
      this._speaking = false;
      this._cancelBargeLoop();
      if (this._state === 'speaking') this._setState('listening');
      onend?.();
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    window.speechSynthesis.speak(utterance);
    return { supported: true };
  }

  /**
   * Lets the consumer fold request-lifecycle states ('thinking', 'acting',
   * 'waiting-for-approval') into the same state stream this pipeline
   * emits, so a single <u2-agent-status> can bind to one property. This
   * module never produces those states on its own -- it has no idea what
   * a network request or an approval queue is.
   */
  setBusy(state) {
    this._setState(state);
  }

  // ---- VAD: energy-based (RMS over a rolling window) + hangover ----

  _runVadLoop() {
    const data = new Uint8Array(this._gatedAnalyser.fftSize);
    const tick = () => {
      if (!this._gatedAnalyser) return; // stop() tore everything down
      if (this._speaking) {
        // The barge-in loop owns speech-onset detection while TTS plays;
        // this loop just waits for it to end before resuming.
        this._vadRafId = requestAnimationFrame(tick);
        return;
      }
      this._gatedAnalyser.getByteTimeDomainData(data);
      this._handleEnergySample(computeRms(data));
      this._vadRafId = requestAnimationFrame(tick);
    };
    this._vadRafId = requestAnimationFrame(tick);
  }

  _cancelVadLoop() {
    if (this._vadRafId) {
      cancelAnimationFrame(this._vadRafId);
      this._vadRafId = null;
    }
    if (this._hangoverTimer) {
      clearTimeout(this._hangoverTimer);
      this._hangoverTimer = null;
    }
    this._speechActive = false;
  }

  _handleEnergySample(rms) {
    const isLoud = rms >= this._vadThreshold;

    if (isLoud) {
      if (this._hangoverTimer) {
        clearTimeout(this._hangoverTimer);
        this._hangoverTimer = null;
      }
      if (this._recognitionActive) {
        this._captureFrequencyFrame();
      }
      if (!this._speechActive) {
        this._speechActive = true;
        this._startRecognitionSegment();
      }
    } else if (this._speechActive && !this._hangoverTimer) {
      this._hangoverTimer = setTimeout(() => {
        this._hangoverTimer = null;
        this._speechActive = false;
        this._endRecognitionSegment();
      }, this._vadHangoverMs);
    }
  }

  _captureFrequencyFrame() {
    if (!this._gatedAnalyser) return;
    const frame = new Uint8Array(this._gatedAnalyser.frequencyBinCount);
    this._gatedAnalyser.getByteFrequencyData(frame);
    this._segmentFrames.push(frame);
  }

  // ---- SpeechRecognition: only runs for the duration of a detected segment ----

  _setupRecognition() {
    if (!SpeechRecognitionCtor) {
      this._emitError('This browser has no SpeechRecognition/webkitSpeechRecognition -- voice input is unsupported here.');
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const text = result?.[0]?.transcript?.trim();
      if (!text) return;
      const speaker = this._identifySpeaker(this._segmentFrames.slice());
      this._lastSpeaker = speaker;
      this._setState(speakerState(speaker) || 'listening');
      this.dispatchEvent(new CustomEvent('transcript', { detail: { text, speaker } }));
    };

    recognition.onerror = (event) => {
      this._recognitionActive = false;
      // 'no-speech'/'aborted' are routine (the segment ended with nothing
      // recognizable, or we stopped it ourselves) -- only surface
      // genuinely unexpected errors.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        this._emitError(`Speech recognition error: ${event.error}`);
      }
    };

    recognition.onend = () => {
      this._recognitionActive = false;
      if (!['thinking', 'acting', 'speaking', 'waiting-for-approval'].includes(this._state)) {
        this._setState('listening');
      }
    };

    this._recognition = recognition;
  }

  _startRecognitionSegment() {
    this._segmentFrames = [];
    if (!this._recognition || this._recognitionActive) return;
    try {
      this._recognition.start();
      this._recognitionActive = true;
    } catch {
      // InvalidStateError if already starting/started -- the next detected
      // segment will retry; never throw out of a VAD tick over this.
    }
  }

  _endRecognitionSegment() {
    if (this._recognition && this._recognitionActive) {
      try {
        this._recognition.stop();
      } catch {
        /* already stopped */
      }
    }
  }

  // ---- barge-in: always-on tap, read only while TTS is speaking ----

  _runBargeInLoop() {
    if (!this._bargeInAnalyser) return;
    const data = new Uint8Array(this._bargeInAnalyser.fftSize);
    const tick = () => {
      if (!this._speaking || !this._bargeInAnalyser) return; // TTS already ended on its own
      this._bargeInAnalyser.getByteTimeDomainData(data);
      if (computeRms(data) >= this._vadThreshold) {
        window.speechSynthesis.cancel();
        this._speaking = false;
        this._setState('listening');
        // Hand off to the same segment-start path the gated loop uses so
        // recognition actually starts for the speech that triggered the
        // barge-in, instead of waiting for a whole new rising edge.
        this._speechActive = true;
        this._startRecognitionSegment();
        return;
      }
      this._bargeRafId = requestAnimationFrame(tick);
    };
    this._bargeRafId = requestAnimationFrame(tick);
  }

  _cancelBargeLoop() {
    if (this._bargeRafId) {
      cancelAnimationFrame(this._bargeRafId);
      this._bargeRafId = null;
    }
  }

  // ---- state/error plumbing ----

  _setState(state) {
    this._state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, speaker: this._lastSpeaker } }));
  }

  _emitError(reason) {
    this.dispatchEvent(new CustomEvent('error', { detail: { reason } }));
  }

  _unsupported(reason) {
    this._emitError(reason);
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
    return { supported: false, reason };
  }
}

// Phase 4 stub (docs/voice.md): no enrolled voiceprint exists yet, so
// nothing is claimed. Pass a real `identifySpeaker` (Phase 5,
// public/services/voiceprint.js) to replace this.
function defaultIdentifySpeaker() {
  return { cluster: 0, identity: 'unknown', confidence: 0 };
}

function speakerState(speaker) {
  if (!speaker) return null;
  if (speaker.identity === 'owner') return 'owner-speaking';
  if (speaker.identity && speaker.identity !== 'unknown') return 'other-speaker';
  // Phase-4 stub (identity always 'unknown'): no opinion, stay generic.
  return null;
}

// RMS over samples normalized from byte time-domain data (0..255, centered
// on 128) to -1..1, per the standard AnalyserNode.getByteTimeDomainData()
// contract.
function computeRms(byteTimeDomainData) {
  let sumSquares = 0;
  for (let i = 0; i < byteTimeDomainData.length; i++) {
    const normalized = (byteTimeDomainData[i] - 128) / 128;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / byteTimeDomainData.length);
}

function describeGetUserMediaError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Microphone permission was denied.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone device was found.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'The microphone is already in use by another application.';
  if (name === 'SecurityError') return 'Microphone access requires a secure (HTTPS) context.';
  return `Could not access the microphone (${name || err?.message || 'unknown error'}).`;
}
