import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { jobAttention } from '../mcp/jobs/hunt/attention.js';
import { startServer } from './helpers/authed-server.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('attention says what is needed, in words, for each kind of blocked job', () => {
  const job = (status) => ({ id: 'job_0000000000000001', status });
  const needs = jobAttention({ job: job('materials_generated'), applications: [{ status: 'needs_input', plan: { unresolved: [{ label: 'Do you have a clearance?', reason: 'sensitive_never_inferred' }, { key: 'x', reason: 'unknown_required_field' }] } }] });
  assert.equal(needs.needsYou, true);
  assert.equal(needs.reasons[0].kind, 'needs_answers');
  assert.match(needs.reasons[0].items[0], /Do you have a clearance\?: a sensitive question U2OS never answers/);
  assert.match(needs.reasons[0].items[1], /^x: U2OS has no answer/);

  const blocked = jobAttention({ job: job('materials_generated'), applications: [{ status: 'manual_required', plan: { blockers: ['captcha'] } }] });
  assert.match(blocked.reasons[0].items[0], /CAPTCHA/);

  const rejected = jobAttention({
    job: job('materials_generated'),
    reviews: [{ kind: 'form', decision: 'reject', notes: 'n', checks: [{ name: 'not_part_time_or_token_pay_unless_allowed', pass: false, detail: '' }, { name: 'plan_ready', pass: true }, { name: 'posting_contains_instructions_for_ai', pass: false, informational: true }], concerns: [{ severity: 'blocking', text: 'Legal name is only "Robison"' }, { severity: 'minor', text: 'capitalize OpenAI' }] }],
  });
  assert.equal(rejected.reasons[0].kind, 'review_rejected');
  assert.deepEqual(rejected.reasons[0].items, ['It reads as part-time or token pay', 'Legal name is only "Robison"']);

  const uncertain = jobAttention({ job: job('uncertain'), applications: [{ status: 'uncertain', result: { reason: 'interrupted after the click; outcome unknown' } }] });
  assert.equal(uncertain.reasons[0].kind, 'uncertain');
  assert.match(uncertain.reasons[0].action, /never retries/);

  const listing = jobAttention({ job: job('needs_input'), needsInput: ['work authorization'] });
  assert.deepEqual(listing.reasons[0].items, ['work authorization']);
});

test('a settled or healthy job does not ask for attention', () => {
  assert.deepEqual(jobAttention({ job: { status: 'applied' }, reviews: [{ kind: 'form', decision: 'reject', checks: [], concerns: [], notes: 'x' }] }), { needsYou: false, reasons: [] });
  assert.equal(jobAttention({ job: { status: 'materials_generated' }, applications: [{ status: 'planned', plan: {} }], reviews: [{ kind: 'form', decision: 'approve', checks: [], concerns: [] }] }).needsYou, false);
});

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-job-details-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const vault = process.env.U2OS_VAULT;
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  const store = openStore(huntDbPath(vault));
  const { job } = store.upsertSighting({ source: 'greenhouse', sourceKey: 'greenhouse:1#0', company: 'Acme', role: 'Staff Engineer', rawText: 'Acme | Staff Engineer', applicationUrls: ['https://boards.greenhouse.io/acme/jobs/1'], contactEmails: [], author: 'a', locations: ['San Francisco'], remote: false });
  const shots = path.join(vault, 'job-hunt', 'state', 'screens', job.id);
  fs.mkdirSync(path.join(shots, 'application-1', 'run-a'), { recursive: true });
  fs.writeFileSync(path.join(shots, 'form.png'), PNG);
  fs.writeFileSync(path.join(shots, 'application-1', 'run-a', 'result.png'), PNG);
  const secret = path.join(dir, 'secret.png');
  fs.writeFileSync(secret, PNG);
  const plan = { fields: [{ key: 'first_name', label: 'First Name', required: true, value: 'Pat', origin: 'identity' }, { key: 'resume', label: 'Resume', file: 'resume', fileName: 'Pat_Resume.pdf', origin: 'upload' }], unresolved: [{ label: 'Security clearance?', reason: 'sensitive_never_inferred' }], blockers: [], needs: [], ready: false, planHash: 'h1' };
  const application = store.addApplication(job.id, { url: 'https://boards.greenhouse.io/acme/jobs/1', status: 'needs_input', plan, idempotencyKey: 'k1' });
  store.updateApplication(application.id, { result: { outcome: 'unconfirmed', screenshots: [path.join(shots, 'form.png'), path.join(shots, 'application-1', 'run-a', 'result.png'), secret, '/etc/passwd'], at: '2026-10-11T00:00:00.000Z' } });
  store.addReview(job.id, { kind: 'form', decision: 'reject', contentHash: 'c', checks: [{ name: 'plan_ready', pass: false, detail: 'plan is needs_input' }], concerns: [{ severity: 'blocking', text: 'Clearance unanswered' }], notes: 'No.', model: 'm' });
  store.close();
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  return { job, shots, dir, get: (url) => fetch(`${base}${url}`) };
}

