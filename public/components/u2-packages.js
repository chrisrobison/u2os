import { escapeHtml, formatDateTime } from './util.js';
import * as api from '../services/api.js';

const PAST = { enable: 'enabled', disable: 'disabled', pause: 'paused', resume: 'resumed' };

// Packages view (docs/plugin-architecture.md §12): installed packages and
// their permissions, automations and run history, capabilities and skills.
// Every decision shown here is enforced by the server; this view only asks.
export class U2Packages extends HTMLElement {
  constructor() {
    super();
    this._data = null;
    this._review = null;
    this._message = null;
    this._busy = false;
    this._runs = new Map();
    this._expanded = new Set();
    this._onClick = this._onClick.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.addEventListener('click', this._onClick);
    this.addEventListener('submit', this._onSubmit);
    this._load();
  }

  async _load() {
    if (!this._data) this.innerHTML = '<div class="empty-state">Loading packages...</div>';
    try {
      const [{ packages }, { automations }, { capabilities }, { skills }] = await Promise.all([
        api.getPackages(), api.getAutomations(), api.getPackageCapabilities(), api.getPackageSkills(),
      ]);
      this._data = { packages, automations, capabilities, skills };
      this._render();
    } catch (err) {
      this.innerHTML = `<div class="load-error">Couldn't load packages: ${escapeHtml(err.message)}</div>`;
    }
  }

