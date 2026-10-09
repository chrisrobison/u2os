// The side panel: pairs with U2OS on this computer, lists reviewed applications, and runs a fill in the job's tab.
// It is the only part of the extension that talks to U2OS and the only part that holds the token. The token lives
// in chrome.storage.local, goes only to a validated loopback origin, and is never logged or shown.
(() => {
  const Core = globalThis.U2Core;
  const $ = (id) => document.getElementById(id);
  const CORE_FILES = ['lib/u2-core.js', 'lib/read-schema.js', 'content.js'];
  const CHANNEL = '/api/extension/v1';
  let busy = false;

  const say = (text, tone = '') => { const status = $('status'); status.textContent = text; status.className = tone; };
  const store = {
    get: () => chrome.storage.local.get(['server', 'token', 'pairingId', 'submitWhenComplete']),
    set: (values) => chrome.storage.local.set(values),
    clear: () => chrome.storage.local.remove(['token', 'pairingId']),
  };

  class ChannelError extends Error { constructor(message, status) { super(message); this.status = status; } }

  /** Every request goes through here: the base is re-validated each time, redirects are refused, errors never include the request. */
  async function channel(path, { method = 'GET', body, token: override } = {}) {
    const state = await store.get();
    const base = Core.loopbackOrigin(state.server);
    if (!base) throw new ChannelError('The U2OS address must be http://localhost, http://127.0.0.1 or http://[::1] (this computer only).', 0);
    const token = override === null ? null : state.token;
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method, redirect: 'error', cache: 'no-store', credentials: 'omit',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new ChannelError('Could not reach U2OS. Is it running on this computer, at that address?', 0); }
    if (response.status === 401) { await store.clear(); show(false); throw new ChannelError('This browser is no longer paired. Pair it again.', 401); }
    if (!response.ok) {
      let message = `U2OS answered ${response.status}`;
      try { const data = await response.json(); if (data?.error) message = String(data.error).slice(0, 200); } catch { /* not json */ }
      throw new ChannelError(message, response.status);
    }
    return response;
  }
  const json = async (path, options) => (await channel(path, options)).json();

  function show(paired) {
    $('pair-view').hidden = paired;
    $('main-view').hidden = !paired;
  }

  async function pair(event) {
    event.preventDefault();
    const server = $('server').value.trim();
    if (!Core.loopbackOrigin(server)) return say('The U2OS address must be http://localhost, http://127.0.0.1 or http://[::1] (this computer only).', 'error');
    await store.set({ server: Core.loopbackOrigin(server) });
    try {
      const data = await json(`${CHANNEL}/pair`, { method: 'POST', body: { code: $('code').value, label: 'Chrome extension' }, token: null });
      await store.set({ token: data.token, pairingId: data.id });
      $('code').value = '';
      say('Paired.', 'ok');
      show(true);
      await refresh();
    } catch (error) { say(error.message, 'error'); }
  }

  async function refresh() {
    const list = $('applications');
    list.replaceChildren();
    try {
      const { applications } = await json(`${CHANNEL}/applications`);
      $('empty').hidden = applications.length > 0;
      for (const app of applications) {
        const item = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = `${app.company}${app.role ? ` - ${app.role}` : ''}`;
        const where = document.createElement('span');
        where.textContent = app.url;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Fill this application';
        button.addEventListener('click', () => run(app, button));
        item.append(title, where, button);
        list.append(item);
      }
    } catch (error) { if (error.status !== 401) say(error.message, 'error'); }
  }

  const tabReady = async (tabId) => {
    for (let i = 0; i < 60; i += 1) {
      if ((await chrome.tabs.get(tabId)).status === 'complete') return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  const inject = (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: CORE_FILES });
  async function ask(tabId, message) {
    const answer = await chrome.tabs.sendMessage(tabId, message);
    if (!answer?.ok) throw new Error(answer?.error ?? 'The page did not answer');
    return answer.value;
  }
  const toBase64 = (bytes) => { let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); };

  async function openTab(url) {
    const pattern = Core.originPattern(url);
    const bare = (value) => String(value).split('#')[0];
    const existing = (await chrome.tabs.query({ url: pattern })).find((tab) => bare(tab.url) === bare(url));
    if (existing) { await chrome.tabs.update(existing.id, { active: true }); return existing.id; }
    return (await chrome.tabs.create({ url, active: true })).id;
  }

  async function fetchFiles(plan) {
    const encoded = {};
    for (const file of plan.files) {
      if (!file.path.startsWith(`${CHANNEL}/jobs/`)) throw new Error('U2OS sent an unexpected file path');
      const bytes = new Uint8Array(await (await channel(file.path)).arrayBuffer());
      if (!(await Core.verifySha256(bytes, file.sha256))) throw new Error(`The ${file.kind} file does not match what you reviewed; nothing was filled. Re-plan in U2OS.`);
      encoded[file.kind] = toBase64(bytes);
    }
    return encoded;
  }

  async function report(jobId, body) {
    try { await json(`${CHANNEL}/jobs/${encodeURIComponent(jobId)}/result`, { method: 'POST', body }); } catch (error) { say(`Could not report to U2OS: ${error.message}`, 'error'); }
  }

  async function run(app, button) {
    if (busy) return;
    busy = true;
    for (const each of document.querySelectorAll('#applications button')) each.disabled = true;
    try { await fill(app); } catch (error) { say(error.message, 'error'); } finally {
      busy = false;
      for (const each of document.querySelectorAll('#applications button')) each.disabled = false;
    }
  }

  async function fill(app) {
    // Host access is requested for this job's origin only, and must be asked from the click.
    const pattern = Core.originPattern(app.url);
    if (!pattern) throw new Error('This application has no web address to open.');
    if (!(await chrome.permissions.contains({ origins: [pattern] })) && !(await chrome.permissions.request({ origins: [pattern] }))) {
      throw new Error(`Chrome access to ${new URL(app.url).hostname} was not granted, so nothing was filled.`);
    }
    say('Fetching the reviewed plan...');
    const plan = await json(`${CHANNEL}/jobs/${encodeURIComponent(app.jobId)}/plan`);
    if (Core.originPattern(plan.url) !== pattern) throw new Error('The application address changed; refresh the list and try again.');
    const files = await fetchFiles(plan);

    say('Opening the application...');
    const tabId = await openTab(plan.url);
    await tabReady(tabId);
    say('Filling the form...');
    let result;
    for (let attempt = 0; attempt < 10; attempt += 1) { // single-page boards render their form late
      await inject(tabId);
      result = await ask(tabId, { type: 'u2-fill', plan: { schemaHash: plan.schemaHash, fields: plan.fields, files: plan.files }, files });
      if (result.stopped?.code !== 'no_form') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await report(app.jobId, Core.fillResult(plan.planHash, result));
    if (result.stopped) return say(result.stopped.message, 'error');

    const settings = await store.get();
    if (!Core.mayAutoSubmit({ setting: settings.submitWhenComplete === true, planAutoSubmit: plan.autoSubmit, report: result })) {
      const flagged = result.uncertain.length + new Set([...result.unfilled, ...result.missingRequired]).size;
      return say(settings.submitWhenComplete && !plan.autoSubmit ? 'Filled. U2OS is not in live mode, so submitting is left to you.' : flagged ? `Filled. ${flagged} field${flagged === 1 ? '' : 's'} need you; review the form and press submit yourself.` : 'Filled. Review the form and press submit yourself.', 'ok');
    }
    await submit(app, plan, tabId);
  }

  async function submit(app, plan, tabId) {
    const check = await ask(tabId, { type: 'u2-submit', check: true });
    if (!check.ready) return say(`Filled, but not submitted (${check.reason}). Press submit yourself.`, 'ok');
    // Intent is recorded with U2OS BEFORE the click: from here a lost report is "uncertain", never "try again".
    try { await json(`${CHANNEL}/jobs/${encodeURIComponent(app.jobId)}/submitting`, { method: 'POST', body: { planHash: plan.planHash } }); } catch (error) {
      return say(`Filled, but not submitted: ${error.message}. Press submit yourself.`, 'ok');
    }
    say('Submitting...');
    let outcome = null;
    try {
      const clicked = await ask(tabId, { type: 'u2-submit' });
      if (!clicked.clicked) outcome = { notClicked: true };
    } catch { /* the page may have navigated away at once */ }
    const deadline = Date.now() + 20_000;
    let last = null;
    while (!outcome && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      try {
        await inject(tabId);
        last = await ask(tabId, { type: 'u2-observe', formUrl: plan.url });
      } catch { continue; } // mid-navigation, or left the origin we may read
      if (last.submitted || last.captcha) break;
    }
    const body = Core.submitResult(plan.planHash, outcome ? null : last);
    await report(app.jobId, body);
    say(body.status === 'submitted' ? 'Submitted. The board confirmed it.' : `Not confirmed: ${body.reason}`, body.status === 'submitted' ? 'ok' : 'error');
    await refresh();
  }

  async function init() {
    const state = await store.get();
    if (state.server) $('server').value = state.server;
    $('submit-when-complete').checked = state.submitWhenComplete === true;
    $('pair-form').addEventListener('submit', pair);
    $('refresh').addEventListener('click', refresh);
    $('submit-when-complete').addEventListener('change', (event) => store.set({ submitWhenComplete: event.target.checked }));
    $('unpair').addEventListener('click', async () => { await store.clear(); show(false); say('Forgotten here. Revoke it in U2OS too: npm run u2 -- job extension revoke <id>.'); });
    show(!!state.token);
    if (state.token) { $('paired-with').textContent = `Paired with ${Core.loopbackOrigin(state.server) ?? 'U2OS'} (pairing ${String(state.pairingId ?? '').slice(0, 16)}).`; await refresh(); }
  }
  init();
})();
