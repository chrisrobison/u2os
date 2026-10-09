import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Router } from '../server/api/router.js';
import { createExtensionChannel } from '../server/extension/channel.js';
import { ExtensionPairings, CODE_TTL_MS } from '../server/extension/pairings.js';
import { registerExtensionRoutes } from '../server/api/routes/extension.js';
import { isLoopbackAddress, isLoopbackHost } from '../server/security/loopback.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { planHash } from '../mcp/jobs/hunt/applications/form/plan.js';
import { reviewJob } from '../mcp/jobs/hunt/review/agent.js';
import { loadCandidate } from '../mcp/jobs/hunt/candidate/load.js';
import { loadAutopilotConfig } from '../mcp/jobs/hunt/autopilot/config.js';
import { createLlm } from '../mcp/jobs/hunt/llm/structured.js';
import { closeAllForTests } from '../server/db/connection.js';
import { startServer } from './helpers/authed-server.js';
import { RESUME, fakeLlm } from './fixtures/job-hunt-candidate.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const POSTING = 'Tahoma AI | Founding Engineer | Remote (US)\nWe build deterministic orchestration around agents. Apply through our form.';
const EXT = `chrome-extension://${'a'.repeat(32)}`;
const OTHER_EXT = `chrome-extension://${'b'.repeat(32)}`;
const approve = () => ({ decision: 'approve', confidence: 0.9, concerns: [], notes: 'ok' });

async function world(t, { mode = 'live' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-channel-'));
  const vault = path.join(dir, 'vault');
  const dataDir = path.join(dir, 'home');
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify(RESUME));
  fs.writeFileSync(path.join(vault, 'job-hunt', 'facts.md'), '## D. Harris Tours\n- Grew the fleet from 2 to 14 vehicles.\n');
  fs.writeFileSync(path.join(vault, 'job-hunt', 'autopilot.yaml'), `enabled: true\nmode: ${mode}\n`);
  const pdf = path.join(dir, 'resume.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 resume bytes');
  const store = openStore(huntDbPath(vault));
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:1#0', company: 'Tahoma AI', role: 'Founding Engineer', locations: ['Remote (US)'], remote: true, technologies: [], description: POSTING, rawText: POSTING, applicationUrls: [], contactEmails: [], author: 'founder' });
  store.saveScore(job.id, { score: 90, confidence: 0.9, label: 'exceptional', dimensions: {}, reasons: ['Direct overlap'], concerns: [], recommendedNarrative: 'ai-agent-systems', projects: [], flags: [], degraded: false, model: 'm' });
  const write = (name, content) => { const file = path.join(dir, name); fs.writeFileSync(file, content); return file; };
  store.addArtifact(job.id, 'resume_txt', write('resume.txt', 'Pat Example\nCTO at D. Harris Tours\n'));
  store.addArtifact(job.id, 'resume_pdf', pdf);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(pdf)).digest('hex');
  const plan = {
    jobId: job.id, url: 'https://jobs.ashbyhq.com/x/1/application', schemaHash: 's'.repeat(64), submitLabel: 'Submit',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, value: 'Pat Example', origin: 'identity' },
      { key: 'resume', label: 'Resume', type: 'file', required: true, file: 'resume', fileName: 'Pat_Example_Resume.pdf', origin: 'upload' },
    ],
    unresolved: [], files: { resume: { sha256 } }, blockers: [], needs: [], ready: true,
  };
  plan.planHash = planHash(plan);
  store.addApplication(job.id, { url: plan.url, status: 'planned', plan, idempotencyKey: 'k1' });

  let clock = Date.now();
  const pairings = new ExtensionPairings({ dataDir, now: () => clock });
  const channel = createExtensionChannel({ pairings });
  const router = new Router({ extension: channel });
  registerExtensionRoutes(router, { channel, vaultDir: () => vault, now: () => NOW });
  // The test server lets a header stand in for the TCP peer address, which a real client cannot choose.
  const server = http.createServer((req, res) => {
    const fake = req.headers['x-test-remote'];
    if (fake) Object.defineProperty(req.socket, 'remoteAddress', { value: fake, configurable: true });
    router.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => { server.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const call = ({ method = 'GET', url, headers = {}, body, remote = null, host = `127.0.0.1:${port}` }) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const request = http.request({ agent: false, host: '127.0.0.1', port, path: url, method, headers: { host, ...(remote ? { 'x-test-remote': remote } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const raw = Buffer.concat(chunks); let json = null; try { json = JSON.parse(raw.toString('utf8')); } catch { /* binary */ } resolve({ status: res.statusCode, headers: res.headers, json, raw }); });
    });
    request.on('error', reject);
    request.end(data);
  });
  const pair = async (origin = EXT) => {
    const { code } = pairings.createCode();
    const res = await call({ method: 'POST', url: '/api/extension/v1/pair', headers: { origin }, body: { code, label: 'My Chrome' } });
    assert.equal(res.status, 201);
    return res.json;
  };
  const authed = (token, extra = {}) => ({ authorization: `Bearer ${token}`, origin: EXT, ...extra });
  const review = async (kind = 'form') => {
    const candidate = loadCandidate(vault);
    return reviewJob({ store, job: store.getJob(job.id), kind, candidate, preferences: candidate.preferences, config: loadAutopilotConfig(vault), llm: createLlm([fakeLlm(approve()).provider]), now: NOW });
  };
  return { dir, vault, dataDir, store, job, pdf, plan, pairings, call, pair, authed, review, port, tick: (ms) => { clock += ms; } };
}

