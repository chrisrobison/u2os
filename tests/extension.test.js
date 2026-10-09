import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { CAPTCHA_SELECTOR, readFormSchema, schemaHash } from '../mcp/jobs/hunt/applications/form/schema.js';
import { startApplyForms } from './fixtures/apply-forms.js';

// The Chrome extension's pure logic (extension/lib/u2-core.js) and its parity with the Playwright driver.
// u2-core.js is a classic script that publishes globalThis.U2Core, so it is loaded the way Chrome loads it.
const read = (file) => fs.readFileSync(path.join(import.meta.dirname, '..', 'extension', file), 'utf8');
const sandbox = { crypto: globalThis.crypto, TextEncoder, URL, Uint8Array };
sandbox.globalThis = sandbox;
vm.runInNewContext(read('lib/u2-core.js'), sandbox);
const Core = sandbox.U2Core;
const plain = (value) => JSON.parse(JSON.stringify(value)); // results built inside the vm context have another Object.prototype

test('the server address must be plain http to this computer', () => {
  for (const ok of ['http://localhost:4000', 'http://127.0.0.1:4000/', 'http://[::1]:4000', 'http://LOCALHOST:80', ' http://127.0.0.1:4000/anything ']) assert.ok(Core.loopbackOrigin(ok), ok);
  assert.equal(Core.loopbackOrigin('http://127.0.0.1:4000/x'), 'http://127.0.0.1:4000');
  // Spellings the URL parser normalizes to 127.0.0.1 are that address, and the normalized origin is what gets used.
  for (const alias of ['http://2130706433', 'http://0x7f.0.0.1']) assert.equal(Core.loopbackOrigin(alias), 'http://127.0.0.1');
  for (const bad of ['https://localhost:4000', 'http://evil.example', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'http://localhost@evil.example', 'http://user:pw@localhost:4000', 'http://evil.example@127.0.0.1:4000/@localhost',
    'http://192.168.1.5:4000', 'http://10.0.0.1', 'http://0.0.0.0:4000', 'http://127.0.0.2:4000', 'http://localhost.:4000', 'ftp://localhost', 'chrome-extension://abc', 'javascript:alert(1)', '//localhost:4000', 'localhost:4000', '', null, undefined]) {
    assert.equal(Core.loopbackOrigin(bad), null, String(bad));
  }
});

test('host access is requested for the job origin only', () => {
  assert.equal(Core.originPattern('https://jobs.ashbyhq.com/x/1/application?a=1'), 'https://jobs.ashbyhq.com/*');
  assert.equal(Core.originPattern('http://127.0.0.1:5000/ashby/application'), 'http://127.0.0.1/*');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,x', '', null, 'not a url']) assert.equal(Core.originPattern(bad), null, String(bad));
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(![...manifest.permissions, ...manifest.host_permissions, ...manifest.optional_host_permissions].some((entry) => /all_urls/.test(entry)));
  for (const entry of manifest.host_permissions) assert.match(entry, /^http:\/\/(localhost|127\.0\.0\.1)\/\*$/, 'only loopback is granted at install');
  assert.ok(!('content_scripts' in manifest), 'the content script is injected into the job tab only, never declared for every page');
});

test('a file is used only when its SHA-256 is exactly the reviewed one', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 resume bytes');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(await Core.sha256Hex(bytes), sha);
  assert.equal(await Core.verifySha256(bytes, sha), true);
  assert.equal(await Core.verifySha256(new TextEncoder().encode('%PDF-1.4 resume byteS'), sha), false);
  for (const bad of [undefined, null, '', sha.toUpperCase(), sha.slice(1), `${sha}0`, 5]) assert.equal(await Core.verifySha256(bytes, bad), false, String(bad));
});

test('a fill stops on a CAPTCHA, a login wall, no form, or a changed form, in that order', () => {
  const form = { hasForm: true, blockers: { captcha: false, password: false }, fields: [] };
  assert.equal(Core.stopReason(form, 'a', 'a'), null);
  assert.equal(Core.stopReason({ ...form, blockers: { captcha: true, password: true } }, 'a', 'a').code, 'captcha');
  assert.equal(Core.stopReason({ ...form, blockers: { captcha: false, password: true } }, 'a', 'a').code, 'login_required');
  assert.equal(Core.stopReason({ ...form, hasForm: false }, 'a', 'a').code, 'no_form');
  assert.equal(Core.stopReason(form, 'a', 'b').code, 'schema_changed');
});

test('reports map to the channel: a fill is "filled", a stop is "failed", only a confirmation is "submitted"', () => {
  assert.deepEqual(plain(Core.fillResult('h', { filled: 5, uncertain: [], unfilled: [], missingRequired: [] })), { planHash: 'h', status: 'filled' });
  assert.deepEqual(plain(Core.fillResult('h', { filled: 3, uncertain: ['a'], unfilled: ['b', 'c'], missingRequired: [] })), { planHash: 'h', status: 'filled', reason: '1 to check, 2 left for you' });
  const stopped = Core.fillResult('h', { stopped: { code: 'captcha', message: 'x'.repeat(500) } });
  assert.equal(stopped.status, 'failed');
  assert.ok(stopped.reason.startsWith('captcha: ') && stopped.reason.length <= 300);

  assert.deepEqual(plain(Core.submitResult('h', { submitted: true })), { planHash: 'h', status: 'submitted' });
  assert.equal(Core.submitResult('h', { submitted: false, errors: ['Email is required'], stillOnForm: true }).status, 'failed');
  assert.match(Core.submitResult('h', { submitted: false, errors: ['Email is required'], stillOnForm: true }).reason, /Email is required/);
  // Nothing proves what happened: reported as a failure after submitting began, which U2OS records as uncertain and never retries.
  for (const unclear of [null, undefined, {}, { submitted: false, errors: [], stillOnForm: true }, { errors: ['x'], stillOnForm: false }]) {
    assert.match(Core.submitResult('h', unclear).reason, /outcome unknown/);
    assert.equal(Core.submitResult('h', unclear).status, 'failed');
  }
  assert.match(Core.submitResult('h', { captcha: true }).reason, /captcha/);
});

