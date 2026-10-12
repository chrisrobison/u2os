import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { planApplication } from '../mcp/jobs/hunt/applications/form/submit.js';
import { candidateDigest } from '../mcp/jobs/hunt/candidate/profile.js';
import { createLlm } from '../mcp/jobs/hunt/llm/structured.js';
import { RESUME, PREFS, fakeLlm } from './fixtures/job-hunt-candidate.js';
import { startApplyForms } from './fixtures/apply-forms.js';
import { startServer } from './helpers/authed-server.js';

// #569: the owner approves a planned application from the page and it is submitted through the guarded path.

let forms;
let env = {};
let browserOk = true;
before(async () => {
  forms = await startApplyForms();
  try {
    const { chromium } = await import('playwright');
    if (!fs.existsSync(chromium.executablePath())) browserOk = false;
    env = { JOBS_SUBMIT_TIMEOUT_MS: '2500' };
    Object.assign(process.env, env);
  } catch { browserOk = false; }
});
after(() => forms.close());

const SCORE = { score: 90, confidence: 0.9, label: 'exceptional', dimensions: { experience: { points: 24, max: 25, reason: 'x' } }, reasons: ['fit'], concerns: [], recommendedNarrative: 'ai-agent-systems', projects: [], flags: [], degraded: false, model: 'm' };
const ANSWERS = { work_authorization_us: true, requires_sponsorship: false, custom: {}, policy: { accept_privacy_notices: true, accept_truthfulness_attestations: false } };
const WHY = 'Tahoma builds deterministic orchestration around LLM agents, which is the problem I work on with U2OS, a personal agent platform with MCP and approval. I also ran engineering as CTO of D. Harris Tours.';
const FACTS = { text: '## D. Harris Tours\n- Grew the fleet from 2 to 14 vehicles; AI-driven scheduling raised daily revenue by about 30%.\n## Project: U2OS\nPersonal agent platform with deterministic orchestration, MCP tools and approval.' };

async function fixture(t, { url = `${forms.base}/ashby/application`, autopilot = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-owner-submit-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const vault = process.env.U2OS_VAULT;
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify(RESUME));
  fs.writeFileSync(path.join(vault, 'job-hunt', 'preferences.yaml'), `minimum_score: ${PREFS.minimum_score}\nlocations: [San Francisco, Remote US]\nhome: { city: San Francisco, region: CA, country: US, areas: [san francisco, sf] }\n`);
  fs.writeFileSync(path.join(vault, 'job-hunt', 'answers.yaml'), 'work_authorization_us: true\nrequires_sponsorship: false\n');
  fs.writeFileSync(path.join(vault, 'job-hunt', 'facts.md'), FACTS.text);
  fs.writeFileSync(path.join(vault, 'job-hunt', 'autopilot.yaml'), `enabled: false\nmode: dry_run\nbrowser:\n  headed: false\n${autopilot}`);
  const pdf = path.join(dir, 'resume.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\nresume body\n%%EOF\n');
  const txt = path.join(dir, 'resume.txt');
  fs.writeFileSync(txt, 'Pat Example resume');
  const store = openStore(huntDbPath(vault));
  const { job } = store.upsertSighting({ source: 'greenhouse', sourceKey: 'greenhouse:1#0', company: 'Tahoma AI', role: 'Founding Engineer', rawText: 'Tahoma AI | Founding Engineer. Remote (US). We build deterministic orchestration around LLM agents.', applicationUrls: [url], contactEmails: [], author: 'a', locations: ['Remote (US)'], remote: true, description: 'We build deterministic orchestration around LLM agents.' });
  store.saveScore(job.id, SCORE);
  store.addArtifact(job.id, 'resume_pdf', pdf);
  store.addArtifact(job.id, 'resume_txt', txt);
  const candidate = { resume: RESUME, preferences: PREFS, answers: ANSWERS, facts: FACTS, repos: [], digest: candidateDigest(RESUME, PREFS) };
  const llm = createLlm([fakeLlm({ answers: { why: WHY }, unanswerable: [] }).provider]);
  const application = await planApplication({ store, job: store.getJob(job.id), candidate, llm, now: new Date() });
  store.close();
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const inspect = () => { const s = openStore(huntDbPath(vault)); try { return { job: s.getJob(job.id), reviews: s.listReviews(job.id), applications: s.listApplications(job.id), events: s.listEvents(job.id) }; } finally { s.close(); } };
  return { vault, job, application, post, inspect, reject: () => { const s = openStore(huntDbPath(vault)); s.addReview(job.id, { kind: 'form', decision: 'reject', contentHash: 'x', checks: [], concerns: [{ severity: 'blocking', text: 'The URL could not be verified' }], notes: 'No.', model: 'm' }); s.close(); } };
}
const URL_FOR = (job) => `/api/job-hunt/jobs/${job.id}/approve-and-submit`;

