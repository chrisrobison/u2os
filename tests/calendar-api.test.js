import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { startServer } from './helpers/authed-server.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-calendar-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  return {
    get: (url) => fetch(`${base}${url}`),
    post: (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

test('events can be requested for a date range, overlapping events included', async (t) => {
  const { get } = await fixture(t);
  const all = (await (await get('/api/calendar/events?range=all')).json()).events;
  assert.ok(all.length > 0, 'the demo calendar has events');
  const first = all[0];
  const from = new Date(Date.parse(first.start_at) - 60_000).toISOString();
  const to = new Date(Date.parse(first.start_at) + 60_000).toISOString();
  const res = await get(`/api/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).events.some((e) => e.id === first.id));

  const far = await get('/api/calendar/events?from=2001-01-01T00:00:00Z&to=2001-02-01T00:00:00Z');
  assert.deepEqual((await far.json()).events, []);
});

test('a bad or oversized range is rejected', async (t) => {
  const { get } = await fixture(t);
  for (const query of ['from=nope&to=2026-01-01', 'from=2026-02-01&to=2026-01-01', 'from=2026-01-01', 'from=2026-01-01&to=2027-01-01']) {
    assert.equal((await get(`/api/calendar/events?${query}`)).status, 400, query);
  }
});

test('creating an event is validated and goes through the gated pipeline', async (t) => {
  const { post } = await fixture(t);
  assert.equal((await post('/api/calendar/events', { startAt: '2030-05-17T10:00:00Z', endAt: '2030-05-17T11:00:00Z' })).status, 400, 'title required');
  assert.equal((await post('/api/calendar/events', { title: 'x', startAt: 'soon', endAt: '2030-05-17T11:00:00Z' })).status, 400, 'bad start');
  assert.equal((await post('/api/calendar/events', { title: 'x', startAt: '2030-05-17T11:00:00Z', endAt: '2030-05-17T10:00:00Z' })).status, 400, 'end before start');

  const res = await post('/api/calendar/events', { title: ' Dentist ', startAt: '2030-05-17T10:00:00Z', endAt: '2030-05-17T11:00:00Z', location: 'Main St' });
  const outcome = await res.json();
  // Policy decides: executed (201) or awaiting approval (202). Never silently dropped.
  assert.ok([201, 202].includes(res.status), `unexpected ${res.status}`);
  assert.ok(['executed', 'pending'].includes(outcome.status), outcome.status);
  assert.equal(outcome.tool, 'calendar.create');
  if (outcome.status === 'executed') assert.equal(outcome.result.title, 'Dentist');
});
