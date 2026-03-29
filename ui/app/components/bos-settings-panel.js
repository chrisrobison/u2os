/**
 * ui/app/components/bos-settings-panel.js
 *
 * Custom Element: <bos-settings-panel>
 *
 * Renders a per-tenant instance settings panel with collapsible sections.
 * Talks to GET /api/system/settings and PUT /api/system/settings.
 *
 * Shadow DOM is used so the component is style-isolated while still
 * inheriting CSS custom properties from the parent page (they pierce the
 * shadow boundary by design).
 *
 * Usage in an app definition:
 *   componentTag: "bos-settings-panel"
 *   (no componentProps needed; it's self-contained)
 */

'use strict';

class BosSettingsPanel extends HTMLElement {
  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: 'open' });
    this._settings = null;
    this._dirty = {}; // Sections that have unsaved changes: { sectionKey: patchObj }
    this._saving = false;
    this._error = null;
    this._successMessage = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  connectedCallback() {
    this._render();
    this._load();
  }

  // config setter/getter so the app runtime can pass componentProps (no-op for
  // this component but required by the runtime protocol).
  set config(value) { /* settings panel is self-contained */ }
  get config()      { return {}; }

  // ── API ────────────────────────────────────────────────────────────────────

  async _fetchJson(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    if (response.status === 401) {
      this._error = 'Session expired. Please sign in again.';
      this._render();
      return null;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(payload.error || `Request failed (${response.status})`);
      err.status = response.status;
      throw err;
    }
    return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
  }

  async _load() {
    this._error = null;
    this._renderLoading();
    try {
      const result = await this._fetchJson('/api/system/settings');
      if (!result) return; // 401 redirect handled above
      this._settings = result.effectiveSettings || {};
      this._dirty = {};
      this._render();
    } catch (error) {
      this._error = error.message;
      this._render();
    }
  }

  async _save(sectionKey) {
    if (this._saving) return;
    const patch = this._dirty[sectionKey];
    if (!patch || Object.keys(patch).length === 0) {
      this._showToast('No changes to save.', 'info');
      return;
    }

    this._saving = true;
    this._error = null;
    this._successMessage = null;
    this._updateSaveButton(sectionKey, true);

    try {
      const result = await this._fetchJson('/api/system/settings', {
        method: 'PUT',
        body: JSON.stringify(patch)
      });
      if (!result) return;
      this._settings = result.effectiveSettings || this._settings;
      delete this._dirty[sectionKey];
      this._showToast('Settings saved.', 'success');
    } catch (error) {
      this._showToast(error.message, 'error');
    } finally {
      this._saving = false;
      this._updateSaveButton(sectionKey, false);
    }
  }

  // ── Toast notifications ────────────────────────────────────────────────────

  _showToast(message, type = 'info') {
    const toast = this._shadow.getElementById('sp-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = `sp-toast sp-toast-${type} sp-toast-visible`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.className = 'sp-toast';
    }, 3500);
  }

  // ── Inline save-button busy state ─────────────────────────────────────────

  _updateSaveButton(sectionKey, busy) {
    const btn = this._shadow.querySelector(`[data-save-section="${sectionKey}"]`);
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? 'Saving…' : 'Save';
  }

  // ── Dirty tracking ─────────────────────────────────────────────────────────

  _trackChange(sectionKey, path, value) {
    if (!this._dirty[sectionKey]) this._dirty[sectionKey] = {};
    // Build a nested patch object for this sectionKey (the top-level key in settings)
    const parts = path.split('.');
    let cursor = this._dirty[sectionKey];
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') {
        cursor[parts[i]] = {};
      }
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  _renderLoading() {
    this._shadow.innerHTML = `
      ${this._styles()}
      <div class="sp-loading">Loading settings…</div>
    `;
  }

  /** Check if a field in globalSettings is marked read-only. */
  _isReadOnly(fieldPath) {
    // Convention: if the global settings value for the path has a sibling
    // _readOnly: true key, or the parent object has _<field>_readOnly: true.
    // We check the raw settings data we received from the API.
    // Since the API merges everything, we can't distinguish global vs override
    // here — the server enforces the actual restriction. We disable fields
    // only when the server explicitly marks them (not implemented in the simple
    // settings.json format — this is a UI hint only).
    return false;
  }

  _escHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Field renderers ────────────────────────────────────────────────────────

  _renderTextField({ id, label, value, sectionKey, fieldPath, type = 'text', readOnly = false }) {
    const esc = this._escHtml(value);
    return `
      <div class="sp-field">
        <label class="sp-label" for="${id}">
          ${this._escHtml(label)}
          ${readOnly ? '<span class="sp-lock" aria-label="Operator-locked">&#128274;</span>' : ''}
        </label>
        <input
          class="sp-input"
          type="${type}"
          id="${id}"
          value="${esc}"
          ${readOnly ? 'disabled aria-disabled="true"' : ''}
          data-section="${sectionKey}"
          data-field-path="${fieldPath}"
        />
      </div>
    `;
  }

  _renderToggleField({ id, label, value, sectionKey, fieldPath, readOnly = false }) {
    return `
      <div class="sp-field sp-field-toggle">
        <div class="sp-toggle-row">
          <label class="sp-label" for="${id}">
            ${this._escHtml(label)}
            ${readOnly ? '<span class="sp-lock" aria-label="Operator-locked">&#128274;</span>' : ''}
          </label>
          <button
            class="sp-toggle ${value ? 'sp-toggle-on' : ''}"
            role="switch"
            aria-checked="${value ? 'true' : 'false'}"
            id="${id}"
            ${readOnly ? 'disabled aria-disabled="true"' : ''}
            data-section="${sectionKey}"
            data-field-path="${fieldPath}"
          >
            <span class="sp-toggle-thumb"></span>
          </button>
        </div>
      </div>
    `;
  }

  _renderColorField({ id, label, value, sectionKey, fieldPath, readOnly = false }) {
    const esc = this._escHtml(value || '#000000');
    return `
      <div class="sp-field">
        <label class="sp-label" for="${id}-hex">
          ${this._escHtml(label)}
          ${readOnly ? '<span class="sp-lock" aria-label="Operator-locked">&#128274;</span>' : ''}
        </label>
        <div class="sp-color-pair">
          <input
            type="color"
            id="${id}"
            class="sp-color-swatch"
            value="${esc}"
            ${readOnly ? 'disabled aria-disabled="true"' : ''}
            data-section="${sectionKey}"
            data-field-path="${fieldPath}"
            data-color-peer="${id}-hex"
          />
          <input
            type="text"
            id="${id}-hex"
            class="sp-input"
            value="${esc}"
            maxlength="7"
            placeholder="#000000"
            ${readOnly ? 'disabled aria-disabled="true"' : ''}
            data-section="${sectionKey}"
            data-field-path="${fieldPath}"
            data-color-peer="${id}"
          />
        </div>
      </div>
    `;
  }

  // ── Section renderer ───────────────────────────────────────────────────────

  _renderSection({ key, title, icon, fieldsHtml }) {
    return `
      <details class="sp-section" open>
        <summary class="sp-section-header">
          <span class="sp-section-icon" aria-hidden="true">${icon}</span>
          <span class="sp-section-title">${this._escHtml(title)}</span>
          <span class="sp-chevron" aria-hidden="true">&#8964;</span>
        </summary>
        <div class="sp-section-body">
          ${fieldsHtml}
          <div class="sp-section-footer">
            <button
              class="sp-btn sp-btn-primary"
              data-save-section="${key}"
              type="button"
            >Save</button>
          </div>
        </div>
      </details>
    `;
  }

  // ── Full render ────────────────────────────────────────────────────────────

  _render() {
    if (!this._settings) {
      this._renderLoading();
      return;
    }

    const s = this._settings;
    const branding  = s.branding  || {};
    const features  = s.features  || {};
    const ui        = s.ui        || {};

    const brandingSection = this._renderSection({
      key: 'branding',
      title: 'Branding',
      icon: '&#127912;',
      fieldsHtml: [
        this._renderTextField({
          id: 'sp-productName',
          label: 'Product name',
          value: branding.productName,
          sectionKey: 'branding',
          fieldPath: 'branding.productName'
        }),
        this._renderTextField({
          id: 'sp-supportEmail',
          label: 'Support email',
          value: branding.supportEmail,
          sectionKey: 'branding',
          fieldPath: 'branding.supportEmail',
          type: 'email'
        }),
        this._renderTextField({
          id: 'sp-logoUrl',
          label: 'Logo URL',
          value: branding.logoUrl,
          sectionKey: 'branding',
          fieldPath: 'branding.logoUrl',
          type: 'url'
        }),
        branding.primaryColor != null
          ? this._renderColorField({
            id: 'sp-primaryColor',
            label: 'Primary color',
            value: branding.primaryColor,
            sectionKey: 'branding',
            fieldPath: 'branding.primaryColor'
          })
          : ''
      ].join('\n')
    });

    const featuresSection = this._renderSection({
      key: 'features',
      title: 'Features',
      icon: '&#9881;',
      fieldsHtml: [
        this._renderToggleField({
          id: 'sp-schemasWorkbench',
          label: 'Schema workbench',
          value: Boolean(features.schemasWorkbench),
          sectionKey: 'features',
          fieldPath: 'features.schemasWorkbench'
        }),
        this._renderToggleField({
          id: 'sp-advancedAnalytics',
          label: 'Advanced analytics',
          value: Boolean(features.advancedAnalytics),
          sectionKey: 'features',
          fieldPath: 'features.advancedAnalytics'
        })
      ].join('\n')
    });

    const localeSection = this._renderSection({
      key: 'ui',
      title: 'Localization',
      icon: '&#127760;',
      fieldsHtml: [
        this._renderTextField({
          id: 'sp-defaultLocale',
          label: 'Default locale',
          value: ui.defaultLocale,
          sectionKey: 'ui',
          fieldPath: 'ui.defaultLocale'
        }),
        this._renderTextField({
          id: 'sp-timezone',
          label: 'Timezone',
          value: ui.timezone,
          sectionKey: 'ui',
          fieldPath: 'ui.timezone'
        })
      ].join('\n')
    });

    this._shadow.innerHTML = `
      ${this._styles()}
      <div class="sp-root">
        <header class="sp-header">
          <h2 class="sp-heading">Settings</h2>
          <p class="sp-subheading">Configure this workspace's branding, features, and localization.</p>
        </header>
        ${this._error ? `<div class="sp-error-banner">${this._escHtml(this._error)}</div>` : ''}
        <div id="sp-toast" class="sp-toast" role="status" aria-live="polite"></div>
        <div class="sp-sections">
          ${brandingSection}
          ${featuresSection}
          ${localeSection}
        </div>
      </div>
    `;

    this._bindEvents();
  }

  // ── Event binding ──────────────────────────────────────────────────────────

  _bindEvents() {
    const root = this._shadow;

    // Text / email / url inputs
    root.querySelectorAll('.sp-input').forEach((input) => {
      input.addEventListener('input', () => {
        const sectionKey = input.dataset.section;
        const fieldPath  = input.dataset.fieldPath;
        if (!sectionKey || !fieldPath) return;
        this._trackChange(sectionKey, fieldPath, input.value);
      });
    });

    // Color swatch ↔ hex text synchronisation
    root.querySelectorAll('[data-color-peer]').forEach((el) => {
      el.addEventListener('input', () => {
        const peerId = el.dataset.colorPeer;
        const peer = root.getElementById(peerId);
        if (!peer) return;
        const val = el.value.trim();
        // Only sync hex→swatch when format looks valid
        if (el.type === 'text') {
          if (/^#[0-9a-fA-F]{6}$/.test(val)) {
            peer.value = val;
          }
        } else {
          peer.value = val;
        }
        const sectionKey = el.dataset.section;
        const fieldPath  = el.dataset.fieldPath;
        if (sectionKey && fieldPath) {
          this._trackChange(sectionKey, fieldPath, val);
        }
      });
    });

    // Toggle buttons
    root.querySelectorAll('.sp-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const currentlyOn = btn.getAttribute('aria-checked') === 'true';
        const newVal = !currentlyOn;
        btn.setAttribute('aria-checked', String(newVal));
        btn.classList.toggle('sp-toggle-on', newVal);
        const sectionKey = btn.dataset.section;
        const fieldPath  = btn.dataset.fieldPath;
        if (sectionKey && fieldPath) {
          this._trackChange(sectionKey, fieldPath, newVal);
        }
      });
    });

    // Save buttons
    root.querySelectorAll('[data-save-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._save(btn.dataset.saveSection);
      });
    });
  }

  // ── Styles (Shadow DOM inline) ─────────────────────────────────────────────

  _styles() {
    return `
      <style>
        /*
         * Component-scoped styles for <bos-settings-panel>.
         * CSS custom properties from the parent page are inherited (they
         * pierce the shadow boundary), falling back to sensible defaults.
         */

        :host {
          display: block;
          font-family: "Avenir Next", "Segoe UI", system-ui, sans-serif;
          font-size: 14px;
          color: var(--text, #0f2433);
        }

        * { box-sizing: border-box; }

        /* ── Shell ──────────────────────────────────────────────────────── */

        .sp-root {
          max-width: 640px;
          margin: 0 auto;
          padding: 0 0 40px;
        }

        .sp-loading {
          padding: 24px;
          color: var(--text-muted, #5a6f80);
        }

        .sp-header {
          padding: 20px 0 16px;
          border-bottom: 1px solid var(--surface-line, #d1dde6);
          margin-bottom: 20px;
        }

        .sp-heading {
          margin: 0 0 4px;
          font-size: 22px;
          font-weight: 700;
          color: var(--text, #0f2433);
        }

        .sp-subheading {
          margin: 0;
          font-size: 13px;
          color: var(--text-muted, #5a6f80);
        }

        .sp-error-banner {
          background: #fdf0ef;
          border: 1px solid #f5c6c2;
          color: #922;
          border-radius: 10px;
          padding: 10px 14px;
          font-size: 13px;
          margin-bottom: 16px;
        }

        /* ── Toast ──────────────────────────────────────────────────────── */

        .sp-toast {
          position: sticky;
          top: 12px;
          z-index: 10;
          border-radius: 10px;
          padding: 10px 14px;
          font-size: 13px;
          font-weight: 600;
          margin-bottom: 12px;
          display: none;
          transition: opacity 200ms ease;
        }

        .sp-toast.sp-toast-visible {
          display: block;
        }

        .sp-toast-success {
          background: #eef9f3;
          border: 1px solid #b7e4cc;
          color: #166534;
        }

        .sp-toast-error {
          background: #fdf0ef;
          border: 1px solid #f5c6c2;
          color: #922;
        }

        .sp-toast-info {
          background: #eff6ff;
          border: 1px solid #bfdbfe;
          color: #1d4ed8;
        }

        /* ── Section cards ──────────────────────────────────────────────── */

        .sp-sections {
          display: grid;
          gap: 14px;
        }

        .sp-section {
          border: 1px solid var(--surface-line, #d1dde6);
          border-radius: 12px;
          background: var(--surface-strong, #fff);
          overflow: hidden;
        }

        .sp-section-header {
          list-style: none;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 16px;
          cursor: pointer;
          user-select: none;
          font-weight: 600;
          font-size: 14px;
          color: var(--text, #0f2433);
        }

        .sp-section-header::-webkit-details-marker { display: none; }
        .sp-section-header::marker { display: none; }

        .sp-section-header:hover {
          background: var(--surface, #f4f7fa);
        }

        .sp-section-icon {
          font-size: 18px;
          line-height: 1;
        }

        .sp-section-title {
          flex: 1;
        }

        .sp-chevron {
          font-size: 16px;
          color: var(--text-muted, #5a6f80);
          transition: transform 180ms ease;
        }

        .sp-section[open] .sp-chevron {
          transform: rotate(180deg);
        }

        .sp-section-body {
          padding: 4px 16px 16px;
          border-top: 1px solid var(--surface-line, #d1dde6);
        }

        .sp-section-footer {
          margin-top: 16px;
          display: flex;
          justify-content: flex-end;
        }

        /* ── Fields ─────────────────────────────────────────────────────── */

        .sp-field {
          margin-top: 14px;
        }

        .sp-label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          color: var(--text-muted, #5a6f80);
          margin-bottom: 6px;
          letter-spacing: 0.02em;
        }

        .sp-lock {
          margin-left: 4px;
          font-size: 11px;
          opacity: 0.6;
        }

        .sp-input {
          width: 100%;
          border: 1px solid var(--surface-line, #d1dde6);
          border-radius: 8px;
          padding: 9px 11px;
          font: inherit;
          font-size: 13px;
          color: var(--text, #0f2433);
          background: var(--surface, #f4f7fa);
          transition: border-color 140ms ease, box-shadow 140ms ease;
          appearance: none;
        }

        .sp-input:focus {
          outline: none;
          border-color: var(--accent, #1f8ab4);
          box-shadow: 0 0 0 3px rgba(31, 138, 180, 0.15);
        }

        .sp-input:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          background: var(--surface-line, #d1dde6);
        }

        /* Color pair */
        .sp-color-pair {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .sp-color-swatch {
          width: 40px;
          height: 36px;
          padding: 2px 3px;
          border: 1px solid var(--surface-line, #d1dde6);
          border-radius: 8px;
          cursor: pointer;
          flex-shrink: 0;
          background: var(--surface, #f4f7fa);
        }

        .sp-color-swatch:disabled { opacity: 0.5; cursor: not-allowed; }

        /* Toggle */
        .sp-field-toggle .sp-toggle-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .sp-field-toggle .sp-label {
          margin: 0;
          flex: 1;
        }

        .sp-toggle {
          position: relative;
          width: 40px;
          height: 22px;
          border-radius: 999px;
          border: none;
          background: var(--surface-line, #d1dde6);
          cursor: pointer;
          flex-shrink: 0;
          transition: background 160ms ease;
          padding: 0;
        }

        .sp-toggle-on {
          background: var(--accent, #1f8ab4);
        }

        .sp-toggle:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .sp-toggle-thumb {
          position: absolute;
          top: 3px;
          left: 3px;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 3px rgba(0,0,0,0.2);
          transition: transform 160ms ease;
          pointer-events: none;
        }

        .sp-toggle-on .sp-toggle-thumb {
          transform: translateX(18px);
        }

        /* ── Buttons ─────────────────────────────────────────────────────── */

        .sp-btn {
          border-radius: 8px;
          padding: 8px 18px;
          font: inherit;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: opacity 130ms ease;
        }

        .sp-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .sp-btn-primary {
          background: var(--accent, #1f8ab4);
          color: #fff;
          border: 1px solid var(--accent-strong, #0f6a8e);
        }

        .sp-btn-primary:hover:not(:disabled) {
          background: var(--accent-strong, #0f6a8e);
        }
      </style>
    `;
  }
}

customElements.define('bos-settings-panel', BosSettingsPanel);