test('loopback helpers accept only loopback peers and hosts', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true);
  for (const address of ['192.168.1.5', '10.0.0.1', '::ffff:10.0.0.1', '0.0.0.0', '', undefined]) assert.equal(isLoopbackAddress(address), false);
  for (const host of ['localhost', 'localhost:4000', '127.0.0.1:4000', '[::1]:4000', 'LOCALHOST']) assert.equal(isLoopbackHost(host), true);
  for (const host of ['evil.example', 'localhost.evil.example', '127.0.0.1.evil.example', 'evil.example:4000', 'localhost@evil.example', '::1', '', undefined]) assert.equal(isLoopbackHost(host), false);
});

test('every extension route refuses a non-loopback peer, even with a valid token, and X-Forwarded-For does not matter', async (t) => {
  const w = await world(t);
  const { token } = await w.pair();
  const routes = [['GET', '/api/extension/v1/applications'], ['GET', `/api/extension/v1/jobs/${w.job.id}/plan`], ['GET', `/api/extension/v1/jobs/${w.job.id}/files/resume`], ['POST', `/api/extension/v1/jobs/${w.job.id}/submitting`], ['POST', `/api/extension/v1/jobs/${w.job.id}/result`], ['POST', '/api/extension/v1/pair']];
  for (const [method, url] of routes) {
    for (const remote of ['192.168.1.20', '::ffff:10.0.0.9', '203.0.113.7']) {
      const res = await w.call({ method, url, remote, headers: { ...w.authed(token), 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1', 'x-real-ip': '127.0.0.1' }, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 403, `${method} ${url} from ${remote}`);
    }
  }
  const preflight = await w.call({ method: 'OPTIONS', url: '/api/extension/v1/applications', remote: '192.168.1.20', headers: { origin: EXT, 'access-control-request-method': 'GET' } });
  assert.equal(preflight.status, 403);
  // A loopback peer that merely claims to be forwarded for someone else is still served: the header is ignored, not trusted.
  const ok = await w.call({ url: '/api/extension/v1/applications', headers: { ...w.authed(token), 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(ok.status, 200);
  for (const remote of ['::1', '::ffff:127.0.0.1']) assert.equal((await w.call({ url: '/api/extension/v1/applications', remote, headers: w.authed(token) })).status, 200);
});

test('a Host header that is not localhost is refused (DNS rebinding)', async (t) => {
  const w = await world(t);
  const { token } = await w.pair();
  for (const host of ['evil.example', 'evil.example:4000', 'localhost.evil.example', '127.0.0.1.evil.example', 'localhost@evil.example', '192.168.1.5:4000']) {
    const res = await w.call({ url: '/api/extension/v1/applications', host, headers: w.authed(token) });
    assert.equal(res.status, 403, host);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await w.call({ url: '/api/extension/v1/applications', host: `localhost:${w.port}`, headers: w.authed(token) })).status, 200);
  assert.equal((await w.call({ method: 'OPTIONS', url: '/api/extension/v1/applications', host: 'evil.example', headers: { origin: EXT } })).status, 403);
});

test('missing, malformed, wrong, other-extension and revoked tokens are refused', async (t) => {
  const w = await world(t);
  const { token, id } = await w.pair();
  const url = '/api/extension/v1/applications';
  assert.equal((await w.call({ url, headers: { origin: EXT } })).status, 401);
  assert.equal((await w.call({ url, headers: { origin: EXT, cookie: 'u2os_session=anything' } })).status, 401, 'a cookie is not credentials here');
  for (const bad of ['Bearer', 'Bearer wrong', `Bearer ${token}x`, `bearer ${token}`, `Basic ${token}`, `Bearer ${token.slice(0, -1)}`]) assert.equal((await w.call({ url, headers: { origin: EXT, authorization: bad } })).status, 401, bad);
  assert.equal((await w.call({ url, headers: { authorization: `Bearer ${token}` } })).status, 200, 'no Origin header at all (non-browser client) is fine with a token');
  assert.equal((await w.call({ url: `${url}?token=${token}` })).status, 401, 'tokens are not accepted in the URL');
  assert.equal(w.pairings.revoke(id), true);
  assert.equal((await w.call({ url, headers: w.authed(token) })).status, 401, 'revoked');
  assert.equal(w.pairings.revoke(id), false);
});

test('a foreign Origin is refused, including another extension holding a stolen token', async (t) => {
  const w = await world(t);
  const { token } = await w.pair();
  const url = '/api/extension/v1/applications';
  for (const origin of ['https://evil.example', 'http://localhost:4000', 'null', OTHER_EXT, 'chrome-extension://short', 'chrome-extension://' + 'A'.repeat(32), `${EXT}.evil.example`, '*']) {
    const res = await w.call({ url, headers: { authorization: `Bearer ${token}`, origin } });
    assert.equal(res.status, 403, origin);
    assert.equal(res.headers['access-control-allow-origin'], undefined, origin);
  }
  const { code } = w.pairings.createCode();
  assert.equal((await w.call({ method: 'POST', url: '/api/extension/v1/pair', headers: { origin: 'https://evil.example' }, body: { code } })).status, 403);
  assert.equal((await w.call({ method: 'POST', url: '/api/extension/v1/pair', body: { code } })).status, 403, 'pairing without an Origin');
  assert.equal(w.pairings.list().length, 1, 'the refused attempts did not pair');
});

test('CORS names exactly the paired origin, never a wildcard or credentials; preflight only for paired origins', async (t) => {
  const w = await world(t);
  const { token } = await w.pair();
  const res = await w.call({ url: '/api/extension/v1/applications', headers: w.authed(token) });
  assert.equal(res.headers['access-control-allow-origin'], EXT);
  assert.equal(res.headers['access-control-allow-credentials'], undefined);
  assert.match(res.headers.vary, /Origin/);
  const pre = await w.call({ method: 'OPTIONS', url: '/api/extension/v1/applications', headers: { origin: EXT, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], EXT);
  assert.equal(pre.headers['access-control-allow-credentials'], undefined);
  assert.match(pre.headers['access-control-allow-headers'], /Authorization/i);
  for (const origin of [OTHER_EXT, 'https://evil.example', '*']) {
    const denied = await w.call({ method: 'OPTIONS', url: '/api/extension/v1/applications', headers: { origin } });
    assert.equal(denied.status, 403, origin);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  }
  // Pairing preflight is open to any well-formed extension origin (there is no pairing yet); web pages are not.
  assert.equal((await w.call({ method: 'OPTIONS', url: '/api/extension/v1/pair', headers: { origin: OTHER_EXT } })).status, 204);
  assert.equal((await w.call({ method: 'OPTIONS', url: '/api/extension/v1/pair', headers: { origin: 'https://evil.example' } })).status, 403);
  // Revoking removes the origin from preflight too.
  w.pairings.revoke(w.pairings.list()[0].id);
  assert.equal((await w.call({ method: 'OPTIONS', url: '/api/extension/v1/applications', headers: { origin: EXT } })).status, 403);
});

test('a pairing code works once, expires, and only a hash of the token is stored (0600)', async (t) => {
  const w = await world(t);
  const { code } = w.pairings.createCode();
  const exchange = (c, origin = EXT) => w.call({ method: 'POST', url: '/api/extension/v1/pair', headers: { origin }, body: { code: c, label: 'Laptop' } });
  const first = await exchange(code.toLowerCase());
  assert.equal(first.status, 201);
  assert.match(first.json.token, /^u2x_/);
  assert.equal((await exchange(code)).status, 403, 'one time');
  const expiring = w.pairings.createCode().code;
  w.tick(CODE_TTL_MS + 1000);
  assert.equal((await exchange(expiring)).status, 403, 'expired');
  const consumed = w.pairings.createCode().code;
  assert.equal((await exchange('AAAAA-BBBBB')).status, 403);
  assert.equal((await exchange(consumed)).status, 201, 'a wrong guess does not burn someone else\'s code');
  const file = path.join(w.dataDir, 'credentials', 'extension-pairings.json');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes(first.json.token), false, 'no plaintext token');
  assert.equal(text.includes(code.replace('-', '')), false, 'no plaintext code');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(w.pairings.list()).includes('tokenHash'), false);
});

test('repeated wrong pairing codes are rate limited', async (t) => {
  const w = await world(t);
  let last;
  for (let i = 0; i < 12; i += 1) last = await w.call({ method: 'POST', url: '/api/extension/v1/pair', headers: { origin: EXT }, body: { code: `WRONG-${i}` } });
  assert.equal(last.status, 429);
  const { code } = w.pairings.createCode();
  assert.equal((await w.call({ method: 'POST', url: '/api/extension/v1/pair', headers: { origin: EXT }, body: { code } })).status, 429, 'locked out for the window, even with a good code');
});

test('an unapproved job\'s plan and files are not served; an approved one is, and later edits withdraw it', async (t) => {
  const w = await world(t);
  const { token } = await w.pair();
  const headers = w.authed(token);
  const plan = `/api/extension/v1/jobs/${w.job.id}/plan`;
  const file = `/api/extension/v1/jobs/${w.job.id}/files/resume`;
  assert.equal((await w.call({ url: plan, headers })).status, 403, 'never reviewed');
  assert.equal((await w.call({ url: file, headers })).status, 403);
  await w.review();
  const rejectedWorld = await world(t);
  const rejected = await rejectedWorld.pair();
  const candidate = loadCandidate(rejectedWorld.vault);
  await reviewJob({ store: rejectedWorld.store, job: rejectedWorld.store.getJob(rejectedWorld.job.id), kind: 'form', candidate, preferences: candidate.preferences, config: loadAutopilotConfig(rejectedWorld.vault), llm: createLlm([fakeLlm({ decision: 'reject', confidence: 0.9, concerns: [], notes: 'no' }).provider]), now: NOW });
  assert.equal((await rejectedWorld.call({ url: `/api/extension/v1/jobs/${rejectedWorld.job.id}/plan`, headers: rejectedWorld.authed(rejected.token) })).status, 403, 'rejected');
  assert.equal((await w.call({ url: '/api/extension/v1/jobs/job_0000000000000000/plan', headers })).status, 404);
  assert.equal((await w.call({ url: '/api/extension/v1/jobs/bad.id/plan', headers })).status, 400);

  const served = await w.call({ url: plan, headers });
  assert.equal(served.status, 200);
  assert.equal(served.json.planHash, w.plan.planHash);
  assert.equal(served.json.autoSubmit, true);
  assert.deepEqual(served.json.fields.map((f) => f.key), ['name', 'resume']);
  assert.equal(served.json.files[0].sha256, w.plan.files.resume.sha256);
  const downloaded = await w.call({ url: file, headers });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers['x-content-sha256'], w.plan.files.resume.sha256);
  assert.equal(crypto.createHash('sha256').update(downloaded.raw).digest('hex'), w.plan.files.resume.sha256);
  assert.equal((await w.call({ url: `/api/extension/v1/jobs/${w.job.id}/files/..%2Fsecret`, headers })).status, 404);
  assert.equal((await w.call({ url: `/api/extension/v1/jobs/${w.job.id}/files/constructor`, headers })).status, 404);
  assert.deepEqual((await w.call({ url: '/api/extension/v1/applications', headers })).json.applications.map((a) => a.jobId), [w.job.id]);

  fs.writeFileSync(w.pdf, '%PDF-1.4 tampered');
  assert.equal((await w.call({ url: file, headers })).status, 409, 'bytes that differ from the reviewed hash are never sent');
  const art = w.store.getArtifacts(w.job.id).resume_pdf;
  assert.ok(art);
  fs.writeFileSync(w.pdf, '%PDF-1.4 resume bytes');
  w.store.addArtifact(w.job.id, 'resume_txt', (() => { const f = path.join(w.dir, 'other.txt'); fs.writeFileSync(f, 'changed after approval'); return f; })());
  assert.equal((await w.call({ url: plan, headers })).status, 403, 'content changed after approval');
});

test('results: filled, then submitted, are recorded in the ledger; a failure after submitting began is uncertain and final', async (t) => {
  const w = await world(t);
  await w.review();
  const { token } = await w.pair();
  const headers = w.authed(token);
  const base = `/api/extension/v1/jobs/${w.job.id}`;
  const planHashValue = w.plan.planHash;
  assert.equal((await w.call({ method: 'POST', url: `${base}/result`, headers, body: { status: 'submitted', planHash: planHashValue } })).status, 409, 'no plan was served yet');
  assert.equal((await w.call({ url: `${base}/plan`, headers })).status, 200);
  assert.equal((await w.call({ method: 'POST', url: `${base}/result`, headers, body: { status: 'bogus', planHash: planHashValue } })).status, 400);
  assert.equal((await w.call({ method: 'POST', url: `${base}/result`, headers, body: { status: 'submitted', planHash: 'x' } })).status, 409, 'wrong plan');
  const filled = await w.call({ method: 'POST', url: `${base}/result`, headers, body: { status: 'filled', planHash: planHashValue } });
  assert.equal(filled.json.status, 'planned');
  assert.equal(w.store.listApplications(w.job.id)[0].result.outcome, 'filled');
  assert.equal((await w.call({ method: 'POST', url: `${base}/submitting`, headers, body: { planHash: 'stale' } })).status, 409);
  const sub = await w.call({ method: 'POST', url: `${base}/submitting`, headers, body: { planHash: planHashValue } }); assert.equal(sub.json.status, 'submitting', JSON.stringify(sub.json));
  assert.equal((await w.call({ method: 'POST', url: `${base}/result`, headers, body: { status: 'filled', planHash: planHashValue } })).status, 409);
  assert.equal((await w.call({ url: `${base}/plan`, headers })).status, 409, 'nothing is served while a submit is in flight');
  const failed = await w.call({ method: 'POST', url: `${base}/result`, headers, body: { status: 'failed', planHash: planHashValue, reason: 'tab closed' } });
  assert.equal(failed.json.status, 'uncertain');
  assert.equal(w.store.getJob(w.job.id).status, 'uncertain');
  assert.equal(w.store.listApplications(w.job.id)[0].result.via, 'extension');
  assert.equal((await w.call({ url: `${base}/plan`, headers })).status, 409, 'an uncertain outcome is never retried');
  assert.equal((await w.call({ method: 'POST', url: `${base}/submitting`, headers, body: { planHash: planHashValue } })).status, 409);
  assert.equal((await w.call({ method: 'POST', url: `${base}/result`, headers, body: { status: 'submitted', planHash: planHashValue } })).status, 409, 'cannot be overwritten');
});

test('submitted after an intent record marks the job applied; failure before submitting is retryable; dry run never submits', async (t) => {
  const w = await world(t);
  await w.review();
  const { token } = await w.pair();
  const headers = w.authed(token);
  const base = `/api/extension/v1/jobs/${w.job.id}`;
  await w.call({ url: `${base}/plan`, headers });
  assert.equal((await w.call({ method: 'POST', url: `${base}/result`, headers, body: { status: 'failed', planHash: w.plan.planHash, reason: 'field missing' } })).json.status, 'planned');
  await w.call({ url: `${base}/plan`, headers });
  await w.call({ method: 'POST', url: `${base}/submitting`, headers, body: { planHash: w.plan.planHash } });
  assert.equal((await w.call({ method: 'POST', url: `${base}/result`, headers, body: { status: 'submitted', planHash: w.plan.planHash } })).json.status, 'submitted');
  assert.equal(w.store.getJob(w.job.id).status, 'applied');
  assert.ok(w.store.listEvents(w.job.id).some((e) => e.type === 'application_result'));

  const d = await world(t, { mode: 'dry_run' });
  await d.review();
  const dt = await d.pair();
  const dh = d.authed(dt.token);
  const plan = await d.call({ url: `/api/extension/v1/jobs/${d.job.id}/plan`, headers: dh });
  assert.equal(plan.json.autoSubmit, false);
  assert.equal((await d.call({ method: 'POST', url: `/api/extension/v1/jobs/${d.job.id}/submitting`, headers: dh, body: { planHash: d.plan.planHash } })).status, 409);
});

test('owner routes: pairings can be listed and revoked, and the web UI routes are not extension-token routes', async (t) => {
  const w = await world(t);
  const { token, id } = await w.pair();
  assert.deepEqual(w.pairings.list().map((p) => [p.id, p.origin, p.label]), [[id, EXT, 'My Chrome']]);
  // The owner routes are not marked `extension`, so a bearer token does not authenticate them (they need the web session).
  const router = new Router({});
  registerExtensionRoutes(router, { channel: createExtensionChannel({ pairings: w.pairings }) });
  const marked = Object.fromEntries(router.routes.map((r) => [`${r.method} ${r.path}`, r.options.extension ?? null]));
  assert.equal(marked['POST /api/extension/pairing-codes'], null);
  assert.equal(marked['GET /api/extension/pairings'], null);
  assert.equal(marked['DELETE /api/extension/pairings/:id'], null);
  assert.equal(marked['POST /api/extension/v1/pair'], 'pair');
  for (const [key, mode] of Object.entries(marked)) if (key.includes('/v1/') && !key.endsWith('/pair')) assert.equal(mode, 'token', key);
  assert.ok(token);
});

test('in the real server the owner mints codes with the web session, the channel ignores cookies, and the cookie/CSRF scheme still guards the owner routes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-channel-server-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const handle = await startServer({ port: 0 });
  t.after(async () => { await new Promise((resolve) => handle.server.close(resolve)); closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT; fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${handle.port}`;
  const raw = (method, url, headers = {}, body) => new Promise((resolve, reject) => {
    const request = http.request(`${base}${url}`, { method, agent: false, headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })); });
    request.on('error', reject); request.end(body);
  });
  // No session at all: the owner routes are closed, and the channel answers with its own token error.
  assert.equal((await raw('POST', '/api/extension/pairing-codes', { origin: base })).status, 401);
  assert.equal((await raw('GET', '/api/extension/v1/applications', { origin: EXT })).status, 401);
  // With the web session the owner mints a code (the test helper adds cookie + CSRF).
  const minted = await fetch(`${base}/api/extension/pairing-codes`, { method: 'POST' });
  assert.equal(minted.status, 201);
  const { code } = await minted.json();
  const paired = await raw('POST', '/api/extension/v1/pair', { origin: EXT, 'content-type': 'application/json' }, JSON.stringify({ code, label: 'Chrome' }));
  assert.equal(paired.status, 201);
  const { token, id } = JSON.parse(paired.text);
  assert.equal((await raw('GET', '/api/extension/v1/applications', { authorization: `Bearer ${token}`, origin: EXT })).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/extension/pairings`)).json()).pairings.map((p) => p.id), [id]);
  assert.equal((await fetch(`${base}/api/extension/pairings/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await raw('GET', '/api/extension/v1/applications', { authorization: `Bearer ${token}`, origin: EXT })).status, 401, 'revoked');
});
