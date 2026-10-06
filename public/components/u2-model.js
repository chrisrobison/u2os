import { getModelStatus, saveModelConfiguration } from '../services/api.js';
import './u2-model-connections.js';

// Explicit owner configuration only: no endpoint probing, model calls or secret
// retrieval. A successful save is applied to the running server immediately
// (server-side hot reload); no restart. Advanced configs are read-only.
export class U2Model extends HTMLElement {
  connectedCallback() { this._generation = (this._generation || 0) + 1; this._load(this._generation); }
  disconnectedCallback() { this._generation++; if (this._key) this._key.value = ''; }

  async _load(generation) {
    this.textContent = 'Loading saved model configuration…';
    try {
      const config = await getModelStatus();
      if (!this.isConnected || generation !== this._generation) return;
      if (typeof config?.configurationRevision !== 'string' || !/^[a-f0-9]{64}$/.test(config.configurationRevision)) throw new Error('Unavailable revision');
      this._render(config);
    } catch {
      if (!this.isConnected || generation !== this._generation) return;
      this.textContent = 'Could not load model configuration. Reload this view before saving; no configuration change was attempted.';
    }
  }

  _render(config) {
    this.innerHTML = `
      <div class="workspace__header"><div class="workspace__title">Model setup</div></div>
      <p>Saving applies your changes to the running planner immediately, with no restart. It is not a connection test: reachability is only checked when the planner is first used.</p>
      <p>Choose an endpoint and model you control or explicitly trust. Remote models may receive context allowed by your privacy policies; setup itself sends no model requests.</p>
      <p class="model-status" role="status"></p>
      <div class="model-content"></div>`;
    this.querySelector('.model-status').textContent = config.plannerStatus === 'configuration-required' ? 'Personal planner requires configuration.' : config.plannerStatus === 'demo' ? 'Saved demo planner: isolated fixtures, not personal reasoning.' : 'Planning adapter is configured in saved settings; reachability has not been checked.';
    if (config.restartRequired) this.querySelector('.model-status').append(' The running planner has not adopted the saved changes (they may have been edited outside this form); restart U2OS to apply them.');
    const content = this.querySelector('.model-content');
    if (config.providers || config.roles || (config.provider && !['mock', 'openai-compatible', 'anthropic'].includes(config.provider))) {
      const note = document.createElement('p'); note.textContent = Array.isArray(config.order) ? 'Your model is configured as the ordered list of connections below; edit it there.' : 'Advanced model configuration is read-only here. This form will not replace provider roles or fallback settings. Use the existing model API to edit them (applied immediately); after editing the config file directly, restart U2OS.';
      const list = document.createElement('ul');
      for (const [role, name] of Object.entries(config.roles || {})) {
        const row = document.createElement('li'); row.textContent = `${role}: ${name}`; list.appendChild(row);
      }
      content.append(note, list); this._mountConnections(config); return;
    }
    content.innerHTML = `
      <form class="model-form">
        <label class="connector-field">Provider<select name="provider"><option value="openai-compatible">OpenAI-compatible (local or remote)</option><option value="anthropic">Anthropic</option></select></label>
        <label class="connector-field">Endpoint URL<input name="baseUrl" type="url" autocomplete="off" placeholder="http://127.0.0.1:11434"></label>
        <label class="connector-field">Model name<input name="model" required autocomplete="off"></label>
        <label class="connector-field">Request timeout (milliseconds)<input name="timeoutMs" type="number" required min="1000" max="300000" step="1"></label>
        <label class="connector-field">API key (optional)<input name="apiKey" type="password" autocomplete="off"></label>
        <p>Keys use the encrypted server vault, are never loaded into this form, and are cleared from this input when submitted or you leave the view. Leave blank to keep the selected provider's existing key. A key may be unnecessary for a local endpoint.</p>
        <p class="model-key-status"></p>
        <p>OpenAI-compatible requires an HTTP(S) endpoint; Anthropic can leave it blank to use its existing adapter default. Saving applies immediately without restarting U2OS, and sends no test prompt.</p>
        <button type="submit" class="btn">Save model configuration</button>
        <p class="model-save-status" role="status" aria-live="polite"></p>
      </form>`;
    const form = content.querySelector('form'), fields = form.elements;
    fields.provider.value = config.provider === 'anthropic' ? 'anthropic' : 'openai-compatible';
    fields.baseUrl.value = typeof config.baseUrl === 'string' ? config.baseUrl : '';
    fields.model.value = typeof config.model === 'string' ? config.model : '';
    fields.timeoutMs.value = Number.isInteger(config.timeoutMs) && config.timeoutMs >= 1000 && config.timeoutMs <= 300000 ? config.timeoutMs : 30000;
    this._key = fields.apiKey;
    this._mountConnections(config);
    form.querySelector('.model-key-status').textContent = config.apiKeyConfigured ? 'A key is stored for the currently saved provider; its value is not available here.' : 'No key is reported for the currently saved provider.';
    const update = () => { fields.baseUrl.required = fields.provider.value === 'openai-compatible'; };
    fields.provider.addEventListener('change', update); update();
    form.addEventListener('submit', (event) => { event.preventDefault(); this._save(form, config.configurationRevision); });
  }

