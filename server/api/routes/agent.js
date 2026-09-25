import { sendJson } from '../router.js';
import { verifyVoiceObservation } from '../../voice/enrollment-store.js';
import { getRun, getRunResult, listRuns } from '../../agent/run-store.js';
import { createConversation, getConversationTurns, listConversations } from '../../agent/conversation-store.js';

// Agent conversation entry point. Approve/reject live in routes/actions.js
// (kept in one place rather than duplicated here) since they operate on
// agent_actions rows regardless of whether they originated from chat or a
// direct API call.
export function registerAgentRoutes(router, { agent }) {
  router.get('/api/agent/conversations', async (req, res) => {
    sendJson(res, 200, { conversations: listConversations(req.owner.id, req.query.limit) });
  });

  router.post('/api/agent/conversations', async (req, res) => {
    sendJson(res, 201, { conversationId: createConversation(req.owner.id) });
  });

  router.get('/api/agent/conversations/:id/turns', async (req, res) => {
    sendJson(res, 200, { conversationId: req.params.id, turns: getConversationTurns(req.params.id, req.owner.id, req.query.limit) });
  });

  router.get('/api/agent/runs', async (req, res) => {
    sendJson(res, 200, { runs: listRuns({ limit: req.query.limit }) });
  });

  router.get('/api/agent/runs/:id', async (req, res) => {
    const run = getRun(req.params.id);
    if (!run) return sendJson(res, 404, { error: 'Run not found' });
    sendJson(res, 200, run);
  });

  router.get('/api/agent/runs/:id/result', async (req, res) => {
    const run = getRunResult(req.params.id);
    if (!run) return sendJson(res, 404, { error: 'Run not found' });
    sendJson(res, 200, run);
  });

  router.post('/api/agent/runs/:id/resume', async (req, res) => {
    const run = getRun(req.params.id);
    if (!run) return sendJson(res, 404, { error: 'Run not found' });
    await agent.resumeRunDependents(req.params.id);
    const updated = await agent.resumeRunPlanning(req.params.id);
    sendJson(res, 200, updated);
  });

  router.post('/api/agent/runs/:id/cancel', async (req, res) => {
    const run = await agent.cancelRun(req.params.id, req.owner.id);
    if (!run) return sendJson(res, 404, { error: 'Run not found' });
    sendJson(res, 200, run);
  });

  router.post('/api/agent/message', async (req, res) => {
    const text = req.body?.text;
    if (!text || typeof text !== 'string' || text.length > 20_000) return sendJson(res, 400, { error: 'text must be 1–20000 characters' });
    if (req.body?.conversationId !== undefined && typeof req.body.conversationId !== 'string') return sendJson(res, 400, { error: 'conversationId must be a string' });
    const actorId = req.owner.id;
    const conversationId = req.body?.conversationId || createConversation(actorId);
    const result = await agent.handleMessage({ text, actorId, conversationId });
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
    if (!text || typeof text !== 'string' || text.length > 20_000) return sendJson(res, 400, { error: 'text must be 1–20000 characters' });
    if (req.body?.conversationId !== undefined && typeof req.body.conversationId !== 'string') return sendJson(res, 400, { error: 'conversationId must be a string' });
    const observation = req.body?.voiceObservation;
    const actorId = req.owner.id;
    // Never trust a browser-supplied identity/confidence. The browser sends
    // only its observed DSP vector; comparison with the enrolled vector is
    // performed here, inside the authenticated server boundary.
    const verified = verifyVoiceObservation(observation?.vector);
    const voice = { confidence: verified.confidence };
    const conversationId = req.body?.conversationId || createConversation(actorId);
    const result = await agent.handleMessage({ text, actorId, voice, conversationId });
    sendJson(res, 200, result);
  });
}
