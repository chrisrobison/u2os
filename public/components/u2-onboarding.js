import { escapeHtml } from './util.js';
import * as api from '../services/api.js';
import './u2-model.js';
import './u2-connectors.js';

const STEPS = [
  { id: 'vault', title: 'Where your vault lives' },
  { id: 'me', title: 'Who you are' },
  { id: 'model', title: 'Choose intelligence' },
  { id: 'connect', title: 'Connect your world' },
  { id: 'routines', title: 'Starter routines' },
  { id: 'review', title: 'Review what U2OS may do' },
  { id: 'finish', title: 'Finish' },
];

// First-run onboarding wizard (#413, PLAN.md Milestone B, docs/onboarding.md):
// vault location, me.md, model, connecting Gmail/Calendar/Contacts, starter
// routines, a review of what runs automatically, and a finish step into the
// dashboard. Every step is individually skippable/revisitable via the step
// tabs and Back/Next -- nothing consequential (relocating the vault, saving
// me.md, installing a routine, connecting an account, changing the model)
// happens except from an explicit button press within that step, the same
// explicit-consent spirit as u2-model.js's save flow.
//
// u2-app.js mounts this in place of the dashboard shell when onboarding is
// not yet complete, and listens for the `u2-onboarding-complete` event this
// component dispatches on its finish step. u2-app.js can also mount this on
// demand later (e.g. from Settings/nav) to let an already-onboarded owner
// revisit the wizard -- doing so never re-gates them, because only the
// finish step's button calls POST /api/onboarding.
export class U2Onboarding extends HTMLElement {
  constructor() {
    super();
    this._step = 0;
    this._starterInstalled = new Set();
    this._onClick = this._onClick.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
  }

  connectedCallback() {
    this.addEventListener('click', this._onClick);
    this.addEventListener('submit', this._onSubmit);
    this._renderShell();
    this._loadStep();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    this.removeEventListener('submit', this._onSubmit);
  }

  _renderShell() {
    const step = STEPS[this._step];
    const last = this._step === STEPS.length - 1;
    this.innerHTML = `
      <div class="workspace__header">
        <div class="workspace__title">Welcome to U2OS</div>
        <div class="workspace__subtitle">Step ${this._step + 1} of ${STEPS.length}: ${escapeHtml(step.title)}</div>
      </div>
      <ol class="onboarding-steps">
        ${STEPS.map((s, i) => `<li class="onboarding-steps__item${i === this._step ? ' is-active' : ''}${i < this._step ? ' is-done' : ''}"><button type="button" data-goto-step="${i}">${escapeHtml(s.title)}</button></li>`).join('')}
      </ol>
      <div class="dashboard-card onboarding-step" data-step-body></div>
      <div class="onboarding-nav">
        <button type="button" class="btn" data-prev ${this._step === 0 ? 'disabled' : ''}>Back</button>
        ${last ? '' : '<button type="button" class="btn" data-skip>Skip for now</button>'}
        ${last ? '' : '<button type="button" class="btn btn-primary" data-next>Next</button>'}
      </div>
    `;
  }

  _stepBody() {
    return this.querySelector('[data-step-body]');
  }

  _loadStep() {
    const body = this._stepBody();
    switch (STEPS[this._step].id) {
      case 'vault': return this._renderVaultStep(body);
      case 'me': return this._renderMeStep(body);
      case 'model': return this._renderModelStep(body);
      case 'connect': return this._renderConnectStep(body);
      case 'routines': return this._renderRoutinesStep(body);
      case 'review': return this._renderReviewStep(body);
      case 'finish': return this._renderFinishStep(body);
      default: return undefined;
    }
  }

  _goto(step) {
    this._step = Math.max(0, Math.min(STEPS.length - 1, step));
    this._renderShell();
    this._loadStep();
  }

  // ---- step 1: vault location ----

