# U2OS

U2OS is **the operating system for your digital self**. It consolidates who you are into **files you own**, and **acts on your behalf** within the authority you delegate.

> Observe → remember → anticipate → act → observe outcome → learn.

It is not a chatbot. The digital self is a **vault of plain Markdown files** that you can read, edit, version and carry anywhere:

- who you are (`me.md`)
- the people and projects in your life, and what you have promised
- the standing routines you want carried out, and skills describing how you want things done

U2OS indexes that vault, watches the accounts you connect, and runs your routines unattended. Every action goes through a policy engine that sits outside the model. The agent is just a tool that uses this information, and the model is replaceable infrastructure. The name means "the second you" plus "operating system".

Start with the [overview](docs/overview.md), then [the vault](docs/vault.md) and [routines](docs/routines.md). [ADR 0007](docs/adr/0007-owned-vault-is-the-digital-self.md) records why the vault is the centre, and [PLAN.md](PLAN.md) is the roadmap. [ADR 0010](docs/adr/0010-lean-core-bundled-addons.md) sets the direction for a lean core with bundled add-ons, and [add-ons](docs/addons.md) specifies the contract. [PROMPT.md](PROMPT.md) is the historical product specification, not onboarding documentation.

## How it works

```text
            your vault (Markdown files you own)
  me.md · people/ · projects/ · commitments/ · routines/
                │ indexed within seconds of any edit
                ▼
   memory index (SQLite) ◄── connected accounts (mail, calendar, contacts, search)
                │
   routines · triggers · chat · voice    ← sources of intent
                ▼
   planner (replaceable model) proposes structured actions
                ▼
   data-processing policy: what each model may see
   action policy: allow · ask you · block        ← outside the model
                ▼
   durable action queue → tool → outcome → event log / audit / "Why?"
```

- **The vault is the self.** Files are the authority for what they say. SQLite holds an index of them plus runtime state (sessions, queue, runs, audit, connector caches), and vault-sourced memory can be rebuilt from the files.
- **Routines act for you.** A routine file names a trigger (a daily time, an interval, or an event such as `email.received`) and an instruction in your own words. It runs without a chat, through the same planner → policy → queue → audit path as everything else, and never with more authority than your policy delegates.
- **Policy is outside the model.** Reads and drafts can be automatic. Sending, rescheduling and other consequential actions ask you or are blocked, according to policy. Model output, routines, feedback and voice confidence cannot loosen that.
- **Privacy is separate from permission.** Each fact carries a classification (`public`, `personal`, `private`, `sensitive`), and the data-processing policy decides what may reach a local or remote model.
- **Everything is explainable.** Actions keep their reasoning summary, policy rule, model identity and the memory that informed them.

The browser is a client of a persistent Node.js service. Closing it does not stop sync, routines, triggers or the agent.

## Project status

U2OS is a working **pre-alpha**, not a production product. Everything below is implemented and tested with fixtures. **It has not yet been validated in daily use with real accounts and a real model**; that is the next milestone ([PLAN.md](PLAN.md), Milestone B).

**The owned digital self**
- Markdown vault with YAML frontmatter: `me.md`, `people/`, `projects/`, `commitments/`, `routines/`. It is indexed on start and on every change, and its location is set with `U2OS_VAULT` or `vaultDir`.
- Vault facts are explicit memory with `vault:<path>` provenance. Edits supersede, removals soft-delete, and other sources are never modified.
- Per-file `classification` and `sensitive_keys` control what can reach a model.
- `npm run vault:export` moves existing database memory into vault files, bound to the same records with `id:`. Memory-UI edits are written back to the files, `policies.yaml` in the vault states what U2OS may do without asking (an invalid file fails closed), and `journal/` records what it did on your behalf.
- Standing routines run on daily, interval or event triggers. Each slot runs once, even across restarts, and runs go through policy and approval, with a runaway limit. Routines can use vault **skills** (Markdown instructions) such as the [example Job Hunter](examples/vault/README.md).
- **Coding agents**: hand a software task to the Codex CLI or Claude Code you already use. U2OS launches the official tool and never holds its credentials ([coding agents](docs/coding-agents.md)).
- Tools from **MCP servers** declared in your vault's `mcp.yaml` run out of process, behind the same policy gate ([MCP tools](docs/mcp.md)). The first-party **job-hunt server** searches Greenhouse and Lever boards and applies in a headless browser, with an application ledger in your vault ([job hunting](docs/job-hunt.md)).

