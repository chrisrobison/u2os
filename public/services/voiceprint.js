// Phase 5 speaker verification (docs/voice.md, PROMPT.md #7).
//
// HONESTY NOTE, said plainly because docs/voice.md requires it be said
// plainly everywhere this shows up: this is a lightweight spectral/DSP
// fingerprint -- a band-energy distribution across a small number of
// frequency bins (via AnalyserNode.getByteFrequencyData), averaged over a
// few seconds of enrollment audio and compared later by cosine similarity.
// It is explicitly NOT a trained neural speaker-embedding model. It is a
// real, functioning similarity measure -- just a much cruder one than
// commercial speaker verification. Phase 4's stub
// (`{cluster:0, identity:'unknown', confidence:0}`) is exactly what this
// module falls back to whenever there is no enrolled voiceprint to compare
// against -- it never fabricates a confidence score that doesn't measure
// anything.
//
// Persistence: the averaged voiceprint vector is stored server-side (POST
// /api/voice/enrollment), not in localStorage -- U2OS already has a
// "settings/config persist on the server, in ~/.u2os/config" convention
// (server/policy/policies-loader.js, server/integrations/connectors-config.js),
// and an enrolled voice should survive a refresh or a different browser
// tab like any other piece of this app's configuration, not disappear
// with per-browser storage.

import { getVoiceEnrollment, saveVoiceEnrollment } from './api.js';

// Number of contiguous frequency-bin buckets the raw FFT output is
// collapsed into. Small on purpose -- this is a coarse fingerprint, not a
// learned embedding; a handful of broad bands is exactly the right amount
// of resolution for a real-but-simple DSP comparison.
const BAND_COUNT = 16;
const ENROLLMENT_SAMPLE_COUNT = 4;
const SAMPLE_DURATION_MS = 1200;
const FRAME_INTERVAL_MS = 50;

// Cosine similarity floor to call a live utterance "owner" rather than
// "unknown". Deliberately conservative -- per PROMPT.md #7, "voice
// identity is one signal, not absolute authentication", and the server
// side (server/voice/authorize.js) applies its own, separate confidence
// thresholds on top of whatever this reports regardless.
const OWNER_SIMILARITY_FLOOR = 0.75;

export class VoiceprintService {
  constructor() {
    this._voiceprint = null; // number[] | null
  }

