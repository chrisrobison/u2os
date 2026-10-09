import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CAPTCHA_SELECTOR, readFormSchema, schemaHash } from './schema.js';

// Executing a reviewed application plan in headless Chromium.
//
// Order matters, and each step can stop the run:
//   1. open the page; a CAPTCHA, login wall or missing form stops it (never evaded)
//   2. the form must still ask the same questions as when the plan was made
//   3. uploaded files must still be the exact files the plan was made with
//   4. fill from the plan; every required field must end up filled
//   5. record intent (the caller marks the application "submitting") BEFORE the click
//   6. click submit and look for the board's own confirmation
// A crash between 5 and 6 leaves "submitting" with no outcome, which callers
// treat as uncertain and never retry.

const SUCCESS_TEXT = /thank you for (applying|your (application|interest|submission))|application (has been |was )?(received|submitted|sent)|we('ve| have) received your application|successfully (applied|submitted)|your application is (in|complete)/i;
const SUCCESS_URL = /confirmation|thank-?you|thanks|submitted|success/i;

export async function launchBrowser(env = process.env) {
  let playwright;
  try { playwright = await import('playwright'); } catch { throw new Error('Playwright is not installed. Run: npm install && npx playwright install chromium'); }
  return playwright.chromium.launch({ headless: true, ...(env.JOBS_BROWSER_PATH ? { executablePath: env.JOBS_BROWSER_PATH } : {}) });
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sel = (key) => `[data-u2=${JSON.stringify(key)}]`;

async function openApplication(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  page.setDefaultTimeout(15_000);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('form', { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return page;
}

/** Read-only: open the application page and report its form (used to make a plan). */
export async function inspectApplication({ url, env = process.env }) {
  const browser = await launchBrowser(env);
  try {
    const page = await openApplication(browser, url);
    return await readFormSchema(page);
  } finally { await browser.close().catch(() => {}); }
}

function matchOption(options = [], value) {
  const wanted = String(value).trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === wanted) || options.find((option) => option.toLowerCase().startsWith(wanted)) || options.find((option) => option.toLowerCase().includes(wanted)) || null;
}

async function setField(page, entry, schemaField, files) {
  const control = page.locator(sel(entry.key));
  if (entry.file) {
    await control.first().setInputFiles(files[entry.file].path);
    return true;
  }
  const value = entry.value;
  const options = schemaField?.options ?? entry.options ?? [];
  try {
    switch (schemaField?.type ?? entry.type) {
      case 'buttons': {
        const wanted = matchOption(options, value);
        if (!wanted) return false;
        await page.locator(`[data-u2-btn=${JSON.stringify(entry.key)}]`).nth(options.indexOf(wanted)).click();
        return true;
      }
      case 'select':
        await control.first().selectOption({ label: matchOption(options, value) ?? value });
        return true;
      case 'checkbox':
        if (options.length <= 1) { if (/^(yes|true)$/i.test(value)) await control.first().check(); return true; }
        // falls through to option matching below
      case 'radio': { // eslint-disable-line no-fallthrough
        const wanted = matchOption(options, value);
        if (!wanted) return false;
        await control.nth(options.indexOf(wanted)).check({ force: true });
        return true;
      }
      case 'combobox':
        await control.first().click();
        await control.first().fill(String(value));
        await page.waitForTimeout(300);
        await control.first().press('Enter');
        return true;
      default:
        await control.first().fill(String(value));
        return true;
    }
  } catch { return false; }
}

async function findSubmit(page) {
  // The application form, or the page itself when the board renders no <form> (single-page apps).
  const index = await page.evaluate(() => { const forms = [...document.forms]; return forms.length ? forms.indexOf(forms.slice().sort((a, b) => b.elements.length - a.elements.length)[0]) : -1; });
  const scope = index >= 0 ? page.locator('form').nth(index) : page.locator('body');
  const candidates = [scope.locator('button[type="submit"], input[type="submit"]'), scope.locator('button:has-text("Submit")'), scope.locator('button:has-text("Apply")')];
  for (const candidate of candidates) if (await candidate.count()) return candidate.first();
  return null;
}

async function outcome(page, timeoutMs, formUrl) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    if (await page.locator(CAPTCHA_SELECTOR).first().isVisible().catch(() => false)) return { status: 'manual_required', reason: 'captcha_after_submit' };
    const text = await page.locator('body').innerText().catch(() => '');
    if (SUCCESS_TEXT.test(text) || SUCCESS_URL.test(new URL(page.url()).pathname)) return { status: 'submitted' };
  }
  const errors = await page.locator('[role="alert"], .error, .field-error, .error-message, [aria-invalid="true"]').evaluateAll((elements) => elements
    .map((element) => (element.getAttribute('aria-invalid') === 'true' ? `invalid: ${element.name || element.id}` : element.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 5)).catch(() => []);
  const stillOnForm = page.url() === formUrl && await page.locator('form').count() > 0;
  // Only a form still showing its own validation errors counts as "not submitted".
  return errors.length && stillOnForm ? { status: 'failed', errors } : { status: 'unconfirmed' };
}

/**
 * @param plan    from buildApplicationPlan (reviewed)
 * @param files   { resume: { path }, cover_letter?: { path } } — verified against plan.files hashes
 * @param submit  false fills and checks but never submits (dry run)
 * @param beforeSubmit async () => void  called after everything is verified and before the click; throw to stop
 */
export async function executePlan({ plan, files = {}, submit = true, beforeSubmit = async () => {}, screenshotDir = null, env = process.env, outcomeTimeoutMs = Number(env.JOBS_SUBMIT_TIMEOUT_MS) || 20_000 }) {
  for (const [kind, expected] of Object.entries(plan.files ?? {})) {
    if (!files[kind] || !fs.existsSync(files[kind].path) || sha256(files[kind].path) !== expected.sha256) return { status: 'files_changed', reason: `${kind} is not the file the plan was made with` };
  }
  const browser = await launchBrowser(env);
  const shots = [];
  const shot = async (page, name) => {
    if (!screenshotDir) return null;
    try { fs.mkdirSync(screenshotDir, { recursive: true }); const file = path.join(screenshotDir, `${name}.png`); await page.screenshot({ path: file, fullPage: true }); shots.push(file); return file; } catch { return null; }
  };
  try {
    const page = await openApplication(browser, plan.url);
    const schema = await readFormSchema(page);
    if (schema.blockers?.captcha) return { status: 'manual_required', reason: 'captcha', screenshots: [await shot(page, 'blocked')].filter(Boolean) };
    if (!schema.hasForm || schema.blockers?.password) return { status: 'manual_required', reason: schema.blockers?.password ? 'login_required' : 'no_form', screenshots: [await shot(page, 'blocked')].filter(Boolean) };
    if (schemaHash(schema.fields) !== plan.schemaHash) return { status: 'schema_changed', reason: 'the form asks different questions than when it was planned' };

    const byKey = new Map(schema.fields.map((field) => [field.key, field]));
    const failed = [];
    for (const entry of plan.fields) {
      if (!byKey.has(entry.key)) continue;
      if (!(await setField(page, entry, byKey.get(entry.key), files))) failed.push(entry.key);
    }
    const after = await readFormSchema(page);
    const missing = after.fields.filter((field) => field.required && !field.filled).map((field) => field.label || field.key);
    const formShot = await shot(page, 'form');
    if (failed.length || missing.length) return { status: 'fill_incomplete', failed, missing, screenshots: [formShot].filter(Boolean) };
    if (!submit) return { status: 'dry_run', screenshots: [formShot].filter(Boolean) };

    const button = await findSubmit(page);
    if (!button) return { status: 'manual_required', reason: 'no_submit_button', screenshots: [formShot].filter(Boolean) };
    await beforeSubmit(); // the caller records intent here: from now on the outcome is uncertain until proven otherwise
    // What the page's own network calls said after the click: the evidence when a submit is not confirmed.
    const evidence = [];
    page.on('response', async (response) => {
      if (response.request().method() !== 'POST' || evidence.length >= 8) return;
      let body = '';
      try { body = (await response.text()).replace(/\s+/g, ' ').slice(0, 240); } catch { /* not readable */ }
      try { evidence.push({ path: new URL(response.url()).pathname.slice(0, 90), status: response.status(), body }); } catch { /* odd url */ }
    });
    await button.click();
    const result = await outcome(page, outcomeTimeoutMs, plan.url);
    return { ...result, evidence, screenshots: [formShot, await shot(page, 'result')].filter(Boolean) };
  } finally { await browser.close().catch(() => {}); }
}
