import { MockModelProvider } from './mock-model-provider.js';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { CliModelProvider } from './cli-model-provider.js';
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
 *     providers: { [name]: { type: 'mock'|'openai-compatible'|'anthropic'|'cli', ...settings } },
 *     roles:     { [role]: providerName },
 *     fallback:  providerName | null   // used when a role's primary provider throws
 *     order:     [providerName, ...]   // optional: owner-ordered planner chain; first is primary, the rest are tried in turn
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
    this._reloadListeners = new Set();
  }

  /**
   * Hot reload: adopt a new config without restarting the process. The config
   * is normalized first, so an invalid one throws before anything changes and
   * the previous config stays in force. The swap itself is synchronous, so no
   * resolve() can observe a new config with old cached providers. Calls that
   * already hold a provider finish on it; the next resolve() builds from the
   * new config. Listeners run after the swap, and a failing listener never
   * undoes a completed reload.
   */
  reload(config = {}, { allowMock = this.allowMock } = {}) {
    const next = normalizeConfig(config);
    this.config = next;
    this.allowMock = allowMock;
    this._cache = new Map();
    for (const listener of this._reloadListeners) {
      try { listener(this); } catch (error) { console.error(`[model-router] reload listener failed: ${error?.message || error}`); }
    }
  }

  /** Subscribe to completed reloads (e.g. to re-resolve a captured provider). Returns an unsubscribe function. */
  onReload(listener) {
    this._reloadListeners.add(listener);
    return () => this._reloadListeners.delete(listener);
  }

  /** @returns {import('./model-provider.js').ModelProvider} */
  resolve(role) {
    const providerName = this._chain(role)[0] ?? this.config.roles[role] ?? this.config.roles.default ?? this.config.fallback;
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
    return this.resolveFallbacks(role)[0] ?? null;
  }

  /**
   * Every provider to try after the primary for `role`, in order. For the
   * planner role with an owner-ordered `order` list this is the rest of that
   * list; otherwise it is the single configured `fallback`. Mock providers are
   * skipped unless mocks are allowed.
   */
  resolveFallbacks(role) {
    const chain = this._chain(role);
    const primaryName = chain[0] ?? this.config.roles[role] ?? this.config.roles.default;
    const names = chain.length ? chain.slice(1) : (this.config.fallback ? [this.config.fallback] : []);
    const seen = new Set([primaryName]);
    const providers = [];
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!this.allowMock && isMock(this.config.providers[name])) continue;
      providers.push(this._instantiate(name, `${role}:fallback`));
    }
    return providers;
  }

  // The owner-ordered connection list applies to the planner role.
  _chain(role) {
    return role === 'planner' && Array.isArray(this.config.order) ? this.config.order : [];
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
      const error = new Error('Planner unavailable: configure a local or remote model for personal mode');
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

export function createProviderFromConfig(providerConfig) { return defaultCreateProvider(providerConfig); }

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
  cli: (cfg) => new CliModelProvider(cfg),
  'mock-embedding': () => new MockEmbeddingProvider(),
  'embedding-openai-compatible': (cfg) => new OpenAICompatibleEmbeddingProvider(cfg),
};

function normalizeConfig(config) {
  if (config && config.providers) {
    return {
      providers: config.providers,
      roles: config.roles || { default: Object.keys(config.providers)[0] },
      fallback: config.fallback ?? null,
      ...(Array.isArray(config.order) && config.order.length ? { order: config.order } : {}),
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
