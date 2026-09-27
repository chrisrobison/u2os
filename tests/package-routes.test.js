import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { startServer } from './helpers/authed-server.js';
import { closeAllForTests } from '../server/db/connection.js';
import { main as cli } from '../server/packages/cli.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-package-routes-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

async function cleanup(dir, handle) {
  if (handle?.server) await new Promise((resolve) => handle.server.close(resolve));
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeExamplePackage(root) {
  const files = {
    'u2os.yaml': {
      apiVersion: 'u2os/v1', kind: 'Package',
      metadata: { id: 'com.example.pinger', name: 'Pinger', version: '0.1.0', description: 'Pings.' },
      exports: { capabilities: [{ id: 'pinger.ping', file: 'capabilities/ping.yaml' }], automations: [{ id: 'pinger', file: 'automations/pinger.yaml' }] },
      permissions: { network: true },
      policies: { pingFreely: { approval: 'automatic', description: 'Ping without asking' } },
      secrets: ['pinger.token'],
      events: { emits: ['ping.done'] },
    },
    'capabilities/ping.yaml': { id: 'pinger.ping', effect: 'read', permissions: ['network'], implementation: { type: 'static', output: { pong: '{{ input.n }}' } } },
    'automations/pinger.yaml': { id: 'pinger', triggers: [{ type: 'manual' }, { type: 'schedule', every: '1h' }], steps: [
      { id: 'ping', use: 'capability:pinger.ping', policy: 'pingFreely', with: { n: 1 } },
      { id: 'done', use: 'emit', with: { type: 'ping.done', data: { pong: '{{ steps.ping.output.pong }}' } } },
    ] },
  };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), yaml.dump(content));
  }
  return root;
}

async function call(port, method, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('owner API: review, install, grant, enable, run, inspect, audit and uninstall', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.port;
    const source = writeExamplePackage(path.join(dir, 'src'));

    const review = await call(port, 'POST', '/api/packages/review', { source });
    assert.equal(review.status, 200);
    assert.equal(review.body.review.installable, true);
    assert.deepEqual(review.body.review.permissions.map((p) => p.permission), ['network']);

    const installed = await call(port, 'POST', '/api/packages/install', { source });
    assert.equal(installed.status, 201);
    assert.equal(installed.body.package.permissions[0].granted, false);

    const blocked = await call(port, 'POST', '/api/automations/pinger/enable');
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /network/);

    assert.equal((await call(port, 'POST', '/api/packages/com.example.pinger/grants', { grant: 'all' })).status, 200);
    const enabled = await call(port, 'POST', '/api/automations/pinger/enable');
    assert.equal(enabled.status, 200);
    assert.ok(enabled.body.automation.nextRunAt);

    const started = await call(port, 'POST', '/api/automations/pinger/run', {});
    assert.equal(started.status, 202);
    let detail;
    for (let i = 0; i < 50; i++) {
      detail = (await call(port, 'GET', `/api/automations/runs/${started.body.run.id}`)).body.run;
      if (detail.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(detail.status, 'completed');
    assert.deepEqual(detail.steps.map((s) => [s.stepId, s.status]), [['ping', 'completed'], ['done', 'completed']]);

    const automations = await call(port, 'GET', '/api/automations');
    assert.equal(automations.body.automations[0].lastRun.status, 'completed');
    assert.deepEqual(automations.body.automations[0].policies.map((p) => p.approval), ['automatic']);

    const audit = await call(port, 'GET', '/api/packages/audit?package=com.example.pinger');
    assert.equal(audit.body.entries[0].action, 'pinger.ping');
    assert.equal(audit.body.entries[0].context.policy.name, 'pingFreely');

    const capabilities = await call(port, 'GET', '/api/packages/capabilities');
    assert.ok(capabilities.body.capabilities.some((c) => c.id === 'pinger.ping' && c.status === 'available'));
    assert.ok(capabilities.body.capabilities.some((c) => c.id === 'email.send' && c.source === 'core'));
    // The device capability vocabulary keeps its own route.
    assert.equal((await call(port, 'GET', '/api/capabilities')).status, 200);

    const secret = await call(port, 'PUT', '/api/packages/com.example.pinger/secrets/pinger.token', { value: 'do-not-echo' });
    assert.deepEqual(secret.body, { secrets: [{ name: 'pinger.token', configured: true }] });
    const pkg = await call(port, 'GET', '/api/packages/com.example.pinger');
    assert.ok(!JSON.stringify(pkg.body).includes('do-not-echo'));

    assert.equal((await call(port, 'GET', '/api/automations/nope')).status, 404);
    assert.equal((await call(port, 'GET', '/api/packages/com.example.nope')).status, 404);

    const removed = await call(port, 'DELETE', '/api/packages/com.example.pinger');
    assert.equal(removed.status, 200);
    assert.deepEqual((await call(port, 'GET', '/api/automations')).body.automations, []);
  } finally { await cleanup(dir, handle); }
});

test('package routes require an owner session and CSRF', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    // Raw requests: the test fetch wrapper would add the owner's session.
    const http = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: handle.port, path: '/api/packages', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 401);
    const install = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: handle.port, path: '/api/packages/install', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(JSON.stringify({ source: '/tmp' }));
    });
    assert.equal(install, 401);
  } finally { await cleanup(dir, handle); }
});

test('the offline CLI installs, grants, enables, runs and lists', async () => {
  const dir = tempHome();
  try {
    const source = writeExamplePackage(path.join(dir, 'src'));
    const lines = [];
    const out = { log: (line) => lines.push(String(line)) };
    assert.equal(await cli(['package', 'install', source, '--grant-all'], out), 0);
    assert.ok(lines.some((line) => line.includes('Pinger wants permission to:')));
    assert.ok(lines.some((line) => line.includes('✓ access the network')));
    assert.ok(lines.some((line) => line.includes('✓ Ping without asking')));
    assert.equal(await cli(['automation', 'enable', 'pinger'], out), 0);
    lines.length = 0;
    assert.equal(await cli(['automation', 'run', 'pinger'], out), 0);
    assert.equal(JSON.parse(lines.join('\n')).status, 'completed');
    lines.length = 0;
    await cli(['automation', 'list'], out);
    assert.match(lines[0], /^pinger\s+enabled\s+idle/);
    lines.length = 0;
    await cli(['capability', 'list'], out);
    assert.ok(lines.some((line) => line.startsWith('pinger.ping')));
    lines.length = 0;
    await cli(['audit', '--package', 'com.example.pinger'], out);
    assert.ok(lines.some((line) => line.includes('pinger.ping') && line.includes('pingFreely:automatic')));
    lines.length = 0;
    assert.equal(await cli(['package', 'config', 'com.example.pinger', '--policy', 'pingFreely=never'], out), 0);
    assert.equal(JSON.parse(lines.join('\n')).policies[0].approval, 'never');
    lines.length = 0;
    await cli(['audit', '--automation', 'nothing-here'], out);
    assert.deepEqual(lines, ['(none)']);
    await assert.rejects(() => cli(['package', 'frobnicate'], out), /Usage/);
    assert.equal(await cli(['package', 'uninstall', 'com.example.pinger'], out), 0);
  } finally {
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
