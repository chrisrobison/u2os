# U2OS

U2OS is **the operating system for your digital self**: a local-first, user-owned evented counterpart built around a durable loop:

> Observe → remember → anticipate → act → observe outcome → learn.

It is not a chatbot or desktop wrapper. Events, structured memory, policies, tools, automations, and feedback belong to one user-controlled agent; the model is replaceable infrastructure. The name means “the second you” plus “operating system.” See [Architecture](docs/architecture.md) for the current system and [PLAN.md](PLAN.md) for the roadmap; [PROMPT.md](PROMPT.md) is the historical product specification, not onboarding documentation.

## Project status

U2OS is currently a working pre-alpha prototype. The repository implements the seven development phases in [PROMPT.md](PROMPT.md), plus the deployment milestone and the nine-phase device/capability subsystem (see [docs/devices.md](docs/devices.md)), as tested vertical slices:

- Persistent SQLite event log with normalized events, correlation, provenance, subscriptions, filtered history, and SSE delivery
- Structured entities, facts, relationships, commitments, and memory provenance, including a data-processing privacy classification across every context type (facts, people, commitments, and event-derived summaries), not just facts
- An Agent orchestrator decomposed into focused services (ContextAssembler, Planner, ActionEvaluator, ActionExecutor, ApprovalManager, EvaluatorRegistry) rather than one growing class
- Real OpenAI-compatible and Anthropic model providers alongside the deterministic `MockModelProvider`, selected per-role by a `ModelRouter` with one deterministic fallback retry
- A strict, validated plan schema (bounded action count/argument depth, `dependsOn`, `memoryCandidates`) with one bounded, non-fabricating repair pass before a malformed plan is rejected outright
- Bounded, ranked, provenance-tagged personal-context assembly for planning requests, with optional semantic (embedding-based) fact re-ranking over the same structured memory -- never a vector-database replacement
- A data-processing privacy policy, separate from tool authorization, governing what data may reach a local vs. remote model provider
- Prompt-injection containment tests proving retrieved content cannot register tools, authorize actions, or alter policy/routing configuration
- Tool registry and a policy engine outside the model execution path
- Durable SQLite action delivery with atomic leases, restart recovery, bounded retries, explicit provider idempotency contracts, execution-time policy/approval/freshness checks, and a sanitized owner Operations view
- Audited consequential actions with explicit approval or hard policy blocks, plus owner-facing **Why?** views on approval cards and activity history. The views use `GET /api/actions/:id/explain` and `GET /api/recommendations/:id/explain` to show stored reasoning summaries, policy/model identity, retrieved-context references, source events, and correlated event trails—never hidden model chain-of-thought.
- Native Web Component interface with morning, meeting, and project dashboards
- A device/capability subsystem (see [docs/devices.md](docs/devices.md)): a persisted device registry, an in-memory capability catalog, a deterministic (never LLM-driven) trust/privacy-aware resolver, a realtime WebSocket device bus (`/ws/devices`), the browser itself as a registered device, semantic presentation (`presentation.present`/`presentation.notify`) routed through the same policy/approval/audit pipeline as every other tool, a device management UI (`#/devices`), an enforced trust lifecycle (pairing-request events, revocation that disconnects live connections and is checked on every path), a metadata-only stream registry, and a service-provider unification proof of concept
- Google Calendar, Gmail, Google Contacts, Brave Search, and webhook connector adapters, with mock fallbacks
- Encrypted local credential storage and Google OAuth support
- Browser microphone, VAD, STT/TTS, barge-in, voice enrollment, and confidence-aware authorization
- Timers, recurring schedules, event rules, condition watches, and proactive event evaluation
- Outcome feedback that adjusts prioritization without weakening authorization policies
- Docker, systemd, launchd, mDNS, health checks, structured logs, backup/restore, and portable JSON export

