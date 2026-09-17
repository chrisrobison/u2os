// A tiny, deliberately provider-agnostic read against the shared
// `calendar_events` table (mock and real providers both upsert into this
// same table, keyed by provider-prefixed id -- see docs/connectors.md's "ID
// convention"). Used ONLY for policy-context resolution (server/agent/agent.js's
// _buildEvalContext), which must stay synchronous and must never depend on a
// live network call to whichever calendar provider happens to be active --
// policy evaluation has to work even if Google's API is unreachable, and it
// must not incur an extra real API round trip on every propose+approve just
// to read a category that's already sitting in the local mirror. This is
// intentionally NOT routed through provider-registry.getProvider('calendar')
// for that reason; it reads the local cache directly, by design, not by
// accident (previously this same read happened to go through
// mock-calendar-provider.js's getEvent(), which worked only because that
// function happens to be a thin wrapper over this exact table -- this file
// makes that contract explicit instead of implicit).
import { getDb } from '../db/connection.js';

export function getCachedCalendarEvent(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  return row ? { ...row, attendees: JSON.parse(row.attendees || '[]') } : null;
}
