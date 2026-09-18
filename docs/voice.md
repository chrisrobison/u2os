# U2OS Voice (Phase 4 + groundwork for Phase 5)

Voice devices belong to the **client** (a browser tab today, a future satellite device per PROMPT.md §24), never to the U2OS server — the server may be headless with no microphone or speaker at all (PROMPT.md §20). So the entire capture → VAD → STT → TTS → barge-in pipeline runs in the browser; the server's only job is to receive recognized text plus speaker metadata, and to independently enforce authorization on it — never to trust the client's UI state as the security boundary (PROMPT.md §17: "never rely on prompts alone as a security boundary" generalizes to "never rely on the client's own JS as the security boundary" here too).

## Honesty about scope

Full acoustic diarization (clustering unknown speakers by voice) and neural speaker-embedding verification are real ML problems that need a trained model U2OS doesn't ship in Phase 4. Per PROMPT.md's own instruction ("If a component is mocked, label it clearly"):

- **Phase 4** ships a real, working voice pipeline — real mic capture, real energy-based VAD, real browser speech recognition and synthesis, real barge-in — but diarization/speaker-identity is a **labeled stub**: every utterance is reported as `{ cluster: 0, identity: 'unknown', confidence: 0 }` because there is no enrolled voiceprint yet to compare against. `authorized` is therefore always `false` for anything beyond read-only conversation until Phase 5 ships.
- **Phase 5** replaces the stub identity function with a real (if simple) implementation: a lightweight DSP feature-vector comparison (spectral-centroid/band-energy fingerprint + cosine similarity — **not** a trained neural speaker-embedding model). This is a genuine, functioning similarity measure, just a much cruder one than commercial speaker verification. Documented as such everywhere it appears, including in the UI.

This progression (real pipeline + honest stub in Phase 4, real-but-simple identity function in Phase 5) is preferred over either skipping voice entirely or faking a confidence score that doesn't measure anything.

## Pipeline (client-side, `public/services/audio.js` + `public/components/u2-voice.js`)

```
getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true } })
        |
   AnalyserNode-based energy VAD  (RMS over a short window vs. a threshold + hangover time)
        |
   speech segment detected -> (Phase 5: compare against enrolled voiceprint -> speaker metadata)
        |
   Web Speech API (SpeechRecognition) starts ONLY for the duration of the detected segment
        |
   recognized text + speaker metadata -> POST /api/agent/voice-message
        |
   agent responds -> browser SpeechSynthesis (TTS) speaks it
        |
   VAD keeps running during TTS playback -> speech onset during playback = barge-in:
   speechSynthesis.cancel() immediately, stop speaking, resume listening
```

Why VAD runs continuously but `SpeechRecognition` only runs per-segment: `SpeechRecognition` in Chrome does its own network-backed recognition and is heavier/noisier to run continuously; gating it behind our own cheap local VAD avoids constantly streaming audio for recognition when nobody's talking, and — combined with the browser's own `echoCancellation` removing U2OS's own TTS output from the captured mic signal — means the assistant's own voice is very unlikely to trigger a false speech-detected segment in the first place. This is the practical, standards-based version of PROMPT.md §8's "keep the outgoing audio reference available to the echo cancellation layer": that's exactly what the browser's native AEC does when TTS plays through the same output device while `echoCancellation:true` mic capture is active — no custom echo-cancellation code needed or reasonable to build from scratch here.

## Speaker metadata contract (matches PROMPT.md §6 exactly)

```json
{
  "text": "Move my meeting to Friday",
  "speaker": { "cluster": 0, "identity": "owner", "confidence": 0.96 },
  "authorized": true
}
```

Phase 4 stub: `speaker: { cluster: 0, identity: "unknown", confidence: 0 }`, `authorized: false` always (safe default — no enrolled voice yet means no voice-granted authority yet, full stop).

## Server-side enforcement (`server/voice/authorize.js`, new)

The server is the only place authorization actually gets decided — a compromised or simply buggy browser tab reporting `authorized: true` must not be trusted blindly, because a real attacker model here is "someone else's browser tab talking to my server," not just "the owner's own honest client." So:

`POST /api/agent/voice-message` body: `{ text, speaker: { cluster, identity, confidence } }` →

1. Looks up the confidence thresholds from `~/.u2os/config/config.json` (new `voiceThresholds` block, defaults per PROMPT.md §7: `conversation: 0.70, standard: 0.85, private: 0.95`).
2. Runs `agent.handleMessage({ text, actorId: speaker.identity, voice: { confidence: speaker.confidence } })`. Every proposed action the agent produces already goes through `policy-engine.evaluate()` (unchanged, Phase 1's invariant) — Phase 4/5 add exactly one more gate on top, not a replacement: **any consequential action whose policy resolution would otherwise be `autonomous` (no approval needed) is forced to `confirm` if the requesting speaker's `confidence` is below the `standard` threshold**, and refused outright (treated the same as a policy `never`/blocked) if the request touches a domain marked "private" in config and confidence is below the `private` threshold. Financial/legal/destructive actions additionally always require the existing non-voice confirmation mechanism (the web approval UI) regardless of voice confidence, per PROMPT.md §7's explicit "financial / legal / destructive actions require another confirmation mechanism" — voice can never be sufficient authorization for those, only a contributing signal.
3. This means voice authorization is **additive** to the existing policy engine, implemented as an extra parameter the agent's `evaluateAndMaybeExecute` already threads through `context` (the same mechanism `_buildEvalContext` uses for calendar category) — not a parallel bypassable path.

## Voice status states (PROMPT.md §11, wired into `<u2-agent-status>`, currently a Phase-1 placeholder)

`idle | listening | owner speaking | other speaker | thinking | acting | speaking | waiting for approval` — driven directly by the pipeline's real state transitions (VAD speech-start/end, recognition start/end, TTS start/end/barge-in, and the existing request-lifecycle states already used for the text chat panel). The UI must always show *who the system believes is speaking* per PROMPT.md §11's explicit example (`● Chris — 96%` / `○ Unknown speaker`) — this is a direct, honest rendering of the speaker metadata above, including in the Phase-4-stub state (it will show "○ Unknown speaker — 0%" until Phase 5 enrollment exists, which is the correct and honest thing for it to show).

## Explicitly out of scope for Phase 4/5

- Wake-word detection (PROMPT.md's Voice Satellite concept, §24 — needs always-on local audio processing a browser tab can't do; a future native companion process per §22).
- Multi-speaker clustering beyond "the one person talking into this browser tab" (real diarization needs a model this phase doesn't ship).
- Cloud STT/TTS (Deepgram, ElevenLabs) — ship as `skills/deepgram/manifest.json` and `skills/elevenlabs/manifest.json` **stubs** only (same pattern as Phase 3's CalDAV/IMAP stubs), selectable in config but falling back to the browser-native providers if not actually wired up, which they aren't yet.
- Access control on `/api/voice/enrollment` (GET/POST/DELETE) — it has none right now, same as every other route in this app (see `docs/architecture.md`'s no-auth technical debt note). Concretely: anyone who can reach the server on the network can overwrite the owner's stored voiceprint reference right now. This isn't a new hole specific to voice — `POST /api/actions/:id/approve` and connector credential submission are equally open today — but it's worth naming here explicitly since enrollment is the one thing Phase 5's identity comparison trusts as ground truth. Fix once, with a real auth layer covering all of these routes together, not per-route patches.
