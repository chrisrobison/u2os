import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../server/events/event-bus.js';
import { getDb } from '../server/db/connection.js';
import { listEventsAfterId } from '../server/events/log.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('EventBus.publish persists to the events table and delivers to exact/prefix/wildcard subscribers', () => {
  const dir = tempHome();
  try {
    const db = getDb();
    const bus = new EventBus(db);

    const exact = [];
    const prefix = [];
    const wildcard = [];
    bus.subscribe('calendar.event_changed', (e) => exact.push(e));
    bus.subscribe('calendar.*', (e) => prefix.push(e));
    bus.subscribe('*', (e) => wildcard.push(e));

    const published = bus.publish({
      type: 'calendar.event_changed',
      source: 'test',
      data: { foo: 'bar' },
    });

    assert.equal(exact.length, 1);
    assert.equal(prefix.length, 1);
    assert.equal(wildcard.length, 1);
    assert.equal(exact[0].id, published.id);

    // A non-matching prefix subscriber must not receive it.
    const other = [];
    bus.subscribe('email.*', (e) => other.push(e));
    bus.publish({ type: 'calendar.event_added', source: 'test' });
    assert.equal(other.length, 0);

    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(published.id);
    assert.ok(row);
    assert.equal(row.type, 'calendar.event_changed');
    assert.deepEqual(JSON.parse(row.data), { foo: 'bar' });
  } finally {
    cleanup(dir);
  }
});

test('listEventsAfterId replays only events after an SSE cursor in causal order', () => {
  const dir = tempHome();
  try {
    const db = getDb(); const bus = new EventBus(db);
    const first = bus.publish({ type: 'test.first' });
    const second = bus.publish({ type: 'test.second' });
    const third = bus.publish({ type: 'test.third' });
    assert.deepEqual(listEventsAfterId(db, first.id).map((e) => e.id), [second.id, third.id]);
  } finally { cleanup(dir); }
});

test('EventBus.subscribe returns an unsubscribe function that stops delivery', () => {
  const dir = tempHome();
  try {
    const db = getDb();
    const bus = new EventBus(db);
    const received = [];
    const unsubscribe = bus.subscribe('*', (e) => received.push(e));
    unsubscribe();
    bus.publish({ type: 'foo.bar', source: 'test' });
    assert.equal(received.length, 0);
  } finally {
    cleanup(dir);
  }
});
