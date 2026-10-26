import crypto from 'node:crypto';
import net from 'node:net';
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

export async function launchBrowser(env = process.env, { headed = false } = {}) {
  let playwright;
  try { playwright = await import('playwright'); } catch { throw new Error('Playwright is not installed. Run: npm install && npx playwright install chromium'); }
  // `headed` opens a normal, visible window on this machine (some boards' passive bot scoring treats headless browsers differently). Nothing is spoofed or hidden.
  return playwright.chromium.launch({ headless: !headed, ...(env.JOBS_BROWSER_PATH ? { executablePath: env.JOBS_BROWSER_PATH } : {}) });
}

/**
 * A visible Chrome that outlives this process: spawned detached and driven over
 * CDP, so disconnecting (or the server restarting) leaves the window open for
 * the owner to look at. Returns the connected browser; the page opens in the
 * browser's own default context so it is not torn down on disconnect.
 */
async function launchKeptBrowser(env) {
  const playwright = await import('playwright');
  const os = await import('node:os');
  const { spawn } = await import('node:child_process');
  const executable = env.JOBS_BROWSER_PATH || playwright.chromium.executablePath();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'u2-form-'));
  const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port: free } = server.address(); server.close(() => resolve(free)); }); server.on('error', reject); });
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...(env.JOBS_FORCE_HEADLESS === '1' ? ['--headless=new'] : []), ...(process.getuid?.() === 0 || env.CI ? ['--no-sandbox'] : []), 'about:blank'], { detached: true, stdio: 'ignore' });
  child.unref();
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const browser = await playwright.chromium.connectOverCDP(endpoint);
  browser.u2Endpoint = endpoint; browser.u2Child = child; browser.u2Profile = profile;
  return browser;
}