  // The ordered API/CLI connection list sits below the quick form (or the advanced summary).
  _mountConnections(config) {
    if (this.querySelector('u2-model-connections')) return;
    const panel = document.createElement('u2-model-connections');
    this.appendChild(panel);
    const note = this._connectionsNote || ''; this._connectionsNote = '';
    panel.setConfig(config, (message) => { this._connectionsNote = message || ''; this._load(this._generation); }, note);
  }

  async _save(form, revision) {
    if (this._saving) return;
    const fields = form.elements, status = form.querySelector('.model-save-status');
    const payload = { provider: fields.provider.value, model: fields.model.value.trim(), timeoutMs: Number(fields.timeoutMs.value), configurationRevision: revision };
    const endpoint = fields.baseUrl.value.trim();
    if (endpoint) payload.baseUrl = endpoint;
    if (fields.apiKey.value) payload.apiKey = fields.apiKey.value;
    fields.apiKey.value = '';
    try {
      const url = endpoint ? new URL(endpoint) : null;
      if (!payload.model || !Number.isInteger(payload.timeoutMs) || payload.timeoutMs < 1000 || payload.timeoutMs > 300000 ||
          (payload.provider === 'openai-compatible' && !url) || (url && (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash))) throw new Error('Invalid configuration');
    } catch {
      status.textContent = 'Use a model name, supported timeout and HTTP(S) endpoint without URL credentials, query or fragment. No configuration change was attempted.'; return;
    }
    this._saving = true;
    const generation = this._generation;
    for (const field of fields) field.disabled = true;
    status.textContent = 'Saving configuration; no model request is being made…';
    try {
      const result = await saveModelConfiguration(payload);
      if (!this.isConnected || generation !== this._generation) return;
      if (result?.configured !== true) throw new Error('Unconfirmed save');
      if (result.reloaded === true && result.restartRequired !== true) {
        // Applied to the running server. Re-read the saved configuration so a
        // further edit starts from the current revision instead of a stale one.
        // A failed refresh must not be reported as a failed save.
        let fresh = null;
        try { fresh = await getModelStatus(); } catch { /* fall through to the reload hint */ }
        if (!this.isConnected || generation !== this._generation) return;
        if (typeof fresh?.configurationRevision === 'string' && /^[a-f0-9]{64}$/.test(fresh.configurationRevision)) {
          this._render(fresh);
          this.querySelector('.model-save-status').textContent = 'Saved and applied to the running planner; no restart needed. Reachability has not been tested.';
        } else {
          status.textContent = 'Saved and applied to the running planner. Reload this view before editing again.';
        }
        return;
      }
      this.querySelector('.model-status').textContent = 'Saved, but the running server could not adopt the change; restart is required. Reachability has not been checked.';
      form.querySelector('.model-key-status').textContent = 'Reload this view to inspect current key-presence metadata; stored key values are never available here.';
      status.textContent = 'Configuration saved but not applied. Restart U2OS, then reload the browser.';
      // Keep controls disabled: a second save requires reloading the current
      // revision, and must never reuse the now-stale snapshot.
    } catch {
      if (!this.isConnected || generation !== this._generation) return;
      status.textContent = 'Save could not be confirmed. Reload this view to inspect current settings before trying again; no automatic retry or model request.';
    } finally {
      this._saving = false;
      // A lost response may still have saved config. Refresh metadata even then,
      // but never test a model or retry the configuration write.
      window.dispatchEvent(new CustomEvent('u2-model-configuration-saved'));
    }
  }
}
customElements.define('u2-model', U2Model);
