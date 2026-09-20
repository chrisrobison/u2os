// Phase 5 (docs/devices.md): presentation.present/presentation.notify are
// ordinary Tools, so this proves they go through the REAL policy/approval
// pipeline (PolicyEngine -> agent_actions audit -> ApprovalManager ->
// ActionExecutor -> the device resolver/invoker), not a bespoke path --
// closing the "capability invocation isn't policy-gated" gap earlier
// phases documented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { Agent } from '../server/agent/agent.js';
import { createCapabilityRegistry } from '../server/devices/register-capabilities.js';
import { DeviceRegistry } from '../server/devices/device-registry.js';
import { MockDeviceAdapter } from '../server/devices/adapters/mock-device-adapter.js';
import { PresentationPresentTool, PresentationNotifyTool } from '../server/tools/presentation-tools.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-presentation-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}
function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

async function buildAgent() {
  const db = getDb();
  const eventBus = new EventBus(db);
  const capabilityRegistry = createCapabilityRegistry();
  const deviceRegistry = new DeviceRegistry({ db, eventBus, capabilityRegistry });
  await deviceRegistry.registerAdapter(new MockDeviceAdapter());
  const toolRegistry = createToolRegistry({ deviceRegistry, capabilityRegistry });
  const agent = new Agent({ policyEngine: new PolicyEngine(), toolRegistry, eventBus, ownerEntityId: 'owner_test' });
  return { db, eventBus, deviceRegistry, capabilityRegistry, toolRegistry, agent };
}

// --- registration -----------------------------------------------------------

test('presentation.present and presentation.notify are registered with sane schemas', async () => {
  const dir = tempHome();
  try {
    const { toolRegistry } = await buildAgent();
    const present = toolRegistry.get('presentation.present');
    assert.equal(present.domain, 'presentation');
    assert.equal(present.category, 'consequential');
    assert.deepEqual(present.schema.required, ['audience', 'content']);

    const notify = toolRegistry.get('presentation.notify');
    assert.equal(notify.domain, 'presentation');
    assert.deepEqual(notify.schema.required, ['audience', 'title']);
  } finally {
    cleanup(dir);
  }
});

test('createToolRegistry() with no device deps still builds a complete registry (existing call sites unaffected)', () => {
  const registry = createToolRegistry();
  assert.equal(registry.has('presentation.present'), true);
  assert.equal(registry.has('presentation.notify'), true);
});

test('a presentation tool executed without a configured device subsystem throws clearly rather than crashing', async () => {
  const tool = new PresentationPresentTool();
  await assert.rejects(() => tool.execute({ audience: 'chris', content: {} }, {}), /device subsystem is not configured/);
  const notifyTool = new PresentationNotifyTool();
  await assert.rejects(() => notifyTool.execute({ audience: 'chris', title: 'x' }, {}), /device subsystem is not configured/);
});

// --- full policy/approval pipeline ------------------------------------------

test('presentation.present with no configured "presentation" policy fails safe to confirm (pending), same as any new domain', async () => {
  const dir = tempHome();
  try {
    const { agent } = await buildAgent();
    const result = await agent.evaluateAndMaybeExecute({
      tool: 'presentation.present',
      arguments: { audience: 'chris', privacy: 'private', content: { title: 'Today', body: '3 meetings' } },
      requestedBy: 'agent',
    });
    assert.equal(result.status, 'pending');
  } finally {
    cleanup(dir);
  }
});

test('approving a pending presentation.present actually invokes the resolved device (Chris\'s phone), never the shared display', async () => {
  const dir = tempHome();
  try {
    const { agent, db } = await buildAgent();
    const proposed = await agent.evaluateAndMaybeExecute({
      tool: 'presentation.present',
      arguments: { audience: 'chris', privacy: 'private', content: { title: 'Today', body: '3 meetings' } },
      requestedBy: 'agent',
    });
    assert.equal(proposed.status, 'pending');

    const approved = await agent.approvalManager.approve(proposed.id, 'owner');
    assert.equal(approved.status, 'executed');
    assert.equal(approved.result.device, 'mock.phone.chris');
    assert.equal(approved.result.delivered, true);

    const row = db.prepare('SELECT status, result FROM agent_actions WHERE id = ?').get(proposed.id);
    assert.equal(row.status, 'executed');
    assert.equal(JSON.parse(row.result).device, 'mock.phone.chris');
  } finally {
    cleanup(dir);
  }
});

test('approving presentation.notify for the household kitchen display is rejected by the device resolver, never silently delivered elsewhere', async () => {
  const dir = tempHome();
  try {
    const { agent, deviceRegistry } = await buildAgent();
    // A private notification explicitly aimed at the shared living-room
    // display's owner ("household") but scoped to audience "chris" can
    // never land there -- and there is no OTHER chris-owned device with
    // ui.notify once we exclude the phone, so resolution has nothing
    // eligible and the approved action must fail, not silently redirect.
    deviceRegistry.setTrust('mock.phone.chris', 'revoked');

    const proposed = await agent.evaluateAndMaybeExecute({
      tool: 'presentation.notify',
      arguments: { audience: 'chris', privacy: 'private', title: 'Bank balance updated' },
      requestedBy: 'agent',
    });
    assert.equal(proposed.status, 'pending');

    const approved = await agent.approvalManager.approve(proposed.id, 'owner');
    assert.equal(approved.status, 'failed');
    assert.match(approved.error, /No eligible device/);
  } finally {
    cleanup(dir);
  }
});

test('a public presentation.notify with no restrictive audience/privacy can be configured to execute autonomously via policy', async () => {
  const dir = tempHome();
  try {
    const { db, eventBus, toolRegistry, deviceRegistry, capabilityRegistry } = await buildAgent();
    // Explicitly opt this domain into autonomous execution -- proves
    // policies.yaml genuinely governs presentation.*, exactly like any
    // other tool, rather than something hardcoded to always require
    // approval.
    const policyEngine = new PolicyEngine({ policies: { presentation: { notify: 'autonomous' } } });
    const agent = new Agent({ policyEngine, toolRegistry, eventBus, ownerEntityId: 'owner_test' });

    const result = await agent.evaluateAndMaybeExecute({
      tool: 'presentation.notify',
      arguments: { title: 'Welcome to U2OS' },
      requestedBy: 'agent',
    });
    assert.equal(result.status, 'executed');
    assert.equal(typeof result.result.device, 'string');
  } finally {
    cleanup(dir);
  }
});
