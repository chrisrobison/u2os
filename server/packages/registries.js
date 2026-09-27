// Package, skill and automation registries, plus the composite that
// registers a validated package bundle into all of them at once
// (docs/plugin-architecture.md §3). In-memory, rebuilt from installed
// package files at startup; persistent state lives in the database.
import { CapabilityRegistry } from './capability-registry.js';
import { validateDependencies } from './dependencies.js';

class DefinitionRegistry {
  constructor(kind) { this.kind = kind; this._items = new Map(); }
  register(definition) {
    if (!definition?.id) throw new Error(`${this.kind} needs an id`);
    const existing = this._items.get(definition.id);
    if (existing && existing.packageId !== definition.packageId) {
      throw new Error(`${this.kind} ${definition.id} is already provided by package ${existing.packageId}`);
    }
    this._items.set(definition.id, definition);
    return definition;
  }
  has(id) { return this._items.has(id); }
  get(id) {
    const item = this._items.get(id);
    if (!item) {
      const error = new Error(`Unknown ${this.kind}: ${id}`);
      error.code = `${this.kind.toUpperCase()}_UNKNOWN`;
      throw error;
    }
    return item;
  }
  find(id) { return this._items.get(id) || null; }
  list() { return [...this._items.values()]; }
  unregisterPackage(packageId) {
    for (const [id, item] of this._items) if (item.packageId === packageId) this._items.delete(id);
  }
}

export class SkillRegistry extends DefinitionRegistry { constructor() { super('skill'); } }
export class AutomationRegistry extends DefinitionRegistry { constructor() { super('automation'); } }

export class PackageRegistry {
  constructor() { this._packages = new Map(); }
  register(record) {
    if (!record?.manifest?.id) throw new Error('Package record needs a manifest');
    this._packages.set(record.manifest.id, record);
    return record;
  }
  has(id) { return this._packages.has(id); }
  get(id) { return this._packages.get(id) || null; }
  list() { return [...this._packages.values()]; }
  unregister(id) { this._packages.delete(id); }

  /** Installed packages (other than `packageId`) that depend on its exports. */
  dependentsOf(packageId) {
    const target = this.get(packageId);
    if (!target) return [];
    const capabilities = new Set(target.manifest.exports.capabilities.map((entry) => entry.id));
    const skills = new Set(target.manifest.exports.skills.map((entry) => entry.id));
    return this.list().filter((record) => record.manifest.id !== packageId && (
      Object.keys(record.manifest.requires.capabilities).some((id) => capabilities.has(id)) ||
      Object.keys(record.manifest.requires.skills).some((id) => skills.has(id))
    )).map((record) => record.manifest.id);
  }
}

/**
 * The four registries together. `registerBundle` takes a bundle produced by
 * the package loader: { manifest, capabilities, skills, automations,
 * installPath, enabled, providers } where providers maps capability id ->
 * execute implementation built by the loader.
 */
export class PlatformRegistries {
  constructor({ capabilities = new CapabilityRegistry() } = {}) {
    this.packages = new PackageRegistry();
    this.capabilities = capabilities;
    this.skills = new SkillRegistry();
    this.automations = new AutomationRegistry();
  }

  /** Dependency and conflict check for a bundle against what is registered. */
  check(bundle) {
    const errors = [];
    const packageId = bundle.manifest.id;
    for (const capability of bundle.capabilities) {
      if (capability.implements) continue;
      const existing = this.capabilities.has(capability.id) ? this.capabilities.get(capability.id) : null;
      if (existing && existing.source !== `package:${packageId}`) errors.push(`capability ${capability.id} is already provided by ${existing.source}`);
    }
    for (const [kind, registry] of [['skill', this.skills], ['automation', this.automations]]) {
      for (const definition of bundle[`${kind}s`]) {
        const existing = registry.find(definition.id);
        if (existing && existing.packageId !== packageId) errors.push(`${kind} ${definition.id} is already provided by package ${existing.packageId}`);
      }
    }
    errors.push(...validateDependencies(bundle, this).errors);
    return errors;
  }

  registerBundle(bundle) {
    const errors = this.check(bundle);
    if (errors.length) {
      const error = new Error(`Cannot register ${bundle.manifest.id}:\n- ${errors.join('\n- ')}`);
      error.code = 'PACKAGE_DEPENDENCIES';
      error.errors = errors;
      throw error;
    }
    const packageId = bundle.manifest.id;
    this.unregisterPackage(packageId);
    this.packages.register({ manifest: bundle.manifest, installPath: bundle.installPath || null, enabled: bundle.enabled !== false, source: bundle.source || null });
    for (const capability of bundle.capabilities) {
      const contractId = capability.implements || capability.id;
      if (!capability.implements) {
        this.capabilities.registerContract({ ...capability, source: `package:${packageId}` });
      }
      this.capabilities.registerProvider({
        id: capability.implements ? `${packageId}/${capability.id}` : packageId,
        capability: contractId,
        packageId,
        kind: capability.implementation?.type || 'static',
        description: capability.description,
        definition: capability,
        execute: bundle.providers?.[capability.id] || null,
      });
    }
    for (const skill of bundle.skills) this.skills.register({ ...skill, packageId });
    for (const automation of bundle.automations) this.automations.register({ ...automation, packageId });
    return this.packages.get(packageId);
  }

  unregisterPackage(packageId) {
    this.capabilities.unregisterPackage(packageId);
    this.skills.unregisterPackage(packageId);
    this.automations.unregisterPackage(packageId);
    this.packages.unregister(packageId);
  }
}