  async _renderVaultStep(body) {
    body.innerHTML = '<p>Loading vault status…</p>';
    try {
      const status = await api.getVaultStatus();
      if (this._stepBody() !== body) return;
      body.innerHTML = `
        <p>Your vault is a folder of Markdown files you own (see <span class="mono">docs/vault.md</span>). It currently lives at:</p>
        <p class="mono">${escapeHtml(status.vaultDir)}</p>
        <p>You can move it now, while it is still empty, or keep this default and move on -- this can only relocate an empty vault, never one with your files in it.</p>
        <form data-vault-form>
          <label class="connector-field">New vault location (absolute path -- leave blank to keep the current one)
            <input name="vaultDir" placeholder="${escapeHtml(status.vaultDir)}" autocomplete="off">
          </label>
          <button type="submit" class="btn">Save location</button>
          <p class="onboarding-message" role="status" aria-live="polite"></p>
        </form>
      `;
    } catch (err) {
      body.innerHTML = `<div class="load-error">Couldn't load vault status: ${escapeHtml(err.message)}</div>`;
    }
  }

  async _saveVaultLocation(form) {
    const value = form.elements.vaultDir.value.trim();
    const status = form.querySelector('.onboarding-message');
    if (!value) {
      status.classList.remove('is-error');
      status.textContent = 'Enter a path to move the vault, or use Next to keep the current location.';
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.classList.remove('is-error');
    status.textContent = 'Moving vault…';
    try {
      const result = await api.relocateVault(value);
      status.textContent = `Vault moved to ${result.vaultDir}.`;
      form.elements.vaultDir.value = '';
      form.elements.vaultDir.placeholder = result.vaultDir;
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  }

  // ---- step 2: me.md ----

  async _renderMeStep(body) {
    body.innerHTML = '<p>Loading me.md…</p>';
    try {
      const { content } = await api.getMeFile();
      if (this._stepBody() !== body) return;
      body.innerHTML = `
        <p>This becomes <span class="mono">me.md</span> in your vault -- who you are, in your own words. Frontmatter keys become facts U2OS can use.</p>
        <form data-me-form>
          <textarea name="content" class="onboarding-textarea" spellcheck="false">${escapeHtml(content)}</textarea>
          <button type="submit" class="btn btn-primary">Save me.md</button>
          <p class="onboarding-message" role="status" aria-live="polite"></p>
        </form>
      `;
    } catch (err) {
      body.innerHTML = `<div class="load-error">Couldn't load me.md: ${escapeHtml(err.message)}</div>`;
    }
  }

  async _saveMe(form) {
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('.onboarding-message');
    button.disabled = true;
    status.classList.remove('is-error');
    status.textContent = 'Saving me.md…';
    try {
      const result = await api.saveMeFile(form.elements.content.value);
      if (result.error) {
        status.classList.add('is-error');
        status.textContent = `Saved, but indexing this file reported: ${result.error}`;
      } else {
        status.textContent = 'Saved.';
      }
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  }

  // ---- step 3: model (embeds the existing, self-contained <u2-model>) ----

  _renderModelStep(body) {
    body.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = 'Choose the model U2OS plans and reasons with. You can change this later from Model in the navigation.';
    body.appendChild(p);
    body.appendChild(document.createElement('u2-model'));
  }

  // ---- step 4: connect Gmail/Calendar/Contacts (embeds <u2-connectors>, filtered) ----

  _renderConnectStep(body) {
    body.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = 'Connect Gmail, Google Calendar and Contacts, or skip this and keep using the built-in mock data for now. You can revisit this any time from Connectors.';
    body.appendChild(p);
    const connectors = document.createElement('u2-connectors');
    connectors.filterDomains = ['calendar', 'email', 'contacts'];
    body.appendChild(connectors);
  }

  // ---- step 5: starter routines (#412's catalog) ----

  async _renderRoutinesStep(body) {
    body.innerHTML = '<p>Loading starter routines…</p>';
    try {
      const { catalog, installed } = await api.getStarterRoutines();
      if (this._stepBody() !== body) return;
      this._starterInstalled = new Set(installed);
      body.innerHTML = `
        <p>Turn on any of these ready-made routines (see <span class="mono">docs/routines.md</span>). They only act within your policy, and you can disable or edit them later from Routines.</p>
        <form data-routines-form>
          ${catalog.map((item) => `
            <label class="onboarding-checkbox">
              <input type="checkbox" name="ids" value="${escapeHtml(item.id)}" ${this._starterInstalled.has(item.id) ? 'checked disabled' : ''}>
              <span><strong>${escapeHtml(item.label)}</strong>${this._starterInstalled.has(item.id) ? ' (already installed)' : ''}<br><small>${escapeHtml(item.description)}</small></span>
            </label>
          `).join('')}
          <button type="submit" class="btn btn-primary">Install selected</button>
          <p class="onboarding-message" role="status" aria-live="polite"></p>
        </form>
      `;
    } catch (err) {
      body.innerHTML = `<div class="load-error">Couldn't load starter routines: ${escapeHtml(err.message)}</div>`;
    }
  }

  async _installRoutines(form) {
    const ids = [...new FormData(form).getAll('ids')];
    const status = form.querySelector('.onboarding-message');
    if (!ids.length) {
      status.classList.remove('is-error');
      status.textContent = 'Choose at least one routine to install, or use Next to skip this step.';
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.classList.remove('is-error');
    status.textContent = 'Installing…';
    try {
      const { results } = await api.installStarterRoutines(ids);
      const installedNow = results.filter((r) => r.installed.length).map((r) => r.id);
      const alreadyPresent = results.filter((r) => !r.installed.length).map((r) => r.id);
      const parts = [];
      if (installedNow.length) parts.push(`Installed: ${installedNow.join(', ')}.`);
      if (alreadyPresent.length) parts.push(`Already present: ${alreadyPresent.join(', ')}.`);
      status.textContent = parts.join(' ') || 'Nothing new to install.';
      for (const id of ids) {
        this._starterInstalled.add(id);
        const checkbox = form.querySelector(`input[value="${CSS.escape(id)}"]`);
        if (checkbox) checkbox.disabled = true;
      }
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  }

  // ---- step 6: review ----

  async _renderReviewStep(body) {
    body.innerHTML = '<p>Loading a summary…</p>';
    try {
      const [status, starter] = await Promise.all([api.getVaultStatus(), api.getStarterRoutines()]);
      if (this._stepBody() !== body) return;
      const installedItems = starter.catalog.filter((item) => starter.installed.includes(item.id));
      body.innerHTML = `
        <p>Here is what U2OS is set up to do, all still subject to your policy (nothing here runs without it):</p>
        <ul>
          <li>Vault: <span class="mono">${escapeHtml(status.vaultDir)}</span></li>
          <li>Routines enabled: ${installedItems.length ? installedItems.map((item) => escapeHtml(item.label)).join(', ') : 'none yet'}</li>
          <li>Policy in effect: ${status.policy?.active ? "your vault's own policies.yaml" : 'the built-in default policy'}</li>
        </ul>
        <p>Review or change any of this later from <a href="#/vault">Vault</a> and <a href="#/routines">Routines</a>. <span class="mono">docs/policies.md</span> explains what each policy level (always/autonomous/confirm/never) means.</p>
      `;
    } catch (err) {
      body.innerHTML = `<div class="load-error">Couldn't load a summary: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ---- step 7: finish ----

  _renderFinishStep(body) {
    body.innerHTML = `
      <p>That's the setup. You can revisit any of this later from Vault, Model, Connectors and Routines, or reopen this wizard from Settings.</p>
      <button type="button" class="btn btn-primary" data-finish>Go to my dashboard</button>
      <p class="onboarding-message" role="status" aria-live="polite"></p>
    `;
  }

  async _finish() {
    const body = this._stepBody();
    const button = body.querySelector('[data-finish]');
    const status = body.querySelector('.onboarding-message');
    button.disabled = true;
    status.classList.remove('is-error');
    status.textContent = 'Finishing setup…';
    try {
      await api.completeOnboarding();
      this.dispatchEvent(new CustomEvent('u2-onboarding-complete', { bubbles: true }));
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
      button.disabled = false;
    }
  }

  // ---- events ----

  _onClick(event) {
    const gotoBtn = event.target.closest('[data-goto-step]');
    if (gotoBtn) return this._goto(Number(gotoBtn.dataset.gotoStep));
    if (event.target.closest('[data-prev]')) return this._goto(this._step - 1);
    if (event.target.closest('[data-next], [data-skip]')) return this._goto(this._step + 1);
    if (event.target.closest('[data-finish]')) return this._finish();
  }

  _onSubmit(event) {
    if (event.target.matches('[data-vault-form]')) { event.preventDefault(); this._saveVaultLocation(event.target); return; }
    if (event.target.matches('[data-me-form]')) { event.preventDefault(); this._saveMe(event.target); return; }
    if (event.target.matches('[data-routines-form]')) { event.preventDefault(); this._installRoutines(event.target); }
  }
}

customElements.define('u2-onboarding', U2Onboarding);
