// PackageManager (docs/plugin-architecture.md §12): install, review,
// uninstall, enable/disable, grants, settings, secrets and provider
// selection. Installing copies validated files and registers definitions;
// it never runs package code and never enables automations.
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/connection.js';
import { log } from '../logging/logger.js';
import { fetchSource, copyPackage, readPackageDirectory } from './loader.js';
import { buildProvider } from './providers.js';
import { describePermission, SENSITIVE_PERMISSIONS } from './permissions.js';
import { summarizePolicy } from './policy.js';
import { automationRequirements, validateDependencies } from './dependencies.js';
import {
  upsertPackage, getPackageRow, listPackageRows, setPackageEnabled, markPackageUninstalled, listGrants, grantPermissions,
  revokePermissions, pruneGrants, getStoredSettings, effectiveSettings, setSettings, setPolicyApproval, listProviderSelections,
  saveProviderSelection,
} from './store.js';
import { setPackageSecret, deletePackageSecret, secretStatus } from './secrets.js';
import { ensureAutomationInstance, listInstances, updateInstance } from './workflow-store.js';

export class PackageManager {
  constructor({ registries, invoker, runtime, eventBus, dataDir = getDataDir() }) {
    this.registries = registries;
    this.invoker = invoker;
    this.runtime = runtime;
    this.eventBus = eventBus;
    this.root = path.join(dataDir, 'packages');
    this.loadErrors = new Map();
  }

