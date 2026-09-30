// CodingAgentRegistry: the providers U2OS knows about, and the one rule for
// choosing between them. Callers ask for the capability ("auto") or name a
// provider; neither needs to know how any provider works.
import { CodingAgentError, PROVIDER_ID } from './types.js';
import { loadCodingAgentConfig } from './config.js';

export class CodingAgentRegistry {
  /** configLoader: () => config; read on every call so vault edits apply without a restart. */
  constructor({ configLoader = loadCodingAgentConfig } = {}) {
    this._providers = new Map();
    this._configLoader = configLoader;
  }

  register(provider) {
    if (!provider || !PROVIDER_ID.test(provider.id || '')) throw new Error('A coding agent provider needs an id of lowercase letters, digits and "-"');
    if (this._providers.has(provider.id)) throw new Error(`Coding agent provider already registered: ${provider.id}`);
    this._providers.set(provider.id, provider);
    return provider;
  }

  has(id) { return this._providers.has(id); }

  /** The registered provider, whether or not it is enabled or installed. */
  get(id) {
    const provider = this._providers.get(id);
    if (!provider) throw new CodingAgentError(`Unknown coding agent provider: ${id}`, 'unknown_provider', { status: 404 });
    return provider;
  }

  list() { return [...this._providers.values()]; }

  config() { return this._configLoader(); }

  isEnabled(id, config = this.config()) {
    return !config.disabled && config.providers[id]?.enabled !== false;
  }

  /**
   * Probes every registered provider:
   * [{ id, name, enabled, available, version?, reason? }]
   * A disabled provider is reported but never probed (never executed).
   */
  async discover() {
    const config = this.config();
    return Promise.all(this.list().map(async (provider) => {
      if (!this.isEnabled(provider.id, config)) {
        return { id: provider.id, name: provider.name, enabled: false, available: false, reason: config.error ? `coding-agents.yaml is invalid: ${config.error}` : 'disabled in coding-agents.yaml' };
      }
      const probe = await safeProbe(provider);
      return { id: provider.id, name: provider.name, enabled: true, ...probe, available: probe.available === true };
    }));
  }

  /**
   * Picks the provider that will run a task.
   *   provider: "auto" (default) -- first usable one by preference
   *   provider: "<id>"           -- exactly that one, or an error
   *   preference: optional ordered ids overriding the configured order
   * Ids in a preference list that are not registered (for example "local"
   * before a local adapter exists) are skipped, so a list can be written
   * ahead of the providers it names.
   */
  async resolve({ provider = 'auto', preference } = {}) {
    const config = this.config();
    if (config.disabled) throw new CodingAgentError(`coding-agents.yaml is invalid, so no coding agent is enabled: ${config.error}`, 'config_invalid', { status: 409 });

    if (provider !== 'auto') {
      const chosen = this.get(provider);
      if (!this.isEnabled(chosen.id, config)) throw new CodingAgentError(`Coding agent ${provider} is disabled in coding-agents.yaml`, 'provider_disabled', { status: 409 });
      const probe = await safeProbe(chosen);
      if (probe.available !== true) throw new CodingAgentError(`Coding agent ${provider} is not available${probe.reason ? `: ${probe.reason}` : ''}`, 'provider_unavailable', { status: 409 });
      return chosen;
    }

    const order = orderedIds({ preference, config, registered: [...this._providers.keys()] });
    const skipped = [];
    for (const id of order) {
      const candidate = this._providers.get(id);
      if (!candidate) continue;
      if (!this.isEnabled(id, config)) { skipped.push(`${id} (disabled)`); continue; }
      const probe = await safeProbe(candidate);
      if (probe.available === true) return candidate;
      skipped.push(`${id} (${probe.reason || 'unavailable'})`);
    }
    throw new CodingAgentError(`No coding agent is available${skipped.length ? `: ${skipped.join(', ')}` : ''}. Install and sign in to one (see docs/coding-agents.md).`, 'no_provider', { status: 409 });
  }
}

function orderedIds({ preference, config, registered }) {
  const explicit = Array.isArray(preference) && preference.length ? preference : null;
  const ordered = explicit || [...(config.default ? [config.default] : []), ...config.preference];
  return [...new Set([...ordered, ...(explicit ? [] : registered)])];
}

async function safeProbe(provider) {
  try {
    const probe = await provider.probe();
    return probe && typeof probe === 'object' ? probe : { available: false, reason: 'probe returned nothing' };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}
