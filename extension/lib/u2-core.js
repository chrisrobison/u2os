// Pure logic shared by the side panel, the content script and the tests. A classic script (content scripts
// cannot be modules): it publishes globalThis.U2Core and touches no chrome.* API and no DOM.
(() => {
  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

  /** The origin of a U2OS server URL, or null unless it is plain http to localhost / 127.0.0.1 / [::1] (no credentials, no path games). */
  function loopbackOrigin(value) {
    let url;
    try { url = new URL(String(value ?? '').trim()); } catch { return null; }
    if (url.protocol !== 'http:' || url.username || url.password) return null;
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
    return url.origin;
  }

  /** `https://boards.example.com/*` for the job's page, or null when it is not an http(s) page. */
  function originPattern(value) {
    let url;
    try { url = new URL(String(value ?? '')); } catch { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.protocol}//${url.hostname}/*`;
  }

  const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  async function sha256Hex(bytes) { return hex(await crypto.subtle.digest('SHA-256', bytes)); }
  /** True only when the bytes hash to exactly what the reviewed plan promised. */
  async function verifySha256(bytes, expected) {
    return typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected) && (await sha256Hex(bytes)) === expected;
  }

  /** Mirrors schemaHash() in mcp/jobs/hunt/applications/form/schema.js: a hash of what the form asks for. */
  async function schemaHash(fields) {
    const stable = fields.map(({ key, type, label, required, options }) => ({ key, type, label, required, options })).sort((a, b) => a.key.localeCompare(b.key));
    return sha256Hex(new TextEncoder().encode(JSON.stringify(stable)));
  }

  // Mirrors SUCCESS_TEXT / SUCCESS_URL in form/apply.js.
  const SUCCESS_TEXT = /thank you for (applying|your (application|interest|submission))|application (has been |was )?(received|submitted|sent)|we('ve| have) received your application|successfully (applied|submitted)|your application is (in|complete)/i;
  const SUCCESS_URL = /confirmation|thank-?you|thanks|submitted|success/i;
  // Mirrors CAPTCHA_SELECTOR in form/schema.js (interactive challenges only).
  const CAPTCHA_SELECTOR = 'iframe[src*="hcaptcha"]:not([src*="size=invisible"]), iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"], iframe[src*="challenges.cloudflare"], iframe[title*="challenge" i], .h-captcha';

  const confirmed = (text, pathname) => SUCCESS_TEXT.test(String(text ?? '')) || SUCCESS_URL.test(String(pathname ?? ''));

  function matchOption(options = [], value) {
    const wanted = String(value).trim().toLowerCase();
    return options.find((option) => option.toLowerCase() === wanted) || options.find((option) => option.toLowerCase().startsWith(wanted)) || options.find((option) => option.toLowerCase().includes(wanted)) || null;
  }

  /** What to say to the owner and the channel when the fill must not proceed. `blockers` is the schema's. */
  function stopReason(schema, expectedHash, actualHash) {
    if (schema.blockers?.captcha) return { code: 'captcha', message: 'This page shows a CAPTCHA. Solve it yourself; the extension never tries to.' };
    if (schema.blockers?.password) return { code: 'login_required', message: 'This page asks you to sign in. Sign in, then fill again.' };
    if (!schema.hasForm) return { code: 'no_form', message: 'No application form was found on this page.' };
    if (actualHash !== expectedHash) return { code: 'schema_changed', message: 'The form asks different questions than when it was planned. Nothing was filled; re-plan the application in U2OS.' };
    return null;
  }

  /** The body of POST .../result for a fill report. Filling is always reported as `filled`; a stop is a `failed` (nothing was submitted). */
  function fillResult(planHash, report) {
    if (report.stopped) return { planHash, status: 'failed', reason: `${report.stopped.code}: ${report.stopped.message}`.slice(0, 300) };
    const parts = [];
    if (report.uncertain?.length) parts.push(`${report.uncertain.length} to check`);
    if (report.unfilled?.length) parts.push(`${report.unfilled.length} left for you`);
    return { planHash, status: 'filled', ...(parts.length ? { reason: parts.join(', ') } : {}) };
  }

  /** Whether "submit when complete" may click: every field filled with confidence, nothing flagged, and the owner has the setting on. */
  function mayAutoSubmit({ setting, planAutoSubmit, report }) {
    return setting === true && planAutoSubmit === true && !report.stopped && !report.unfilled.length && !report.uncertain.length && !report.missingRequired.length && report.valid !== false;
  }

  /** Final outcome of a click on submit, from the last observation: only a confirmation is `submitted`; visible validation errors on the form are `failed`; anything else is uncertain and is reported as a failure after submitting began (never retried). */
  function submitResult(planHash, observation) {
    if (observation?.submitted) return { planHash, status: 'submitted' };
    if (observation?.captcha) return { planHash, status: 'failed', reason: 'captcha appeared after submitting' };
    if (observation?.errors?.length && observation.stillOnForm) return { planHash, status: 'failed', reason: `the form showed errors: ${observation.errors.join('; ')}`.slice(0, 300) };
    return { planHash, status: 'failed', reason: 'no confirmation was seen after submitting; outcome unknown, check your email' };
  }

  globalThis.U2Core = { loopbackOrigin, originPattern, sha256Hex, verifySha256, schemaHash, confirmed, matchOption, stopReason, fillResult, mayAutoSubmit, submitResult, SUCCESS_TEXT, SUCCESS_URL, CAPTCHA_SELECTOR };
})();