test('submit-when-complete clicks only when the owner turned it on, U2OS is live and nothing needs a human', () => {
  const clean = { filled: 4, uncertain: [], unfilled: [], missingRequired: [], valid: true };
  const may = (over = {}) => Core.mayAutoSubmit({ setting: true, planAutoSubmit: true, report: clean, ...over });
  assert.equal(may(), true);
  assert.equal(may({ setting: false }), false);
  assert.equal(may({ setting: undefined }), false);
  assert.equal(may({ planAutoSubmit: false }), false);
  for (const flag of [{ uncertain: ['a'] }, { unfilled: ['a'] }, { missingRequired: ['a'] }, { valid: false }, { stopped: { code: 'captcha' } }]) assert.equal(may({ report: { ...clean, ...flag } }), false, JSON.stringify(flag));
  assert.equal(JSON.parse(read('sidepanel.html').match(/id="submit-when-complete"[^>]*/)[0].includes('checked') ? 'true' : 'false'), false, 'off by default');
});

test('the board-confirmation and CAPTCHA rules are the driver\'s', () => {
  const apply = read('../mcp/jobs/hunt/applications/form/apply.js');
  assert.ok(apply.includes(`const SUCCESS_TEXT = ${Core.SUCCESS_TEXT};`), 'SUCCESS_TEXT drifted from form/apply.js');
  assert.ok(apply.includes(`const SUCCESS_URL = ${Core.SUCCESS_URL};`), 'SUCCESS_URL drifted from form/apply.js');
  assert.equal(Core.CAPTCHA_SELECTOR, CAPTCHA_SELECTOR);
  assert.equal(Core.confirmed('Thank you for applying', '/x'), true);
  assert.equal(Core.confirmed('Please fill in', '/jobs/1/thanks'), true);
  assert.equal(Core.confirmed('Please fill in', '/jobs/1/apply'), false);
});

// --- schema parity with the Playwright driver -----------------------------------------------------------------------
let forms;
let browser;
before(async () => {
  forms = await startApplyForms();
  try { browser = await (await import('playwright')).chromium.launch(); } catch { browser = null; }
});
after(async () => { await browser?.close(); await forms.close(); });

test('the extension reads every fixture form exactly as the Playwright driver does, with the same schema hash', async (t) => {
  if (!browser) return t.skip('Chromium is not available');
  const page = await browser.newPage();
  const pages = ['/ashby/application', '/simple/apply', '/simple/extra', '/cover/apply', '/captcha/apply', '/login/apply', '/careers'];
  for (const route of pages) {
    await page.goto(`${forms.base}${route}`);
    const driver = await readFormSchema(page);
    await page.evaluate(() => { for (const element of document.querySelectorAll('[data-u2]')) element.removeAttribute('data-u2'); });
    await page.addScriptTag({ content: read('lib/read-schema.js') });
    const extension = await page.evaluate(() => globalThis.U2Schema.readFormSchema());
    assert.deepEqual(extension, driver, `${route}: schema differs`);
    if (driver.fields.length) {
      assert.equal(await Core.schemaHash(driver.fields), schemaHash(driver.fields), `${route}: hash differs`);
      const tagged = await page.evaluate(() => [...document.querySelectorAll('[data-u2]')].map((element) => element.getAttribute('data-u2')));
      assert.ok(tagged.length >= driver.fields.length, `${route}: the same data-u2 keys are applied`);
    }
  }
  await page.close();
});

test('job extension pair / list / revoke manage pairings from the terminal', async () => {
  const { main } = await import('../server/jobhunt/cli.js');
  const { ExtensionPairings } = await import('../server/extension/pairings.js');
  const os = await import('node:os');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-cli-'));
  const run = async (...args) => { const lines = []; const code = await main(['extension', ...args], { log: (line) => lines.push(line) }, { dataDir }); return { code, text: lines.join('\n') }; };
  try {
    assert.match((await run('list')).text, /No paired extensions/);
    const pair = await run('pair');
    const code = /Pairing code: ([A-Z0-9-]+)/.exec(pair.text)[1];
    const { token, id } = new ExtensionPairings({ dataDir }).exchange({ code, origin: `chrome-extension://${'a'.repeat(32)}`, label: 'Chrome' });
    const listed = await run('list');
    assert.ok(listed.text.includes(id));
    assert.ok(!listed.text.includes(token), 'a token is never printed');
    assert.equal((await run('revoke')).code, 1);
    assert.equal((await run('revoke', 'nope')).code, 1);
    assert.equal((await run('revoke', id)).code, 0);
    assert.equal(new ExtensionPairings({ dataDir }).authenticate(token), null);
    assert.equal((await run('bogus')).code, 1);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
