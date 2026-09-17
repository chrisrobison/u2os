// Real Google Calendar provider (REST v3, native fetch, no SDK dependency).
// Same function shape as mock-calendar-provider.js so calendar-tools.js
// never needs to know which one is active. Per docs/connectors.md's
// "Google Calendar provider" section.
import { getDb } from '../db/connection.js';
import { hasTokens, getValidAccessToken } from './oauth/google-oauth.js';

export const id = 'google-calendar';

const API_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const ID_PREFIX = 'gcal_';

/** Cheap synchronous local-state check -- no network call. */
export function isConnected(dataDir) {
  return hasTokens('calendar', dataDir);
}

function toLocalId(googleEventId) {
  return `${ID_PREFIX}${googleEventId}`;
}

function toGoogleId(localId) {
  return localId.startsWith(ID_PREFIX) ? localId.slice(ID_PREFIX.length) : localId;
}

// Maps Google's event shape to our calendar_events row shape, per
// docs/connectors.md's mapping table. `category` has no trustworthy Google
// equivalent, so it defaults to 'personal' -- a documented simplification.
function mapGoogleEvent(gEvent) {
  const attendees = (gEvent.attendees || []).map((a) => a.displayName || a.email).filter(Boolean);
  return {
    id: toLocalId(gEvent.id),
    title: gEvent.summary || '(untitled)',
    start_at: gEvent.start?.dateTime || gEvent.start?.date,
    end_at: gEvent.end?.dateTime || gEvent.end?.date,
    location: gEvent.location || null,
    attendees,
    category: 'personal',
    status: gEvent.status === 'cancelled' ? 'cancelled' : 'confirmed',
    source: id,
  };
}

function upsertRow(row) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(row.id);
  if (existing) {
    db.prepare(
      `UPDATE calendar_events SET title=?, start_at=?, end_at=?, location=?, attendees=?, category=?, status=?, source=?, updated_at=? WHERE id=?`
    ).run(row.title, row.start_at, row.end_at, row.location, JSON.stringify(row.attendees), row.category, row.status, row.source, now, row.id);
  } else {
    db.prepare(
      `INSERT INTO calendar_events (id, title, start_at, end_at, location, attendees, category, status, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(row.id, row.title, row.start_at, row.end_at, row.location, JSON.stringify(row.attendees), row.category, row.status, row.source, now, now);
  }
  return getRowById(row.id);
}

function getRowById(localId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(localId);
  return row ? { ...row, attendees: JSON.parse(row.attendees || '[]') } : null;
}

async function authHeaders(fetchImpl, dataDir) {
  const token = await getValidAccessToken('calendar', { dataDir, fetchImpl });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export async function listEvents({ from, to } = {}, { fetchImpl = globalThis.fetch, dataDir } = {}) {
  const headers = await authHeaders(fetchImpl, dataDir);
  const url = new URL(API_BASE);
  if (from) url.searchParams.set('timeMin', from);
  if (to) url.searchParams.set('timeMax', to);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  const res = await fetchImpl(url.toString(), { headers });
  if (!res.ok) throw new Error(`google-calendar: list failed (status ${res.status})`);
  const json = await res.json();
  return (json.items || []).map((gEvent) => upsertRow(mapGoogleEvent(gEvent)));
}

export async function getEvent(localId, { fetchImpl = globalThis.fetch, dataDir } = {}) {
  const headers = await authHeaders(fetchImpl, dataDir);
  const res = await fetchImpl(`${API_BASE}/${encodeURIComponent(toGoogleId(localId))}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`google-calendar: getEvent failed (status ${res.status})`);
  const gEvent = await res.json();
  return upsertRow(mapGoogleEvent(gEvent));
}

export async function createEvent(
  { title, startAt, endAt, attendees = [], location = null },
  { fetchImpl = globalThis.fetch, dataDir } = {}
) {
  const headers = await authHeaders(fetchImpl, dataDir);
  const body = {
    summary: title,
    start: { dateTime: startAt },
    end: { dateTime: endAt },
    location: location || undefined,
    attendees: attendees.map((a) => (typeof a === 'string' && a.includes('@') ? { email: a } : { displayName: a })),
  };
  const res = await fetchImpl(API_BASE, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`google-calendar: createEvent failed (status ${res.status})`);
  const gEvent = await res.json();
  return upsertRow(mapGoogleEvent(gEvent));
}

export async function rescheduleEvent(localId, { newStartAt, newEndAt }, { fetchImpl = globalThis.fetch, dataDir } = {}) {
  const before = getRowById(localId);
  if (!before) return null;
  const headers = await authHeaders(fetchImpl, dataDir);
  const res = await fetchImpl(`${API_BASE}/${encodeURIComponent(toGoogleId(localId))}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ start: { dateTime: newStartAt }, end: { dateTime: newEndAt } }),
  });
  if (!res.ok) throw new Error(`google-calendar: rescheduleEvent failed (status ${res.status})`);
  const gEvent = await res.json();
  const after = upsertRow(mapGoogleEvent(gEvent));
  return { before, after };
}

/**
 * Polled by sync-scheduler.js. Fetches recent upstream events, upserts them
 * into calendar_events, and publishes the same event types the mock path
 * would (calendar.event_added for new local ids, calendar.event_changed for
 * ones that already existed with a different start/end), source:'google-calendar'.
 */
export async function syncChanges({ db, eventBus, correlationId, fetchImpl = globalThis.fetch, dataDir } = {}) {
  const headers = await authHeaders(fetchImpl, dataDir);
  const url = new URL(API_BASE);
  url.searchParams.set('timeMin', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  const res = await fetchImpl(url.toString(), { headers });
  if (!res.ok) throw new Error(`google-calendar: syncChanges failed (status ${res.status})`);
  const json = await res.json();
  const items = json.items || [];
  let count = 0;
  for (const gEvent of items) {
    const mapped = mapGoogleEvent(gEvent);
    const existing = (db || getDb()).prepare('SELECT * FROM calendar_events WHERE id = ?').get(mapped.id);
    const after = upsertRow(mapped);
    if (!existing) {
      eventBus?.publish({
        type: 'calendar.event_added',
        source: id,
        subject: { type: 'calendar_event', id: after.id },
        data: { after },
        metadata: { correlationId, provenance: 'sync:google-calendar' },
      });
    } else if (existing.start_at !== after.start_at || existing.end_at !== after.end_at) {
      eventBus?.publish({
        type: 'calendar.event_changed',
        source: id,
        subject: { type: 'calendar_event', id: after.id },
        data: { before: { ...existing, attendees: JSON.parse(existing.attendees || '[]') }, after },
        metadata: { correlationId, provenance: 'sync:google-calendar' },
      });
    }
    count += 1;
  }
  return { synced: count };
}
