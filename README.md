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
- Bounded, ranked, provenance-tagged personal-context assembly across entities, facts, commitments, and allowlisted events, with optional application-side semantic ranking over the same structured memory -- never a vector-database replacement
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
- An owner-only Diagnostics view with dependency/action health and a deliberate sanitized bug-bundle download that excludes content, credentials, endpoints, raw errors, and operation identifiers

This is not production-ready. A single-owner passphrase, expiring sessions, CSRF protection, request limits, and loopback-default networking protect the HTTP boundary. `MockModelProvider` remains the default until a real provider is configured. Major limitations include simplified speaker verification, in-process-only rate limits, a single-owner identity model, no supported direct internet exposure, and — in the device/capability subsystem — raw direct-invoke/test/stream-open routes that are session-authenticated but not policy-gated, no cryptographic pairing, and only one connector unified into the capability model. Real Gmail, Google Calendar, and notification webhooks do not claim provider-level idempotency; uncertain crash/timeout outcomes stop for owner review rather than risk a duplicate external side effect.

### Capability status

| Status | Current scope |
|---|---|
| **Implemented** | Persistent event/memory state, destination-aware context privacy, model routing, policy/approval/audit, durable actions, explainability, fact controls, dynamic dashboards, browser E2E/SSE recovery, real Google/Brave/webhook connectors, and backup/export described above |
| **Mock by default** | Planner, calendar, email, contacts, search, and notifications use deterministic/local mock providers until the owner selects a configured real provider |
| **Experimental** | Node's `node:sqlite`; simplified DSP voice similarity; device/capability subsystem; application-side semantic retrieval; self-hosted real connectors |
| **Unavailable** | CalDAV, IMAP, Deepgram, ElevenLabs, cryptographic device pairing, external task-manager sync, native mobile/watch apps, and a U2OS-hosted cloud service |

What you should absolutely not do yet: expose U2OS directly to the public internet, treat voice confidence as authentication, assume an uncertain external action was not delivered, or use the pre-alpha system as the sole copy of important data without tested backups.

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
- [Architecture decisions](docs/adr/README.md)
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
- [Contributing](CONTRIBUTING.md)

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

The current suite contains 369 Node tests covering the event bus and deterministic projection replay, memory, policy enforcement, tools, durable action leasing/recovery/idempotency and sanitized operational diagnostics/bug bundles, the complete approval vertical slice, dashboard generation, server-side source resolution, and bounded card provenance, connectors and OAuth security, encrypted credentials, bounded real webhook/ntfy notification delivery, deployment utilities, triggers and proactive decisions including calendar-conflict detection, feedback, voice authorization, the Agent-refactor regression suite, model providers and routing, the strict plan schema, bounded cross-type context selection and inspectable hybrid retrieval, destination-aware embedding and planner privacy, prompt-injection containment, the daily-driver restart slice, explainability, audited fact/entity/relationship lifecycle management, fact-authority labeling, contradiction handling, and the device/capability subsystem (registry, resolver, the realtime WebSocket device bus, the browser-as-device flow, policy-gated presentation tools, device management, the trust lifecycle, streams, and service-provider unification — see [docs/devices.md](docs/devices.md)). The Playwright suite contains 65 real-browser scenarios, run in Chromium, Firefox, and WebKit, covering authentication, navigation, chat, approval/rejection, memory candidates and owner memory controls including impact-previewed deletion, trusted and live-updating dashboard components and card provenance, the coherent daily-driver story, SSE recovery, multi-tab synchronization, responsive/accessibility and keyboard-focus behavior, privacy-safe client error recovery, owner-facing explainability, notification connector configuration, structured trigger management, durable action operations, and the responsive live diagnostics and bundle-download flow.

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

Mock calendar, email, contacts, search, and notification providers work without external accounts. Real adapters are available for Google Calendar, Gmail, Google Contacts, Brave Search, and generic JSON or ntfy-compatible notification webhooks. The Connectors page accepts owner-supplied credentials and lets each domain select its active provider. Google requires an owner-created OAuth client; the exact scopes, redirect URI, setup sequence, and connector limitations are in [docs/connectors.md](docs/connectors.md). Configure the write-only webhook URL there and select **Webhook Notifications** for real delivery; U2OS stores the URL encrypted and never returns it from the status API. CalDAV, IMAP, Deepgram, and ElevenLabs currently have manifests only and are not implemented providers. The notifications connector is also reachable through the device/capability model (`server/devices/adapters/notification-service-adapter.js`) as a proof of concept that a physical device and an external service resolve/invoke through the exact same code path — see [docs/devices.md](docs/devices.md)'s "Service-provider unification".

The default planner is `MockModelProvider`, a deterministic intent matcher for demonstration workflows and the offline/test fixture. The browser's model settings form configures one OpenAI-compatible or Anthropic provider. Advanced installations can send the validated multi-provider/per-role shape to `POST /api/model` or edit the model config, including an explicit embeddings role; provider secrets are moved into the encrypted vault and configuration changes require a restart. See [docs/models.md](docs/models.md) for exact payloads and local-provider examples. Voice similarity uses a lightweight browser-side DSP fingerprint and must not be treated as authentication.

## Keeping data local

U2OS has no required hosted backend. Keep the default mock providers for a fully offline demonstration, or configure loopback/private-network model endpoints and only the connectors you choose. The data-processing policy independently controls which classifications may reach `local_model`, `configured_remote_model`, `external_tool`, and `local_ui`; a remote planner or embedding endpoint does not receive restricted context merely because tool policy would allow an action. Runtime state and encrypted credentials stay under `U2OS_HOME`, but any real remote model or connector necessarily receives the specific request data sent to it. Review [docs/policies.md](docs/policies.md), [docs/models.md](docs/models.md), and [docs/connectors.md](docs/connectors.md) before enabling remote services.

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
