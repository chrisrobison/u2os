# Model providers

Explicit demo homes default to the deterministic `MockModelProvider`; personal homes report the planner as unavailable until a local or remote model is explicitly configured. Two real adapters are implemented, deliberately non-identical so the `ModelProvider` abstraction is proven rather than nominal:

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

The endpoint and model name are stored in `U2OS_HOME/config/config.json`; a supplied API key is encrypted in the existing credential vault under `model-<provider>` and is never returned by `GET /api/model`. Restart U2OS after changing providers. Only an isolated demo home may select `{ "provider": "mock" }`; personal homes reject that choice.

`GET /api/model` reports `plannerStatus` as `configuration-required`, `configured`, or `demo`. In a personal home with no configured real/local planner, chat and voice planning return HTTP 503 with an actionable message, no action is proposed, and the agent panel disables its composer. This is a configuration check, not a live model-endpoint probe: a configured provider can still be unavailable at request time, in which case a sanitized error is reported rather than retrying through a mock.

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

Each non-mock provider's API key is read from the vault under `model-provider-<apiKeyRef || providerName>`. If the role's primary provider throws while planning, `Planner` retries exactly once against an allowed configured `fallback` provider (if any and if distinct from the primary; a mock fallback is ignored in personal mode) and records which provider actually produced the plan for the audit trail -- it never silently retries in a loop or auto-selects a "better" model.

The run status reports a persisted 20,000-token cap and cumulative input/output counts when a model endpoint returns usage metadata. OpenAI-compatible `prompt_tokens`/`completion_tokens` and Anthropic `input_tokens`/`output_tokens` are metered before accepting a plan, including a failed plan and each fallback response. A response that reaches the cap is recorded, but its proposed actions are discarded. Missing usage is shown as incomplete coverage (`meteredCalls` versus `modelCallsUsed`), not as zero spend; malformed usage or a metering failure stops planning. Older runs retain their action history and start with unknown historical token usage. Monetary cost is unavailable until trustworthy pricing information exists. Token counts are provider-reported, not independently measured, and failed/timeout requests with no usage report cannot be counted.

## Embeddings and semantic memory retrieval

`server/agent/embeddings/` provides an `EmbeddingProvider` abstraction (`embed`/`embedBatch`), separate from `ModelProvider` since it's a different capability. Two implementations exist: `MockEmbeddingProvider` (deterministic word-hash sketch for demos/tests, not real semantic understanding) and `OpenAICompatibleEmbeddingProvider` (`POST <baseUrl>/v1/embeddings`, the same family of endpoint Ollama/llama.cpp/LM Studio/hosted OpenAI-compatible servers expose). Personal homes cannot resolve the mock embedding provider.

Configure it as an explicit `embeddings` role in the multi-provider config shape above, e.g. `"roles": { "planner": "local-planner", "embeddings": "embed" }` with a provider entry `"embed": { "type": "embedding-openai-compatible", "baseUrl": "...", "model": "nomic-embed-text" }`.

**DOCUMENTED FOOTGUN:** a legacy single-provider config's "every role uses this one provider" fallback also technically resolves an unconfigured `embeddings` role -- to the planning provider, which has no `.embed()`. `server/index.js` guards against this explicitly (`modelRouter.listRoles().includes('embeddings')` before resolving) rather than relying on ModelRouter to special-case a role name it otherwise stays agnostic about. Anything else that resolves the `embeddings` role directly must do the same check.

Retrieval combines semantic similarity with exact-word overlap, recency, confidence, explicit authority, entity relevance, relationship proximity, open-commitment state, current-project state, and interaction frequency (`server/memory/semantic-retrieval.js`) -- never pure vector similarity alone, per PLAN.md. Every ranked candidate carries the complete signal breakdown. Vectors are stored as plain JSON in a local `embeddings` SQLite table (one row per `(subjectType, subjectId, model)`); cosine similarity is computed application-side, which is sufficient at personal scale without a vector database.

Embedding providers identify their authoritative destination just like planning providers. Candidate text is evaluated by the data-processing policy before embedding: restricted private/sensitive candidates are not sent to a remote endpoint, the omission is audited as `agent.context_restricted`, and those candidates continue through deterministic ranking with a semantic contribution of zero. Local embedding providers may receive them when policy allows.

For bounded multi-step planning, `Planner` filters `context.observations` independently for each resolved provider, including when a run resumes from a persisted checkpoint. The real-provider payload places allowed, bounded tool results under `tool_observations` (untrusted data), never in the trusted system instruction or owner objective. Account-backed results default to `private`; a configured remote model therefore receives no such content under the default policy unless the owner changes that policy. Restricted observation metadata is audited without result text. A plan may request `continue: true` after its actions have known successful outcomes, up to three persisted model calls per run. Approval can wake a waiting checkpoint; after restart or a later queue completion the owner can explicitly resume it. Later actions use explicit `resultRefs` (argument name to `{stepIndex,itemIndex,path}`) for values drawn from observed results; invalid or withheld references fail before any action in that plan executes.

Saved conversation turns are distinct from established memory and current-run observations. For a follow-up, at most six previous user/assistant turns from the same conversation are included, each capped at 500 characters with source turn/run IDs. They are `private` by default, re-filtered for the selected provider and any fallback, and omitted for remote models under the default policy. Allowed turns enter only `conversation_history` as untrusted data; prior requests do not gain current-instruction authority. No full-transcript dump or automatic summary is sent.

The planner may also receive up to four successful prior read actions from the same conversation under `prior_read_artifacts`. Each is bounded by the observation filter, has a private classification floor, and is re-filtered for fallback destinations. Account-backed legacy results without an exact account binding are omitted. `resultRefs` still resolve solely against current-run `tool_observations`. For a prior email search/read, task list, or calendar list item, the model may propose `priorResultRefs` on `email.read.id`, `tasks.complete.id`, or `calendar.reschedule.eventId`: `{actionId,itemIndex,path:"id"}`. The runtime requires that exact item to have been visible to this provider, checks the permitted source tool, and pins email/calendar actions to its stored account binding before normal policy. Other historical references and guessed literal IDs fail verification.

## Known limitations

- The browser UI still exposes only the single-provider form; multi-provider configuration currently uses the HTTP API or config file.
- Retrieval is application-side and intentionally bounded; installations that grow far beyond personal scale may eventually need measured indexing improvements, but no vector database is currently warranted.
- No streaming.
- Provider failure (including after a fallback attempt) is explicit and never silently executes a stale plan or bypasses policy.
