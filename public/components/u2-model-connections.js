import { saveModelConnections, testModelConnection } from '../services/api.js';

// Ordered list of model connections: API endpoints and CLI tools (claude, codex,
// grok, or any command). The first entry plans; later entries are tried in order
// when it fails. Everything is built with textContent/value, never innerHTML, and
// API keys are write-only: they are sent on save and cleared from the form.
const KINDS = [
  ['openai-compatible', 'API: OpenAI-compatible (local or hosted)'],
  ['anthropic', 'API: Anthropic'],
  ['cli:claude', 'CLI: Claude Code (claude)'],
  ['cli:codex', 'CLI: OpenAI Codex (codex)'],
  ['cli:grok', 'CLI: Grok (grok)'],
  ['cli:custom', 'CLI: any other command'],
];
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
const kindOf = (c) => (c.type === 'cli' ? `cli:${c.preset}` : c.type);
const labelOf = (c) => KINDS.find(([value]) => value === kindOf(c))?.[1] || c.type;

export class U2ModelConnections extends HTMLElement {
  /** @param {object} config the GET /api/model response  @param {() => void} onSaved */
  setConfig(config, onSaved, note = '') {
    this._initialStatus = note;
    this._revision = config.configurationRevision;
    this._items = (config.connections || []).map((c) => ({ ...c, apiKey: '' }));
    this._onSaved = onSaved; this._dirty = false; this._editing = null; this._results = new Map();
    this._render();
  }
  disconnectedCallback() { for (const item of this._items || []) item.apiKey = ''; }

  _render() {
    const keep = this._status?.textContent || this._initialStatus || '';
    this.replaceChildren(
      el('h3', { textContent: 'Connections, in order of preference' }),
      el('p', { textContent: 'U2OS plans with the first connection that works and falls back down this list when one fails. CLI tools such as claude, codex and grok sign in on their own (OAuth, your subscription): U2OS never sees that login. They must be installed and signed in for the account that runs U2OS, so run the tool once in a terminal as that account first.' }),
    );
    const list = el('ol', { className: 'model-connections' });
    if (!this._items.length) list.append(el('li', { textContent: 'No connections yet. Add one below.' }));
    this._items.forEach((item, index) => list.append(this._row(item, index)));
    this._status = el('p', { role: 'status', ariaLive: 'polite', className: 'model-connections-status', textContent: keep });
    const save = el('button', { type: 'button', className: 'btn btn-primary', textContent: 'Save connections', disabled: !this._dirty || !this._items.length });
    save.addEventListener('click', () => this._save());
    const add = el('button', { type: 'button', className: 'btn', textContent: 'Add a connection' });
    add.addEventListener('click', () => { this._editing = { index: this._items.length, item: { id: '', type: 'cli', preset: 'claude', timeoutMs: 120000 } }; this._render(); });
    this.append(list, el('p', {}, add, ' ', save), this._status);
    if (this._editing) this.append(this._form());
  }

  _row(item, index) {
    const li = el('li', { className: 'model-connection' });
    const detail = [labelOf(item), item.model, item.baseUrl, item.executable].filter(Boolean).join(' · ');
    li.append(el('strong', { textContent: `${index + 1}. ${item.id}` }), el('span', { textContent: ` ${detail}` }));
    const result = this._results.get(item.id);
    if (result) li.append(el('span', { className: 'model-connection-result', role: 'status', textContent: ` ${result}` }));
    const actions = el('span', { className: 'model-connection-actions' });
    const button = (text, onClick, disabled = false) => { const b = el('button', { type: 'button', className: 'btn', textContent: text, disabled }); b.addEventListener('click', onClick); actions.append(' ', b); return b; };
    button('Up', () => this._move(index, -1), index === 0);
    button('Down', () => this._move(index, 1), index === this._items.length - 1);
    button('Edit', () => { this._editing = { index, item: { ...item } }; this._render(); });
    button('Remove', () => { this._items.splice(index, 1); this._dirty = true; this._render(); });
    const saved = !this._dirty && !item.apiKey;
    button(item.type === 'cli' ? 'Check installed' : 'Check reachable', () => this._test(item, false), !saved);
    if (item.type === 'cli') button('Send test prompt', () => this._test(item, true), !saved);
    li.append(actions);
    return li;
  }

  _move(index, delta) {
    const other = index + delta; if (other < 0 || other >= this._items.length) return;
    [this._items[index], this._items[other]] = [this._items[other], this._items[index]];
    this._dirty = true; this._render();
  }

