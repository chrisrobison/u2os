import { MockModelProvider } from './mock-model-provider.js';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { MockEmbeddingProvider } from './embeddings/mock-embedding-provider.js';
import { OpenAICompatibleEmbeddingProvider } from './embeddings/openai-compatible-embedding-provider.js';

/**
 * ModelRouter: resolves a provider/model for a role (planner, classifier,
 * summarizer, extractor, response, embeddings, ...). Per PLAN.md, this
 * stays deliberately simple and deterministic -- role name looks up a
 * configured provider name, no autonomous model selection.
 *
 * Config shape:
 *   {
 *     providers: { [name]: { type: 'mock'|'openai-compatible'|'anthropic', ...settings } },
 *     roles:     { [role]: providerName },
 *     fallback:  providerName | null   // used when a role's primary provider throws
 *   }
 *
 * A bare legacy single-provider config ({ provider, baseUrl, model, ... },
 * the pre-router shape still written by POST /api/model) is normalized into
 * one provider named "default" used for every role, so existing
 * installations and tests keep working unchanged.
 *
 * Providers are instantiated lazily and cached per provider name -- a
 * provider backing two roles (e.g. classifier and summarizer both pointing
 * at "local-small") is constructed once.
 */
export class ModelRouter {
  constructor(config = {}, { createProvider = defaultCreateProvider, allowMock = true } = {}) {
    this.config = normalizeConfig(config);
    this.createProvider = createProvider;
    this.allowMock = allowMock;
    this._cache = new Map();
  }

  /** @returns {import('./model-provider.js').ModelProvider} */
  resolve(role) {
    const providerName = this.config.roles[role] ?? this.config.roles.default ?? this.config.fallback;
    if (!providerName) {
      throw new Error(`ModelRouter: no provider configured for role "${role}" (no role/default/fallback mapping)`);
    }
    return this._instantiate(providerName, role);
  }

  /**
   * Returns the configured fallback provider instance for `role`, or null
   * if there is none or it's the same provider already resolved for that
   * role (no point falling back to yourself). Callers (e.g. Planner) decide
   * when to actually use it -- ModelRouter never calls a provider itself.
   */
  resolveFallback(role) {
    const primaryName = this.config.roles[role] ?? this.config.roles.default;
    const fallbackName = this.config.fallback;
    if (!fallbackName || fallbackName === primaryName) return null;
    if (!this.allowMock && isMock(this.config.providers[fallbackName])) return null;
    return this._instantiate(fallbackName, `${role}:fallback`);
  }

  listRoles() {
    return Object.keys(this.config.roles);
  }

  _instantiate(providerName, role) {
    if (this._cache.has(providerName)) return this._cache.get(providerName);
    const providerConfig = this.config.providers[providerName];
    if (!providerConfig) {
      throw new Error(`ModelRouter: role "${role}" references unknown provider "${providerName}"`);
    }
    if (!this.allowMock && isMock(providerConfig)) {
      const error = new Error('Planner unavailable: configure a local or remote model for personal mode, then restart U2OS');
      error.code = 'MODEL_UNAVAILABLE';
      error.status = 503;
      throw error;
    }
    const provider = this.createProvider(providerConfig);
    this._cache.set(providerName, provider);
    return provider;
  }
}

function isMock(config) { return config?.type === 'mock' || config?.type === 'mock-embedding'; }

function defaultCreateProvider(providerConfig) {
  const factory = PROVIDER_FACTORIES[providerConfig.type];
  if (!factory) throw new Error(`ModelRouter: unknown provider type "${providerConfig.type}"`);
  return factory(providerConfig);
}

// Planning (ModelProvider: plan/respond/...) and embedding (EmbeddingProvider:
// embed/embedBatch) providers share one type->factory map -- ModelRouter
// itself is capability-agnostic; it just instantiates whatever `type` a
// role's provider config declares. A role's caller (Planner vs.
// ContextAssembler's semantic ranking) is what determines which interface
// it actually needs, by which role name it resolves.
const PROVIDER_FACTORIES = {
  mock: () => new MockModelProvider(),
  'openai-compatible': (cfg) => new OpenAICompatibleProvider(cfg),
  anthropic: (cfg) => new AnthropicProvider(cfg),
  'mock-embedding': () => new MockEmbeddingProvider(),
  'embedding-openai-compatible': (cfg) => new OpenAICompatibleEmbeddingProvider(cfg),
};

function normalizeConfig(config) {
  if (config && config.providers) {
    return {
      providers: config.providers,
      roles: config.roles || { default: Object.keys(config.providers)[0] },
      fallback: config.fallback ?? null,
    };
  }
  // Legacy single-provider shape: { provider, baseUrl, model, timeoutMs, apiKey }.
  const provider = config?.provider || 'mock';
  return {
    providers: { default: { type: provider, baseUrl: config?.baseUrl, model: config?.model, timeoutMs: config?.timeoutMs, apiKey: config?.apiKey } },
    roles: { default: 'default' },
    fallback: null,
  };
}
