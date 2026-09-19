import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { checkEventLogIntegrity, pruneEvents } from '../server/events/maintenance.js';

test('event maintenance checks integrity and requires explicit apply before pruning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-maintenance-')); process.env.U2OS_HOME = dir;
  try {
    const db = getDb(); const bus = new EventBus(db);
    bus.publish({ type: 'test.old', timestamp: '2000-01-01T00:00:00.000Z' });
    assert.equal(checkEventLogIntegrity(db).ok, true);
    assert.equal(pruneEvents({ retentionDays: 365, db }).eligible, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, 1);
    assert.equal(pruneEvents({ retentionDays: 365, apply: true, db }).removed, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='system.event_retention_applied'").get().n, 1);
  } finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
});
