# Model providers

U2OS defaults to the deterministic `MockModelProvider`. The optional `openai-compatible` provider uses `POST <baseUrl>/v1/chat/completions` and can target a compatible local endpoint such as Ollama or a hosted service. The model is planning infrastructure only: returned JSON is validated against the registered tool names and argument schemas, then every consequential proposal still passes through the same policy engine.

Configure it through authenticated `POST /api/model`:

```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:11434",
  "model": "your-installed-model",
  "timeoutMs": 30000,
  "apiKey": "optional-for-local-endpoints"
}
```

The endpoint and model name are stored in `U2OS_HOME/config/config.json`; a supplied API key is encrypted in the existing credential vault and is never returned by `GET /api/model`. Restart U2OS after changing providers. Set `{ "provider": "mock" }` to return to the offline deterministic planner.

Current limitations: one provider is selected for every role at startup; there is no retry/fallback router, bounded memory retrieval, streaming, embeddings, or separately implemented non-compatible adapter yet. Provider failure is explicit and does not silently execute stale plans or bypass policy.
