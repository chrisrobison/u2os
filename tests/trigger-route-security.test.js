import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/authed-server.js';
import { closeAllForTests } from '../server/db/connection.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';

// Regression tests for a ReDoS found in security review: POST /api/triggers
// used to accept an event_rule trigger's `when.matches` with no validation
// at all, and matchesWhen() ran that pattern synchronously against every
// event published on the bus. A catastrophic-backtracking pattern (e.g.
// "^(a+)+$") plus one ordinary event was enough to hang the entire
// single-threaded server for everyone. Fixed via server/triggers/regex-safety.js,
// enforced at the HTTP boundary in server/api/routes/triggers.js.

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-trigger-route-sec-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

async function cleanup(dir, handle) {
  syncScheduler.stopAll();
  await triggerEngine.stopAll();
  if (handle?.server) {
    await new Promise((resolve) => handle.server.close(resolve));
  }
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

async function postJson(port, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('POST /api/triggers rejects a catastrophic-backtracking when.matches pattern instead of storing it', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { status, body } = await postJson(port, '/api/triggers', {
      name: 'Malicious ReDoS trigger',
      kind: 'event_rule',
      config: { eventType: 'demo.ping', when: { path: 'data.value', matches: '^(a+)+$' }, action: { kind: 'notify' } },
    });

    assert.equal(status, 400);
    assert.match(body.error, /nested quantifier|catastrophic/i);
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/triggers rejects a slow-but-not-obviously-nested pattern via the timed probe, not just the fast heuristic', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { status, body } = await postJson(port, '/api/triggers', {
      name: 'Ambiguous alternation ReDoS trigger',
      kind: 'event_rule',
      config: { eventType: 'demo.ping', when: { path: 'data.value', matches: '(a|a)+$' }, action: { kind: 'notify' } },
    });

    assert.equal(status, 400);
    assert.match(body.error, /took too long|catastrophic/i);
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/triggers still accepts a legitimate simple when.matches pattern (no regression for real usage)', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { status, body } = await postJson(port, '/api/triggers', {
      name: 'Notify on recruiter emails (user copy)',
      kind: 'event_rule',
      config: { eventType: 'email.received', when: { path: 'data.from', matches: 'recruiter|talent' }, action: { kind: 'notify' } },
    });

    assert.equal(status, 201);
    assert.equal(body.config.when.matches, 'recruiter|talent');
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/triggers rejects an oversized when.matches pattern', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { status, body } = await postJson(port, '/api/triggers', {
      name: 'Oversized pattern',
      kind: 'event_rule',
      config: { eventType: 'demo.ping', when: { path: 'data.value', matches: 'a'.repeat(500) }, action: { kind: 'notify' } },
    });

    assert.equal(status, 400);
    assert.match(body.error, /characters or fewer/);
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/triggers rejects a schedule with everyMinutes below the floor (spam-loop prevention)', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { status, body } = await postJson(port, '/api/triggers', {
      name: 'Tight-loop schedule',
      kind: 'schedule',
      config: { everyMinutes: 0.0001, action: { kind: 'notify' } },
    });

    assert.equal(status, 400);
    assert.match(body.error, /everyMinutes/);
  } finally {
    await cleanup(dir, handle);
  }
});

test('PATCH /api/triggers/:id also runs the same validation when config is updated', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { body: created } = await postJson(port, '/api/triggers', {
      name: 'Initially safe trigger',
      kind: 'event_rule',
      config: { eventType: 'demo.ping', when: { path: 'data.value', matches: 'safe' }, action: { kind: 'notify' } },
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/triggers/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { eventType: 'demo.ping', when: { path: 'data.value', matches: '^(a+)+$' }, action: { kind: 'notify' } },
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.match(body.error, /nested quantifier|catastrophic/i);
  } finally {
    await cleanup(dir, handle);
  }
});