test('the owner approves a planned application and it is submitted, even with the autopilot off and a reviewer rejection', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const { job, application, post, inspect, reject } = await fixture(t);
  assert.equal(application.status, 'planned', JSON.stringify(application.plan.unresolved));
  reject();
  const before = forms.submissions.length;
  const response = await post(URL_FOR(job), { planHash: application.planHash, confirm: true });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'submitted');
  assert.equal(forms.submissions.length, before + 1, 'the form was really submitted');
  const after = inspect();
  assert.equal(after.job.status, 'applied');
  assert.equal(after.applications.at(-1).status, 'submitted');
  const approval = after.reviews.find((review) => review.model === 'owner');
  assert.equal(approval.decision, 'approve');
  assert.ok(after.events.some((event) => event.type === 'owner_approved'));
  assert.ok(after.events.some((event) => event.type === 'application_form_submitted' && event.detail.by === 'owner'));
  assert.equal(body.job.applications[0].status, 'submitted');

  const again = await post(URL_FOR(job), { planHash: application.planHash, confirm: true });
  assert.equal(again.status, 409, 'it cannot be sent twice');
  assert.equal(forms.submissions.length, before + 1);
});

test('a plan that changed since the owner looked, a missing confirmation, and a plan that is not ready are refused', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const { job, application, post, inspect } = await fixture(t);
  const before = forms.submissions.length;
  const stale = await post(URL_FOR(job), { planHash: 'f'.repeat(64), confirm: true });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'STALE_PLAN');
  assert.equal((await post(URL_FOR(job), { planHash: application.planHash })).status, 400);
  assert.equal((await post(URL_FOR(job), { planHash: application.planHash, confirm: 'yes' })).status, 400);
  assert.equal((await post(URL_FOR(job), { confirm: true })).status, 400);
  assert.equal((await post('/api/job-hunt/jobs/nope/approve-and-submit', { planHash: 'x', confirm: true })).status, 400);
  assert.equal((await post('/api/job-hunt/jobs/job_0000000000000000/approve-and-submit', { planHash: 'x', confirm: true })).status, 404);
  assert.equal(forms.submissions.length, before);
  assert.equal(inspect().reviews.length, 0, 'no approval was recorded');
});

test('the owner cannot override the rules: a blocklisted company is refused, nothing is approved or sent', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const { job, application, post, inspect } = await fixture(t, { autopilot: 'blocklist:\n  companies: [Tahoma AI]\n' });
  const before = forms.submissions.length;
  const response = await post(URL_FOR(job), { planHash: application.planHash, confirm: true });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, 'CHECKS_FAILED');
  assert.match(body.error, /not_on_blocklist/);
  assert.equal(forms.submissions.length, before);
  assert.equal(inspect().reviews.length, 0);
  assert.notEqual(inspect().job.status, 'applied');
});

test('an application that still needs answers is not ready to submit', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const { job, post, inspect } = await fixture(t, { url: `${forms.base}/simple/extra` });
  const state = inspect();
  assert.equal(state.applications.at(-1).status, 'needs_input');
  const response = await post(URL_FOR(job), { planHash: state.applications.at(-1).planHash, confirm: true });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'NOT_READY');
  assert.equal(inspect().reviews.length, 0);
});
