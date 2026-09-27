# U2OS Development Plan

U2OS consolidates the owner's digital self into **files they own**, and acts on their behalf within the authority they delegate. The agent is a tool that uses that information, and the model is replaceable infrastructure ([ADR 0007](docs/adr/0007-owned-vault-is-the-digital-self.md)).

Work is ordered by product value:

1. Make the owned vault the complete digital self.
2. Prove the product in real daily use.
3. Widen what U2OS may do on the owner's behalf, safely.
4. Only then broaden into voice, more connectors, and packaging.

The foundations built so far (security boundary, policy, durable actions, privacy, explainability) are complete enough to serve that product. Further hardening happens when real use exposes a need, not speculatively.

## Guiding constraints

- The owner's digital self is a vault of plain files they own. SQLite is an index of the vault plus operational runtime state.
- The file is the authority for anything written in the vault. Edits made elsewhere are written back, never silently diverge.
- Keep authorization outside the model. Routines, feedback, voice confidence and model output never loosen policy.
- Everything U2OS does on the owner's behalf goes through planner → policy → durable queue → audit, whether it started in chat, a routine, or a trigger.
- The data-processing policy decides what each model may see, independently of what tools may do.
- Preserve the event log as the history, correlation and explainability spine.
- Treat the browser and future satellites as untrusted clients of the persistent service.
- Prefer standard formats and protocols, native browser modules, small explicit interfaces, and few dependencies.
- Clearly label mock, simplified, unavailable, and degraded behaviour.
- Existing `U2OS_HOME` installations upgrade additively, and migrations never delete owner data.

## Milestone A — The owned digital self (current)

