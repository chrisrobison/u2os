// Composition root for the coding agent capability: the registry with the
// built-in adapters, and the service on top of it. Adding a provider means
// adding one line to `adapters` here; nothing in the service changes.
import { CodingAgentRegistry } from './registry.js';
import { CodingAgentService } from './service.js';
import { loadCodingAgentConfig } from './config.js';
import { CodexProvider } from './providers/codex.js';
import { ClaudeCodeProvider } from './providers/claude-code.js';

// Built-in adapters: [ProviderClass]. Nothing else in the core names a vendor.
const adapters = [CodexProvider, ClaudeCodeProvider];

export function createCodingAgentRegistry({ configLoader = loadCodingAgentConfig } = {}) {
  const registry = new CodingAgentRegistry({ configLoader });
  for (const Adapter of adapters) {
    const provider = new Adapter({ providerConfig: () => registry.config().providers[provider.id] || {} });
    registry.register(provider);
  }
  return registry;
}

export function createCodingAgentService({ eventBus = null, configLoader } = {}) {
  return new CodingAgentService({ registry: createCodingAgentRegistry({ configLoader }), eventBus });
}

export { CAPABILITY_ID } from './types.js';