  _render() {
    const { packages, automations, capabilities, skills } = this._data;
    this.innerHTML = `
      <div class="workspace__header">
        <div class="workspace__title">Packages</div>
        <div class="workspace__subtitle">Capabilities, skills and automations you have installed. Permissions and policies are enforced by U2OS, not by packages.</div>
      </div>
      <form class="dashboard-card package-install" data-review-package>
        <div class="u2-card__title">Install a package</div>
        <label>Source <input name="source" required maxlength="500" placeholder="/path/to/package, package.tgz or git+https://…"></label>
        <button type="submit" ${this._busy ? 'disabled' : ''}>Review</button>
      </form>
      <div class="trigger-message${this._message?.error ? ' is-error' : ''}" role="status" aria-live="polite">${escapeHtml(this._message?.text || '')}</div>
      ${this._review ? this._renderReview(this._review) : ''}
      <section aria-labelledby="packages-installed"><h2 class="package-section__title" id="packages-installed">Installed packages</h2>
        ${packages.length ? `<div class="trigger-list">${packages.map((p) => this._packageRow(p)).join('')}</div>` : '<div class="empty-state">No packages installed.</div>'}
      </section>
      <section aria-labelledby="packages-automations"><h2 class="package-section__title" id="packages-automations">Automations</h2>
        ${automations.length ? `<div class="trigger-list">${automations.map((a) => this._automationRow(a)).join('')}</div>` : '<div class="empty-state">No automations installed.</div>'}
      </section>
      <section aria-labelledby="packages-skills"><h2 class="package-section__title" id="packages-skills">Skills</h2>
        ${skills.length ? `<table class="package-table"><thead><tr><th scope="col">Skill</th><th scope="col">Package</th><th scope="col">Uses</th></tr></thead><tbody>${skills.map((s) => `<tr>
          <td><strong>${escapeHtml(s.id)}</strong> <span class="package-muted">${escapeHtml(s.version)}</span><div class="package-muted">${escapeHtml(s.description)}</div></td>
          <td>${escapeHtml(s.packageId)}</td>
          <td>${escapeHtml([...s.dependencies.capabilities.map((c) => `capability:${c}`), ...s.dependencies.skills.map((k) => `skill:${k}`)].join(', ') || '—')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">No skills installed.</div>'}
      </section>
      <section aria-labelledby="packages-capabilities"><h2 class="package-section__title" id="packages-capabilities">Capabilities</h2>
        <table class="package-table"><thead><tr><th scope="col">Capability</th><th scope="col">Provider</th><th scope="col">Effect</th><th scope="col">Status</th><th scope="col">Needs</th></tr></thead><tbody>
          ${capabilities.map((c) => `<tr><td><strong>${escapeHtml(c.id)}</strong> <span class="package-muted">${escapeHtml(c.version)}</span></td>
            <td>${escapeHtml(c.selectedProvider || '—')}${c.providers.some((p) => p.connectors?.length) ? `<div class="package-muted">via ${escapeHtml(c.providers.flatMap((p) => p.connectors || []).join(', '))}</div>` : ''}</td>
            <td>${escapeHtml(c.effect)}</td><td>${escapeHtml(c.status === 'available' ? 'Available' : 'No provider')}</td>
            <td>${escapeHtml(c.requiredPermissions.join(', ') || '—')}</td></tr>`).join('')}
        </tbody></table>
      </section>`;
  }

  _renderReview(review) {
    return `<article class="dashboard-card package-review" aria-label="Package review">
      <div class="u2-card__title">${escapeHtml(review.name)} ${escapeHtml(review.version)}${review.upgradeFrom ? ` <span class="package-muted">(upgrade from ${escapeHtml(review.upgradeFrom)})</span>` : ''}</div>
      <p>${escapeHtml(review.description || '')}</p>
      <div><strong>${escapeHtml(review.name)} wants permission to:</strong>
        <ul>${review.permissions.map((p) => `<li>${escapeHtml(p.description)}${p.sensitive ? ' <span class="trigger-state trigger-state--paused">sensitive</span>' : ''}</li>`).join('') || '<li>nothing</li>'}</ul></div>
      ${review.policies.length ? `<div><strong>Automatic actions</strong> (your policies.yaml still applies):
        <ul>${review.policies.map((p) => `<li>${p.approval === 'automatic' ? '✓' : '✗'} ${escapeHtml(p.description || p.name)}${p.approval === 'automatic' ? '' : p.approval === 'never' ? ' — never' : ' — asks you first'}</li>`).join('')}</ul></div>` : ''}
      ${review.exports.automations.length ? `<div><strong>Automations</strong> (installed disabled): ${escapeHtml(review.exports.automations.map((a) => a.id).join(', '))}</div>` : ''}
      ${review.problems.length ? `<div class="load-error">Cannot install: ${escapeHtml(review.problems.join('; '))}</div>` : ''}
      <div class="trigger-row__actions">
        ${review.installable ? `<button type="button" data-install="none" ${this._busy ? 'disabled' : ''}>Install</button>
        <button type="button" data-install="all" ${this._busy ? 'disabled' : ''}>Install and grant permissions</button>` : ''}
        <button type="button" data-cancel-review>Cancel</button>
      </div>
    </article>`;
  }

  _packageRow(p) {
    const missing = p.permissions.filter((perm) => !perm.granted);
    return `<article class="trigger-row" data-package-id="${escapeHtml(p.id)}">
      <div class="trigger-row__body">
        <div class="trigger-row__heading"><strong>${escapeHtml(p.name)}</strong> <span class="package-muted">${escapeHtml(p.version)} · ${escapeHtml(p.id)}</span>
          <span class="trigger-state trigger-state--${p.enabled ? 'enabled' : 'paused'}">${p.enabled ? 'Enabled' : 'Disabled'}</span>
          ${p.loaded ? '' : '<span class="trigger-state trigger-state--paused">Not loaded</span>'}</div>
        <div class="trigger-row__meta">${escapeHtml(p.description)}</div>
        <div class="trigger-row__meta">Permissions: ${p.permissions.map((perm) => `${perm.granted ? '✓' : '·'} ${escapeHtml(perm.description)}`).join(', ') || 'none'}</div>
        <div class="trigger-row__meta">Requires: ${escapeHtml([...Object.keys(p.dependencies.capabilities).map((c) => `capability:${c}`), ...Object.keys(p.dependencies.skills).map((s) => `skill:${s}`)].join(', ') || 'nothing')}</div>
        ${p.loadError ? `<div class="load-error">${escapeHtml(p.loadError)}</div>` : ''}
      </div>
      <div class="trigger-row__actions">
        ${missing.length ? `<button type="button" data-grant-all="${escapeHtml(p.id)}" ${this._busy ? 'disabled' : ''}>Grant permissions</button>` : `<button type="button" data-revoke-all="${escapeHtml(p.id)}" ${this._busy ? 'disabled' : ''}>Revoke permissions</button>`}
        <button type="button" data-toggle-package="${escapeHtml(p.id)}" data-enabled="${p.enabled}" ${this._busy ? 'disabled' : ''}>${p.enabled ? 'Disable' : 'Enable'}</button>
        <button type="button" class="btn-danger" data-uninstall="${escapeHtml(p.id)}" ${this._busy ? 'disabled' : ''}>Uninstall</button>
      </div>
    </article>`;
  }

  _automationRow(a) {
    const state = !a.enabled ? 'Disabled' : a.paused ? 'Paused' : a.running ? 'Running' : 'Enabled';
    const expanded = this._expanded.has(a.id);
    return `<article class="trigger-row" data-automation-id="${escapeHtml(a.id)}">
      <div class="trigger-row__body">
        <div class="trigger-row__heading"><strong>${escapeHtml(a.name)}</strong> <span class="package-muted">${escapeHtml(a.packageId)}</span>
          <span class="trigger-state trigger-state--${a.enabled && !a.paused ? 'enabled' : 'paused'}">${state}</span></div>
        <div class="trigger-row__meta">Triggers: ${escapeHtml(a.triggers.map((t) => t.description).join(' · '))}</div>
        <div class="trigger-row__next">Next run: ${escapeHtml(a.nextRunAt ? formatDateTime(a.nextRunAt) : '—')} · Last run: ${escapeHtml(a.lastRun ? `${a.lastRun.status} ${formatDateTime(a.lastRun.createdAt)}` : 'never')}${a.lastRun?.error ? ` (${escapeHtml(a.lastRun.error)})` : ''}</div>
        <div class="trigger-row__meta">Needs: ${escapeHtml(a.requirements.permissions.join(', ') || 'nothing')}${a.requirements.missing.length ? ` — not granted: ${escapeHtml(a.requirements.missing.join(', '))}` : ''}</div>
        ${a.policies.length ? `<div class="trigger-row__meta">Policies: ${a.policies.map((p) => `${escapeHtml(p.name)} (${escapeHtml(p.approval)})`).join(', ')}</div>` : ''}
      </div>
      <div class="trigger-row__actions">
        <button type="button" data-automation-op="${a.enabled ? 'disable' : 'enable'}" data-id="${escapeHtml(a.id)}" ${this._busy ? 'disabled' : ''}>${a.enabled ? 'Disable' : 'Enable'}</button>
        ${a.enabled ? `<button type="button" data-automation-op="${a.paused ? 'resume' : 'pause'}" data-id="${escapeHtml(a.id)}" ${this._busy ? 'disabled' : ''}>${a.paused ? 'Resume' : 'Pause'}</button>` : ''}
        <button type="button" data-automation-run="${escapeHtml(a.id)}" ${this._busy || a.paused ? 'disabled' : ''}>Run now</button>
        <button type="button" data-automation-history="${escapeHtml(a.id)}" aria-expanded="${expanded}">${expanded ? 'Hide history' : 'History'}</button>
      </div>
      ${expanded ? this._renderHistory(a) : ''}
    </article>`;
  }

  _renderHistory(a) {
    if (!a.runs.length) return '<div class="trigger-history"><div class="trigger-history__empty">No runs yet.</div></div>';
    return `<div class="trigger-history" aria-label="Run history"><ul>${a.runs.map((run) => {
      const detail = this._runs.get(run.id);
      return `<li>
        <span class="trigger-history__status trigger-history__status--${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
        <span>${escapeHtml(formatDateTime(run.createdAt))}</span>
        <span>${escapeHtml(run.trigger || '')}${run.waitingFor ? ` · waiting for ${escapeHtml(run.waitingFor)}` : ''}${run.error ? ` · ${escapeHtml(run.error)}` : ''}</span>
        <button type="button" data-run-detail="${escapeHtml(run.id)}">${detail ? 'Hide steps' : 'Steps'}</button>
        ${detail ? `<ol class="package-steps">${detail.steps.map((step) => `<li>${escapeHtml(step.stepId)}${step.iteration >= 0 ? `[${step.iteration}]` : ''}: ${escapeHtml(step.status)}${step.policy ? ` · policy ${escapeHtml(step.policy.name)} → ${escapeHtml(step.policy.decision)}` : ''}${step.actionId ? ` · action ${escapeHtml(step.actionId)}` : ''}${step.error ? ` · ${escapeHtml(step.error)}` : ''}</li>`).join('')}</ol>` : ''}
      </li>`;
    }).join('')}</ul></div>`;
  }

  async _onSubmit(event) {
    if (!event.target.matches('[data-review-package]')) return;
    event.preventDefault();
    const source = event.target.source.value.trim();
    await this._act(async () => {
      this._review = { ...(await api.reviewPackage(source)).review, sourceInput: source };
      return this._review.installable ? 'Review the permissions before installing.' : 'This package cannot be installed.';
    });
  }

  async _onClick(event) {
    const target = event.target.closest('button');
    if (!target || this._busy) return;
    const d = target.dataset;
    if (d.cancelReview !== undefined) { this._review = null; this._render(); return; }
    if (d.install) {
      const review = this._review;
      await this._act(async () => {
        await api.installPackage(review.sourceInput, d.install === 'all' ? 'all' : null);
        this._review = null;
        return `Installed ${review.name}. Its automations are disabled until you enable them.`;
      });
    } else if (d.grantAll) await this._act(async () => { await api.setPackageGrants(d.grantAll, { grant: 'all' }); return 'Permissions granted.'; });
    else if (d.revokeAll) await this._act(async () => { await api.setPackageGrants(d.revokeAll, { revoke: 'all' }); return 'Permissions revoked.'; });
    else if (d.togglePackage) await this._act(async () => { await api.setPackageEnabled(d.togglePackage, d.enabled !== 'true'); return d.enabled === 'true' ? 'Package disabled.' : 'Package enabled.'; });
    else if (d.uninstall) {
      if (!window.confirm(`Uninstall ${d.uninstall}? Its run history and audit records are kept.`)) return;
      await this._act(async () => { await api.uninstallPackage(d.uninstall); return 'Package uninstalled.'; });
    } else if (d.automationOp) await this._act(async () => { await api.automationOperation(d.id, d.automationOp); return `Automation ${PAST[d.automationOp]}.`; });
    else if (d.automationRun) await this._act(async () => { const { run } = await api.runAutomation(d.automationRun); this._expanded.add(d.automationRun); return `Run started (${run.status}).`; });
    else if (d.automationHistory) {
      if (this._expanded.has(d.automationHistory)) this._expanded.delete(d.automationHistory); else this._expanded.add(d.automationHistory);
      this._render();
    } else if (d.runDetail) {
      if (this._runs.has(d.runDetail)) this._runs.delete(d.runDetail);
      else { try { this._runs.set(d.runDetail, (await api.getAutomationRun(d.runDetail)).run); } catch (err) { this._message = { text: err.message, error: true }; } }
      this._render();
    }
  }

  async _act(work) {
    this._busy = true;
    this._render();
    try {
      this._message = { text: await work(), error: false };
    } catch (err) {
      this._message = { text: err.message, error: true };
    } finally {
      this._busy = false;
    }
    await this._load();
  }
}

customElements.define('u2-packages', U2Packages);
