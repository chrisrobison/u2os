import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../mcp/jobs/hunt/storage/store.js';
import { planApplication, submitApplication } from '../mcp/jobs/hunt/applications/form/submit.js';
import { schemaHash } from '../mcp/jobs/hunt/applications/form/schema.js';
import { driverNames, playwrightDriver, registerDriver, resolveDriver, unregisterDriver } from '../mcp/jobs/hunt/applications/form/driver.js';
import { loadAutopilotConfig } from '../mcp/jobs/hunt/autopilot/config.js';
import { RESUME, PREFS, fakeLlm } from './fixtures/job-hunt-candidate.js';
import { createLlm } from '../mcp/jobs/hunt/llm/structured.js';
import { candidateDigest } from '../mcp/jobs/hunt/candidate/profile.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const FIELDS = [
  { key: 'name', type: 'text', label: 'Full name', required: true, filled: false },
  { key: 'email', type: 'email', label: 'Email', required: true, filled: false },
  { key: 'resume', type: 'file', label: 'Resume', required: true, filled: false },
];
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A fake driver that honours the whole contract; `outcome` is what its "submit button" reports. */
function fakeDriver({ fields = FIELDS, outcome = { status: 'submitted' } } = {}) {
  const calls = { inspect: [], execute: [], order: [] };
  return {
    calls,
    inspect: async ({ url }) => { calls.inspect.push(url); return { hasForm: true, blockers: {}, fields: fields.map((f) => ({ ...f })) }; },
    execute: async ({ plan, files = {}, submit = true, beforeSubmit = async () => {} }) => {
      calls.execute.push({ submit });
      if (schemaHash(fields) !== plan.schemaHash) return { status: 'schema_changed', reason: 'the form asks different questions than when it was planned' };
      for (const [name, expected] of Object.entries(plan.files ?? {})) if (!files[name] || sha(files[name].path) !== expected.sha256) return { status: 'files_changed', reason: `${name} changed` };
      if (!submit) return { status: 'dry_run' };
      calls.order.push('beforeSubmit');
      await beforeSubmit();
      calls.order.push('click');
      return outcome;
    },
  };
}

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-driver-'));
  const store = openStore(':memory:');
  const url = 'https://boards.greenhouse.io/tahoma/jobs/1';
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:1#0', company: 'Tahoma AI', role: 'Founding Engineer', locations: ['Remote (US)'], remote: true, technologies: [], description: 'We build orchestration around LLM agents for operators.', rawText: 'Tahoma AI | Founding Engineer | Remote (US).', applicationUrls: [url], contactEmails: [], author: 'founder' });
  const resume = path.join(dir, 'resume.pdf');
  fs.writeFileSync(resume, '%PDF-1.4\nresume body\n%%EOF\n');
  store.addArtifact(job.id, 'resume_pdf', resume);
  const candidate = { resume: RESUME, preferences: PREFS, answers: { work_authorization_us: true, requires_sponsorship: false, custom: {}, policy: { accept_privacy_notices: true, accept_truthfulness_attestations: false } }, facts: { text: '', projects: [], voice: '' }, repos: [], digest: candidateDigest(RESUME, PREFS) };
  return { dir, store, job: store.getJob(job.id), resume, files: { resume: { path: resume } }, candidate, url };
}
const llm = () => createLlm([fakeLlm({ answers: {}, unanswerable: [] }).provider]);

test('the registry resolves playwright by default and rejects unknown drivers loudly', () => {
  assert.equal(resolveDriver(), playwrightDriver);
  assert.equal(resolveDriver('playwright'), playwrightDriver);
  assert.ok(driverNames().includes('playwright'));
  assert.throws(() => resolveDriver('selenium'), /Unknown form driver "selenium" \(available: playwright/);
  assert.throws(() => resolveDriver({ inspect() {} }), /inspect\(\) and execute\(\)/);
  assert.throws(() => registerDriver('Bad Name', fakeDriver()), /lowercase/);
  assert.throws(() => registerDriver('half', { inspect() {} }), /inspect\(\) and execute\(\)/);
  assert.throws(() => registerDriver('playwright', fakeDriver()), /cannot be replaced/);
  const fake = registerDriver('fake', fakeDriver());
  assert.equal(resolveDriver('fake'), fake);
  unregisterDriver('fake');
  unregisterDriver('playwright');
  assert.equal(resolveDriver('playwright'), playwrightDriver, 'the default cannot be unregistered');
  assert.throws(() => resolveDriver('fake'), /Unknown form driver/);
});

test('browser.driver in autopilot.yaml defaults to playwright; a registered name is accepted; an unknown one fails loudly', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-driver-cfg-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  const write = (text) => fs.writeFileSync(path.join(vault, 'job-hunt', 'autopilot.yaml'), text);
  assert.equal(loadAutopilotConfig(vault).browser.driver, 'playwright');
  write('browser:\n  headed: true\n');
  assert.deepEqual(loadAutopilotConfig(vault).browser, { driver: 'playwright', headed: true });
  write('browser:\n  driver: fake\n');
  assert.throws(() => loadAutopilotConfig(vault), /browser\.driver must be one of playwright/);
  registerDriver('fake', fakeDriver());
  try { assert.equal(loadAutopilotConfig(vault).browser.driver, 'fake'); } finally { unregisterDriver('fake'); }
  write('browser:\n  driver: 7\n');
  assert.throws(() => loadAutopilotConfig(vault), /browser\.driver/);
});

