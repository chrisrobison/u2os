import { sendJson } from '../router.js';
import * as calendarProvider from '../../integrations/mock-calendar-provider.js';
import { getHealth } from '../../integrations/provider-registry.js';
import { newId } from '../../db/ids.js';

// Month views ask for about six weeks. Anything much larger is a mistake or
// an attempt to pull the whole cache in one response.
const MAX_RANGE_MS = 100 * 24 * 60 * 60 * 1000;

function parseInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function registerCalendarRoutes(router, { agent } = {}) {
  router.get('/api/calendar/events', async (req, res) => {
    const range = req.query.range || 'upcoming';
    const events = calendarProvider.listEvents({});
    const now = new Date();

    let filtered = events;
    if (req.query.from !== undefined || req.query.to !== undefined) {
      // Events overlapping [from, to), for the month, week and day views.
      const from = parseInstant(req.query.from);
      const to = parseInstant(req.query.to);
      if (from === null || to === null || to <= from) return sendJson(res, 400, { error: 'from and to must be ISO dates with to after from' });
      if (to - from > MAX_RANGE_MS) return sendJson(res, 400, { error: 'The requested range is too large' });
      filtered = events.filter((e) => {
        const start = Date.parse(e.start_at);
        if (Number.isNaN(start)) return false;
        const end = e.end_at && !Number.isNaN(Date.parse(e.end_at)) ? Date.parse(e.end_at) : start;
        return start < to && (end > from || (end === start && start >= from));
      });
    } else if (range === 'today') {
      const today = now.toDateString();
      filtered = events.filter((e) => new Date(e.start_at).toDateString() === today);
    } else if (range === 'upcoming') {
      filtered = events.filter((e) => new Date(e.start_at).getTime() >= now.getTime() - 60 * 60 * 1000);
    }

    const { active, connected, lastSyncAt, mode } = getHealth().find((entry) => entry.domain === 'calendar');
    sendJson(res, 200, { events: filtered, cache: { source: mode === 'demo' ? 'demo-fixture' : 'local-cache', active, connected, lastSyncAt } });
  });

  router.post('/api/calendar/events', async (req, res) => {
    const { title, startAt, endAt, location } = req.body || {};
    if (typeof title !== 'string' || !title.trim()) return sendJson(res, 400, { error: 'title is required' });
    const start = parseInstant(startAt);
    const end = parseInstant(endAt);
    if (start === null || end === null) return sendJson(res, 400, { error: 'startAt and endAt must be ISO dates' });
    if (end <= start) return sendJson(res, 400, { error: 'endAt must be after startAt' });

    // Creating an event is consequential, so it goes through the same
    // policy-gated pipeline as an agent-proposed one (approval and audit).
    const args = { title: title.trim(), startAt, endAt };
    if (typeof location === 'string' && location.trim()) args.location = location.trim();
    const outcome = await agent.evaluateAndMaybeExecute({
      tool: 'calendar.create',
      arguments: args,
      requestedBy: 'user',
      requestText: 'POST /api/calendar/events',
      reasoningSummary: 'Direct event creation via API.',
      correlationId: newId('corr'),
      actor: { type: 'user', id: 'user' },
    });
    sendJson(res, outcome.status === 'failed' ? 500 : outcome.status === 'executed' ? 201 : 202, outcome);
  });
}
