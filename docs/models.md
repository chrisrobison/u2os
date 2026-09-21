# Model providers

U2OS defaults to the deterministic `MockModelProvider`. Two real adapters are implemented, deliberately non-identical so the `ModelProvider` abstraction is proven rather than nominal:

- `openai-compatible` -- `POST <baseUrl>/v1/chat/completions`, `response_format: json_object`, bearer auth. Targets Ollama, llama.cpp, LM Studio, or a hosted OpenAI-compatible endpoint.
- `anthropic` -- `POST <baseUrl or https://api.anthropic.com>/v1/messages`, `x-api-key`/`anthropic-version` headers, a top-level `system` field instead of a system message, and no guaranteed JSON-only response mode (the provider strips one bounded markdown fence if the model wraps its answer in one).

In both cases the model is planning infrastructure only: returned JSON is validated by the shared `validatePlan()` against the registered tool names and argument schemas (server/agent/plan-validator.js) before anything reaches the policy engine, and every consequential proposal still passes through that same policy engine regardless of which provider produced it.

## Configuring providers (current HTTP API)

`POST /api/model`:

```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:11434",
  "model": "your-installed-model",
  "timeoutMs": 30000,
  "apiKey": "optional-for-local-endpoints"
}
```

or, for Anthropic:

```json
{ "provider": "anthropic", "model": "claude-...", "apiKey": "sk-ant-..." }
```

The endpoint and model name are stored in `U2OS_HOME/config/config.json`; a supplied API key is encrypted in the existing credential vault under `model-<provider>` and is never returned by `GET /api/model`. Restart U2OS after changing providers. Set `{ "provider": "mock" }` to return to the offline deterministic planner.

The same endpoint also accepts the multi-provider shape shown below. Provider API keys may be supplied inside their provider entries; they are removed from `config.json` and encrypted in the vault. Changes currently require a restart.

## ModelRouter and roles

`server/agent/model-router.js` resolves a provider for a role (`planner`, `classifier`, `summarizer`, `extractor`, `response`, `embeddings`, ...) from a small, deterministic config -- role name looks up a configured provider name, nothing more elaborate. `Agent` accepts either a single `modelProvider` (what every existing test and the single-provider HTTP config above still produce) or a `modelRouter`; `server/index.js` always builds a router via `createModelRouter()`, which normalizes the legacy single-provider config into one provider used for every role, so existing installations need no config change.

A multi-provider, per-role config is supported through `POST /api/model` and at the config-file level:

```json
{
  "model": {
    "providers": {
      "local-planner": { "type": "openai-compatible", "baseUrl": "http://127.0.0.1:11434", "model": "llama3" },
      "hosted": { "type": "anthropic", "model": "claude-...", "apiKeyRef": "hosted" }
    },
    "roles": { "planner": "local-planner", "classifier": "local-planner", "summarizer": "local-planner" },
    "fallback": "hosted"
  }
}
```

Each non-mock provider's API key is read from the vault under `model-provider-<apiKeyRef || providerName>`. If the role's primary provider throws while planning, `Planner` retries exactly once against the configured `fallback` provider (if any and if distinct from the primary) and records which provider actually produced the plan for the audit trail -- it never silently retries in a loop or auto-selects a "better" model.

## Embeddings and semantic memory retrieval

`server/agent/embeddings/` provides an `EmbeddingProvider` abstraction (`embed`/`embedBatch`), separate from `ModelProvider` since it's a different capability. Two implementations exist: `MockEmbeddingProvider` (deterministic word-hash sketch, offline default -- clearly not real semantic understanding) and `OpenAICompatibleEmbeddingProvider` (`POST <baseUrl>/v1/embeddings`, the same family of endpoint Ollama/llama.cpp/LM Studio/hosted OpenAI-compatible servers expose).

Configure it as an explicit `embeddings` role in the multi-provider config shape above, e.g. `"roles": { "planner": "local-planner", "embeddings": "embed" }` with a provider entry `"embed": { "type": "embedding-openai-compatible", "baseUrl": "...", "model": "nomic-embed-text" }`.

**DOCUMENTED FOOTGUN:** a legacy single-provider config's "every role uses this one provider" fallback also technically resolves an unconfigured `embeddings` role -- to the planning provider, which has no `.embed()`. `server/index.js` guards against this explicitly (`modelRouter.listRoles().includes('embeddings')` before resolving) rather than relying on ModelRouter to special-case a role name it otherwise stays agnostic about. Anything else that resolves the `embeddings` role directly must do the same check.

Retrieval combines semantic similarity with recency, confidence, exact-word overlap, and an inferred-fact penalty (`server/memory/semantic-retrieval.js`'s `rankFactsHybrid`) -- never pure vector similarity alone, per PLAN.md. Vectors are stored as plain JSON in a local `embeddings` SQLite table (one row per `(subjectType, subjectId, model)`); cosine similarity is computed application-side, which is sufficient at personal scale (dozens to low thousands of facts) without a vector database.

## Known limitations

- The browser UI still exposes only the single-provider form; multi-provider configuration currently uses the HTTP API or config file.
- `ContextAssembler` now performs bounded lexical/structural candidate selection across entities, current facts, open owner commitments, and allowlisted events before assembly. A matching current fact can promote its person before the people limit is applied. Semantic scoring is still applied only within a selected person's facts; cross-type hybrid semantic ranking is the next retrieval increment.
- No streaming.
- Provider failure (including after a fallback attempt) is explicit and never silently executes a stale plan or bypasses policy.
