// GET /api/export -- a portable, human-inspectable JSON export of exactly
// the domains PROMPT.md §30 names. Per docs/deployment.md §7.
//
// Deliberately EXCLUDES ~/.u2os/credentials/* (and hence anything derived
// from it, like decrypted OAuth tokens) -- this endpoint is for taking your
// data to a different system or just inspecting it, not for moving live
// credentials around. `npm run backup`/`server/backup/snapshot.js` is the
// mechanism for full-fidelity migration (including credentials) to new
// hardware.
//
// No auth gate exists anywhere else in this single-owner Phase 1-3 app, so
// none is added here either -- but this becomes a real access-control
// concern once Phase 5+ multi-device/multi-user auth exists (see
// docs/deployment.md §7).
import { sendJson } from '../router.js';
import { getDb } from '../../db/connection.js';

// Exactly the domains named in PROMPT.md §30 -- intentionally NOT including
// conversation_messages or anything under credentials/.
const EXPORT_TABLES = [
  'events',
  'entities',
  'facts',
  'relationships',
  'tasks',
  'calendar_events',
  'emails',
  'agent_actions',
];

export function registerExportRoutes(router) {
  router.get('/api/export', async (_req, res) => {
    const db = getDb();
    const domains = {};
    for (const table of EXPORT_TABLES) {
      domains[table] = db.prepare(`SELECT * FROM ${table}`).all();
    }
    sendJson(res, 200, {
      exportedAt: new Date().toISOString(),
      source: 'u2os',
      ...domains,
    });
  });
}