Tracking issue: [#355](https://github.com/chrisrobison/u2os/issues/355).

- [x] [#358](https://github.com/chrisrobison/u2os/issues/358) Re-centre the direction on the owned vault (ADR 0007)
- [x] [#356](https://github.com/chrisrobison/u2os/issues/356) Index the owner-authored Markdown vault into memory ([vault](docs/vault.md))
- [x] [#357](https://github.com/chrisrobison/u2os/issues/357) Run owner-written routine files unattended through policy ([routines](docs/routines.md))
- [x] [#359](https://github.com/chrisrobison/u2os/issues/359) Export existing database memory into vault files, bound by `id:`
- [x] [#367](https://github.com/chrisrobison/u2os/issues/367) Align all documentation with the vault architecture and roadmap
- [x] [#361](https://github.com/chrisrobison/u2os/issues/361) Write owner memory edits and accepted memory candidates back to vault files
- [x] [#362](https://github.com/chrisrobison/u2os/issues/362) Move action policies into the vault (`policies.yaml`)
- [x] [#360](https://github.com/chrisrobison/u2os/issues/360) Append observations and action outcomes to a vault journal (`journal/YYYY-MM.jsonl`)

### Acceptance criteria

- The owner's identity, people, projects, commitments, routines and delegated authority are ordinary files that remain readable and useful without U2OS.
- Deleting the SQLite database and restarting rebuilds vault-sourced memory from the files.
- Editing memory in the UI and editing the file converge on the same state.
- At least one owner-written routine runs unattended on schedule and on an event, with consequential actions still gated by policy.

## Milestone B — Living with it

The product has not yet been used day to day with real accounts and a real model. This milestone proves (or disproves) that it is worth using, and turns what real use reveals into the next issues.

- Browser views for the vault (index status, errors, file locations) and routines (schedule, last run, run now, awaiting approval).
- Onboarding that starts from the vault: choose its location, write or export `me.md`, add a first routine, configure a model.
- Starter routines: morning brief, meeting preparation, recruiter/important-sender triage, commitment follow-up.
- Real-model quality evaluation: a small fixed set of owner tasks scored for usefulness, not just schema validity, against at least one local and one hosted model.
- Confirm Google OAuth behaviour for owner-created clients in "Testing" status (refresh-token lifetime), and document the setup that keeps a personal install connected.
- The [personal acceptance walkthrough and two-week dogfooding](docs/personal-acceptance.md), extended to vault and routine workflows, with results recorded honestly.

### Acceptance criteria

- An owner can go from a fresh install to a working morning-brief routine on their own accounts using only the documentation and UI.
- Two weeks of real use are recorded, and every blocker found becomes an issue before new breadth is added.

## Milestone C — Delegated authority

Let the owner say, in their vault, what U2OS may do without asking, while keeping policy outside the model.

- Vault policy (from #362) extended to be scoped by domain, counterpart and routine, for example "may send routine replies to people tagged family" or "may decline meetings outside working hours".
- Approvals that reach the owner where they are (notification with approve/reject) instead of only in the browser.
- Commitment follow-through: open commitments with due dates produce routine-driven reminders and follow-ups.
- Clear owner-facing summaries of what was done on their behalf, drawn from the journal.

### Acceptance criteria

- Delegated authority is visible and editable as a file, and is validated. An invalid policy fails closed to `confirm`.
- No routine, model output or feedback signal can widen authority beyond the vault policy (regression-tested).

## Later — deferred until the product is proven

These remain valid, but are scheduled after Milestones A–C unless real use makes one urgent.

### Voice and satellites

- A versioned satellite protocol for audio, device identity, presence, speaker metadata and output control, likely carried over the existing realtime device bus.
- Pluggable STT/TTS adapters (Deepgram and ElevenLabs manifests exist, or local alternatives).
- A reviewed speaker-embedding provider instead of the simple spectral fingerprint, diarization, and explicit unknown-speaker handling.
- Challenge or second-factor confirmation for sensitive operations. Replay, synthesized speech and the agent's own TTS are tested.

### Connectors and skills

- Contract tests shared by mock and real providers, and opt-in live tests for Google, Brave Search and webhooks.
- Google token revocation and clearer re-authorization, plus Gmail MIME, attachment, thread and real draft support.
- CalDAV. IMAP/SMTP exist but need live-account validation.
- Signed, installable skills with permission review, and enforced outbound network permissions.

### Distribution

- Multi-architecture Docker validation, Windows service packaging, and tested upgrade/uninstall paths.
- PWA installability and deliberate offline caching.
- Migration tooling with backup-before-upgrade and rollback guidance, and encrypted offsite backup adapters.
- Explicit restored-instance activation and original-instance retirement ([backups](docs/backups.md)).
- Release versioning, changelogs, and reproducible artifacts.

### Devices

- Real cryptographic device pairing, a semantic `listen()`, policy-gating of the remaining owner-only debug routes, and unifying more connectors into the capability model ([devices](docs/devices.md)).

## Foundations (complete)

The first nine milestones built the machinery the product now runs on. Detail lives in the linked documents and in git history.

| Foundation | What exists | Reference |
|---|---|---|
| Secure single-owner access | Passphrase owner setup, expiring HTTP-only sessions, CSRF, loopback default, rate limits, security headers | [SECURITY.md](SECURITY.md), [deployment](docs/deployment.md) |
| Replaceable models | OpenAI-compatible and Anthropic providers, per-role `ModelRouter`, strict plan schema, bounded context assembly with provenance, prompt-injection containment, optional semantic ranking | [models](docs/models.md), [architecture](docs/architecture.md) |
| Browser client | No-build Web Components, SSE recovery, multi-tab sync, accessibility checks, and Playwright across Chromium, Firefox and WebKit | [dashboards](docs/dashboards.md) |
| Memory controls | Fact authority labels, confirm/correct/reclassify/delete with revisions, soft entity deletion with impact previews, projection replay | [architecture](docs/architecture.md) |
| Durable automation | Leased scheduler, durable action queue with idempotency keys, execution-time policy/approval/freshness checks, uncertain-outcome review, Operations view | [automation](docs/automation.md), [policies](docs/policies.md) |
| Privacy | Data-processing policy by classification and destination, applied to every model-bound item | [policies](docs/policies.md), [ADR 0006](docs/adr/0006-data-processing-policy-separate-from-tool-policy.md) |
| Explainability | `Why?` views for actions and recommendations from stored summaries and provenance | [architecture](docs/architecture.md#explainability) |
| Bounded goals | Owner-scoped goals with finite read-only research runs and budgets | [goals](docs/goals.md) |
| Operations and recovery | Runtime ownership guard, encrypted backups, validated inactive restore, recovery quarantine | [runtime ownership](docs/runtime-ownership.md), [backups](docs/backups.md) |
| Devices and capabilities | Device registry, deterministic resolver, realtime device bus, browser-as-device, policy-gated presentation, trust lifecycle | [devices](docs/devices.md) |

Current test counts and the implemented/fixture/live distinction are tracked in the [progress record](docs/personal-agent-progress.md).

## Continuous work

- Keep unit, integration, security, migration and browser tests green.
- Update documentation and known limitations in the same change as behaviour.
- Log no message bodies, credentials, tokens, private memory or vault contents by default.
- Threat-model every new connector, tool, model input, routine trigger, and externally supplied event.
- Record architectural decisions that change extension points, trust boundaries, or where the owner's data lives.
