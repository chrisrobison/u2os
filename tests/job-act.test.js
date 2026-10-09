import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { sendApplication, submitApplicationForm, Refused } from '../mcp/jobs/hunt/act.js';
import { reviewJob } from '../mcp/jobs/hunt/review/agent.js';
import { loadCandidate } from '../mcp/jobs/hunt/candidate/load.js';
import { loadAutopilotConfig } from '../mcp/jobs/hunt/autopilot/config.js';
import { createLlm } from '../mcp/jobs/hunt/llm/structured.js';
import { stageAttachment, resolveAttachments } from '../server/tools/email-attachments.js';
import { RESUME, fakeLlm } from './fixtures/job-hunt-candidate.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const POSTING = 'Tahoma AI | Founding Engineer | Remote (US)\nWe build deterministic orchestration around agents. Email founder@tahoma.io with your resume.';
const BODY = 'Hi,\n\nI saw your post for the Founding Engineer role. Deterministic orchestration around agents is what I build with U2OS, a personal agent platform with MCP and approval, and I ran engineering as CTO of D. Harris Tours.\n\nMy tailored resume is attached.\n\nBest,\nPat Example\n';
const approve = () => ({ decision: 'approve', confidence: 0.9, concerns: [], notes: 'ok' });

function vaultWorld({ mode = 'live', limits = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-act-'));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify(RESUME));
  fs.writeFileSync(path.join(vault, 'job-hunt', 'facts.md'), '## D. Harris Tours\n- Grew the fleet from 2 to 14 vehicles.\n## Project: U2OS\nPersonal agent platform with deterministic orchestration, MCP, and approval.\n');
  fs.writeFileSync(path.join(vault, 'job-hunt', 'autopilot.yaml'), `enabled: true\nmode: ${mode}\n${limits}`);
  const pdf = path.join(dir, 'resume.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 resume');
  const staged = stageAttachment(vault, pdf, { name: 'Pat_Resume.pdf' });
  const store = openStore(huntDbPath(vault));
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:1#0', company: 'Tahoma AI', role: 'Founding Engineer', locations: ['Remote (US)'], remote: true, technologies: [], description: POSTING, rawText: POSTING, applicationUrls: [], contactEmails: ['founder@tahoma.io'], author: 'founder' });
  store.saveScore(job.id, { score: 90, confidence: 0.9, label: 'exceptional', dimensions: {}, reasons: ['Direct overlap'], concerns: [], recommendedNarrative: 'ai-agent-systems', projects: [], flags: [], degraded: false, model: 'm' });
  const write = (name, content) => { const file = path.join(dir, name); fs.writeFileSync(file, content); return file; };
  store.addArtifact(job.id, 'resume_txt', write('resume.txt', 'Pat Example\nCTO at D. Harris Tours\n'));
  store.addArtifact(job.id, 'resume_pdf', pdf);
  store.addArtifact(job.id, 'email_json', write('email.json', JSON.stringify({ to: 'founder@tahoma.io', subject: 'Founding Engineer at Tahoma AI', text: BODY, attachments: [staged.ref], needsInput: [] })));
  return { dir, vault, store, job: store.getJob(job.id), pdf };
}
const reviewIt = async (w, kind = 'email', reply = approve()) => {
  const f = fakeLlm(reply);
  const candidate = loadCandidate(w.vault);
  return reviewJob({ store: w.store, job: w.store.getJob(w.job.id), kind, candidate, preferences: candidate.preferences, config: loadAutopilotConfig(w.vault), llm: createLlm([f.provider]), now: NOW, verifyAttachments: (refs) => resolveAttachments(w.vault, refs) });
};
const mailer = () => { const sent = []; return { sent, send: async (message) => { sent.push(message); return { status: 'sent' }; } }; };
const act = (w, m, extra = {}) => sendApplication({ vaultDir: w.vault, jobId: w.job.id, mailer: m, resolveAttachments, now: NOW, ...extra });

test('an approved job is emailed once, recorded, marked contacted and never emailed again', async () => {
  const w = vaultWorld();
  assert.equal((await reviewIt(w)).decision, 'approve');
  const m = mailer();
  const result = await act(w, m);
  assert.equal(result.status, 'sent');
  assert.deepEqual(m.sent.map((message) => [message.to, message.subject, message.attachments.length]), [['founder@tahoma.io', 'Founding Engineer at Tahoma AI', 1]]);
  const store = openStore(huntDbPath(w.vault));
  assert.equal(store.getJob(w.job.id).status, 'contacted');
  assert.equal(store.listEmails(w.job.id)[0].status, 'sent');
  assert.equal(store.listEmails(w.job.id)[0].detail.by, 'autopilot');
  assert.ok(store.listEvents(w.job.id).some((event) => event.type === 'application_email_sent'));
  store.close();
  await assert.rejects(act(w, m), (error) => error instanceof Refused && /Refused by the checks|already/.test(error.message));
  assert.equal(m.sent.length, 1);
});

test('without a valid approval nothing is sent: never reviewed, rejected, or changed since', async () => {
  const w = vaultWorld();
  const m = mailer();
  await assert.rejects(act(w, m), (error) => error.code === 'NOT_APPROVED');
  await reviewIt(w, 'email', { decision: 'reject', confidence: 0.9, concerns: [], notes: 'no' });
  await assert.rejects(act(w, m), (error) => error.code === 'NOT_APPROVED');
  await reviewIt(w);
  const emailFile = w.store.getArtifacts(w.job.id).email_json.path;
  fs.writeFileSync(emailFile, fs.readFileSync(emailFile, 'utf8').replace('Founding Engineer at Tahoma AI', 'FOUNDING ENGINEER!!!'));
  await assert.rejects(act(w, m), (error) => error.code === 'NOT_APPROVED', 'edited after approval');
  assert.equal(m.sent.length, 0);
  await assert.rejects(sendApplication({ vaultDir: w.vault, jobId: 'job_0000000000000000', mailer: m }), (error) => error.code === 'UNKNOWN_JOB');
});

test('dry run records what it would do and sends nothing', async () => {
  const w = vaultWorld({ mode: 'dry_run' });
  await reviewIt(w);
  const m = mailer();
  const result = await act(w, m);
  assert.equal(result.status, 'dry_run');
  assert.equal(m.sent.length, 0);
  const store = openStore(huntDbPath(w.vault));
  assert.equal(store.getJob(w.job.id).status, 'scored');
  assert.equal(store.listEmails(w.job.id).length, 0);
  assert.ok(store.listEvents(w.job.id).some((event) => event.type === 'autopilot_dry_run' && event.detail.to === 'founder@tahoma.io'));
  store.close();
});

test('the checks run again at act time: a limit reached or a duplicate that appeared after the review stops it', async () => {
  const w = vaultWorld({ limits: 'limits:\n  emails_per_day: 1\n' });
  await reviewIt(w);
  const { job: other } = w.store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:2#0', company: 'Other', role: 'Engineer', rawText: 'x', applicationUrls: [], contactEmails: [], author: null });
  w.store.addEmail(other.id, { to: 'a@b.test', subject: 's', body: 'b', status: 'sent', idempotencyKey: 'k1' }, new Date(NOW.getTime() - 3600_000));
  const m = mailer();
  await assert.rejects(act(w, m), (error) => error.code === 'CHECKS_FAILED' && /under_daily_email_limit/.test(error.message));
  assert.equal(m.sent.length, 0);
});

test('a send that fails leaves the job open; an uncertain one blocks everything', async () => {
  const w = vaultWorld();
  await reviewIt(w);
  const failing = { send: async () => { throw new Error('apple_mail: Mail got an error'); } };
  await assert.rejects(act(w, failing), /Mail got an error/);
  let store = openStore(huntDbPath(w.vault));
  assert.equal(store.listEmails(w.job.id)[0].status, 'failed');
  assert.equal(store.getJob(w.job.id).status, 'scored', 'a failure before sending leaves the job open');
  store.close();
  const ok = mailer();
  assert.equal((await act(w, ok)).status, 'sent', 'a plain failure can be retried');

  const u = vaultWorld();
  await reviewIt(u);
  const uncertain = { send: async () => { throw new Error('apple_mail: send outcome uncertain (Mail did not answer in time)'); } };
  await assert.rejects(act(u, uncertain), /uncertain/);
  store = openStore(huntDbPath(u.vault));
  assert.equal(store.listEmails(u.job.id)[0].status, 'uncertain');
  assert.equal(store.getJob(u.job.id).status, 'uncertain');
  store.close();
  const again = mailer();
  await assert.rejects(act(u, again), (error) => error instanceof Refused);
  assert.equal(again.sent.length, 0, 'an uncertain outcome is never retried');
});

test('a second action for the same job while one is running is refused', async () => {
  const w = vaultWorld();
  await reviewIt(w);
  let release;
  const slow = { send: () => new Promise((resolve) => { release = resolve; }) };
  const first = act(w, slow);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(act(w, mailer()), (error) => error.code === 'IN_PROGRESS');
  release({});
  assert.equal((await first).status, 'sent');
});

test('form submission: needs an approved plan, honours dry run, and goes through the verified executor', async () => {
  const w = vaultWorld();
  const plan = { jobId: w.job.id, url: 'https://jobs.ashbyhq.com/x/1/application', schemaHash: 's', fields: [{ key: 'name', label: 'Name', type: 'text', required: true, value: 'Pat Example', origin: 'identity' }], unresolved: [], files: {}, blockers: [], needs: [], ready: true, planHash: 'p'.repeat(64) };
  w.store.addApplication(w.job.id, { url: plan.url, status: 'planned', plan, idempotencyKey: 'fk' });
  const calls = [];
  const execute = async (options) => { calls.push({ submit: options.submit }); if (options.submit) await options.beforeSubmit(); return { status: options.submit ? 'submitted' : 'dry_run', screenshots: [] }; };
  await assert.rejects(submitApplicationForm({ vaultDir: w.vault, jobId: w.job.id, execute, now: NOW }), (error) => error.code === 'NOT_APPROVED');
  assert.equal(calls.length, 0);
  assert.equal((await reviewIt(w, 'form')).decision, 'approve');
  const result = await submitApplicationForm({ vaultDir: w.vault, jobId: w.job.id, execute, now: NOW });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(calls, [{ submit: true }]);
  const store = openStore(huntDbPath(w.vault));
  assert.equal(store.getJob(w.job.id).status, 'applied');
  assert.equal(store.listApplications(w.job.id)[0].status, 'submitted');
  store.close();
  await assert.rejects(submitApplicationForm({ vaultDir: w.vault, jobId: w.job.id, execute, now: NOW }), (error) => error instanceof Refused);
  assert.equal(calls.length, 1);

  const d = vaultWorld({ mode: 'dry_run' });
  d.store.addApplication(d.job.id, { url: plan.url, status: 'planned', plan: { ...plan, jobId: d.job.id }, idempotencyKey: 'fk2' });
  await reviewIt(d, 'form');
  const dry = await submitApplicationForm({ vaultDir: d.vault, jobId: d.job.id, execute, now: NOW });
  assert.equal(dry.status, 'dry_run');
  assert.deepEqual(calls.at(-1), { submit: false }, 'a dry run fills but never submits');
});

test('the MCP tools take only a job id', async () => {
  const text = fs.readFileSync(new URL('../mcp/jobs/server.js', import.meta.url), 'utf8');
  for (const tool of ['send_application', 'submit_application']) {
    const block = text.slice(text.indexOf(`${tool}: {`), text.indexOf(`${tool}: {`) + 900);
    assert.match(block, /properties: \{ job_id: \{ type: 'string'/);
    assert.match(block, /required: \['job_id'\]/);
    const schema = block.slice(block.indexOf('inputSchema'), block.indexOf('handler'));
    assert.doesNotMatch(schema, /\bto:|recipient|\burl\b|subject|attachments|body/i, 'the input schema offers nothing but the job id');
  }
});

test('a headed submit is requested from the executor only when the owner opted in', async () => {
  for (const [yamlText, expected] of [['', false], ['browser:\n  headed: true\n', true]]) {
    const w = vaultWorld();
    fs.appendFileSync(path.join(w.vault, 'job-hunt', 'autopilot.yaml'), yamlText);
    const plan = { jobId: w.job.id, url: 'https://jobs.ashbyhq.com/x/1/application', schemaHash: 's', fields: [{ key: 'name', label: 'Name', type: 'text', required: true, value: 'Pat Example', origin: 'identity' }], unresolved: [], files: {}, blockers: [], needs: [], ready: true, planHash: 'p'.repeat(64) };
    w.store.addApplication(w.job.id, { url: plan.url, status: 'planned', plan, idempotencyKey: `hk${expected}` });
    await reviewIt(w, 'form');
    const seen = [];
    await submitApplicationForm({ vaultDir: w.vault, jobId: w.job.id, now: NOW, execute: async (options) => { seen.push(options.headed); await options.beforeSubmit?.(); return { status: 'submitted', screenshots: [] }; } });
    assert.deepEqual(seen, [expected]);
  }
});
