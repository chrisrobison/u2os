import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { idempotencyKey, proposeApplicationEmail, reconcileEmails, sendBlockers } from '../mcp/jobs/hunt/applications/send.js';
import { main as jobCli } from '../server/jobhunt/cli.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const REF = `outbox/${'a'.repeat(64)}/Pat_Resume.pdf`;
const SCORE = { score: 86, confidence: 0.9, label: 'strong', dimensions: {}, reasons: ['Direct overlap'], concerns: [], recommendedNarrative: 'ai-agent-systems', projects: [], flags: [], degraded: false, model: 'm' };

function setup({ draft = {}, score = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-send-'));
  const store = openStore(':memory:');
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:1#0', company: 'Pond AI', role: 'Head of Engineering', rawText: 'Pond AI | Head of Engineering', applicationUrls: [], contactEmails: ['dylan@pond.example'], author: 'd' });
  store.saveScore(job.id, { ...SCORE, ...score });
  const file = path.join(dir, 'email.json');
  fs.writeFileSync(file, JSON.stringify({ to: 'dylan@pond.example', subject: 'Head of Engineering', text: 'Hi,\n\nBody', attachments: [REF], needsInput: [], ...draft }));
  store.addArtifact(job.id, 'email_json', file);
  const proposals = [];
  const respond = (status) => async (proposal) => { proposals.push(proposal); return { id: `act_${proposals.length}`, status }; };
  return { store, job: store.getJob(job.id), proposals, respond };
}
const run = (ctx, propose, extra = {}) => proposeApplicationEmail({ store: ctx.store, job: ctx.store.getJob(ctx.job.id), candidateEmail: 'pat@example.com', minimumScore: 82, propose, now: NOW, ...extra });

test('send goes through the gate: the pipeline sends nothing itself and records the proposal', async () => {
  const ctx = setup();
  const { email, outcome } = await run(ctx, ctx.respond('pending'));
  assert.equal(outcome.status, 'pending');
  assert.equal(email.status, 'proposed');
  assert.deepEqual(ctx.proposals[0].arguments, { to: 'dylan@pond.example', subject: 'Head of Engineering', body: 'Hi,\n\nBody', attachments: [REF] });
  assert.equal(ctx.proposals[0].tool, 'email.send');
  assert.equal(ctx.store.getJob(ctx.job.id).status, 'scored', 'not contacted until the send actually executes');
  assert.ok(ctx.store.listEvents(ctx.job.id).some((event) => event.type === 'email_proposed' && event.detail.actionId === 'act_1'));
});

test('a second send for the same job is blocked and never proposes again', async () => {
  const ctx = setup();
  await run(ctx, ctx.respond('pending'));
  await assert.rejects(run(ctx, ctx.respond('pending')), (error) => error.code === 'BLOCKED' && /already proposed/.test(error.message));
  await assert.rejects(run(ctx, ctx.respond('pending'), { force: true }), /even with --force/);
  assert.equal(ctx.proposals.length, 1);
});

test('the idempotency key is stable for a job and recipient and differs otherwise', () => {
  const job = { id: 'job_1', company: 'Pond AI', role: 'Head of Engineering' };
  const key = idempotencyKey({ candidate: 'pat@example.com', job, to: 'Dylan@Pond.example' });
  assert.equal(key, idempotencyKey({ candidate: 'pat@example.com', job: { ...job, company: 'POND AI, Inc.' }, to: 'dylan@pond.example' }));
  assert.notEqual(key, idempotencyKey({ candidate: 'pat@example.com', job, to: 'other@pond.example' }));
  assert.notEqual(key, idempotencyKey({ candidate: 'pat@example.com', job, to: 'dylan@pond.example', kind: 'followup' }));
});

test('a failed proposal frees the key for a retry; an unfinished attempt blocks', async () => {
  const ctx = setup();
  await assert.rejects(run(ctx, async () => { throw new Error('crash'); }), /crash/);
  assert.equal(ctx.store.listEmails(ctx.job.id)[0].status, 'failed');
  const retry = await run(ctx, ctx.respond('pending'));
  assert.equal(retry.email.status, 'proposed');
  assert.equal(ctx.store.listEmails(ctx.job.id).length, 1, 'the failed row was reused, not duplicated');
  const stuck = setup();
  stuck.store.addEmail(stuck.job.id, { to: 'dylan@pond.example', subject: 's', body: 'b', status: 'proposing', idempotencyKey: 'k' }, NOW);
  assert.match(sendBlockers({ store: stuck.store, job: stuck.job, score: stuck.store.getScore(stuck.job.id), minimumScore: 82 }).join(), /did not finish/);
});

test('refuses drafts that need input, lack attachments, are below threshold or degraded', async () => {
  const needs = setup({ draft: { needsInput: ['a link to something you built'] } });
  await assert.rejects(run(needs, needs.respond('pending')), /facts do not cover/);
  const noAttach = setup({ draft: { attachments: [] } });
  await assert.rejects(run(noAttach, noAttach.respond('pending')), /no staged attachments/);
  const low = setup({ score: { score: 78, label: 'plausible' } });
  await assert.rejects(run(low, low.respond('pending')), /below the threshold 82/);
  const degraded = setup({ score: { degraded: true } });
  await assert.rejects(run(degraded, degraded.respond('pending')), /degraded/);
  assert.equal(needs.proposals.length + low.proposals.length + degraded.proposals.length + noAttach.proposals.length, 0);
});

test('reconcile: executed sends mark the job contacted with a follow-up date; rejected sends free it; uncertain ones block', async () => {
  const ctx = setup();
  await run(ctx, ctx.respond('pending'));
  assert.deepEqual(reconcileEmails({ store: ctx.store, lookup: () => ({ status: 'pending' }), now: NOW }), []);
  const done = reconcileEmails({ store: ctx.store, lookup: () => ({ status: 'executed' }), now: NOW });
  assert.equal(done[0].to, 'sent');
  const job = ctx.store.getJob(ctx.job.id);
  assert.equal(job.status, 'contacted');
  assert.equal(ctx.store.listEmails(job.id)[0].detail.followUpAfter, '2026-10-12T12:00:00.000Z');
  await assert.rejects(run(ctx, ctx.respond('pending')), /already/);

  const rejected = setup();
  await run(rejected, rejected.respond('pending'));
  reconcileEmails({ store: rejected.store, lookup: () => ({ status: 'rejected' }), now: NOW });
  assert.equal(rejected.store.listEmails(rejected.job.id)[0].status, 'rejected');
  assert.equal((await run(rejected, rejected.respond('pending'))).email.status, 'proposed', 'a rejected send can be proposed again');

  const uncertain = setup();
  await run(uncertain, uncertain.respond('pending'));
  reconcileEmails({ store: uncertain.store, lookup: () => ({ status: 'failed', result: { error: 'gmail: send outcome uncertain (status 504)' } }), now: NOW });
  assert.equal(uncertain.store.getJob(uncertain.job.id).status, 'uncertain');
  await assert.rejects(run(uncertain, uncertain.respond('pending'), { force: true }), /uncertain outcome/);
});

test('an autonomous send that executes at once marks the job contacted', async () => {
  const ctx = setup();
  const { email } = await run(ctx, ctx.respond('executed'));
  assert.equal(email.status, 'sent');
  assert.equal(ctx.store.getJob(ctx.job.id).status, 'contacted');
});

test('CLI: send and reconcile use the injected gate', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-send-cli-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify({ basics: { name: 'Pat', email: 'pat@example.com' }, work: [] }));
  const store = openStore(huntDbPath(vault));
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:9#0', company: 'Pond AI', role: 'Head of Engineering', rawText: 'x', applicationUrls: [], contactEmails: ['dylan@pond.example'], author: 'd' });
  store.saveScore(job.id, { ...SCORE, score: 90, label: 'exceptional' });
  const file = path.join(vault, 'email.json');
  fs.writeFileSync(file, JSON.stringify({ to: 'dylan@pond.example', subject: 'S', text: 'T', attachments: [REF], needsInput: [] }));
  store.addArtifact(job.id, 'email_json', file);
  store.close();
  const lines = [];
  const out = { log: (line) => lines.push(line) };
  const code = await jobCli(['send', job.id], out, { vaultDir: vault, now: NOW, send: (operation) => operation(async () => ({ id: 'act_9', status: 'pending' })) });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /waiting for your approval.*act_9/);
  assert.match(lines.join('\n'), /Pat_Resume\.pdf/);
  lines.length = 0;
  assert.equal(await jobCli(['reconcile'], out, { vaultDir: vault, now: NOW, reconcile: (operation) => operation(() => ({ status: 'executed' })) }), 0);
  assert.match(lines.join('\n'), /dylan@pond.example: sent/);
});