  static get supported() {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof window !== 'undefined' &&
      !!(window.AudioContext || window.webkitAudioContext)
    );
  }

  /** Fetches enrollment status from the server and caches the vector (if any) for identifySpeaker(). */
  async loadStatus() {
    try {
      const data = await getVoiceEnrollment();
      this._voiceprint = Array.isArray(data.vector) && data.vector.length ? data.vector : null;
      return { enrolled: !!data.enrolled, enrolledAt: data.enrolledAt || null };
    } catch (err) {
      this._voiceprint = null;
      return { enrolled: false, enrolledAt: null, error: err.message };
    }
  }

  hasVoiceprint() {
    return !!this._voiceprint;
  }

  /**
   * Captures ENROLLMENT_SAMPLE_COUNT short samples from the microphone,
   * extracts a band-energy feature vector per sample, averages them into
   * one voiceprint, and persists it server-side. Never throws for the "no
   * mic" case -- returns `{ supported: false, reason }` instead.
   * `onSampleStart(index)` / `onSampleEnd(index)` let a UI show progress.
   */
  async enroll({ onSampleStart, onSampleEnd } = {}) {
    if (!VoiceprintService.supported) {
      return {
        supported: false,
        reason: 'This browser has no getUserMedia/AudioContext -- voice enrollment is unsupported here.',
      };
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      return { supported: false, reason: describeGetUserMediaError(err) };
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContextCtor();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    try {
      const sampleVectors = [];
      for (let i = 0; i < ENROLLMENT_SAMPLE_COUNT; i++) {
        onSampleStart?.(i);
        const frames = await captureFrames(analyser, SAMPLE_DURATION_MS, FRAME_INTERVAL_MS);
        sampleVectors.push(averageBandVector(frames));
        onSampleEnd?.(i);
      }

      const voiceprint = normalize(averageVectors(sampleVectors));
      await saveVoiceEnrollment(voiceprint);
      this._voiceprint = voiceprint;
      return { supported: true };
    } finally {
      for (const track of stream.getTracks()) track.stop();
      try {
        audioCtx.close();
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Phase 5 replacement for Phase 4's stub identity function -- pass this
   * (bound) as `identifySpeaker` to `new AudioPipeline({ identifySpeaker })`
   * (see public/services/audio.js). `frames` is the array of
   * Uint8Array frequency snapshots the pipeline captured during the
   * recognized segment. Falls back to the exact Phase 4 stub shape when
   * there's no enrolled voiceprint, or no captured audio, to compare --
   * never claims an identity with nothing to compare against.
   */
  identifySpeaker(frames) {
    if (!this._voiceprint || !frames || !frames.length) {
      return { cluster: 0, identity: 'unknown', confidence: 0 };
    }
    const vector = normalize(averageBandVector(frames));
    const confidence = Math.max(0, Math.min(1, cosineSimilarity(vector, this._voiceprint)));
    return {
      cluster: 0,
      identity: confidence >= OWNER_SIMILARITY_FLOOR ? 'owner' : 'unknown',
      confidence,
    };
  }
}

function captureFrames(analyser, durationMs, intervalMs) {
  return new Promise((resolve) => {
    const frames = [];
    const buffer = new Uint8Array(analyser.frequencyBinCount);
    const startedAt = performance.now();
    const tick = () => {
      analyser.getByteFrequencyData(buffer);
      frames.push(buffer.slice());
      if (performance.now() - startedAt >= durationMs) {
        resolve(frames);
      } else {
        setTimeout(tick, intervalMs);
      }
    };
    tick();
  });
}

// Collapses one FFT frequency snapshot into BAND_COUNT contiguous-bin
// averages, then averages those band vectors across every frame in the
// sample/segment -- the coarse "band-energy distribution" feature.
function averageBandVector(frames) {
  const bands = new Array(BAND_COUNT).fill(0);
  for (const frame of frames) {
    const perFrameBands = toBands(frame);
    for (let i = 0; i < BAND_COUNT; i++) bands[i] += perFrameBands[i];
  }
  const count = frames.length || 1;
  for (let i = 0; i < BAND_COUNT; i++) bands[i] /= count;
  return bands;
}

function toBands(frame) {
  const bands = new Array(BAND_COUNT).fill(0);
  const binsPerBand = Math.max(1, Math.floor(frame.length / BAND_COUNT));
  for (let b = 0; b < BAND_COUNT; b++) {
    const start = b * binsPerBand;
    const end = b === BAND_COUNT - 1 ? frame.length : start + binsPerBand;
    let sum = 0;
    for (let i = start; i < end; i++) sum += frame[i];
    bands[b] = sum / Math.max(1, end - start);
  }
  return bands;
}

function averageVectors(vectors) {
  const out = new Array(BAND_COUNT).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < BAND_COUNT; i++) out[i] += v[i];
  }
  const count = vectors.length || 1;
  for (let i = 0; i < BAND_COUNT; i++) out[i] /= count;
  return out;
}

// L2-normalizes so overall loudness/mic distance doesn't dominate the
// later cosine-similarity comparison -- only the *shape* of the spectrum
// should matter.
function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector.slice();
  return vector.map((v) => v / norm);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

function describeGetUserMediaError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Microphone permission was denied.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone device was found.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'The microphone is already in use by another application.';
  if (name === 'SecurityError') return 'Microphone access requires a secure (HTTPS) context.';
  return `Could not access the microphone (${name || err?.message || 'unknown error'}).`;
}
