import { sendJson } from '../router.js';
import { listTriggers, listTriggerHistory, getTrigger, createTrigger, updateTrigger, deleteTrigger } from '../../triggers/trigger-engine.js';
import { assertSafeRegexPattern } from '../../triggers/regex-safety.js';

const VALID_KINDS = ['timer', 'schedule', 'event_rule', 'condition_watch'];
// A schedule trigger firing every tick would spam a notification/task
// forever with no way for the owner to notice why until it's already
// happened many times -- floor it at a sane minimum. This is enforced only
// here (the HTTP boundary for untrusted/external input), not inside
// trigger-engine.js's createTrigger() itself, so internal/test callers can
// still construct faster schedules directly when they need to (see
// tests/trigger-engine.test.js's sub-minute stress test).
const MIN_SCHEDULE_MINUTES = 1;

// SECURITY: validates the parts of an incoming trigger config that could
// hurt something if left unchecked, per the security review that caught the
// ReDoS below. Throws a clear Error (surfaced as a 400) rather than letting
// a dangerous config reach trigger-engine.js's storage layer.
async function validateIncomingConfig(kind, config) {
  if (kind === 'event_rule' && typeof config?.when?.matches === 'string') {
    // ReDoS: matchesWhen() in trigger-engine.js runs this pattern
    // synchronously against every event published on the bus, inline inside
    // the event dispatch loop -- a catastrophic-backtracking pattern here
    // can hang the entire single-threaded server for every user on the very
    // next matching event. Verified exploitable during security review.
    await assertSafeRegexPattern(config.when.matches);
  }
  if (kind === 'schedule' && config?.everyMinutes !== undefined) {
    const minutes = Number(config.everyMinutes);
    if (!Number.isFinite(minutes) || minutes < MIN_SCHEDULE_MINUTES) {
      throw new Error(`config.everyMinutes must be a number >= ${MIN_SCHEDULE_MINUTES}`);
    }
  }
}

export function registerTriggerRoutes(router) {
  router.get('/api/triggers', async (req, res) => {
    const enabled = req.query.enabled !== undefined ? req.query.enabled === 'true' : undefined;
    sendJson(res, 200, { triggers: listTriggers({ kind: req.query.kind, enabled }) });
  });

  router.get('/api/triggers/:id', async (req, res) => {
    const trigger = getTrigger(req.params.id);
    if (!trigger) return sendJson(res, 404, { error: 'Not Found' });
    sendJson(res, 200, trigger);
  });

  router.get('/api/triggers/:id/history', async (req, res) => {
    const trigger = getTrigger(req.params.id);
    if (!trigger) return sendJson(res, 404, { error: 'Not Found' });
    sendJson(res, 200, { triggerId: trigger.id, history: listTriggerHistory(trigger.id, { limit: req.query.limit }) });
  });

  // User-created triggers, per docs/automation.md -- structured data
  // (kind/config), matched and executed by the fixed, audited engine code.
  // Never eval'd/interpreted as code.
  router.post('/api/triggers', async (req, res) => {
    const { name, kind, config, enabled } = req.body || {};
    if (!name || !kind) return sendJson(res, 400, { error: 'name and kind are required' });
    if (!VALID_KINDS.includes(kind)) {
      return sendJson(res, 400, { error: `kind must be one of ${VALID_KINDS.join(', ')}` });
    }
    try {
      await validateIncomingConfig(kind, config || {});
      const trigger = createTrigger({ name, kind, config: config || {}, enabled: enabled !== false, source: 'user' });
      sendJson(res, 201, trigger);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  // Enable/disable (or rename/reconfigure) an existing trigger.
  router.patch('/api/triggers/:id', async (req, res) => {
    const existing = getTrigger(req.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Not Found' });
    const { enabled, name, config } = req.body || {};
    try {
      if (config !== undefined) {
        await validateIncomingConfig(existing.kind, config);
      }
      const updated = updateTrigger(req.params.id, { enabled, name, config });
      sendJson(res, 200, updated);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  router.delete('/api/triggers/:id', async (req, res) => {
    const existing = getTrigger(req.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Not Found' });
    deleteTrigger(req.params.id);
    sendJson(res, 200, { deleted: true, id: req.params.id });
  });
}
