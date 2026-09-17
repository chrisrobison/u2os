import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../server/tools/registry.js';
import { CalendarListTool, CalendarRescheduleTool } from '../server/tools/calendar-tools.js';
import { EventBus } from '../server/events/event-bus.js';
import { getDb } from '../server/db/connection.js';
import * as calendarProvider from '../server/integrations/mock-calendar-provider.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('register/get/list', () => {
  const registry = new ToolRegistry();
  const tool = new CalendarListTool();
  registry.register(tool);

  assert.equal(registry.get('calendar.list'), tool);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.has('calendar.list'), true);
  assert.throws(() => registry.get('nope.nope'));
  assert.throws(() => registry.register(tool));
});

test('calendar.reschedule tool actually updates calendar_events and emits calendar.event_changed', async () => {
  const dir = tempHome();
  try {
    const db = getDb();
    const bus = new EventBus(db);
    const registry = new ToolRegistry();
    registry.register(new CalendarRescheduleTool());

    const event = calendarProvider.createEvent({
      title: 'Test meeting',
      startAt: '2026-09-17T14:00:00.000Z',
      endAt: '2026-09-17T14:30:00.000Z',
      attendees: [{ name: 'Sarah' }],
      category: 'personal',
    });

    const received = [];
    bus.subscribe('calendar.event_changed', (e) => received.push(e));

    const tool = registry.get('calendar.reschedule');
    const result = await tool.execute(
      { eventId: event.id, newStartAt: '2026-09-18T14:00:00.000Z', newEndAt: '2026-09-18T14:30:00.000Z' },
      { eventBus: bus, correlationId: 'corr_test', actor: { type: 'user', id: 'user' } }
    );

    assert.equal(result.start_at, '2026-09-18T14:00:00.000Z');

    const row = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
    assert.equal(row.start_at, '2026-09-18T14:00:00.000Z');

    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'calendar.event_changed');
    assert.equal(received[0].correlationId, 'corr_test');
    assert.equal(received[0].data.after.start_at, '2026-09-18T14:00:00.000Z');
  } finally {
    cleanup(dir);
  }
});
