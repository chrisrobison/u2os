import { getAddons, updateAddon } from '../services/api.js';

// Add-ons page (docs/addons.md, ADR 0010). An add-on only describes; this page
// shows what it says, lets you enable it, and lets you confirm what each of its
// tools may do. Until you confirm a tool, the server treats it as an action
// that asks first and whose results are private. Every decision is enforced by
// the server; this view only asks. Built with textContent, never innerHTML.
const CLASSIFICATIONS = [['public', 'Public'], ['personal', 'Personal'], ['private', 'Private'], ['sensitive', 'Sensitive']];
const el = (tag, props = {}, ...children) => {
  const { role, ariaLive, dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (role) node.setAttribute('role', role);
  if (ariaLive) node.setAttribute('aria-live', ariaLive);
  for (const [k, v] of Object.entries(dataset || {})) node.dataset[k] = v;
  node.append(...children);
  return node;
};
const label = (text, control) => el('label', { className: 'connector-field' }, text, control);

export class U2Addons extends HTMLElement {
  connectedCallback() { this._expanded = new Set(this.focusId ? [this.focusId] : []); this._busy = false; this._load(); }

  async _load() {
    this.replaceChildren(el('div', { className: 'empty-state', textContent: 'Loading add-ons…' }));
    try { this._data = await getAddons(); this._render(); }
    catch (error) { this.replaceChildren(el('div', { className: 'load-error', textContent: `Couldn't load add-ons: ${error.message}` })); }
  }

  _render() {
    const { addons, decisionsError } = this._data;
    this.replaceChildren(
      el('div', { className: 'workspace__header' }, el('div', { className: 'workspace__title', textContent: 'Add-ons' })),
      el('p', { textContent: 'Add-ons give U2OS new abilities. An add-on only describes what it offers; you decide whether it runs and what each tool may do. A tool you have not confirmed always asks before it acts, and its results are treated as private.' }),
    );
    if (decisionsError) this.append(el('p', { className: 'load-error', textContent: `Your addons.yaml has a problem, so no add-on is enabled and nothing here can be saved until it is fixed: ${decisionsError}` }));
    this._status = el('p', { role: 'status', ariaLive: 'polite', className: 'addons-status', textContent: this._message || '' });
    this.append(this._status);
    if (!addons.length) this.append(el('p', { className: 'empty-state', textContent: 'No add-ons are installed. Bundled add-ons appear here when they ship with U2OS; third-party ones go in the add-ons folder of your U2OS home.' }));
    for (const addon of addons) this.append(this._card(addon));
    const focus = this.focusId && this.querySelector(`[data-addon="${CSS.escape(this.focusId)}"]`);
    if (focus && !this._focused) { this._focused = true; focus.scrollIntoView?.({ block: 'start' }); }
  }

  _card(addon) {
    const card = el('section', { className: 'diagnostics-card addon-card', dataset: { addon: addon.id } });
    const title = addon.name || addon.id;
    const stateText = addon.enabled ? 'Enabled' : addon.state === 'available' ? 'Not enabled' : addon.state === 'unsupported' ? 'Not supported here' : 'Invalid';
    card.append(el('h2', { textContent: `${title}${addon.version ? ` ${addon.version}` : ''}` }), el('p', { className: 'addon-meta', textContent: `${stateText} · ${addon.tier === 'bundled' ? 'Bundled with U2OS' : 'Installed (third party)'}${addon.author ? ` · ${addon.author}` : ''}` }));
    if (addon.description) card.append(el('p', { textContent: addon.description }));
    if (addon.problems?.length) card.append(el('ul', { className: 'addon-problems' }, ...addon.problems.map((p) => el('li', { textContent: p }))));
    if (addon.missingCommands?.length) card.append(el('p', { className: 'addon-warning', textContent: `Needs these programs on your PATH, which were not found: ${addon.missingCommands.join(', ')}.` }));
    for (const server of addon.runtime || []) card.append(el('p', { className: 'addon-runtime', textContent: `Tool server ${server.name}: ${server.state}${server.error ? ` (${server.error})` : ''}${server.missingTools?.length ? `. Not offered by the server: ${server.missingTools.join(', ')}` : ''}` }));
    const actions = el('p', {});
    if (addon.state !== 'invalid') {
      const toggle = el('button', { type: 'button', className: addon.enabled ? 'btn' : 'btn btn-primary', textContent: addon.enabled ? 'Disable' : 'Enable', disabled: this._busy || (!addon.enabled && addon.state !== 'available') || Boolean(this._data.decisionsError) });
      toggle.addEventListener('click', () => this._update(addon.id, { enabled: !addon.enabled }, addon.enabled ? `${title} disabled.` : `${title} enabled.`));
      actions.append(toggle, ' ');
    }
    const open = this._expanded.has(addon.id);
    const details = el('button', { type: 'button', className: 'btn', textContent: open ? 'Hide details' : 'Details', ariaExpanded: String(open) });
    details.setAttribute('aria-expanded', String(open));
    details.addEventListener('click', () => { if (open) this._expanded.delete(addon.id); else this._expanded.add(addon.id); this._render(); });
    actions.append(details);
    card.append(actions);
    if (open && addon.name) card.append(this._details(addon));
    return card;
  }

  _details(addon) {
    const box = el('div', { className: 'addon-details' });
    if (addon.readme) box.append(el('h3', { textContent: 'About' }), el('pre', { className: 'addon-readme', textContent: addon.readme }));
    for (const server of addon.servers || []) {
      box.append(el('h3', { textContent: `Tools (${server.name})` }), el('p', { textContent: 'Nothing here takes effect until you confirm it. "Read-only" means it only looks things up, so it runs without asking. Anything else asks you first. The privacy level decides which models may see its results.' }));
      for (const tool of server.tools) box.append(this._tool(addon, tool));
    }
    if (addon.settings?.length) box.append(this._settings(addon));
    if (addon.nav?.length) box.append(el('p', { textContent: `Adds to the navigation: ${addon.nav.map((n) => n.title).join(', ')}.` }));
    if (addon.skills?.length || addon.routines?.length) box.append(el('p', { textContent: `Ships ${[...(addon.skills || []), ...(addon.routines || [])].length} skill/routine file(s); these are not installed into your vault yet.` }));
    return box;
  }

  _tool(addon, tool) {
    const row = el('div', { className: 'addon-tool', dataset: { tool: tool.fullName } });
    const fixed = Object.entries(tool.fixed || {}).map(([k, v]) => `${k}=${v}`).join(', ');
    row.append(el('strong', { textContent: tool.fullName }), el('span', { textContent: ` ${tool.description || ''}${fixed ? ` (uses ${fixed})` : ''}` }));
    row.append(el('div', { className: 'addon-suggested', textContent: `Suggested by the add-on: ${tool.suggested.read ? 'read-only' : 'can change things'}, ${tool.suggested.classification} results.` }));
    const now = el('div', { className: 'addon-effective', textContent: tool.confirmed ? `Your decision: ${tool.effective.read ? 'read-only' : 'asks before acting'}, ${tool.effective.classification} results.` : 'Not confirmed yet: asks before acting, results treated as private.' });
    row.append(now);
    const read = el('input', { type: 'checkbox', checked: tool.confirmed ? tool.effective.read : tool.suggested.read });
    const level = el('select', {}, ...CLASSIFICATIONS.map(([value, text]) => el('option', { value, textContent: text })));
    level.value = tool.confirmed ? tool.effective.classification : tool.suggested.classification;
    const save = el('button', { type: 'button', className: 'btn', textContent: tool.confirmed ? 'Update decision' : 'Confirm', disabled: this._busy || Boolean(this._data.decisionsError) });
    save.addEventListener('click', () => this._update(addon.id, { confirmTools: { [tool.name]: { read: read.checked, classification: level.value } } }, `${tool.fullName} confirmed.`));
    const controls = el('div', { className: 'addon-controls' }, el('label', {}, read, ' Read-only'), ' ', label('Privacy of results ', level), ' ', save);
    if (tool.confirmed) {
      const reset = el('button', { type: 'button', className: 'btn', textContent: 'Reset', disabled: this._busy });
      reset.addEventListener('click', () => this._update(addon.id, { unconfirmTools: [tool.name] }, `${tool.fullName} reset: it asks again.`));
      controls.append(' ', reset);
    }
    row.append(controls);
    return row;
  }

  _settings(addon) {
    const form = el('form', { className: 'model-form addon-settings' }, el('h3', { textContent: 'Settings' }));
    const inputs = new Map();
    for (const setting of addon.settings) {
      let input;
      if (setting.enum) { input = el('select', {}, ...setting.enum.map((v) => el('option', { value: String(v), textContent: String(v) }))); input.value = String(setting.value ?? ''); }
      else if (setting.type === 'boolean') { input = el('input', { type: 'checkbox', checked: setting.value === true }); }
      else { input = el('input', { type: setting.type === 'number' ? 'number' : 'text', value: setting.value ?? '' }); }
      input.name = setting.key; inputs.set(setting.key, [setting, input]);
      form.append(label(`${setting.key}${setting.description ? ` – ${setting.description}` : ''}`, input));
    }
    form.append(el('button', { type: 'submit', className: 'btn', textContent: 'Save settings', disabled: this._busy || Boolean(this._data.decisionsError) }));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = {};
      for (const [key, [setting, input]] of inputs) values[key] = setting.type === 'boolean' ? input.checked : setting.type === 'number' ? Number(input.value) : (setting.enum ? (typeof setting.enum[0] === 'number' ? Number(input.value) : input.value) : input.value);
      this._update(addon.id, { settings: values }, 'Settings saved.');
    });
    return form;
  }

  async _update(id, body, success) {
    if (this._busy) return;
    this._busy = true; this._message = 'Saving…'; this._status.textContent = this._message;
    try {
      const result = await updateAddon(id, body);
      const index = this._data.addons.findIndex((a) => a.id === id);
      if (index >= 0 && result.addon) this._data.addons[index] = result.addon;
      this._message = result.applyError ? `${success} ${result.applyError}` : success;
      window.dispatchEvent(new CustomEvent('u2-addons-changed'));
    } catch (error) { this._message = `Not saved: ${error.message}`; }
    finally { this._busy = false; if (this.isConnected) this._render(); }
  }
}
customElements.define('u2-addons', U2Addons);
