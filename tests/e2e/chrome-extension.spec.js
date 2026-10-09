import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, chromium } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer } from './helpers.js';
import { startApplyForms } from '../fixtures/apply-forms.js';
import { RESUME, fakeLlm } from '../fixtures/job-hunt-candidate.js';
import { openStore, huntDbPath } from '../../mcp/jobs/hunt/storage/store.js';
import { planHash } from '../../mcp/jobs/hunt/applications/form/plan.js';
import { readFormSchema, schemaHash } from '../../mcp/jobs/hunt/applications/form/schema.js';
import { reviewJob } from '../../mcp/jobs/hunt/review/agent.js';
import { loadCandidate } from '../../mcp/jobs/hunt/candidate/load.js';
import { loadAutopilotConfig } from '../../mcp/jobs/hunt/autopilot/config.js';
import { createLlm } from '../../mcp/jobs/hunt/llm/structured.js';
import { main as jobCli } from '../../server/jobhunt/cli.js';

// The unpacked Chrome extension (extension/) against the apply-form fixtures and a real U2OS server: pair with a
// code from the CLI, fill a reviewed plan, and leave submit to the owner unless "submit when complete" is on.
// Extensions need a full Chromium (new headless); where this machine cannot load one the scenarios skip.
const EXTENSION = path.resolve(import.meta.dirname, '..', '..', 'extension');
const NOW = new Date();
const POSTING = 'Tahoma AI | Founding Engineer | Remote (US)\nWe build deterministic orchestration around agents. Apply through our form.';

test.describe.configure({ mode: 'serial' });

let forms;
let dedicated;
let context;
let extensionId;
let userDataDir;
let skipReason = null;

test.beforeAll(async ({ browserName }) => {
  if (browserName !== 'chromium') { skipReason = 'Chrome extension: Chromium only'; return; }
  forms = await startApplyForms();
  dedicated = await startDedicatedServer();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2-ext-profile-'));
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    extensionId = new URL(worker.url()).host;
  } catch (error) { skipReason = `this Chromium cannot load an unpacked extension (${String(error.message).split('\n')[0]})`; }
});
test.afterAll(async () => {
  await context?.close().catch(() => {});
  if (dedicated) await stopDedicatedServer(null, dedicated);
  await forms?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});
test.beforeEach(() => { test.skip(!!skipReason, skipReason ?? ''); });

/** A reviewed, approved, planned application for the form at `route`, exactly as the autopilot's planner would leave it. */
async function plannedApplication({ route, fields, live }) {
  const vault = path.join(dedicated._dataDir, 'vault');
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify(RESUME));
  fs.writeFileSync(path.join(vault, 'job-hunt', 'facts.md'), '## D. Harris Tours\n- Grew the fleet from 2 to 14 vehicles.\n');
  fs.writeFileSync(path.join(vault, 'job-hunt', 'autopilot.yaml'), `enabled: true\nmode: ${live ? 'live' : 'dry_run'}\n`);
  const pdfPath = path.join(dedicated._dataDir, 'resume.pdf');
  const pdf = Buffer.from('%PDF-1.4 resume bytes for the extension test');
  fs.writeFileSync(pdfPath, pdf);
  const url = `${forms.base}${route}`;
  const probe = await context.newPage();
  await probe.goto(url);
  const hash = schemaHash((await readFormSchema(probe)).fields);
  await probe.close();

  const store = openStore(huntDbPath(vault));
  try {
    const key = crypto.randomBytes(4).toString('hex');
    const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:${key}#0`, company: `Tahoma AI ${key}`, role: 'Founding Engineer', locations: ['Remote (US)'], remote: true, technologies: [], description: POSTING, rawText: POSTING, applicationUrls: [], contactEmails: [], author: 'founder' });
    store.saveScore(job.id, { score: 90, confidence: 0.9, label: 'exceptional', dimensions: {}, reasons: ['Direct overlap'], concerns: [], recommendedNarrative: 'ai-agent-systems', projects: [], flags: [], degraded: false, model: 'm' });
    fs.writeFileSync(path.join(dedicated._dataDir, `resume-${key}.txt`), 'Pat Example\nCTO at D. Harris Tours\n');
    store.addArtifact(job.id, 'resume_txt', path.join(dedicated._dataDir, `resume-${key}.txt`));
    store.addArtifact(job.id, 'resume_pdf', pdfPath);
    const plan = { jobId: job.id, url, schemaHash: hash, submitLabel: 'Submit', fields, unresolved: [], files: { resume: { sha256: crypto.createHash('sha256').update(pdf).digest('hex') } }, blockers: [], needs: [], ready: true };
    plan.planHash = planHash(plan);
    store.addApplication(job.id, { url, status: 'planned', plan, idempotencyKey: `k-${key}` });
    const candidate = loadCandidate(vault);
    await reviewJob({ store, job: store.getJob(job.id), kind: 'form', candidate, preferences: candidate.preferences, config: loadAutopilotConfig(vault), llm: createLlm([fakeLlm({ decision: 'approve', confidence: 0.9, concerns: [], notes: 'ok' }).provider]), now: NOW });
    return { company: store.getJob(job.id).company, jobId: job.id, planHash: plan.planHash, vault, status: () => { const s = openStore(huntDbPath(vault)); try { return s.listApplications(job.id).at(-1); } finally { s.close(); } } };
  } finally { store.close(); }
}