/** Closes a kept browser entirely (the run never reached the submit click, so there is nothing to look at). */
async function closeKept(browser) {
  await browser.close().catch(() => {});
  try { browser.u2Child?.kill('SIGTERM'); } catch { /* already gone */ }
  await new Promise((resolve) => setTimeout(resolve, 800));
  try { fs.rmSync(browser.u2Profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sel = (key) => `[data-u2=${JSON.stringify(key)}]`;

async function openApplication(browser, url, { kept = false } = {}) {
  const viewport = { width: 1280, height: 1600 };
  const page = kept ? await browser.contexts()[0].newPage() : await browser.newPage({ viewport });
  if (kept) await page.setViewportSize(viewport);
  page.setDefaultTimeout(15_000);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('form, iframe[src*="job-boards.greenhouse.io/embed/job_app"]', { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return page;
}

// Company career pages often host the actual Greenhouse form in a separate
// frame. Keep the outer page for screenshots, but inspect and fill that frame.
async function applicationScope(page) {
  const pageOrigin = new URL(page.url()).origin;
  const frame = page.frames().find((entry) => {
    try { const url = new URL(entry.url()); return url.pathname === '/embed/job_app' && (url.hostname === 'job-boards.greenhouse.io' || url.origin === pageOrigin); }
    catch { return false; }
  });
  if (!frame) return page;
  await frame.locator('form').first().waitFor({ timeout: 12_000 }).catch(() => {});
  return frame;
}

async function readInteractiveSchema(scope) {
  const schema = await readFormSchema(scope);
  for (const field of schema.fields.filter((entry) => entry.type === 'combobox' && !entry.options.length)) {
    const input = scope.locator(sel(field.key)).first();
    try {
      await input.click({ timeout: 2000 });
      if (await input.getAttribute('aria-expanded') !== 'true') await input.press('ArrowDown');
      await scope.waitForTimeout(150);
      if (await input.getAttribute('aria-expanded') === 'true') field.options = await scope.locator('[role="option"]').allInnerTexts();
      await input.press('Escape');
    } catch { /* leave the choice unresolved if the widget will not open */ }
  }
  return schema;
}

/** Read-only: open the application page and report its form (used to make a plan). */
export async function inspectApplication({ url, env = process.env }) {
  const browser = await launchBrowser(env);
  try {
    const page = await openApplication(browser, url);
    return await readInteractiveSchema(await applicationScope(page));
  } finally { await browser.close().catch(() => {}); }
}

function matchOption(options = [], value) {
  const wanted = String(value).trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === wanted) || options.find((option) => option.toLowerCase().startsWith(wanted)) || options.find((option) => option.toLowerCase().includes(wanted)) || null;
}

function matchComboboxOption(options, value) {
  const normalized = (text) => String(text).toLowerCase().replace(/\s+/g, '').trim();
  const exact = options.find((option) => normalized(option) === normalized(value));
  if (exact) return exact;
  const wanted = String(value).trim();
  const city = wanted.match(/^([^,]+),\s*[A-Z]{2}$/)?.[1];
  if (city) {
    const matches = options.filter((option) => option.toLowerCase().startsWith(`${city.toLowerCase()}, `) && /, united states$/i.test(option));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

async function setField(page, entry, schemaField, files) {
  const control = page.locator(sel(entry.key));
  if (entry.file) {
    // Uploaded under a proper name (Christopher_Robison_Resume.pdf), not whatever the file is called on disk.
    const source = files[entry.file].path;
    await control.first().setInputFiles(entry.fileName ? { name: entry.fileName, mimeType: 'application/pdf', buffer: fs.readFileSync(source) } : source);
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
        await control.first().fill(String(value).replace(/\s*\+\s*(\d+)$/, ' +$1'));
        await page.waitForTimeout(500);
        let choices = await page.getByRole('option').allInnerTexts();
        if (!choices.length && String(value).includes(',')) {
          await control.first().fill(String(value).split(',')[0]);
          await page.waitForTimeout(800);
          choices = await page.getByRole('option').allInnerTexts();
        }
        const selected = matchComboboxOption(choices, value);
        if (!selected) return false;
        await page.getByRole('option', { name: selected, exact: true }).first().click();
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

async function outcome(page, scope, timeoutMs, formUrl) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    if (await scope.locator(CAPTCHA_SELECTOR).first().isVisible().catch(() => false)) return { status: 'manual_required', reason: 'captcha_after_submit' };
    const text = await scope.locator('body').innerText().catch(() => '');
    if (SUCCESS_TEXT.test(text) || SUCCESS_URL.test(new URL(scope.url()).pathname)) return { status: 'submitted' };
  }
  const errors = await scope.locator('[role="alert"], .error, .field-error, .error-message, [aria-invalid="true"]').evaluateAll((elements) => elements
    .map((element) => (element.getAttribute('aria-invalid') === 'true' ? `invalid: ${element.name || element.id}` : element.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 5)).catch(() => []);
  const stillOnForm = page.url() === formUrl && await scope.locator('form').count() > 0;
  // Only a form still showing its own validation errors counts as "not submitted".
  return errors.length && stillOnForm ? { status: 'failed', errors } : { status: 'unconfirmed' };
}

/**
 * @param plan    from buildApplicationPlan (reviewed)
 * @param files   { resume: { path }, cover_letter?: { path } } — verified against plan.files hashes
 * @param submit  false fills and checks but never submits (dry run)
 * @param beforeSubmit async () => void  called after everything is verified and before the click; throw to stop
 */
export async function executePlan(options) {
  const state = {};
  const result = await runPlan(options, state);
  return state.window ? { ...result, window: state.window } : result;
}

async function runPlan({ plan, files = {}, submit = true, prefill = false, headed = false, keepOpen = false, beforeSubmit = async () => {}, screenshotDir = null, env = process.env, outcomeTimeoutMs = Number(env.JOBS_SUBMIT_TIMEOUT_MS) || 20_000 }, state) {
  for (const [kind, expected] of Object.entries(plan.files ?? {})) {
    if (!files[kind] || !fs.existsSync(files[kind].path) || sha256(files[kind].path) !== expected.sha256) return { status: 'files_changed', reason: `${kind} is not the file the plan was made with` };
  }
  const kept = headed && keepOpen;
  let keep = kept; // a kept window stays open whatever happened (submitted, CAPTCHA, login wall, partial fill) so the owner can finish by hand; only a dry run closes it
  const browser = kept ? await launchKeptBrowser(env) : await launchBrowser(env, { headed });
  const shots = [];
  const shot = async (page, name) => {
    if (!screenshotDir) return null;
    try { fs.mkdirSync(screenshotDir, { recursive: true }); const file = path.join(screenshotDir, `${name}.png`); await page.screenshot({ path: file, fullPage: true }); shots.push(file); return file; } catch { return null; }
  };
  try {
    const page = await openApplication(browser, plan.url, { kept });
    const scope = await applicationScope(page);
    const schema = await readInteractiveSchema(scope);
    if (schema.blockers?.captcha) return { status: 'manual_required', reason: 'captcha', screenshots: [await shot(page, 'blocked')].filter(Boolean) };
    if (!schema.hasForm || schema.blockers?.password) return { status: 'manual_required', reason: schema.blockers?.password ? 'login_required' : 'no_form', screenshots: [await shot(page, 'blocked')].filter(Boolean) };
    if (!schema.fields.length || !plan.fields?.length) return { status: 'schema_changed', reason: 'the application form has no readable fields' };
    if (schemaHash(schema.fields) !== plan.schemaHash) return { status: 'schema_changed', reason: 'the form asks different questions than when it was planned' };

    const byKey = new Map(schema.fields.map((field) => [field.key, field]));
    const failed = [];
    for (const entry of plan.fields) {
      if (!byKey.has(entry.key)) continue;
      if (!(await setField(scope, entry, byKey.get(entry.key), files))) failed.push(entry.key);
    }
    const after = await readFormSchema(scope);
    const missing = after.fields.filter((field) => field.required && !field.filled).map((field) => field.label || field.key);
    const formShot = await shot(page, 'form');
    if (failed.length || missing.length) return { status: 'fill_incomplete', failed, missing, screenshots: [formShot].filter(Boolean) };
    // A pre-fill is a dry run whose window stays open: the owner reviews the filled form and submits it by hand.
    if (!submit) { keep = kept && prefill; return { status: prefill ? 'prefilled' : 'dry_run', screenshots: [formShot].filter(Boolean) }; }

    const button = await findSubmit(scope);
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
    const result = await outcome(page, scope, outcomeTimeoutMs, plan.url);
    return { ...result, evidence, screenshots: [formShot, await shot(page, 'result')].filter(Boolean) };
  } finally {
    if (keep) state.window = browser.u2Endpoint;
    // A kept window is only disconnected from (it stays open for the owner); any other run closes its browser.
    if (kept && !keep) await closeKept(browser); else await browser.close().catch(() => {});
  }
}