**Acting safely on your behalf**
- A policy engine outside the model, plus audited approvals, hard blocks and owner-facing **Why?** views (`GET /api/actions/:id/explain`, `GET /api/recommendations/:id/explain`). They show stored summaries, never model chain-of-thought.
- Durable SQLite action delivery with atomic leases, restart recovery, bounded retries, explicit provider idempotency contracts, execution-time policy/approval/freshness checks, and a sanitized Operations view. Uncertain external outcomes stop for your review instead of risking a duplicate send.
- Timers, schedules, event rules, condition watches, proactive evaluators, and bounded read-only goals.
- Installable **packages** of capabilities, skills and durable automations (`npm run u2 -- package install ./packages/job-hunter`, or the Packages view): owner-granted permissions, deterministic package policies that can only tighten `policies.yaml`, restart-safe workflows, and one audit trail ([plugin architecture](docs/plugin-architecture.md)). Direction ([ADR 0009](docs/adr/0009-extension-model-mcp-tools-vault-skills-routines.md)): new tools come from MCP servers, skills from vault Markdown and automations from routines; the package workflow language is frozen.

**Memory and intelligence**
- Append-only event log with correlation, provenance and SSE delivery.
- Structured entities, facts, relationships and commitments, with authority labels (explicit, imported, derived, inferred) and confirm/correct/reclassify/delete controls.
- Bounded, ranked, provenance-tagged context assembly with optional application-side semantic ranking.
- OpenAI-compatible and Anthropic providers selected per role by a `ModelRouter`, plus a strict plan schema and prompt-injection containment tests.

**Interfaces and integrations**
- Native Web Component UI with morning, meeting and project dashboards, chat, approvals, Operations and Diagnostics, plus a first-run **onboarding wizard** that takes a fresh install to a working dashboard ([onboarding](docs/onboarding.md)).
- Daily-use sections that share one pattern (a list or dashboard, a record dialog, a `+` button): mail with message view and a Gmail reply link, calendar month/week/day views, tasks, projects and people created and edited in dialogs (projects and people are vault files). Navigation is grouped into collapsible categories with self-hosted Font Awesome Free icons.
- **Routines**, **Vault** and **Job applications** views show routine schedules and runs, vault/policy/MCP status and the journal, and the application ledger. Starter routine templates cover morning brief, meeting preparation and commitment follow-up.
- Google Calendar, Gmail, Google Contacts, IMAP/SMTP, Brave Search and webhook/ntfy connectors, with named accounts and exact account binding. Mocks run only in explicit demo homes.
- Browser voice (VAD, STT/TTS, barge-in, enrollment). Voice similarity is **not** authentication.
- A device/capability subsystem with a deterministic resolver, a realtime device bus, and the browser as a device ([devices](docs/devices.md)).
- Docker, systemd, launchd, health checks, structured logs, encrypted backups, validated inactive restore, and JSON export.

### Capability status