const ASHBY_FIELDS = [
  { key: '_systemfield_name', label: 'Full name', type: 'text', required: true, value: 'Pat Example', origin: 'identity' },
  { key: '_systemfield_email', label: 'Email', type: 'email', required: true, value: 'pat@example.com', origin: 'identity' },
  { key: 'phone', label: 'Phone', type: 'tel', required: false, value: '555-0100', origin: 'identity' },
  { key: '_systemfield_resume', label: 'Resume', type: 'file', required: true, file: 'resume', fileName: 'Pat_Example_Resume.pdf', origin: 'upload' },
  { key: 'why', label: 'Why do you want to work at Tahoma?', type: 'textarea', required: true, value: 'I build deterministic systems around agents.', origin: 'generated' },
  { key: 'auth', label: 'Are you legally authorized to work in the United States?', type: 'radio', required: true, value: 'Yes', origin: 'answers' },
  { key: 'sponsor', label: 'Will you now or in the future require visa sponsorship?', type: 'radio', required: true, value: 'No', origin: 'answers' },
  { key: 'heard', label: 'How did you hear about us?', type: 'select', required: false, value: 'Hacker News', origin: 'answers' },
  { key: 'privacy', label: 'I agree to the privacy policy', type: 'checkbox', required: true, value: 'Yes', origin: 'answers' },
];

async function openPanel(company) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // The pairing is kept in the profile: only the first panel needs a code.
  if (await panel.locator('#pair-view').isVisible()) {
    await panel.locator('#server').fill(dedicated.baseURL);
    const logs = [];
    const out = { log: (line) => logs.push(line) };
    expect(await jobCli(['extension', 'pair'], out, { dataDir: dedicated._dataDir })).toBe(0);
    const code = /Pairing code: ([A-Z0-9-]+)/.exec(logs.join('\n'))[1];
    await panel.locator('#code').fill(code);
    await panel.locator('#pair-form button').click();
  }
  await expect(panel.locator('#main-view')).toBeVisible();
  await expect(panel.locator('#applications li')).toContainText([company]);
  return panel;
}

test('pairs, fills a reviewed plan, highlights it, and leaves submit to the owner', async () => {
  const app = await plannedApplication({ route: '/ashby/application', fields: ASHBY_FIELDS, live: false });
  const panel = await openPanel(app.company);
  const before = forms.submissions.length;

  // The token is kept in extension storage and nowhere else.
  const stored = await panel.evaluate(() => chrome.storage.local.get(null));
  expect(stored.token).toMatch(/^u2x_/);
  expect(await panel.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(stored.token);

  await panel.locator('#applications li', { hasText: app.company }).locator('button').click();
  await expect(panel.locator('#status')).toContainText('Filled', { timeout: 30_000 });
  const job = context.pages().find((page) => page.url().endsWith('/ashby/application'));
  expect(job).toBeTruthy();

  await expect(job.locator('[name="_systemfield_name"]')).toHaveValue('Pat Example');
  await expect(job.locator('[name="_systemfield_email"]')).toHaveValue('pat@example.com');
  await expect(job.locator('[name="why"]')).toHaveValue('I build deterministic systems around agents.');
  await expect(job.locator('[name="auth"][value="yes"]')).toBeChecked();
  await expect(job.locator('[name="sponsor"][value="no"]')).toBeChecked();
  await expect(job.locator('[name="heard"]')).toHaveValue('Hacker News');
  await expect(job.locator('[name="privacy"]')).toBeChecked();
  expect(await job.locator('[name="_systemfield_resume"]').evaluate((input) => [input.files.length, input.files[0].name, input.files[0].type])).toEqual([1, 'Pat_Example_Resume.pdf', 'application/pdf']);
  // Filled fields are outlined and the owner is told to review and submit.
  await expect(job.locator('[name="_systemfield_name"]')).toHaveAttribute('data-u2-state', 'filled');
  await expect(job.locator('#u2-filler-banner')).toContainText('press submit yourself');

  // Nothing was submitted, and the channel was told the form was filled (not submitted).
  expect(forms.submissions.length).toBe(before);
  const row = app.status();
  expect(row.status).toBe('planned');
  expect(row.result.outcome).toBe('filled');
  expect(row.result.via).toBe('extension');
  await job.close();
  await panel.close();
});

test('submit when complete records intent, clicks submit and reports the board\'s confirmation (live mode)', async () => {
  const app = await plannedApplication({ route: '/ashby/application', fields: ASHBY_FIELDS, live: true });
  const panel = await openPanel(app.company);
  const before = forms.submissions.length;
  await panel.locator('#submit-when-complete').check();
  await panel.locator('#applications li', { hasText: app.company }).locator('button').click();
  await expect(panel.locator('#status')).toContainText('Submitted', { timeout: 40_000 });
  expect(forms.submissions.length).toBe(before + 1);
  expect(forms.submissions.at(-1).fields._systemfield_name).toBe('Pat Example');
  expect(forms.submissions.at(-1).fields._systemfield_resume).toMatch(/^file:Pat_Example_Resume\.pdf:/);
  const row = app.status();
  expect(row.status).toBe('submitted');
  expect(row.result.via).toBe('extension');
  await panel.close();
  for (const page of context.pages()) if (page.url().startsWith(forms.base)) await page.close();
});

test('stops on a CAPTCHA without touching the form', async () => {
  const app = await plannedApplication({ route: '/captcha/apply', live: false, fields: [
    { key: 'first_name', label: 'First Name', type: 'text', required: true, value: 'Pat', origin: 'identity' },
  ] });
  const panel = await openPanel(app.company);
  await panel.locator('#applications li', { hasText: app.company }).locator('button').click();
  await expect(panel.locator('#status')).toContainText('CAPTCHA', { timeout: 30_000 });
  const job = context.pages().find((page) => page.url().endsWith('/captcha/apply'));
  await expect(job.locator('[name="first_name"]')).toHaveValue('');
  const row = app.status();
  expect(row.status).toBe('planned');
  expect(row.result.outcome).toBe('failed');
  expect(row.result.reason).toMatch(/captcha/);
  await panel.close();
  await job.close();
});