test('the job detail carries the plan, the attempts, the reviews and why the job needs you', async (t) => {
  const { job, get } = await fixture(t);
  const response = await get(`/api/job-hunt/jobs/${job.id}`);
  const detail = await response.json();
  assert.equal(response.status, 200, JSON.stringify(detail));
  assert.equal(detail.applications.length, 1);
  const [attempt] = detail.applications;
  assert.equal(attempt.status, 'needs_input');
  assert.deepEqual(attempt.plan.fields, [{ label: 'First Name', required: true, origin: 'identity', value: 'Pat' }, { label: 'Resume', required: false, origin: 'upload', file: 'Pat_Resume.pdf' }]);
  assert.deepEqual(attempt.result.screenshots, ['form.png', 'application-1/run-a/result.png'], 'only files under the job\'s screens folder are listed');
  assert.equal(detail.reviews[0].decision, 'reject');
  assert.equal(detail.attention.needsYou, true);
  assert.deepEqual(detail.attention.reasons.map((reason) => reason.kind), ['needs_answers', 'review_rejected']);
  assert.ok(!JSON.stringify(detail).includes('/etc/passwd'));
  assert.ok(Array.isArray(detail.contacts) && Array.isArray(detail.tasks) && Array.isArray(detail.interviews));
});

test('screenshots are served only from the job\'s own screens folder', async (t) => {
  const { job, shots, dir, get } = await fixture(t);
  const ok = await get(`/api/job-hunt/jobs/${job.id}/screenshot?path=form.png`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  assert.equal((await get(`/api/job-hunt/jobs/${job.id}/screenshot?path=application-1/run-a/result.png`)).status, 200);
  for (const bad of ['../secret.png', '..%2Fsecret.png', 'application-1/../../secret.png', '/etc/passwd', 'form.txt', 'form.png/x', 'a/b/c/d/e.png', '']) {
    assert.ok([400, 404].includes((await get(`/api/job-hunt/jobs/${job.id}/screenshot?path=${bad}`)).status), `refused: ${bad}`);
  }
  assert.equal((await get('/api/job-hunt/jobs/nope/screenshot?path=form.png')).status, 400);
  assert.equal((await get('/api/job-hunt/jobs/job_0000000000000000/screenshot?path=form.png')).status, 404);
  // A link out of the folder is not followed.
  fs.symlinkSync(path.join(dir, 'secret.png'), path.join(shots, 'link.png'));
  assert.equal((await get(`/api/job-hunt/jobs/${job.id}/screenshot?path=link.png`)).status, 404);
  fs.symlinkSync(dir, path.join(shots, 'escape'));
  assert.equal((await get(`/api/job-hunt/jobs/${job.id}/screenshot?path=escape/secret.png`)).status, 404);
});
