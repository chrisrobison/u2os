import fs from 'node:fs';
import path from 'node:path';
import { applicationUrl, endpoints, fetchPosting, parseJobId } from './boards.js';
import { loadProfile, requireApplicant } from './profile.js';
import { FINAL, readRecord, recordFile, submittedInLastDay, writeRecord } from './ledger.js';

// Applies to one posting on the board's hosted form in headless Chromium.
//
// - Identity (name, email, phone, links, resume) comes from the owner's
//   job-hunt/profile.md, never from the model; answers from the model can
//   neither change those fields nor fill demographic questions.
// - Required questions left unanswered stop the run before submitting.
// - A CAPTCHA or an unconfirmed result stops it for the owner. Nothing here
//   tries to evade bot detection.
// - Every attempt is recorded in the vault ledger, which makes submitting
//   exactly-once per job.

const MAX_ANSWER = 5_000;
const IDENTITY_LABEL = [
  [/linkedin/i, 'linkedin'],
  [/github/i, 'github'],
  [/website|portfolio|personal (site|url)/i, 'website'],
  [/^(current )?(location|city)\b/i, 'location'],
  [/current (company|employer)/i, 'currentCompany'],
];
// Protected characteristics are answered only from the owner's own profile.
const DEMOGRAPHIC = /gender|race|ethnic|veteran|disabilit|sexual orientation|pronoun|hispanic|latino/i;
const CAPTCHA = 'iframe[src*="hcaptcha"], iframe[src*="recaptcha/api2/bframe"], iframe[src*="challenges.cloudflare"], iframe[title*="challenge" i]';
const SUCCESS_TEXT = /thank you for (applying|your (application|interest))|application (has been |was )?(received|submitted)|we('ve| have) received your application/i;
const SUCCESS_URL = /confirmation|thank-?you|thanks|submitted/i;

export async function applyToJob({ vaultDir, jobId, answers = {}, coverLetter = null, env = process.env, fetchImpl = fetch }) {
  const job = parseJobId(jobId);
  const urls = endpoints(env);
  const profile = loadProfile(vaultDir);
  requireApplicant(profile);
  const relativeRecord = path.relative(vaultDir, recordFile(vaultDir, jobId)).split(path.sep).join('/');

  const existing = readRecord(vaultDir, jobId);
  if (existing && FINAL.has(existing.status)) {
    return { job_id: jobId, status: 'already_recorded', recorded_status: existing.status, message: `The ledger already records this job as ${existing.status}; nothing was submitted.`, record: relativeRecord };
  }
  if (profile.submit && submittedInLastDay(vaultDir) >= profile.maxPerDay) {
    return { job_id: jobId, status: 'daily_limit', message: `The limit of ${profile.maxPerDay} applications per 24 hours is reached; nothing was submitted.` };
  }
  const posting = await fetchPosting(jobId, { urls, fetchImpl });
  if (!posting) return { job_id: jobId, status: 'closed', message: 'The posting is no longer open.' };

  const lock = `${recordFile(vaultDir, jobId)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  // A lock left by a killed process expires after 10 minutes.
  try { if (Date.now() - fs.statSync(lock).mtimeMs > 600_000) fs.rmSync(lock, { force: true }); } catch { /* no lock */ }
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch {
    return { job_id: jobId, status: 'in_progress', message: 'Another application for this job is in progress.' };
  }
  const base = { job_id: jobId, company: posting.company, title: posting.title, url: applicationUrl(job, urls) };
  let browser;
  try {
    browser = await launchBrowser(env);
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(base.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('form', { timeout: 15_000 });

    const filled = await fillForm(page, { ats: job.ats, profile, answers, coverLetter: coverLetter ? String(coverLetter).slice(0, MAX_ANSWER) : profile.coverLetter });
    const fields = await readFields(page);
    const missing = fields.filter((field) => field.required && !field.filled).map(({ key, label, type, options }) => ({ name: key, label, type, ...(options?.length ? { options } : {}) }));
    const shot = (suffix) => screenshot(page, vaultDir, jobId, suffix);

    if (missing.length) {
      const record = writeRecord(vaultDir, { ...base, status: 'needs_answers', open_questions: missing });
      return { ...base, status: record.status, message: 'Required questions are unanswered; nothing was submitted. Call apply again with answers keyed by name.', missing_questions: missing, record: relativeRecord };
    }
    const formShot = await shot('form');
    if (!profile.submit) {
      writeRecord(vaultDir, { ...base, status: 'dry_run', answered: filled.answered, screenshot: formShot }, filled.coverLetter || '');
      return { ...base, status: 'dry_run', message: 'The form was filled but not submitted (submit: false in profile.md).', screenshot: formShot, record: relativeRecord };
    }

    const submittedAt = new Date().toISOString();
    // Recorded before the click: if anything below fails, the job is never submitted twice.
    writeRecord(vaultDir, { ...base, status: 'unconfirmed', applied_at: submittedAt, answered: filled.answered, screenshot: formShot }, filled.coverLetter || '');
    await clickSubmit(page);
    const outcome = await waitForOutcome(page, Number(env.JOBS_SUBMIT_TIMEOUT_MS) || 20_000, page.url());
    const resultShot = await shot('result');
    const messages = {
      applied: 'The application was submitted and the board confirmed it.',
      needs_owner: 'The board showed a CAPTCHA or challenge. Finish this application yourself; U2OS will not retry it.',
      failed: `The board rejected the form: ${outcome.errors?.join('; ') || 'validation errors'}.`,
      unconfirmed: 'The form was submitted but no confirmation appeared. Check it yourself; U2OS will not resubmit it.',
    };
    // A rejected form was not submitted, so it may be retried with better answers.
    const status = outcome.status;
    writeRecord(vaultDir, { ...base, status, applied_at: status === 'failed' ? null : submittedAt, result_screenshot: resultShot, ...(outcome.errors ? { errors: outcome.errors } : {}) });
    return { ...base, status, message: messages[status], screenshot: resultShot, record: relativeRecord, ...(outcome.errors ? { errors: outcome.errors } : {}) };
  } finally {
    await browser?.close().catch(() => {});
    fs.rmSync(lock, { force: true });
  }
}

async function launchBrowser(env) {
  let playwright;
  try { playwright = await import('playwright'); } catch {
    throw new Error('Playwright is not installed. In the U2OS folder run: npm install && npx playwright install chromium');
  }
  return playwright.chromium.launch({ headless: true, ...(env.JOBS_BROWSER_PATH ? { executablePath: env.JOBS_BROWSER_PATH } : {}) });
}

/** Every form control, keyed by name (or id), with its label and state. */
function readFields(page) {
  return page.evaluate(() => {
    const labelOf = (element) => {
      const byFor = element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      const byledby = element.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      const text = byFor?.innerText || element.closest('label')?.innerText || element.getAttribute('aria-label') || byledby
        || element.closest('fieldset')?.querySelector('legend')?.innerText || element.closest('.application-question, .field, li')?.querySelector('label, .application-label, .text')?.innerText || '';
      return text.replace(/\s+/g, ' ').trim().slice(0, 300);
    };
    const groups = new Map();
    const form = document.querySelector('form');
    for (const element of form.querySelectorAll('input, textarea, select')) {
      const type = element.tagName === 'INPUT' ? (element.type || 'text') : element.tagName.toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      const key = element.name || element.id;
      if (!key) continue;
      const entry = groups.get(key) || { key, type: element.getAttribute('role') === 'combobox' ? 'combobox' : type, label: '', required: false, filled: false, options: [] };
      const label = labelOf(element);
      if (type === 'radio' || type === 'checkbox') {
        entry.options.push(label);
        entry.label ||= (element.closest('fieldset')?.querySelector('legend')?.innerText || label).replace(/\s+/g, ' ').trim();
        entry.filled ||= element.checked;
      } else {
        entry.label ||= label;
        if (type === 'select') entry.options = [...element.options].filter((option) => option.value !== '').map((option) => option.text.trim());
        entry.filled = type === 'file' ? element.files.length > 0 : String(element.value || '').trim() !== '';
      }
      entry.required ||= element.required || element.getAttribute('aria-required') === 'true';
      groups.set(key, entry);
    }
    return [...groups.values()];
  });
}

async function fillForm(page, { ats, profile, answers, coverLetter }) {
  const identity = ats === 'greenhouse'
    ? { first_name: profile.firstName, last_name: profile.lastName, email: profile.email, phone: profile.phone }
    : { name: profile.fullName, email: profile.email, phone: profile.phone, org: profile.currentCompany, location: profile.location,
      'urls[LinkedIn]': profile.linkedin, 'urls[GitHub]': profile.github, 'urls[Portfolio]': profile.website };
  const coverKeys = ats === 'greenhouse' ? ['cover_letter_text'] : ['comments'];
  const fields = await readFields(page);
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const protectedKeys = new Set([...Object.keys(identity), 'resume', 'cover_letter', ...coverKeys]);
  const answered = {};

  for (const [key, value] of Object.entries(identity)) if (value && byKey.has(key)) await setField(page, byKey.get(key), value);
  const resume = fields.find((field) => field.type === 'file' && (field.key === 'resume' || /resume|cv/i.test(field.label)));
  if (resume) { await page.locator(selector(resume.key)).first().setInputFiles(profile.resumePath); protectedKeys.add(resume.key); }
  const cover = coverKeys.map((key) => byKey.get(key)).find(Boolean);
  if (cover && coverLetter) await setField(page, cover, coverLetter);

  for (const field of fields) {
    if (protectedKeys.has(field.key) || field.type === 'file') continue;
    // Owner's links and details for questions such as "LinkedIn Profile".
    const known = IDENTITY_LABEL.find(([pattern]) => pattern.test(field.label));
    if (known && profile[known[1]] && ['text', 'url', 'email', 'tel', 'textarea'].includes(field.type)) {
      await setField(page, field, profile[known[1]]);
      protectedKeys.add(field.key);
      continue;
    }
    let value = Object.hasOwn(answers, field.key) && !DEMOGRAPHIC.test(field.label) ? answers[field.key] : undefined;
    if (value === undefined || value === null || value === '') {
      const standard = Object.entries(profile.answers).find(([fragment]) => field.label.toLowerCase().includes(fragment));
      value = standard?.[1];
    }
    if (value === undefined || value === null || value === '') continue;
    const text = Array.isArray(value) ? value.map((item) => String(item).slice(0, MAX_ANSWER)) : String(value).slice(0, MAX_ANSWER);
    if (await setField(page, field, text)) answered[field.label || field.key] = text;
  }
  return { answered, coverLetter: cover ? coverLetter : null };
}

function selector(key) {
  const quoted = JSON.stringify(key);
  return `form [name=${quoted}], form [id=${quoted}]`;
}

async function setField(page, field, value) {
  const control = page.locator(selector(field.key));
  try {
    if (field.type === 'select') {
      const wanted = Array.isArray(value) ? value : [value];
      await control.first().selectOption(wanted.map((label) => ({ label: matchOption(field.options, label) ?? label })));
    } else if (field.type === 'checkbox' && field.options.length === 1 && /^(yes|true|agree|i agree)$/i.test(String(value).trim())) {
      await control.first().check();
    } else if (field.type === 'radio' || field.type === 'checkbox') {
      const wanted = (Array.isArray(value) ? value : [value]).map((item) => matchOption(field.options, item)).filter(Boolean);
      if (!wanted.length) return false;
      const count = await control.count();
      for (let index = 0; index < count; index++) {
        if (wanted.includes(field.options[index])) await control.nth(index).check();
      }
    } else if (field.type === 'combobox') {
      await control.first().click();
      await control.first().fill(String(value));
      await page.waitForTimeout(300);
      await control.first().press('Enter');
    } else {
      await control.first().fill(Array.isArray(value) ? value.join(', ') : String(value));
    }
    return true;
  } catch {
    return false;
  }
}

function matchOption(options = [], value) {
  const wanted = String(value).trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === wanted) || options.find((option) => option.toLowerCase().startsWith(wanted)) || null;
}

async function clickSubmit(page) {
  const button = page.locator('form button[type="submit"], form input[type="submit"], form button:has-text("Submit")').first();
  await button.click();
}

async function waitForOutcome(page, timeoutMs, formUrl) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    if (await page.locator(CAPTCHA).first().isVisible().catch(() => false)) return { status: 'needs_owner' };
    const text = await page.locator('body').innerText().catch(() => '');
    if (SUCCESS_TEXT.test(text) || SUCCESS_URL.test(new URL(page.url()).pathname)) return { status: 'applied' };
  }
  const errors = await page.locator('[role="alert"], .error, .field-error, .error-message, [aria-invalid="true"]').evaluateAll((elements) => elements
    .map((element) => (element.getAttribute('aria-invalid') === 'true' ? element.name || element.id : element.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean).slice(0, 5)).catch(() => []);
  // Only a form still showing its own errors counts as not submitted.
  const stillOnForm = page.url() === formUrl && await page.locator('form').count() > 0;
  return errors.length && stillOnForm ? { status: 'failed', errors } : { status: 'unconfirmed' };
}

async function screenshot(page, vaultDir, jobId, suffix) {
  const file = recordFile(vaultDir, jobId).replace(/\.md$/, `-${suffix}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    return path.relative(vaultDir, file).split(path.sep).join('/');
  } catch {
    return null;
  }
}
