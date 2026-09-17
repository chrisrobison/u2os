# U2OS Architecture

U2OS is a persistent personal digital agent: **observe → remember → anticipate → act → observe outcome → learn.**

It is not a chatbot with a database attached. It is a small operating system for a person's digital life, built around an append-only **event log**, a structured **memory** of entities and relationships, a **policy engine** that gates every consequential action, and a **tool layer** that actually does things. The LLM is one replaceable component inside this system, not the system itself.

This document describes the Phase 1 vertical slice: the minimum end-to-end architecture needed to run the scenario in [Vertical slice](#vertical-slice-acceptance-test) for real, with mocked integrations. Phase 3 (see `docs/connectors.md`) adds real, swappable connectors (Google Calendar/Gmail/Contacts, Brave Search, webhook notifications) behind the exact same tool interfaces — nothing in this document's core loop changes.

## Runtime & deployment shape (Phase 1)

U2OS runs as a single long-running Node.js process (a daemon, not a desktop app — see PROMPT.md §19-22). Phase 1 runs it directly with `npm start`; Docker/systemd packaging is a later deployment phase. The browser UI is a client of this server, never the thing running the agent logic.

- **Runtime**: Node.js 22+ (ESM, `"type": "module"`, no build step, no transpilation).
- **Database**: SQLite via the built-in `node:sqlite` module (`DatabaseSync`) — zero native dependencies, works everywhere Node runs.
- **HTTP**: Node's built-in `node:http` with a small dependency-free router (see `server/api/router.js`). No Express, no framework.
- **Realtime**: Server-Sent Events (`GET /api/events/stream`) over the same HTTP server. SSE was chosen over WebSocket for Phase 1 because it needs zero extra dependencies and browsers consume it natively via `EventSource`; a WS transport can be added later behind the same `events.js` client service without changing callers.
- **Frontend**: static files served by the same server, loaded as native ES modules — no bundler, no React.

### Local-first data directory

Per PROMPT.md §16, the user's data lives under a local directory, default `~/.u2os` (override with `U2OS_HOME`):

```
~/.u2os/
    config/       config.json  (server config: port, model provider selection, etc.)
    policies/      policies.yaml (policy engine rules — see docs/policies.md)
    db/            u2os.sqlite  (event log + memory + domain data — see below)
    credentials/    (placeholder; empty until real integrations exist)
    cache/          (placeholder)
```

Everything that could logically be "many files" (raw entity records, credentials, cached provider responses) is represented as this directory tree conceptually, but for Phase 1 the actual event log, memory, and domain data are stored in one SQLite file (`db/u2os.sqlite`) for simplicity and transactional integrity, per the note in PROMPT.md §16 ("The implementation may instead use SQLite internally, but preserve this logical organization"). `config/` and `policies/` are real files (JSON/YAML) because they are meant to be hand-edited by the owner.

## Components

```
User (voice/text/UI)
        │
Personal Agent (agent/) ── LLM abstraction, planner
        │  proposes actions (never executes directly)
Policy Engine (policy/) ── evaluates every proposed action against policies.yaml
        │
        ├── requires_approval=false → Tool Layer executes immediately
        └── requires_approval=true  → agent_actions row (status=pending) → UI approval
                                              │ user approves/rejects
                                              ▼
                                        Tool Layer (tools/) executes
                                              │
                                        Event Bus (events/) — every state change is an event
                                              │
                                   ┌──────────┼──────────┐
                             Event Log     Memory      SSE clients (live UI)
                            (append-only) (entities/facts/relationships)
```

### Event Bus (`server/events/`)

`EventBus` is an in-process `EventEmitter`-backed pub/sub with a durable log behind it. Every publish:

1. Assigns an id (`evt_<ulid>`), timestamp, and normalized envelope (see `docs/events.md`).
2. Persists the row to the `events` table (append-only, never mutated).
3. Emits it synchronously to in-process subscribers (memory updater, activity feed, dashboard invalidation).
4. Fans it out to connected SSE clients.

Consumers subscribe by event type (exact type or `"*"` for everything, or a prefix like `"calendar.*"`). Event correlation is done via `correlation_id` (shared by every event caused by one originating request) so the full causal chain of a single user ask ("move my meeting") can be replayed.

### Personal Memory (`server/memory/`)

Structured, not a transcript dump. Three tables (see `server/db/schema.sql`):

- **entities** — `Person`, `Organization`, `Project`, `Goal`, `Task`, `Commitment`, `Preference`, `Place`, `Document`, `Conversation`, `Routine`, `Asset`, `Account`, `Topic`.
- **facts** — individual remembered values about an entity, each with `source`, `confidence`, `inferred` (bool), `observed_at`, `last_confirmed_at`, `provenance`. A fact is never silently promoted from inference to stated truth — `inferred` and `confidence` travel with it forever.
- **relationships** — first-class edges (`works_on`, `knows`, `promised`, `prefers`, `interested_in`, ...) between two entities, with the same provenance fields as facts.

Memory is a *consumer* of the event bus (it listens and derives entities/facts from events), not the primary store of truth — the event log is. Memory supports inspect/correct/delete/export via the `/api/memory/*` routes.

### Agent / Planner (`server/agent/`)

`agent.plan(context, objective)`, `agent.respond(context, message)`, `agent.evaluateEvent(event, context)` — a small provider-agnostic interface (`server/agent/model-provider.js`) so any LLM (cloud or local) can sit behind it. Phase 1 ships a `MockModelProvider` that does deterministic intent-matching good enough to drive the vertical slice and demo data believably; it is clearly labeled as mocked. The planner **returns structured proposed actions** (`{ reasoning_summary, actions: [{ tool, arguments }] }`) — it never executes a tool directly.

### Policy Engine (`server/policy/`)

Loads `~/.u2os/policies/policies.yaml` (see `docs/policies.md`) and exposes `policy.evaluate({ tool, arguments, context })`, returning:

```js
{ autonomyLevel: 0-5, requiresApproval: bool, domain, rule, reason }
```

This is the **only** gate consequential tools pass through — the planner cannot bypass it, and the HTTP layer calls it, not the model. Every evaluation and its outcome is written to `agent_actions` (the audit trail: who requested it, what model proposed it, which policy rule fired, who approved it, what executed, and the result).

### Tool / Action Layer (`server/tools/`)

`Tool` base class with `.schema` (JSON Schema for arguments) and `.execute(args, context)`. A `ToolRegistry` looks tools up by name (`"calendar.reschedule"`). Phase 1 ships mock tools only (see `docs/tools.md`): `email.*`, `calendar.*`, `contacts.search`, `tasks.*`, `web.search`, `notifications.send`. Every tool execution publishes a corresponding event (e.g. `calendar.reschedule` → `calendar.event_changed`).

### Web Component Shell (`public/`)

Three-pane layout (`<u2-app>`): navigation, dynamic workspace, agent conversation. No build step — plain ES module imports, `<script type="module">`. `services/api.js` wraps REST calls; `services/events.js` wraps the SSE connection and re-dispatches typed `CustomEvent`s the components listen for. Dashboards are rendered from the trusted component set only — the LLM composes a JSON layout, never HTML/JS (see `docs/dashboards.md`, Phase 2).

## Vertical slice acceptance test

> "Move my 2 PM meeting with Sarah to tomorrow afternoon."

1. `POST /api/agent/message` with the text.
2. Agent identifies intent, calls `calendar.list` (read tool, no policy gate) to find the matching event, then produces a proposed action: `calendar.reschedule`.
3. Policy engine evaluates `calendar.reschedule` for a `personal` calendar event → per `policies.yaml` this domain is configured `confirm` → `requiresApproval = true`.
4. Server creates an `agent_actions` row (`status=pending`), emits `agent.action.proposed`, returns the pending action to the client.
5. UI shows the approval card (`<u2-approval>`).
6. User approves → `POST /api/actions/:id/approve`.
7. Server re-checks the policy hasn't changed, calls `calendar.reschedule` tool.
8. Tool updates `calendar_events`, publishes `calendar.event_changed`.
9. Event log records the whole chain under one `correlation_id`.
10. Dashboard/activity feed update live over SSE.
11. Agent confirms completion back to the user.

## What is explicitly mocked in Phase 1

Calendar, email, contacts, tasks, web search, and notifications are all mock/demo providers backed by SQLite tables seeded with demo data — clearly labeled `mock-*` as their event `source`. No real Google/Microsoft/etc. integration exists yet (Phase 3). The LLM planner is a deterministic mock, not a cloud model call (still Phase 1 — provider abstraction is real, the provider behind it is a stub).

## Directory layout

```
server/
    index.js            entry point / HTTP server bootstrap
    api/                route handlers + router
    agent/              planner, model provider abstraction, mock provider
    events/             event bus, event log persistence, SSE hub
    memory/             entity/fact/relationship store, memory projector (event → memory)
    policy/             policy engine, policies.yaml loader
    tools/              Tool base class, ToolRegistry, mock tool implementations
    integrations/       provider adapters used by tools (mock-*, plus real google-calendar/gmail/google-contacts/brave-search/webhook-notify — see docs/connectors.md), provider-registry.js, connectors-config.js, sync-scheduler.js, oauth/
    security/           credential vault (encryption at rest) — docs/connectors.md
    db/                 schema.sql, connection singleton, migrations runner
    seed/               demo data seeding script
skills/                 connector manifests (metadata: capabilities/scopes/permissions) — docs/connectors.md
public/
    index.html
    components/         u2-app.js, u2-dashboard.js, u2-card.js, u2-agent.js, u2-approval.js, u2-connectors.js, ...
    services/           api.js, events.js
    styles/             base.css, themes.css
data/                   .gitkeep only — real data lives in ~/.u2os, not the repo
tests/                  node:test suites mirroring server/ modules
docs/                   architecture.md, events.md, tools.md, policies.md, dashboards.md, connectors.md
```

## Technical debt / known gaps after Phase 1

- Model provider is a deterministic mock, not a real LLM call yet.
- No auth/session model yet — single-owner, single-session assumption (fine for local-first Phase 1, must be addressed before multi-device/Phase 4+).
- SSE has no reconnect/backoff hardening yet.
- `node:sqlite` is still flagged experimental by Node upstream; acceptable for Phase 1, worth revisiting before production packaging.
- Credential encryption landed in Phase 3 (see docs/connectors.md) for the connectors that need it; nothing in Phase 1 needed it since only mock tools existed.

## Technical debt / known gaps after Phase 3

See docs/connectors.md's own notes (Gmail send has no MIME/attachment support, Google Calendar events default to `category: 'personal'` since Google has no equivalent field, polling-based sync rather than real-time push webhooks, CalDAV/IMAP are stubbed not implemented). Additionally:

- The OAuth `state` cache is in-memory only — restarting the server mid-consent-flow invalidates any in-flight authorization attempt (acceptable; the user just retries "Connect").
- No token revocation call to Google on disconnect yet — disconnecting clears U2OS's local copy of the tokens but doesn't proactively revoke them at Google; the user can also revoke access directly from their Google Account's third-party access settings.
- Dashboard cards (`<u2-dashboard>`) render once from the schema fetched at route load; they do not yet subscribe to the SSE stream to live-refresh in place. Live updates today work by re-navigating (the SPA router re-fetches), and the agent conversation panel and its inline approval cards *do* update live within the tab that made the request. Wiring `<u2-dashboard>` itself to `services/events.js` is straightforward follow-up work, not a redesign.
