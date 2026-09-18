# U2OS

U2OS is a local-first personal digital agent platform built around a durable loop:

> Observe → remember → anticipate → act → observe outcome → learn.

It is designed as a persistent service rather than a chat transcript or desktop wrapper. Events, structured memory, policies, tools, automations, and feedback belong to one user-controlled agent; the model is replaceable infrastructure.

## Project status

U2OS is currently a working pre-alpha prototype. The repository implements the seven development phases in [PROMPT.md](PROMPT.md), plus the deployment milestone, as tested vertical slices:

- Persistent SQLite event log with normalized events, correlation, provenance, subscriptions, filtered history, and SSE delivery
- Structured entities, facts, relationships, commitments, and memory provenance
- Tool registry and a policy engine outside the model execution path
- Audited consequential actions with explicit approval or hard policy blocks
- Native Web Component interface with morning, meeting, and project dashboards
- Google Calendar, Gmail, Google Contacts, Brave Search, and webhook connector adapters, with mock fallbacks
- Encrypted local credential storage and Google OAuth support
- Browser microphone, VAD, STT/TTS, barge-in, voice enrollment, and confidence-aware authorization
- Timers, recurring schedules, event rules, condition watches, and proactive event evaluation
- Outcome feedback that adjusts prioritization without weakening authorization policies
- Docker, systemd, launchd, mDNS, health checks, structured logs, backup/restore, and portable JSON export

This is not production-ready. The most important missing boundary is owner authentication: all HTTP routes currently assume a trusted single-owner network. Do not expose the server directly to the public internet. Other major limitations include the deterministic mock planner, simplified speaker verification, several placeholder dashboard components, no general request/action rate limits, and limited browser-level test coverage. See [PLAN.md](PLAN.md) for the prioritized path forward.

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
registered tool executes through the selected provider
        ↓
result and outcome are written back to the event log
```

The browser is a client of the persistent Node.js service. Closing the browser does not stop connector synchronization, triggers, event processing, or the agent.

Key documentation:

- [Architecture](docs/architecture.md)
- [Events](docs/events.md)
- [Policies](docs/policies.md)
- [Tools](docs/tools.md)
- [Dashboards](docs/dashboards.md)
- [Connectors](docs/connectors.md)
- [Voice](docs/voice.md)
- [Automation](docs/automation.md)
- [Feedback](docs/feedback.md)
- [Deployment](docs/deployment.md)

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

On first start, U2OS creates its local data directory at `~/.u2os/`. Set `U2OS_HOME` to use another location. The directory contains configuration, policies, the SQLite database, encrypted connector credentials, and cache data. Real user data is not stored in the repository.

The first run also seeds demo people, projects, calendar events, email, tasks, commitments, and activity so the interface is immediately usable. Mock providers remain the default until real connectors are configured from the Connectors page.

For development with automatic server restarts:

```sh
npm run dev
```

## Tests

```sh
npm test
```

The current suite contains 101 Node tests covering the event bus, memory, policy enforcement, tools, the complete approval vertical slice, dashboard generation, connectors and OAuth security, encrypted credentials, deployment utilities, triggers, proactive decisions, feedback, and voice authorization.

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

Mock calendar, email, contacts, search, and notification providers work without external accounts. Real adapters are available for Google Calendar, Gmail, Google Contacts, Brave Search, and generic webhooks. CalDAV, IMAP, Deepgram, and ElevenLabs currently have manifests only and are not implemented providers.

The planner is still `MockModelProvider`, a deterministic intent matcher for demonstration workflows. There is no general-purpose LLM integration or model router yet. Voice similarity uses a lightweight browser-side DSP fingerprint rather than a trained speaker-verification model, and it must not be treated as strong authentication.

## Security warning

U2OS currently has no owner login or authenticated session layer. Anyone who can reach the HTTP service can access its APIs, including memory, events, connector configuration, voice enrollment, triggers, and action approvals. Run it only on a trusted machine/network until the first milestone in [PLAN.md](PLAN.md) is complete.

Security properties already present include policy enforcement outside the planner, append-only action/event auditing, encrypted connector secrets, OAuth state validation, secret-redacted APIs, safe dashboard schemas, and regression tests preventing feedback or voice confidence from loosening authorization policy.

## Repository layout

```text
server/       persistent service, APIs, agent, events, memory, policy, tools
public/       browser client built with native ES modules and Web Components
skills/       connector manifests and declared permissions
tests/        Node test suites
docs/         subsystem contracts, decisions, setup, and known limitations
deploy/       systemd and launchd templates
data/         repository placeholder only; runtime data lives in U2OS_HOME
```

## Roadmap

Development priorities and acceptance criteria are maintained in [PLAN.md](PLAN.md). The immediate goal is a secure, testable single-owner alpha—not additional breadth before the authentication and operational boundaries are trustworthy.
