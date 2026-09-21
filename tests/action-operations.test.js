import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests, getDb } from '../server/db/connection.js';
import { recordAudit } from '../server/policy/policy-engine.js';
import { enqueueAction } from '../server/agent/action-queue-store.js';
import { buildOperationsResponse } from '../server/api/routes/actions.js';

function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-operations-'));
  process.env.U2OS_HOME = dir;
  try { return fn(); } finally {
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('operations response groups pending and durable work without exposing arguments, actors, keys, or provider errors', () => withHome(() => {
  const pending = recordAudit({
    requestedBy: 'owner', tool: 'email.send', arguments: { body: 'private body' },
    status: 'pending', correlationId: 'corr_pending', requiresApproval: true,
  });
  const failed = recordAudit({
    requestedBy: 'owner', tool: 'calendar.create', arguments: { title: 'private title' },
    status: 'failed', correlationId: 'corr_failed', requiresApproval: false,
  });
  const queued = enqueueAction({
    actionId: failed.id, correlationId: failed.correlation_id, tool: failed.tool,
    arguments: failed.arguments, actor: { type: 'user', id: 'secret-owner-id' },
  });
  getDb().prepare(`
    UPDATE action_queue SET status = 'failed', error_class = 'authentication_required',
      last_error = 'token super-secret-token was rejected' WHERE id = ?
  `).run(queued.id);

  const response = buildOperationsResponse();
  assert.equal(response.counts.waiting_approval, 1);
  assert.equal(response.counts.failed, 1);
  assert.equal(response.items.find((item) => item.actionId === pending.id).status, 'waiting_approval');
  assert.equal(response.items.find((item) => item.actionId === failed.id).errorClass, 'authentication_required');
  const serialized = JSON.stringify(response);
  for (const secret of ['private body', 'private title', 'secret-owner-id', 'super-secret-token', 'idempotency']) {
    assert.equal(serialized.includes(secret), false, `must not expose ${secret}`);
  }
}));
