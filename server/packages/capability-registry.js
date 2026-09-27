// CapabilityRegistry (docs/plugin-architecture.md §7): capability
// contracts and the providers that implement them.
//
// Not to be confused with server/devices/capability-registry.js, which is
// the device vocabulary (image.capture, speech.say) resolved against
// connected devices. This registry holds the contracts packages call.
//
// A contract is registered once, by core or by the package that declares
// it. Providers are registered separately so one contract can have several
// implementations; the owner's selection decides which one runs, falling
// back to the core provider and then to the first registered.
import { applyDefaults } from './json-schema.js';

export class CapabilityRegistry {
  constructor() {
    this._contracts = new Map();
    this._providers = new Map(); // capability id -> provider[]
    this._selections = new Map(); // capability id -> provider id
  }

  registerContract(contract) {
    if (!contract?.id) throw new Error('Capability contract needs an id');
    const existing = this._contracts.get(contract.id);
    if (existing && existing.source !== contract.source) {
      throw new Error(`Capability ${contract.id} is already provided by ${existing.source}`);
    }
    const normalized = {
      id: contract.id,
      version: contract.version || '1.0.0',
      description: contract.description || '',
      effect: contract.effect === 'read' ? 'read' : 'write',
      domain: contract.domain || contract.id.split('.')[0],
      inputSchema: contract.inputSchema || { type: 'object' },
      outputSchema: contract.outputSchema || null,
      requiredPermissions: [...(contract.requiredPermissions || [])].sort(),
      source: contract.source || 'core',
    };
    this._contracts.set(normalized.id, normalized);
    return normalized;
  }

  registerProvider(provider) {
    if (!provider?.id || !provider?.capability) throw new Error('Capability provider needs an id and a capability');
    const list = this._providers.get(provider.capability) || [];
    if (list.some((existing) => existing.id === provider.id)) throw new Error(`Provider ${provider.id} already registered for ${provider.capability}`);
    list.push({ packageId: null, kind: 'tool', description: '', ...provider });
    this._providers.set(provider.capability, list);
    return provider;
  }

  has(id) { return this._contracts.has(id); }

  get(id) {
    const contract = this._contracts.get(id);
    if (!contract) {
      const error = new Error(`Unknown capability: ${id}`);
      error.code = 'CAPABILITY_UNKNOWN';
      throw error;
    }
    return contract;
  }

  providers(id) { return [...(this._providers.get(id) || [])]; }

  select(id, providerId) {
    if (providerId === null || providerId === undefined) { this._selections.delete(id); return; }
    if (!this.providers(id).some((provider) => provider.id === providerId)) throw new Error(`No provider ${providerId} for ${id}`);
    this._selections.set(id, providerId);
  }

  /** The provider that will run for `id`, or null when none is available. */
  resolveProvider(id) {
    const providers = this.providers(id);
    const selected = this._selections.get(id);
    return providers.find((provider) => provider.id === selected)
      || providers.find((provider) => provider.id === 'core')
      || providers[0]
      || null;
  }

  list() {
    return [...this._contracts.values()].map((contract) => ({
      ...contract,
      providers: this.providers(contract.id).map(({ id, packageId, kind, description, connectors }) => ({ id, packageId, kind, description, connectors: connectors || [] })),
      selectedProvider: this.resolveProvider(contract.id)?.id || null,
    }));
  }

  /** Removes every contract and provider a package contributed. */
  unregisterPackage(packageId) {
    const source = `package:${packageId}`;
    for (const [id, contract] of this._contracts) if (contract.source === source) this._contracts.delete(id);
    for (const [id, list] of this._providers) {
      const kept = list.filter((provider) => provider.packageId !== packageId);
      if (kept.length) this._providers.set(id, kept); else this._providers.delete(id);
      if (!kept.some((provider) => provider.id === this._selections.get(id))) this._selections.delete(id);
    }
  }

  /** Fills schema defaults for an input before validation. */
  prepareInput(id, input) {
    return applyDefaults(this.get(id).inputSchema, input);
  }
}