  /** Registers every installed package at startup, in dependency order. */
  loadInstalled() {
    let pending = listPackageRows();
    this.loadErrors.clear();
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      const retry = [];
      for (const row of pending) {
        try {
          this._register(row, readPackageDirectory(row.installPath));
          progress = true;
        } catch (error) {
          retry.push(row);
          this.loadErrors.set(row.id, error.message);
        }
      }
      pending = retry;
    }
    for (const row of pending) log.warn('packages', 'Installed package could not be loaded', { package: row.id });
    for (const [capabilityId, providerId] of Object.entries(listProviderSelections())) {
      try { this.registries.capabilities.select(capabilityId, providerId); } catch { /* provider no longer installed */ }
    }
    this.invoker.syncTools();
    return { loaded: listPackageRows().length - pending.length, failed: pending.map((row) => row.id) };
  }

  _register(row, bundle) {
    const providers = {};
    for (const definition of bundle.capabilities) {
      providers[definition.id] = buildProvider(definition, { packageId: bundle.manifest.id, packageDir: row.installPath, invoker: this.invoker });
    }
    this.registries.registerBundle({ ...bundle, providers, installPath: row.installPath, enabled: row.enabled, source: row.sourceRef });
    this.loadErrors.delete(row.id);
  }

  /** Fetches and validates a source, and describes what installing it would mean. */
  async review(source) {
    const fetched = await fetchSource(source);
    try {
      const bundle = readPackageDirectory(fetched.dir);
      return this._describeBundle(bundle, { sourceType: fetched.sourceType, sourceRef: fetched.sourceRef });
    } finally {
      fetched.cleanup();
    }
  }

  _describeBundle(bundle, { sourceType, sourceRef }) {
    const { manifest } = bundle;
    const installed = getPackageRow(manifest.id);
    const dependencyErrors = this.registries.check(bundle);
    const overlay = { skills: overlaySkills(this.registries.skills, bundle.skills), capabilities: overlayCapabilities(this.registries.capabilities, bundle.capabilities) };
    const automationPermissions = bundle.automations.map((automation) => {
      const requirements = automationRequirements(automation, overlay);
      return { id: automation.id, name: automation.name, triggers: automation.triggers, capabilities: requirements.capabilities, permissions: requirements.permissions };
    });
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      source: { type: sourceType, ref: sourceRef },
      upgradeFrom: installed?.status === 'installed' ? installed.version : null,
      permissions: manifest.permissions.map((permission) => ({ permission, description: describePermission(permission), sensitive: SENSITIVE_PERMISSIONS.has(permission) })),
      policies: Object.entries(manifest.policies).map(([name, policy]) => summarizePolicy(name, policy)),
      requires: manifest.requires,
      exports: {
        capabilities: bundle.capabilities.map((c) => ({ id: c.id, effect: c.effect, implements: c.implements, implementation: c.implementation.type, permissions: c.requiredPermissions })),
        skills: bundle.skills.map((s) => ({ id: s.id, version: s.version, description: s.description, codeBacked: Boolean(s.implementation) })),
        automations: automationPermissions,
      },
      secrets: manifest.secrets,
      events: manifest.events,
      problems: dependencyErrors,
      installable: dependencyErrors.length === 0,
    };
  }

  /**
   * install(source, { grant: 'all' | string[] | null, grantedBy }) ->
   *   package detail. Automations are installed disabled.
   */
  async install(source, { grant = null, grantedBy = 'owner' } = {}) {
    const fetched = await fetchSource(source);
    try {
      const bundle = readPackageDirectory(fetched.dir);
      const { manifest } = bundle;
      const problems = this.registries.check(bundle);
      if (problems.length) throw withStatus(new Error(`Cannot install ${manifest.id}:\n- ${problems.join('\n- ')}`), 409, problems);
      const previous = getPackageRow(manifest.id);
      const installPath = path.join(this.root, manifest.id, manifest.version);
      const staging = `${installPath}.staging-${process.pid}-${Date.now()}`;
      fs.mkdirSync(path.dirname(installPath), { recursive: true });
      copyPackage(fetched.dir, staging);
      // Validate the copy, not the source: it is what will be loaded later.
      const installedBundle = readPackageDirectory(staging);
      fs.rmSync(installPath, { recursive: true, force: true });
      fs.renameSync(staging, installPath);
      const row = upsertPackage({ manifest, sourceType: fetched.sourceType, sourceRef: fetched.sourceRef, installPath, enabled: previous?.status === 'installed' ? previous.enabled : true });
      try {
        this._register(row, installedBundle);
      } catch (error) {
        if (previous?.status === 'installed' && previous.installPath && fs.existsSync(previous.installPath)) {
          upsertPackage({ manifest: previous.manifest, sourceType: previous.sourceType, sourceRef: previous.sourceRef, installPath: previous.installPath });
          this._register(getPackageRow(manifest.id), readPackageDirectory(previous.installPath));
        } else markPackageUninstalled(manifest.id);
        throw error;
      }
      pruneGrants(manifest.id, manifest.permissions);
      for (const automation of installedBundle.automations) ensureAutomationInstance({ packageId: manifest.id, automationId: automation.id, initialState: automation.state.initial });
      this.invoker.syncTools();
      if (grant === 'all' && manifest.permissions.length) grantPermissions(manifest.id, manifest.permissions, grantedBy);
      else if (Array.isArray(grant) && grant.length) grantPermissions(manifest.id, grant, grantedBy);
      if (previous?.status === 'installed' && previous.installPath && previous.installPath !== installPath) fs.rmSync(previous.installPath, { recursive: true, force: true });
      this._publish(previous?.status === 'installed' ? 'package.upgraded' : 'package.installed', manifest.id, { version: manifest.version, previousVersion: previous?.status === 'installed' ? previous.version : null });
      return this.get(manifest.id);
    } finally {
      fetched.cleanup();
    }
  }

  uninstall(packageId, { force = false } = {}) {
    const row = this._requireInstalled(packageId);
    const dependents = this.registries.packages.dependentsOf(packageId);
    if (dependents.length && !force) throw withStatus(new Error(`${packageId} is required by ${dependents.join(', ')}`), 409);
    const cancelled = [];
    for (const instance of listInstances({ packageId })) {
      if (this.registries.automations.has(instance.automationId)) cancelled.push(...this.runtime.stopRuns(instance.automationId));
      updateInstance(instance.id, { enabled: false, status: 'uninstalled', nextRunAt: null });
    }
    this.registries.unregisterPackage(packageId);
    this.invoker.syncTools();
    revokePermissions(packageId);
    markPackageUninstalled(packageId);
    if (row.installPath) fs.rmSync(path.dirname(row.installPath), { recursive: true, force: true });
    this.loadErrors.delete(packageId);
    this._publish('package.uninstalled', packageId, { version: row.version, cancelledRuns: cancelled.length });
    return { id: packageId, uninstalled: true, cancelledRuns: cancelled };
  }

  setEnabled(packageId, enabled) {
    this._requireInstalled(packageId);
    setPackageEnabled(packageId, enabled);
    const record = this.registries.packages.get(packageId);
    if (record) record.enabled = Boolean(enabled);
    this._publish(enabled ? 'package.enabled' : 'package.disabled', packageId, {});
    return this.get(packageId);
  }

  grant(packageId, permissions, grantedBy = 'owner') {
    const row = this._requireInstalled(packageId);
    const list = permissions === 'all' ? row.manifest.permissions : permissions;
    if (!Array.isArray(list)) throw withStatus(new Error('permissions must be a list or "all"'), 400);
    grantPermissions(packageId, list, grantedBy);
    this._publish('package.permissions_changed', packageId, { granted: list });
    return this.get(packageId);
  }

  revoke(packageId, permissions) {
    this._requireInstalled(packageId);
    revokePermissions(packageId, permissions === 'all' ? null : permissions);
    this._publish('package.permissions_changed', packageId, { revoked: permissions });
    return this.get(packageId);
  }

  configure(packageId, { settings = null, policies = null } = {}) {
    const row = this._requireInstalled(packageId);
    if (settings) setSettings(row.manifest, settings);
    if (policies) for (const [name, approval] of Object.entries(policies)) setPolicyApproval(row.manifest, name, approval);
    return this.get(packageId);
  }

  setSecret(packageId, name, value) {
    const row = this._requireInstalled(packageId);
    if (value === null) deletePackageSecret(row.manifest, name);
    else {
      if (typeof value !== 'string' || !value || value.length > 16_384) throw withStatus(new Error('secret value must be non-empty text up to 16 KiB'), 400);
      setPackageSecret(row.manifest, name, value);
    }
    return secretStatus(row.manifest);
  }

  selectProvider(capabilityId, providerId) {
    this.registries.capabilities.select(capabilityId, providerId);
    saveProviderSelection(capabilityId, providerId);
    return this.registries.capabilities.list().find((capability) => capability.id === capabilityId);
  }

  list() {
    return listPackageRows().map((row) => this._summary(row));
  }

  get(packageId) {
    const row = getPackageRow(packageId);
    if (!row || row.status !== 'installed') throw withStatus(new Error(`Package ${packageId} is not installed`), 404);
    const stored = getStoredSettings(packageId);
    return {
      ...this._summary(row),
      settings: { schema: row.manifest.settings, values: effectiveSettings(row.manifest, stored) },
      policies: Object.entries(row.manifest.policies).map(([name, policy]) => summarizePolicy(name, policy, stored.policies[name])),
      secrets: secretStatus(row.manifest),
      events: row.manifest.events,
    };
  }

  _summary(row) {
    const granted = listGrants(row.id);
    const record = this.registries.packages.get(row.id);
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description,
      enabled: row.enabled,
      loaded: Boolean(record),
      loadError: this.loadErrors.get(row.id) || null,
      source: { type: row.sourceType, ref: row.sourceRef },
      installedAt: row.installedAt,
      updatedAt: row.updatedAt,
      permissions: row.manifest.permissions.map((permission) => ({
        permission, description: describePermission(permission), sensitive: SENSITIVE_PERMISSIONS.has(permission), granted: granted.includes(permission),
      })),
      dependencies: { u2os: row.manifest.requires.u2os, capabilities: row.manifest.requires.capabilities, skills: row.manifest.requires.skills },
      dependents: this.registries.packages.dependentsOf(row.id),
      exports: {
        capabilities: row.manifest.exports.capabilities.map((entry) => entry.id),
        skills: row.manifest.exports.skills.map((entry) => entry.id),
        automations: row.manifest.exports.automations.map((entry) => entry.id),
      },
    };
  }

  capabilities() {
    return this.registries.capabilities.list().map((capability) => ({
      id: capability.id,
      version: capability.version,
      description: capability.description,
      effect: capability.effect,
      source: capability.source,
      requiredPermissions: capability.requiredPermissions,
      providers: capability.providers,
      selectedProvider: capability.selectedProvider,
      status: capability.selectedProvider ? 'available' : 'no_provider',
    }));
  }

  skills() {
    return this.registries.skills.list().map((skill) => ({
      id: skill.id,
      version: skill.version,
      description: skill.description,
      packageId: skill.packageId,
      codeBacked: Boolean(skill.implementation),
      dependencies: {
        capabilities: [...new Set([...Object.keys(skill.requires?.capabilities || {}), ...(skill.workflow ? stepRefs(skill.workflow, 'capability') : [])])].sort(),
        skills: [...new Set([...Object.keys(skill.requires?.skills || {}), ...(skill.workflow ? stepRefs(skill.workflow, 'skill') : [])])].sort(),
      },
    }));
  }

  /** Dependency check of an installed package against what is loaded now. */
  verify(packageId) {
    const row = this._requireInstalled(packageId);
    return validateDependencies(readPackageDirectory(row.installPath), this.registries);
  }

  _requireInstalled(packageId) {
    const row = getPackageRow(packageId);
    if (!row || row.status !== 'installed') throw withStatus(new Error(`Package ${packageId} is not installed`), 404);
    return row;
  }

  _publish(type, packageId, data) {
    this.eventBus?.publish({ type, source: 'package-manager', subject: { type: 'package', id: packageId }, data: { package: packageId, ...data } });
  }
}

function stepRefs(workflow, kind) {
  return (workflow.steps || []).map((step) => String(step.use)).filter((use) => use.startsWith(`${kind}:`)).map((use) => use.slice(kind.length + 1));
}

function overlaySkills(registry, skills) {
  return { find: (id) => skills.find((skill) => skill.id === id) || registry.find(id) };
}

function overlayCapabilities(registry, capabilities) {
  return {
    has: (id) => capabilities.some((c) => c.id === id && !c.implements) || registry.has(id),
    get: (id) => capabilities.find((c) => c.id === id && !c.implements) || registry.get(id),
  };
}

function withStatus(error, status, problems = null) {
  error.status = status;
  if (problems) error.errors = problems;
  return error;
}
