import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { planApplication } from '../mcp/jobs/hunt/applications/form/submit.js';
import { prefillApplicationForm } from '../mcp/jobs/hunt/act.js';
import { candidateDigest } from '../mcp/jobs/hunt/candidate/profile.js';
import { createLlm } from '../mcp/jobs/hunt/llm/structured.js';
import { RESUME, PREFS, fakeLlm } from './fixtures/job-hunt-candidate.js';
import { startApplyForms } from './fixtures/apply-forms.js';
import { startServer } from './helpers/authed-server.js';

// #622: "Open and pre-fill" fills the planned form in a visible window and leaves it open. It never submits.

const SCORE = { score: 90, confidence: 0.9, label: 'exceptional', dimensions: { experience: { points: 24, max: 25, reason: 'x' } }, reasons: ['fit'], concerns: [], recommendedNarrative: 'ai-agent-systems', projects: [], flags: [], degraded: false, model: 'm' };
const ANSWERS = { work_authorization_us: true, requires_sponsorship: false, custom: {}, policy: { accept_privacy_notices: true, accept_truthfulness_attestations: false } };
const WHY = 'Tahoma builds deterministic orchestration around LLM agents, which is the problem I work on with U2OS, a personal agent platform with MCP and approval. I also ran engineering as CTO of D. Harris Tours.';
const FACTS = { text: '## D. Harris Tours\n- Grew the fleet from 2 to 14 vehicles; AI-driven scheduling raised daily revenue by about 30%.\n## Project: U2OS\nPersonal agent platform with deterministic orchestration, MCP tools and approval.' };

async function fixture(t, { url = 'https://boards.example/tahoma/application', status = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-prefill-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const vault = process.env.U2OS_VAULT;
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify(RESUME));
  fs.writeFileSync(path.join(vault, 'job-hunt', 'preferences.yaml'), `minimum_score: ${PREFS.minimum_score}\nlocations: [Remote US]\nhome: { city: San Francisco, region: CA, country: US, areas: [san francisco, sf] }\n`);
  fs.writeFileSync(path.join(vault, 'job-hunt', 'answers.yaml'), 'work_authorization_us: true\nrequires_sponsorship: false\n');
  fs.writeFileSync(path.join(vault, 'job-hunt', 'facts.md'), FACTS.text);
  const pdf = path.join(dir, 'resume.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\nresume body\n%%EOF\n');
  const store = openStore(huntDbPath(vault));
  const { job } = store.upsertSighting({ source: 'greenhouse', sourceKey: 'greenhouse:1#0', company: 'Tahoma AI', role: 'Founding Engineer', rawText: 'Tahoma AI | Founding Engineer. Remote (US).', applicationUrls: [url], contactEmails: [], author: 'a', locations: ['Remote (US)'], remote: true, description: 'We build orchestration.' });
  store.saveScore(job.id, SCORE);
  store.addArtifact(job.id, 'resume_pdf', pdf);
  const candidate = { resume: RESUME, preferences: PREFS, answers: ANSWERS, facts: FACTS, repos: [], digest: candidateDigest(RESUME, PREFS) };
  const llm = createLlm([fakeLlm({ answers: { why: WHY }, unanswerable: [] }).provider]);
  const schema = { hasForm: true, blockers: {}, fields: [{ key: 'name', label: 'Full name', type: 'text', required: true }] };
  const application = await planApplication({ store, job: store.getJob(job.id), candidate, llm, inspect: async () => schema, now: new Date() });
  if (status) store.transition(job.id, status, {}, new Date());
  store.close();
  t.after(() => { closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT; fs.rmSync(dir, { recursive: true, force: true }); });
  const inspect = () => { const s = openStore(huntDbPath(vault)); try { return { job: s.getJob(job.id), applications: s.listApplications(job.id), events: s.listEvents(job.id) }; } finally { s.close(); } };
  return { vault, job, application, inspect };
}

test('pre-fill asks for a visible, kept-open, non-submitting run and leaves the plan and the stage alone', async (t) => {
  const { vault, job, application, inspect } = await fixture(t);
  assert.equal(application.status, 'planned', JSON.stringify(application.plan.unresolved));
  const stageBefore = inspect().job.status;
  const calls = [];
  const execute = async (args) => { calls.push(args); return { status: 'prefilled', screenshots: [] }; };
  const outcome = await prefillApplicationForm({ vaultDir: vault, jobId: job.id, execute });
  assert.equal(outcome.status, 'prefilled');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].submit, false);
  assert.equal(calls[0].prefill, true);
  assert.equal(calls[0].headed, true);
  assert.equal(calls[0].keepOpen, true);
  const after = inspect();
  assert.equal(after.applications.at(-1).status, 'planned', 'the plan can still be approved and submitted');
  assert.equal(after.job.status, stageBefore, 'the stage is unchanged');
  assert.ok(after.events.some((event) => event.type === 'application_prefilled'));
  assert.ok(!after.events.some((event) => /submitting|application_result/.test(event.type)), 'nothing was recorded as sent');
});

test('a form the window could not finish does not move the job to needs_input', async (t) => {
  const { vault, job, inspect } = await fixture(t);
  const before = inspect().job.status;
  const outcome = await prefillApplicationForm({ vaultDir: vault, jobId: job.id, execute: async () => ({ status: 'manual_required', reason: 'login_required', screenshots: [] }) });
  assert.equal(outcome.status, 'manual_required');
  assert.equal(outcome.reason, 'login_required');
  assert.equal(inspect().job.status, before);
});

test('pre-fill refuses a job that is already applied or has no ready plan', async (t) => {
  const done = await fixture(t, { status: 'applied' });
  await assert.rejects(prefillApplicationForm({ vaultDir: done.vault, jobId: done.job.id, execute: async () => assert.fail('must not run') }), /already applied/);
});

test('the pre-fill route validates the job and refuses a rejected one', async (t) => {
  const { job, vault } = await fixture(t);
  const s = openStore(huntDbPath(vault));
  s.transition(job.id, 'rejected', {}, new Date());
  s.close();
  const handle = await startServer({ port: 0 });
  t.after(() => new Promise((resolve) => handle.server.close(resolve)));
  const base = `http://127.0.0.1:${handle.port}`;
  const post = (id) => fetch(`${base}/api/job-hunt/jobs/${id}/prefill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await post('nope')).status, 400);
  assert.equal((await post('job_0000000000000000')).status, 404);
  const rejected = await post(job.id);
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).error, /rejected/);
});
