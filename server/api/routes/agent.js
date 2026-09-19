import { sendJson } from '../router.js';

// Agent conversation entry point. Approve/reject live in routes/actions.js
// (kept in one place rather than duplicated here) since they operate on
// agent_actions rows regardless of whether they originated from chat or a
// direct API call.
export function registerAgentRoutes(router, { agent }) {
  router.post('/api/agent/message', async (req, res) => {
    const text = req.body?.text;
    if (!text || typeof text !== 'string') {
      return sendJson(res, 400, { error: 'text is required' });
    }
    const actorId = req.owner.id;
    const result = await agent.handleMessage({ text, actorId });
    sendJson(res, 200, result);
  });

  // Phase 4/5 voice entry point (docs/voice.md). Body: { text, speaker:
  // { cluster, identity, confidence } }.
  //
  // SECURITY: hitting this route at all is the caller claiming "this came
  // from voice" -- so it must ALWAYS construct a `voice` context and thread
  // it into the policy gate, never fall through to the plain
  // POST /api/agent/message pass-through path just because `speaker` was
  // left out of the body. The additive-only "voice undefined -> unchanged
  // behavior" invariant in server/voice/authorize.js exists so that the
  // *other* route (which never constructs a `voice` value at all) is
  // provably unaffected by this feature -- it was never meant to let this
  // route opt itself out of its own gate by omitting a field. A previous
  // version of this handler did exactly that (verified exploitable: POSTing
  // {text} with no `speaker` executed an otherwise-autonomous action
  // immediately, identical to claiming confidence 1.0) -- fixed by always
  // building `voice`, defaulting confidence to 0 (fail safe, same posture
  // as a malformed-but-present speaker object) whenever `speaker` or
  // `speaker.confidence` is missing/non-numeric.
  router.post('/api/agent/voice-message', async (req, res) => {
    const text = req.body?.text;
    if (!text || typeof text !== 'string') {
      return sendJson(res, 400, { error: 'text is required' });
    }
    const speaker = req.body?.speaker;
    const actorId = req.owner.id;
    const confidence = typeof speaker?.confidence === 'number' && Number.isFinite(speaker.confidence) ? speaker.confidence : 0;
    const voice = { confidence };
    const result = await agent.handleMessage({ text, actorId, voice });
    sendJson(res, 200, result);
  });
}
