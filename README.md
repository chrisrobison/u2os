# U2OS

U2OS is a persistent personal digital agent platform: **observe -> remember -> anticipate -> act -> observe outcome -> learn.**

This repository currently implements **Phase 1** of the system: the core platform (event bus, SQLite persistence, structured memory, tool registry, policy engine, and a deterministic mock agent/LLM) driving one real end-to-end vertical slice, with mocked integrations. See `PROMPT.md` for the full product vision and `docs/` for the authoritative contracts (`docs/architecture.md`, `docs/events.md`, `docs/tools.md`, `docs/policies.md`, `docs/dashboards.md`).

## Quick start

```sh
npm install
npm start
```

Then visit `http://localhost:4000` for the web shell (native ES modules and Web Components, no build step -- see `docs/architecture.md`'s "Web Component Shell" section), or call the API directly.

On first run, U2OS creates `~/.u2os/` (override with `U2OS_HOME`) with `config/`, `policies/`, `db/`, `credentials/`, and `cache/` subdirectories, writes default `policies/policies.yaml` and `config/config.json`, and seeds realistic demo data (people, a project, calendar events, email, tasks).

## Phase 1 / mocked integrations

Calendar, email, contacts, tasks, web search, and notifications are all mock/demo providers backed by SQLite — clearly labeled `mock-*` as their event `source`. The planner (`server/agent/mock-model-provider.js`) is a deterministic mock, not a real LLM call. No real Google/Microsoft/etc. integration exists yet. See `docs/architecture.md` for what's mocked and what's real infrastructure underneath the mock.

## Tests

```sh
npm test
```

## Seeding standalone

```sh
npm run seed
```