  _form() {
    const { index, item } = this._editing;
    const form = el('form', { className: 'model-form model-connection-form' });
    const field = (label, control) => form.append(el('label', { className: 'connector-field' }, label, control));
    const input = (name, value = '', props = {}) => el('input', { name, value, autocomplete: 'off', ...props });
    const kind = el('select', { name: 'kind' }, ...KINDS.map(([value, text]) => el('option', { value, textContent: text })));
    kind.value = kindOf(item);
    field('Kind', kind);
    field('Name (letters, digits, - and _)', input('id', item.id, { required: true, pattern: '[A-Za-z0-9_\\-]{1,64}' }));
    const model = input('model', item.model || ''); field('Model name (optional for CLI tools)', model);
    const endpoint = input('baseUrl', item.baseUrl || '', { type: 'url', placeholder: 'http://127.0.0.1:1234' }); field('Endpoint URL', endpoint);
    const key = input('apiKey', '', { type: 'password' }); field(item.keyConfigured ? 'API key (leave blank to keep the stored key)' : 'API key (optional for local endpoints)', key);
    const executable = input('executable', item.executable || '', { placeholder: 'default: the tool name on PATH' }); field('Command (name on PATH or absolute path)', executable);
    const args = el('textarea', { name: 'args', rows: 3, value: (item.args || []).join('\n'), placeholder: 'one argument per line; use {promptFile}, {cwd}, {model}' }); field('Arguments (custom command)', args);
    const inputMode = el('select', { name: 'input' }, el('option', { value: 'stdin', textContent: 'Prompt on standard input' }), el('option', { value: 'file', textContent: 'Prompt in a file ({promptFile})' })); inputMode.value = item.input || 'stdin'; field('How the command receives the prompt', inputMode);
    const timeout = input('timeoutMs', String(item.timeoutMs || 120000), { type: 'number', min: '1000', max: '600000', step: '1000' }); field('Timeout (milliseconds)', timeout);
    const destination = el('select', { name: 'destination' }, el('option', { value: '', textContent: 'Automatic (local network addresses count as local)' }), el('option', { value: 'local_model', textContent: 'Runs only on my machines (local model)' }), el('option', { value: 'configured_remote_model', textContent: 'Hosted service (remote model)' })); destination.value = item.destination || ''; field('Privacy destination', destination);
    form.append(el('p', { textContent: 'The privacy destination decides which personal context may be sent here (your data-processing policy). CLI tools are treated as hosted services unless you say otherwise. A custom command runs with your account\'s permissions: only use commands you trust, and do not put secrets in its arguments.' }));
    const apply = () => {
      const [type, preset] = kind.value.split(':'); const cli = type === 'cli', custom = preset === 'custom';
      model.closest('label').hidden = false; endpoint.closest('label').hidden = cli; key.closest('label').hidden = cli;
      executable.closest('label').hidden = !cli; args.closest('label').hidden = !custom; inputMode.closest('label').hidden = !custom;
      endpoint.required = type === 'openai-compatible'; model.required = !cli; executable.required = custom;
    };
    kind.addEventListener('change', apply); apply();
    const ok = el('button', { type: 'submit', className: 'btn btn-primary', textContent: 'Keep this connection' });
    const cancel = el('button', { type: 'button', className: 'btn', textContent: 'Cancel' });
    cancel.addEventListener('click', () => { this._editing = null; this._render(); });
    form.append(el('p', {}, ok, ' ', cancel));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const [type, preset] = kind.value.split(':'); const next = { id: form.elements.id.value.trim(), type, timeoutMs: Number(timeout.value) || 120000 };
      if (type === 'cli') { next.preset = preset; if (executable.value.trim()) next.executable = executable.value.trim(); if (model.value.trim()) next.model = model.value.trim(); if (preset === 'custom') { next.args = args.value.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== ''); next.input = inputMode.value; } }
      else { next.model = model.value.trim(); if (endpoint.value.trim()) next.baseUrl = endpoint.value.trim(); next.keyConfigured = item.keyConfigured; next.apiKey = key.value; }
      if (destination.value) next.destination = destination.value;
      key.value = '';
      if (this._items.some((other, i) => other.id === next.id && i !== index)) { this._status.textContent = `There is already a connection named ${next.id}.`; return; }
      this._items[index] = next; this._dirty = true; this._editing = null; this._render();
    });
    return form;
  }

  async _save() {
    if (this._saving) return; this._saving = true;
    const payload = { configurationRevision: this._revision, connections: this._items.map(({ keyConfigured, apiKey, ...rest }) => ({ ...rest, ...(apiKey ? { apiKey } : {}) })) };
    for (const item of this._items) item.apiKey = '';
    this._status.textContent = 'Saving connections; no model request is being made…';
    try {
      const result = await saveModelConnections(payload);
      const message = result.reloaded ? 'Saved and applied to the running planner.' : 'Saved, but the running server could not adopt the change; restart U2OS.';
      this._status.textContent = message;
      this._onSaved?.(message);
    } catch (error) {
      this._status.textContent = `Not saved: ${error.message || 'the save could not be confirmed'}. Reload this view before trying again.`;
    } finally { this._saving = false; window.dispatchEvent(new CustomEvent('u2-model-configuration-saved')); }
  }

  async _test(item, sendPrompt) {
    this._results.set(item.id, sendPrompt ? 'Sending a test prompt…' : 'Checking…'); this._render();
    try {
      const r = await testModelConnection(item.id, sendPrompt);
      this._results.set(item.id, `${r.ok ? 'OK' : 'Failed'}: ${r.detail || r.reason || ''}${r.version ? ` (${r.version})` : ''}`);
    } catch (error) { this._results.set(item.id, `Failed: ${error.message || 'could not run the test'}`); }
    if (this.isConnected) this._render();
  }
}
customElements.define('u2-model-connections', U2ModelConnections);