test('planning reads the form through the driver; an injected inspect still wins', async () => {
  const w = world();
  const driver = fakeDriver();
  const application = await planApplication({ store: w.store, job: w.job, candidate: w.candidate, llm: llm(), driver, now: NOW });
  assert.deepEqual(driver.calls.inspect, [w.url]);
  assert.equal(application.plan.schemaHash, schemaHash(FIELDS));

  const other = fakeDriver();
  const injected = [];
  await planApplication({ store: w.store, job: w.job, candidate: w.candidate, llm: llm(), driver: other, inspect: async (url) => { injected.push(url); return { hasForm: true, blockers: {}, fields: FIELDS.map((f) => ({ ...f })) }; }, now: NOW });
  assert.deepEqual([injected, other.calls.inspect], [[w.url], []]);
});

test('a real submit goes through the driver, with intent recorded before the click', async () => {
  const w = world();
  const driver = fakeDriver();
  await planApplication({ store: w.store, job: w.job, candidate: w.candidate, llm: llm(), driver, now: NOW });
  const dry = await submitApplication({ store: w.store, job: w.job, files: w.files, submit: false, driver, now: NOW });
  assert.equal(dry.result.status, 'dry_run');
  assert.deepEqual(driver.calls.order, [], 'a dry run never records intent');
  assert.equal(w.store.getJob(w.job.id).status, 'discovered');

  let statusAtClick;
  const spy = { ...driver, execute: async (args) => { const wrapped = { ...args, beforeSubmit: async () => { await args.beforeSubmit(); statusAtClick = w.store.listApplications(w.job.id).at(-1).status; } }; return driver.execute(wrapped); } };
  const done = await submitApplication({ store: w.store, job: w.store.getJob(w.job.id), files: w.files, driver: spy, now: NOW });
  assert.equal(done.result.status, 'submitted');
  assert.equal(statusAtClick, 'submitting', 'intent is stored before the click');
  assert.deepEqual(driver.calls.order, ['beforeSubmit', 'click']);
  assert.equal(done.application.status, 'submitted');
  assert.equal(w.store.getJob(w.job.id).status, 'applied');
});

test('driver-reported schema and file changes stop the run before intent is recorded', async () => {
  const w = world();
  await planApplication({ store: w.store, job: w.job, candidate: w.candidate, llm: llm(), driver: fakeDriver(), now: NOW });
  const changed = fakeDriver({ fields: [...FIELDS, { key: 'extra', type: 'text', label: 'Extra', required: false, filled: false }] });
  const stopped = await submitApplication({ store: w.store, job: w.job, files: w.files, driver: changed, now: NOW });
  assert.equal(stopped.result.status, 'schema_changed');
  assert.deepEqual(changed.calls.order, []);
  assert.equal(stopped.application.status, 'needs_input');

  const w2 = world();
  const driver = fakeDriver();
  await planApplication({ store: w2.store, job: w2.job, candidate: w2.candidate, llm: llm(), driver, now: NOW });
  fs.writeFileSync(w2.resume, 'a different resume');
  const files = await submitApplication({ store: w2.store, job: w2.job, files: w2.files, driver, now: NOW });
  assert.equal(files.result.status, 'files_changed');
  assert.deepEqual(driver.calls.order, []);
});

test('an unconfirmed driver outcome is uncertain and never retried; an unknown status is uncertain too', async () => {
  const w = world();
  const driver = fakeDriver({ outcome: { status: 'unconfirmed', reason: 'no confirmation seen' } });
  await planApplication({ store: w.store, job: w.job, candidate: w.candidate, llm: llm(), driver, now: NOW });
  const first = await submitApplication({ store: w.store, job: w.job, files: w.files, driver, now: NOW });
  assert.equal(first.application.status, 'unconfirmed');
  assert.equal(w.store.getJob(w.job.id).status, 'uncertain');
  await assert.rejects(submitApplication({ store: w.store, job: w.store.getJob(w.job.id), files: w.files, driver, now: NOW }), /already unconfirmed/);
  assert.equal(driver.calls.execute.length, 1);

  const x = world();
  const odd = fakeDriver({ outcome: { status: 'something_new' } });
  await planApplication({ store: x.store, job: x.job, candidate: x.candidate, llm: llm(), driver: odd, now: NOW });
  assert.equal((await submitApplication({ store: x.store, job: x.job, files: x.files, driver: odd, now: NOW })).application.status, 'uncertain');
});

test('a driver that throws after beforeSubmit leaves the application submitting (recovered later as uncertain)', async () => {
  const w = world();
  const driver = { ...fakeDriver(), execute: async ({ beforeSubmit }) => { await beforeSubmit(); throw new Error('driver crashed after the click'); } };
  await planApplication({ store: w.store, job: w.job, candidate: w.candidate, llm: llm(), driver, now: NOW });
  await assert.rejects(submitApplication({ store: w.store, job: w.job, files: w.files, driver, now: NOW }), /driver crashed/);
  await assert.rejects(submitApplication({ store: w.store, job: w.store.getJob(w.job.id), files: w.files, driver, now: NOW }), /already submitting/);
});

test('a registered driver is selected by name, and an injected execute still overrides the driver', async () => {
  const w = world();
  const driver = fakeDriver();
  registerDriver('fake', driver);
  try {
    await planApplication({ store: w.store, job: w.job, candidate: w.candidate, llm: llm(), driver: 'fake', now: NOW });
    assert.equal(driver.calls.inspect.length, 1);
    const overridden = await submitApplication({ store: w.store, job: w.job, files: w.files, driver: 'fake', execute: async () => ({ status: 'failed', reason: 'injected' }), now: NOW });
    assert.equal(overridden.result.reason, 'injected');
    assert.equal(driver.calls.execute.length, 0);
    await assert.rejects(submitApplication({ store: w.store, job: w.job, files: w.files, driver: 'nope', now: NOW }), /Unknown form driver "nope"/);
  } finally { unregisterDriver('fake'); }
});
