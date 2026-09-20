// End-to-end proof of Phase 4's required demonstration (docs/devices.md):
// "sending a presentation from U2OS to a connected browser." Stands in for
// a real browser tab with a raw `ws` client sending the exact hello shape
// public/services/device-client.js sends (same owner sentinel, same
// capabilities) -- this repo has no browser/DOM test runner yet (PLAN.md
// Milestone 3's Playwright coverage is separate, future work), so this is
// the closest thing to an integration test for the client protocol without
// one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';
import { closeAllForTests } from '../server/db/connection.js';

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-browser-device-e2e-'));
  process.env.U2OS_HOME = dir;
  return dir;
}
async function stop(handle, dir) {
  if (handle) await new Promise((r) => handle.server.close(r));
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}
function base(handle) {
  return `http://127.0.0.1:${handle.port}`;
}
function once(ws, event) {
  return new Promise((resolve, reject) => {
    ws.once(event, resolve);
    ws.once('error', reject);
  });
}
function nextMessage(ws) {
  return new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
}

test('U2OS can present/notify/prompt a connected browser device through the capability resolver', async () => {
  const dir = home();
  let handle;
  let ws;
  try {
    handle = await startServer({ port: 0 });
    const origin = base(handle);

    const setup = await fetch(`${origin}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'correct horse battery staple' }),
    });
    const setupBody = await setup.json();
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const authOpts = { headers: { cookie, origin, 'content-type': 'application/json', 'x-u2os-csrf': setupBody.csrfToken } };

    const tokenRes = await fetch(`${origin}/api/devices/connect-token`, { headers: { cookie } });
    const { token } = await tokenRes.json();

    // Exactly the hello shape services/device-client.js sends.
    ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/devices?token=${token}`);
    await once(ws, 'open');
    ws.send(
      JSON.stringify({
        type: 'hello',
        device: {
          id: 'browser.e2e-test',
          name: 'Chrome (MacIntel)',
          type: 'browser',
          owner: 'owner',
          capabilities: ['ui.render', 'ui.notify', 'ui.prompt'],
        },
      })
    );
    const ack = await nextMessage(ws);
    assert.equal(ack.type, 'hello_ack');

    // A freshly-connected device starts 'untrusted' (docs/devices.md) --
    // eligible only for 'public'-tier content until paired. Phase 7 will
    // add a real pairing route; stand in for it here exactly the way that
    // route will: an explicit trust promotion, not anything automatic.
    handle.deviceRegistry.setTrust('browser.e2e-test', 'trusted');

    // The browser device auto-responds to whatever command it receives,
    // the same way public/services/device-client.js's _onMessage() does.
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'command') return;
      if (msg.capability === 'ui.notify') {
        ws.send(JSON.stringify({ type: 'command_result', requestId: msg.requestId, result: { delivered: true } }));
      } else if (msg.capability === 'ui.render') {
        ws.send(JSON.stringify({ type: 'command_result', requestId: msg.requestId, result: { delivered: true } }));
      } else if (msg.capability === 'ui.prompt') {
        ws.send(JSON.stringify({ type: 'command_result', requestId: msg.requestId, result: { answer: 'yes' } }));
      }
    });

    // Resolve explanation first: with audience "owner", only the browser
    // device is eligible -- the seeded mock devices are owned by
    // "chris"/"household", never "owner".
    const explainRes = await fetch(`${origin}/api/capabilities/ui.notify/resolve?audience=owner&privacy=personal`, { headers: { cookie } });
    const explanation = await explainRes.json();
    assert.equal(explanation.chosen, 'browser.e2e-test');

    // Actual invocation: U2OS "presents" a notification to this browser.
    const notifyRes = await fetch(`${origin}/api/capabilities/ui.notify/invoke`, {
      ...authOpts,
      method: 'POST',
      body: JSON.stringify({ args: { title: 'Meeting starting soon' }, audience: 'owner', privacy: 'personal' }),
    });
    assert.equal(notifyRes.status, 200);
    const notifyBody = await notifyRes.json();
    assert.equal(notifyBody.device, 'browser.e2e-test');
    assert.equal(notifyBody.result.delivered, true);

    // A full ui.render "presentation".
    const renderRes = await fetch(`${origin}/api/capabilities/ui.render/invoke`, {
      ...authOpts,
      method: 'POST',
      body: JSON.stringify({ args: { content: { type: 'card', title: 'Today', body: '3 meetings' } }, audience: 'owner', privacy: 'personal' }),
    });
    assert.equal(renderRes.status, 200);
    assert.equal((await renderRes.json()).device, 'browser.e2e-test');

    // ui.prompt round-trips a real answer back through the HTTP response.
    const promptRes = await fetch(`${origin}/api/capabilities/ui.prompt/invoke`, {
      ...authOpts,
      method: 'POST',
      body: JSON.stringify({ args: { question: 'Approve this?' }, audience: 'owner', privacy: 'personal' }),
    });
    assert.equal(promptRes.status, 200);
    assert.equal((await promptRes.json()).result.answer, 'yes');
  } finally {
    ws?.terminate();
    await stop(handle, dir);
  }
});