This is not production-ready. A single-owner passphrase, expiring sessions, CSRF protection, request limits, and loopback-default networking now protect the HTTP boundary. Do not expose the server directly to the public internet. `MockModelProvider` remains the default until a real provider is configured (see [docs/models.md](docs/models.md)). Major limitations include simplified speaker verification, several placeholder dashboard components, in-process-only rate limits, no HTTP route yet for multi-provider/role model configuration, and — in the device/capability subsystem — the raw direct-invoke/test/stream-open routes are session-authenticated but not policy-gated, real cryptographic device pairing is a documented seam rather than an implementation, and only one existing connector (notifications) has been unified into the capability model so far (see [docs/devices.md](docs/devices.md)'s "Known gaps"). Real Gmail/Google Calendar calls do not currently claim provider-level idempotency; if their outcome is uncertain after a crash or timeout, U2OS deliberately stops for owner review rather than risking a duplicate send or meeting.

## Architecture

The main execution path is:

```text
user, connector, or trigger
        ↓
normalized event / structured request
        ↓
planner proposes structured actions
        ↓
policy engine authorizes, blocks, or requests approval
        ↓
authorized action persists in the leased SQLite queue
        ↓
policy, approval, and freshness are re-checked
        ↓
registered tool executes with a stable idempotency key
        ↓
result and outcome are written back to the event log
```

The browser is a client of the persistent Node.js service. Closing the browser does not stop connector synchronization, triggers, event processing, or the agent.

Key documentation:

- [Overview](docs/overview.md) — what U2OS is, why it exists, and how it's meant to be used (start here)
- [Architecture](docs/architecture.md)
- [Events](docs/events.md)
- [Policies](docs/policies.md)
- [Tools](docs/tools.md)
- [Devices and capabilities](docs/devices.md)
- [Dashboards](docs/dashboards.md)
- [Connectors](docs/connectors.md)
- [Voice](docs/voice.md)
- [Automation](docs/automation.md)
- [Feedback](docs/feedback.md)
- [Deployment](docs/deployment.md)
- [Model providers](docs/models.md)

## Requirements

- Node.js 22 or newer
- npm

`node:sqlite` is used directly and may emit an experimental-feature warning on current Node.js releases.

## Quick start

```sh
npm install
npm start
```

Open <http://localhost:4000>.

On first visit, create the required owner passphrase. Later visits show the login form before any private API or interface data is available.

For headless/container initialization, `npm run setup-owner` creates the same owner record through a masked terminal prompt without opening the HTTP listener.

On first start, U2OS creates its local data directory at `~/.u2os/`. Set `U2OS_HOME` to use another location. The directory contains configuration, policies, the SQLite database, encrypted connector credentials, and cache data. Real user data is not stored in the repository.

The first run also seeds demo people, projects, calendar events, email, tasks, commitments, and activity so the interface is immediately usable. Mock providers remain the default until real connectors are configured from the Connectors page.

For an isolated, deterministic five-minute walkthrough, run `npm run demo` and follow [docs/demo.md](docs/demo.md). It uses a separate `~/.u2os-demo` data home and refuses to overwrite an existing demo database without explicit `--reuse`.

For development with automatic server restarts:

```sh
npm run dev
```

## Tests

```sh
npm test
```

The current suite contains 348 Node tests covering the event bus, memory, policy enforcement, tools, durable action leasing/recovery/idempotency and sanitized operational status, the complete approval vertical slice, dashboard generation, connectors and OAuth security, encrypted credentials, deployment utilities, triggers, proactive decisions, feedback, voice authorization, the Agent-refactor regression suite, model providers and routing, the strict plan schema, bounded cross-type context candidate selection, semantic memory retrieval, the data-processing privacy policy, prompt-injection containment, the daily-driver restart slice, explainability, audited fact lifecycle management and contradiction handling, and the device/capability subsystem (registry, resolver, the realtime WebSocket device bus, the browser-as-device flow, policy-gated presentation tools, device management, the trust lifecycle, streams, and service-provider unification — see [docs/devices.md](docs/devices.md)). The Playwright suite contains 56 real-browser tests covering authentication, navigation, chat, approval/rejection, memory candidates and owner fact controls, trusted dashboard components, the coherent daily-driver story, SSE recovery, multi-tab synchronization, responsive/accessibility behavior, owner-facing explainability, and durable action operations.

A small Playwright harness also covers real-browser smoke coverage (boots the actual server in-process, no frontend build step):

```sh
npm run test:e2e
```

## Data operations

Seed an empty data directory:

```sh
npm run seed
```

Create a full-fidelity backup of `U2OS_HOME`:

```sh
npm run backup
```

Restore a backup:

```sh
npm run restore -- /path/to/u2os-backup.tar.gz
```

Backups include the credential master key and are as sensitive as the live data directory. A portable, credential-free JSON export is also available from `GET /api/export`.

## Deployment

Docker Compose is the shortest persistent deployment path:

```sh
docker compose up -d --build
```

The Compose configuration stores U2OS data in a named volume and exposes the service on port 4000. Templates for Linux systemd and macOS launchd are in `deploy/`. See [docs/deployment.md](docs/deployment.md) for installation details and operational caveats.

## Connectors and honest mock boundaries

Mock calendar, email, contacts, search, and notification providers work without external accounts. Real adapters are available for Google Calendar, Gmail, Google Contacts, Brave Search, and generic webhooks. CalDAV, IMAP, Deepgram, and ElevenLabs currently have manifests only and are not implemented providers. The notifications connector is also reachable through the device/capability model (`server/devices/adapters/notification-service-adapter.js`) as a proof of concept that a physical device and an external service resolve/invoke through the exact same code path — see [docs/devices.md](docs/devices.md)'s "Service-provider unification".

The default planner is still `MockModelProvider`, a deterministic intent matcher for demonstration workflows and the offline/test fixture. Opt-in OpenAI-compatible and Anthropic providers can target a local or hosted endpoint, routed per-role by `ModelRouter` and given bounded, ranked, provenance-tagged personal context by `ContextAssembler` (docs/models.md, docs/architecture.md). No HTTP route yet configures multi-provider/role setups -- only a single provider via `POST /api/model`. Voice similarity uses a lightweight browser-side DSP fingerprint and must not be treated as authentication.

## Security warning

U2OS binds to `127.0.0.1` by default and requires owner login for private APIs. This is still a pre-alpha single-owner service, not an internet-facing product. LAN binding is an explicit configuration decision; use a trusted TLS reverse proxy and firewall if you make one. Backups contain the credential master key and owner hash and are as sensitive as the live identity store. See [SECURITY.md](SECURITY.md).

Security properties already present include policy enforcement outside the planner, a separate data-processing privacy policy governing what data may reach a local vs. remote model, prompt-injection containment tests, append-only action/event auditing with retrieved-context provenance, encrypted connector secrets, OAuth state validation, secret-redacted APIs, safe dashboard schemas, and regression tests preventing feedback or voice confidence from loosening authorization policy.

## Repository layout

```text
server/       persistent service, APIs, agent, events, memory, policy, tools, devices
public/       browser client built with native ES modules and Web Components
skills/       connector manifests and declared permissions
tests/        Node test suites
docs/         subsystem contracts, decisions, setup, and known limitations
deploy/       systemd and launchd templates
data/         repository placeholder only; runtime data lives in U2OS_HOME
```

`server/devices/` is the device/capability subsystem: the registry, the capability catalog, the resolver, adapters (mock, realtime WebSocket, the notification service wrapper), and the stream registry. Its client-side half is `public/services/device-client.js` and `public/components/u2-device-panel.js`/`u2-devices.js`. See [docs/devices.md](docs/devices.md).

## Roadmap

Development priorities and acceptance criteria are maintained in [PLAN.md](PLAN.md). The immediate goal is a secure, testable single-owner alpha—not additional breadth before the authentication and operational boundaries are trustworthy.