| Status | Current scope |
|---|---|
| **Implemented** | Vault indexing and export, routines, persistent event/memory state, destination-aware context privacy, model routing, policy/approval/audit, durable actions, explainability, fact controls, dashboards, real Google/IMAP/Brave/webhook connectors, backup/export |
| **Not yet** | Real-model and live-account validation, mail spam/delete (#446), person-to-person relationships (#448), resumable onboarding (#424) |
| **Demo only** | The deterministic planner and connector mocks, in an explicit demo home |
| **Experimental** | `node:sqlite`, simplified voice similarity, the device/capability subsystem, semantic retrieval |
| **Unavailable** | CalDAV, Deepgram, ElevenLabs, cryptographic device pairing, native mobile apps, any U2OS-hosted service |

Do not yet expose U2OS directly to the internet, treat voice confidence as authentication, assume an uncertain external action was not delivered, or keep your only copy of important data in it without tested backups. The vault is plain text, so keep it on an encrypted disk.

## Requirements

- Node.js 22 or newer (22.16+ for backups)
- npm

`node:sqlite` may print an experimental-feature warning.

## Quick start

```sh
npm install
npm start
```

Open <http://localhost:4000> and create the owner passphrase. Later visits show the login form before any private data is available. For headless setup, `npm run setup-owner` creates the owner through a masked terminal prompt; stop any running instance first.

On first start U2OS creates `~/.u2os/` (`U2OS_HOME` to change it) and your vault at `~/.u2os/vault/`. Put the vault anywhere, for example a git repository, with `U2OS_VAULT=/path/to/my-self`. Then:

1. **Describe yourself and your people.** Edit `me.md` and add files under `people/`, `projects/` and `commitments/` ([format](docs/vault.md)). Existing installs can run `npm run vault:export` with U2OS stopped (or `POST /api/vault/export` while it runs) to write current memory out as files.
2. **Configure a model.** Personal mode needs a local or hosted model. Use the **Model** screen or see [models](docs/models.md).
3. **Connect accounts** you want U2OS to see and act on ([connectors](docs/connectors.md)).
4. **Write a routine** ([routines](docs/routines.md)):

   ```markdown
   ---
   when:
     daily: "07:00"
     days: [mon, tue, wed, thu, fri]
   ---
   Brief me on today's meetings and anything urgent in my inbox.
   ```

Personal homes never get fictional data, and disconnected services never fall back to mocks. For a deterministic offline walkthrough in a separate `~/.u2os-demo` home, run `npm run demo` and follow [docs/demo.md](docs/demo.md).

A [runtime ownership guard](docs/runtime-ownership.md) prevents two U2OS processes from running against the same home. For development with automatic restarts, use `npm run dev`.

## Tests

```sh
npm test            # Node suite
npm run test:e2e    # Playwright: Chromium, Firefox, WebKit
```

Current counts, and what is implemented versus fixture-tested versus live-validated, are tracked in the [progress record](docs/personal-agent-progress.md). Passing fixtures do not establish real-model usefulness or owner-account validation; use the [personal acceptance procedure](docs/personal-acceptance.md) to record those honestly.

## Data operations

| Command | Purpose |
|---|---|
| `npm run vault:export` | Write database memory into vault files. Never overwrites a file or deletes a record. |
| `npm run backup -- --encrypt <path>` | Encrypted offline snapshot of `U2OS_HOME`, including the default vault. Stop U2OS first. |
| `npm run restore -- <archive>` | Validate into an empty, **inactive** recovery home (`U2OS_HOME=/isolated/path`) |
| `npm run seed` / `npm run demo` | Seed an empty home / create the isolated demo home |
| `npm run maintain` | Event-log integrity, audited retention, projection replay |
| `GET /api/export` | Portable, credential-free JSON export |

Unencrypted backups include the credential master key. A vault placed outside `U2OS_HOME` is not in U2OS backups; back it up yourself (git works well). See [backups](docs/backups.md).

## Deployment

```sh
docker compose up -d --build
```

Compose stores data in a named volume on port 4000. The deploy directory has systemd and launchd templates. See [deployment](docs/deployment.md), including how to mount a vault you keep elsewhere.

## Security

U2OS binds to `127.0.0.1` by default and requires owner login for every private API. It is a single-owner pre-alpha, not an internet-facing product; LAN binding is an explicit choice, and should sit behind a trusted TLS reverse proxy and firewall. Backups and the vault are as sensitive as the live instance. See [SECURITY.md](SECURITY.md).

Protections include:
- policy enforcement outside the planner, and a separate data-processing policy
- prompt-injection containment tests
- append-only action and event auditing with provenance
- encrypted connector secrets and OAuth state validation
- safe dashboard schemas, and routines that pass only event identifiers (never content) to the planner
- regression tests preventing feedback or voice confidence from loosening policy

Raw device debug routes are disabled outside explicit non-production development mode ([device debug boundary](docs/devices.md#development-debug-boundary)).

## Documentation

- **Start here:** [Overview](docs/overview.md), [The vault](docs/vault.md), [Routines and skills](docs/routines.md), [Skills vs packages](docs/skills-vs-packages.md)
- **Design:** [Architecture](docs/architecture.md), [Onboarding](docs/onboarding.md), [Architecture decisions](docs/adr/README.md), [Events](docs/events.md), [Policies](docs/policies.md), [Tools](docs/tools.md)
- **Subsystems:**
  - [Automation](docs/automation.md), [Bounded goals](docs/goals.md), [Dashboards](docs/dashboards.md), [Feedback](docs/feedback.md)
  - [Model providers](docs/models.md), [Connectors](docs/connectors.md), [Voice](docs/voice.md), [Devices and capabilities](docs/devices.md), [Local iMessage read helper](docs/imsg.md)
- **Operating it:** [Deployment](docs/deployment.md), [Backups](docs/backups.md), [Runtime ownership](docs/runtime-ownership.md), [Demo](docs/demo.md)
- **Validation:**
  - [Progress record](docs/personal-agent-progress.md)
  - [Personal acceptance and dogfooding](docs/personal-acceptance.md)
  - [Job research walkthrough](docs/job-research-walkthrough.md)
- **Extensions:** [MCP tools](docs/mcp.md), [coding agents](docs/coding-agents.md), [job hunting](docs/job-hunt.md), [skills vs packages](docs/skills-vs-packages.md)
- **Packages:** [Plugin architecture](docs/plugin-architecture.md), [writing packages](docs/packages/README.md), [reference Job Hunter package](packages/job-hunter/README.md)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md)

## Repository layout

```text
server/       persistent service
  vault/      vault location, Markdown parsing, indexer, watcher, exporter
  routines/   routine parsing and the unattended runner
  coding-agent/  coding.agent capability over the Codex and Claude Code CLIs
  mcp/        MCP client: servers declared in the vault, tools through the gate
  onboarding/ first-run wizard state
  packages/   package platform: manifests, registries, invoker, workflow engine, automation runtime, loader, CLI
  agent/      context assembly, planner, policy evaluation, execution, approvals, runs, goals
  memory/     entities, facts, relationships, projections, retrieval
  policy/     action policy and data-processing policy
  events/     event log, SSE, maintenance
  integrations/, tools/, triggers/, devices/, voice/, security/, backup/, api/
public/       browser client: native ES modules and Web Components, no build step (public/vendor: self-hosted third-party assets)
packages/     installable packages; packages/job-hunter is the reference package
mcp/          first-party MCP tool servers (mcp/jobs: job search and applications)
skills/       connector manifests and declared permissions
tests/        Node suites and Playwright e2e
docs/         product, architecture, subsystem contracts, decisions
deploy/       systemd and launchd templates
data/         repository placeholder; runtime data lives in U2OS_HOME and your vault
```

## Roadmap

[PLAN.md](PLAN.md) orders work by product value:

1. The owned digital self (complete).
2. Prove it in daily use with real accounts and models (current: Milestone B).
3. Widen delegated authority safely, alongside the extension model (MCP tools, vault skills, routines; lean core with bundled add-ons).
4. Only then broaden voice, connectors and packaging.