test('a freshly-connected (still untrusted) browser device can receive default (public) content without any pairing step', async () => {
  const dir = home();
  let handle;
  let ws;
  try {
    handle = await startServer({ port: 0 });
    const origin = base(handle);
    const setup = await fetch(`${origin}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'correct horse battery staple' }),
    });
    const setupBody = await setup.json();
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const tokenRes = await fetch(`${origin}/api/devices/connect-token`, { headers: { cookie } });
    const { token } = await tokenRes.json();

    ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/devices?token=${token}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', device: { id: 'browser.fresh', name: 'Fresh Browser', type: 'browser', owner: 'owner', capabilities: ['ui.notify'] } }));
    await nextMessage(ws);
    assert.equal(handle.deviceRegistry.getDevice('browser.fresh').trust, 'untrusted');

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'command') ws.send(JSON.stringify({ type: 'command_result', requestId: msg.requestId, result: { delivered: true } }));
    });

    // No `privacy` given -- defaults to 'public', which even an untrusted
    // device is eligible for. `audience: 'owner'` narrows away the seeded
    // mock devices (owned by "chris"/"household") so this specifically
    // proves the fresh browser device itself was chosen.
    const res = await fetch(`${origin}/api/capabilities/ui.notify/invoke`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json', 'x-u2os-csrf': setupBody.csrfToken },
      body: JSON.stringify({ args: { title: 'Welcome to U2OS' }, audience: 'owner' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).device, 'browser.fresh');
  } finally {
    ws?.terminate();
    await stop(handle, dir);
  }
});

test('a private/sensitive request never routes to a shared mock device, only to the audience-owned browser', async () => {
  const dir = home();
  let handle;
  let ws;
  try {
    handle = await startServer({ port: 0 });
    const origin = base(handle);
    const setup = await fetch(`${origin}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'correct horse battery staple' }),
    });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const tokenRes = await fetch(`${origin}/api/devices/connect-token`, { headers: { cookie } });
    const { token } = await tokenRes.json();

    ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/devices?token=${token}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', device: { id: 'browser.e2e-2', name: 'Browser', type: 'browser', owner: 'owner', capabilities: ['ui.render'] } }));
    await nextMessage(ws);
    handle.deviceRegistry.setTrust('browser.e2e-2', 'trusted');

    const explainRes = await fetch(`${origin}/api/capabilities/ui.render/resolve?audience=owner&privacy=sensitive`, { headers: { cookie } });
    const explanation = await explainRes.json();
    // mock.display.livingroom (owner=household) must be present but ineligible.
    const livingRoom = explanation.candidates.find((c) => c.device === 'mock.display.livingroom');
    assert.equal(livingRoom.eligible, false);
    assert.equal(explanation.chosen, 'browser.e2e-2');
  } finally {
    ws?.terminate();
    await stop(handle, dir);
  }
});
