// Composition root for the coding agent capability: the registry with the
// built-in adapters, and the service on top of it. Adding a provider means
// adding one line to `adapters` here; nothing in the service changes.
import { CodingAgentRegistry } from './registry.js';
import { CodingAgentService } from './service.js';
import { loadCodingAgentConfig } from './config.js';

const adapters = []; // filled in by the adapter phases

export function createCodingAgentRegistry({ configLoader = loadCodingAgentConfig } = {}) {
  const registry = new CodingAgentRegistry({ configLoader });
  for (const create of adapters) registry.register(create({ providerConfig: (id) => registry.config().providers[id] || {} }));
  return registry;
}

export function createCodingAgentService({ eventBus = null, configLoader } = {}) {
  return new CodingAgentService({ registry: createCodingAgentRegistry({ configLoader }), eventBus });
}

export { CAPABILITY_ID } from './types.js';
