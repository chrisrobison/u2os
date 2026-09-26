import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server/index.js';
import { closeAllForTests } from '../server/db/connection.js';
import { Router } from '../server/api/router.js';
import { requestLogMetadata } from '../server/logging/request-metadata.js';

async function capture(format, run) {
  const previous = { log: console.log, warn: console.warn, error: console.error, format: process.env.LOG_FORMAT };
  const lines = [];
  for (const key of ['log', 'warn', 'error']) console[key] = (line) => lines.push(String(line));
  process.env.LOG_FORMAT = format;
  try { await run(lines); }
  finally {
    for (const key of ['log', 'warn', 'error']) console[key] = previous[key];
    if (previous.format === undefined) delete process.env.LOG_FORMAT; else process.env.LOG_FORMAT = previous.format;
  }
}
function request(base, target, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}`, { path: target, method }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
}

for (const format of ['pretty', 'json']) test(`HTTP ${format} logs retain useful routes/status/latency without query, fragment or dynamic-path secrets`, () => capture(format, async (lines) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-http-logs-'));
  const savedHome = process.env.U2OS_HOME; process.env.U2OS_HOME = dir;
  let handle;
  try {
    handle = await startServer({ port: 0 }); const base = `http://127.0.0.1:${handle.port}`;
    await request(base, '/api/connectors/google/oauth/callback?code=fixture-oauth-secret&state=fixture-state-secret');
    assert.equal(await request(base, '/api/health?query=fixture-query-secret#fixture-fragment-secret'), 200);
    await request(base, '/api/actions/fixture-id-secret%3Ftoken%3Dfixture-encoded-secret/explain?token=fixture-token-secret');
    await request(base, '/api/fixture-unmatched-secret?code=fixture-unmatched-query');
    await request(base, '/api/%ZZfixture-malformed-secret?state=fixture-malformed-query');
    assert.equal(await request(base, '/index.html?session=fixture-static-secret'), 200);
    await request(base, '/fixture-static-path-secret?key=fixture-static-query');
    await handle.shutdown();
    const transcript = lines.join('\n');
    assert.doesNotMatch(transcript, /fixture-(?:oauth|state|query|fragment|id|encoded|token|unmatched|malformed|static)/);
    if (format === 'json') {
      const access = lines.map((line) => JSON.parse(line)).filter((entry) => entry.component === 'http');
      assert.equal(access.length, 7);
      assert.ok(access.some((entry) => entry.path === '/api/connectors/google/oauth/callback'));
      assert.ok(access.some((entry) => entry.path === '/api/actions/:id/explain'));
      assert.ok(access.some((entry) => entry.path === '[unmatched]'));
      assert.ok(access.some((entry) => entry.path === '[static]'));
      assert.ok(access.every((entry) => entry.method === 'GET' && Number.isInteger(entry.status) && entry.duration_ms >= 0));
    } else {
      assert.match(transcript, /GET \/api\/health method=GET path=\/api\/health status=200 duration_ms=/);
      assert.match(transcript, /GET \/api\/actions\/:id\/explain/);
    }
  } finally {
    if (handle) await handle.shutdown(); closeAllForTests();
    if (savedHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('request handler error logs omit raw exception text and decoded private path parameters', () => capture('json', async (lines) => {
  const router = new Router();
  router.get('/api/probe/:id', () => { const error = new Error('fixture-password-secret?code=fixture-provider-secret'); error.status = 503; throw error; });
  const server = http.createServer((req, res) => router.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal(await request(`http://127.0.0.1:${server.address().port}`, '/api/probe/fixture-private-param?token=fixture-private-query'), 503);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.path, '/api/probe/:id'); assert.equal(entry.status, 503); assert.equal(entry.method, 'GET');
    assert.doesNotMatch(lines.join('\n'), /fixture-|error=/); assert.equal(entry.error, undefined);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}));

test('log metadata has no raw URL fallback and masks unknown HTTP method tokens', () => {
  assert.deepEqual(requestLogMetadata({ method: 'fixture-private-method', url: 'https://fixture-user:fixture-password@host/private?token=fixture-secret' }),
    { method: '[unknown-method]', path: '[unmatched]' });
});
