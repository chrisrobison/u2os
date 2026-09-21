# U2OS Development Plan

This plan begins from the current pre-alpha implementation of Phases 1–7. Work is ordered by dependency and risk: secure the existing platform first, make its intelligence replaceable and useful second, then deepen interfaces, voice, integrations, and packaging.

## Guiding constraints

- Preserve the event log as the system's connective tissue.
- Keep authorization outside the model and tool providers.
- Feedback may change ranking and presentation, never security policy.
- Keep core identity, memory, relationships, and policies local-first and portable.
- Treat the browser and future satellites as untrusted clients of the persistent service.
- Prefer standard protocols, native browser modules, small explicit interfaces, and few dependencies.
- Clearly label mock, simplified, unavailable, and degraded behavior.
- Add migrations and compatibility tests for existing `U2OS_HOME` installations.

## Milestone 1 — Secure single-owner alpha

This is the release blocker for use beyond a trusted loopback-only development environment.

### Work

- [x] Introduce first-run owner setup with a securely hashed passphrase.
- [x] Add authenticated, idle/absolute-expiring server sessions using secure, HTTP-only cookies.
- [x] Require authentication for private reads and every state-changing route.
- [x] Add CSRF protection for cookie-authenticated writes, including approvals and connector changes.
- [x] Bind to loopback by default; require explicit configuration to listen on the LAN.
- [x] Add trusted-proxy and secure-cookie configuration for reverse-proxy deployments.
- [x] Protect SSE connections and ensure reconnects cannot bypass session expiry.
- [x] Add a global JSON request-size limit (no current enrollment payload needs an exception).
- [x] Add in-process rate limits for login attempts, action approvals, agent requests, triggers, connector writes, and voice enrollment.
- [x] Validate `Origin`/`Host` where appropriate and add baseline security headers.
- [x] Stop accepting caller-supplied identities; derive the owner from the authenticated session.
- [x] Document recovery without a credential or policy backdoor.

### Acceptance criteria

- An unauthenticated client cannot read events, memory, email, contacts, exports, or pending actions.
- An unauthenticated client cannot approve actions, replace a voiceprint, create triggers, or alter connectors.
- Login, logout, expiry, CSRF, brute-force throttling, oversized bodies, and SSE authentication have automated tests.
- Loopback remains easy for development, while LAN exposure is an explicit owner decision.
- Existing policy and vertical-slice tests continue to pass unchanged in their authorization semantics.

## Milestone 2 — Real model providers and model routing

Replace the narrow demo intent matcher without making a vendor API part of the architecture.

### Work

- [x] Implement an OpenAI-compatible provider that can target hosted APIs, Ollama, llama.cpp servers, and other compatible local endpoints.
- [x] Add at least one separately implemented provider adapter to verify the abstraction is real rather than nominal. (`AnthropicProvider` -- different auth header, request/response envelope, and no guaranteed JSON-only mode.)
- [x] Store provider credentials in the existing encrypted vault.
- [x] Validate every model-produced plan against strict schemas before policy evaluation.
- [x] Add configurable model roles for classification, planning, summarization, extraction, and embeddings. (`ModelRouter`; the HTTP endpoint accepts validated multi-provider/role configuration, while the browser form remains single-provider.)
- [x] Add policy-aware routing, timeout, retry, fallback, and offline behavior. (Planner calls and fallback calls are destination-filtered by the data-processing policy; embedding inputs are filtered independently before remote transmission.)
- [x] Define bounded context assembly from memory and events, with provenance on retrieved items. (`ContextAssembler` -- bounded cross-type candidate selection, inspectable hybrid ranking, character budget, and provenance refs; optional semantic similarity remains application-side -- see semantic memory retrieval below.)
- [x] Add prompt-injection regression cases from email, web search, documents, and calendar text. (`tests/prompt-injection.test.js`: retrieved content cannot register a tool, cannot smuggle a privileged argument past a tool's own schema, cannot authorize a consequential action, and cannot alter policy/model-routing/data-processing configuration -- proven end to end through Agent, not just at the validator layer.)
- [x] Retain `MockModelProvider` as the deterministic test fixture and offline demo default.
- [x] Add semantic memory retrieval as an index/access mechanism over existing structured memory (never a vector-database replacement). `EmbeddingProvider` abstraction (mock + OpenAI-compatible), vectors stored as plain JSON in a local `embeddings` table, application-side cosine similarity, and inspectable hybrid ranking across entities, facts, commitments, and events. Opt-in via an explicit `embeddings` role; off by default, with destination-aware filtering before remote embedding calls.
- [x] Add a data-processing privacy policy, separate from tool authorization: classification (public/personal/private/sensitive) x destination (local_model/configured_remote_model/external_tool/local_ui), evaluated in `Planner` immediately before a specific provider's `plan()` call so a fact classified `sensitive` can be allowed to a local model while never reaching a configured remote one. Applies to every model-bound context item type -- facts, people, commitments, and event-derived summaries (email/calendar/task) -- each classified deterministically from stored data and each independently evaluated; `confirm` decisions are conservatively treated as `never` pending an interactive confirmation mechanism.
- [x] Build one intelligent end-to-end vertical slice using a real `ModelProvider` (against a deterministic fake HTTP endpoint in tests): an open-ended "what's going on today" request inspects real retrieved context, autonomously handles the routine part, requests approval for the consequential part, and records a fully correlated event chain; a second scenario proves a fact established on one turn is retrieved with provenance and used by a brand-new `Agent` instance on a later turn, sharing only the database (`tests/intelligent-vertical-slice.test.js`, docs/architecture.md).
- [x] Explainability: `agent_actions.context_provenance` records which retrieved fact/entity/event ids actually informed a given plan (after data-processing filtering); `server/agent/explain.js`'s `explainAction()` (also `GET /api/actions/:id/explain`) assembles model/policy-rule/reasoning/provenance/the full correlated event chain into one queryable structure -- concise references and stored summaries only, never raw model chain-of-thought.

### Acceptance criteria

- The owner can configure a local OpenAI-compatible endpoint without a cloud account.
- A natural-language request outside the mock intent set can produce a schema-valid plan.
- Invalid or malicious model output cannot invoke an unregistered tool or skip policy evaluation.
- Provider failure degrades to an explicit unavailable/fallback state rather than losing requests or executing stale actions.
- Tests prove that switching models cannot change tool authorization semantics.

## Milestone 3 — Browser reliability and end-to-end coverage

Turn the current UI from a largely backend-tested shell into a dependable client.

### Work

- [x] Add Playwright coverage for onboarding/login, navigation, chat, approval/rejection, dashboards, connectors, triggers, feedback, themes, and responsive layouts. (62 scenarios run in Chromium, Firefox, and WebKit, including trigger management and live dashboard refresh.)
- [x] Add SSE reconnect with exponential backoff, last-event recovery, duplicate suppression, and session-expiry handling. (The client exposes connection state, bounds remembered event ids, and stops retrying to return the owner to login on HTTP 401.)
- [x] Make dashboards update in place from relevant events. (Visible morning and contextual dashboards debounce relevant SSE events and reload through their current server-side generator without navigation.)
- [x] Surface offline, degraded connector, and queued-action states consistently. (`u2-connectors`, `u2-operations`, and `u2-diagnostics` expose connector health and durable queue states with owner-readable recovery information.)
- [x] Complete keyboard navigation, focus management, semantic labels, contrast checks, and reduced-motion support. (The shell includes skip navigation, labeled regions, deterministic route focus, visible focus treatment, automated axe/contrast checks, and cross-browser keyboard coverage.)
- [x] Add error boundaries and actionable user-facing error messages for failed API operations. (Route/component failures are owner-readable, SSE state is visible, and unexpected client errors produce a privacy-safe shell notice with reload/dismiss recovery.)

### Acceptance criteria

- Critical owner workflows pass in Chromium, Firefox, and WebKit automation.
- Approval and activity views update correctly across two simultaneously connected clients.
- Temporary server/network loss recovers without duplicate actions or a full page reload.
- The core UI meets WCAG 2.2 AA checks for tested workflows.

## Milestone 4 — Complete contextual dashboards and memory controls

Finish the trusted UI primitive set and give the owner meaningful control over remembered information.

### Work

- [x] Implement functional person, project, document, conversation, chart, map, and photo-grid components.
- [x] Extend dashboard sources through a documented server-side resolver rather than embedding arbitrary data access in components. (Every allowlisted source shares one bounded local-store resolver registry with schema validation; browsers receive inert hydrated data only.)
- [x] Add dashboard provenance so the owner can see why each card was included. (Every validated component requires a bounded reason and source references, rendered through the trusted `<u2-why>` component.)
- [x] Add memory correction, confirmation, deletion, and contradiction-resolution APIs and UI. (Deletion is an audited soft-delete, preserving history.)
- [x] Add safe entity and relationship deletion with impact previews and audit events. (Deletion is audited and soft; entity deletion requires a current impact token and preserves linked records.)
- [x] Distinguish explicit, imported, derived, and inferred facts visually. (Authority is derived deterministically from stored source/inference metadata and shown as labeled, non-color-only badges.)
- [x] Implement deterministic event replay for rebuilding derived projections, with dry-run support. (Replay is registry-bound, dry-run by default, atomic on apply, audited, and never republishes historical events to side-effecting subscribers.)
- [x] Expand demo data to exercise every supported component and memory state.

### Acceptance criteria

- Morning, before-meeting, project, and travel contexts render without placeholder components.
- The owner can inspect, correct, confirm, export, and delete a remembered fact.
- Weak inference is never silently promoted to an explicit fact.
- Rebuilding projections from the event log produces repeatable results without replaying external side effects.

## Milestone 5 — Automation durability and degraded operation

Make proactive behavior reliable across restarts and intermittent connectivity.

### Work

- Persist scheduler leases/state so restarts do not lose or double-run due work.
- [x] Add idempotency keys and execution leases for consequential actions.
- [x] Introduce an explicit durable queue for unavailable external actions.
- [x] Re-evaluate policy, freshness, and owner intent before executing a queued consequential action.
- [x] Add retry classes, exponential backoff, dead-letter handling, and operator-visible recovery controls.
- Expand event evaluation beyond the initial email, approaching-meeting, overdue-task, and commitment cases.
- Add calendar-conflict, birthday, renewal, important-message, and project-activity evaluators. (Calendar-conflict detection is complete; remaining evaluator types are still pending.)
- Add trigger history, next-run previews, pause/resume, and manual dry runs.

### Acceptance criteria

- Restarting during a trigger or connector failure does not duplicate an action.
- Network-dependent work is visibly queued or failed, never silently discarded.
- Queued consequential actions cannot execute later under a weaker or stale policy decision.
- A headless restart test verifies that scheduled work occurs and appears when the UI reconnects.

## Milestone 6 — Voice and satellite hardening

Treat voice as context and an authorization signal, not as proof of identity.

### Work

- Define and version an implementation-independent satellite protocol for audio segments, device identity, presence, speaker metadata, and output control.
- Add pluggable STT/TTS adapters, beginning with the existing Deepgram and ElevenLabs manifests or local alternatives.
- Replace the simple spectral fingerprint with a reviewed speaker-embedding provider.
- Add multi-speaker diarization and explicit unknown/other-speaker handling.
- Add challenge or second-factor confirmation for sensitive operations.
- Test owner, second person, television, music, replay attacks, synthesized speech, and the agent's own TTS.
- Keep server-side confidence and policy enforcement authoritative regardless of client claims.

### Acceptance criteria

- Other voices and replayed owner audio cannot gain silent consequential authority.
- Barge-in reliably stops output while maintaining correct speaker state.
- Voice providers can be swapped without changing the agent, policy, or tool interfaces.
- Sensitive actions always require an independent confirmation mechanism.

## Milestone 7 — Connector and skill ecosystem

Harden current adapters before expanding breadth.

### Work

- Add contract-test suites shared by mock and real providers.
- Add opt-in live integration tests for Google, Brave Search, and webhook delivery.
- Implement Google token revocation and clearer reauthorization/recovery flows.
- Add Gmail MIME, attachment, thread, and real draft support.
- Improve calendar category policy context without trusting model-authored labels.
- Implement CalDAV and IMAP providers currently represented by manifests only.
- Define signed/installable third-party skill packaging, compatibility, permission review, enable/disable, and upgrade behavior.
- Add outbound network permission enforcement rather than treating manifest permissions as documentation only.

The current foundation already includes encrypted connector credentials, Google Calendar/Gmail/Google Contacts and Brave Search adapters, bounded webhook/ntfy delivery, health-aware mock fallback, a connector UI, and notification-service capability unification. Those foundations do not satisfy the ecosystem acceptance criteria above on their own.

### Acceptance criteria

- Each real provider passes the same behavioral contract as its mock.
- Connector failures never leak secrets and never bypass policy.
- Skill installation shows declared capabilities and permissions before activation.
- Disabling or removing a skill cannot corrupt historical events or memory provenance.

## Milestone 8 — Distribution and appliance readiness

Package the secure alpha for ordinary self-hosting without creating a cloud dependency.

### Work

- Add a complete browser onboarding flow for owner creation, data location, AI providers, connectors, policies, and optional voice enrollment.
- Add a web app manifest, service worker, installability, and deliberate offline caching rules.
- Validate Docker images on amd64 and ARM64.
- Add Windows Service packaging and tested upgrade/uninstall paths for supported platforms.
- Add database/config migration tooling with backup-before-upgrade and rollback guidance.
- Add HTTPS/reverse-proxy deployment recipes and secure remote-access guidance.
- Add encrypted offsite backup adapters without requiring U2OS-operated infrastructure.
- Define release versioning, changelogs, support windows, and reproducible release artifacts.

Distribution foundations already present are a Dockerfile/Compose deployment, Linux systemd and macOS launchd templates, additive startup migrations, portable JSON export, full-fidelity backup/restore, and reverse-proxy guidance. Multi-architecture validation, Windows packaging, upgrade rollback, PWA support, and release engineering remain open.

### Acceptance criteria

- A fresh supported machine can install, onboard, run headlessly, restart, upgrade, back up, restore, and export U2OS using documented procedures.
- The same core application runs on Docker amd64/ARM64, Linux, macOS, and Windows targets.
- Core capabilities require no U2OS account, subscription, or hosted service.

## Milestone 9 — Device and capability subsystem (complete)

Generalizes tools and connectors to physical and remote endpoints — cameras, microphones, displays, satellites, and the browser/UI clients themselves — under one rule: devices expose capabilities, agents express intent, U2OS resolves the request to an appropriate device deterministically, never the reverse. Implemented as nine incremental phases, each committed and verified separately (tests plus, for the two UI-facing phases, real browser verification); full detail, API surface, event vocabulary, and known gaps live in [docs/devices.md](docs/devices.md) rather than duplicated here.

### Work

- [x] Core model: device/capability schema, a persisted `DeviceRegistry`, an in-memory `CapabilityRegistry`, a `DeviceAdapter` interface, a mock adapter, read-only inspection API.
- [x] A deterministic (never LLM-driven) capability resolver: trust-capped privacy tiers, ownership rules, per-candidate eligibility/score/reasons explanation output, capability invocation.
- [x] A realtime WebSocket device bus (`/ws/devices`, same `http.Server`, no new port) with heartbeats, presence, event publication/subscription over the existing `EventBus`, and device commands.
- [x] The browser itself as a registered device (`ui.render`/`ui.notify`/`ui.prompt`/`audio.play`, no permission prompts beyond what's needed), rendered by `<u2-device-panel>`.
- [x] Semantic presentation (`presentation.present`/`presentation.notify`) registered as real Tools, routed through the existing `PolicyEngine`/approval/`agent_actions` audit pipeline — the same pattern every other consequential route in this codebase already uses.
- [x] A device management UI (`#/devices`): list, detail, rename/relocate/reassign owner, pair/trust/revoke, remove, test-capability.
- [x] An enforced trust lifecycle: `device.pairing_requested` on a genuinely new connection; revocation forcibly disconnects a live realtime connection and is checked on every resolve/invoke/event-publish path at once, not merely recorded; a documented (not yet implemented) cryptographic-identity seam via `device.metadata`.
- [x] A metadata/reference stream registry (`stream://device/name`) — discover/open/close, never a media transport.
- [x] A service-provider unification proof of concept: the existing notifications connector exposed as a `type: 'service'` device, resolved/invoked with zero special-casing next to a physical device.

### Acceptance criteria

- An agent can request `presentation.present({audience, privacy, content})` without ever naming a device; the resolver alone decides, and a shared/other-owner device is provably rejected for private content while an owned, trusted device is provably chosen.
- A revoked device cannot be resolved, invoked (via the resolver or a direct/test path), have a stream opened against it, or publish another event — enforced on every path at once, not just recorded as a trust value.
- A connected browser tab and a connected mock/WebSocket device are indistinguishable to the resolver; a connected service (notifications) and a connected physical device are equally indistinguishable.
- 93 new tests (203 → 296) covering registration, resolution, the realtime bus, the browser flow, policy-gated presentation, management actions, the trust lifecycle, streams, and service unification; verified against a real running server and, for the two UI phases, real browser automation.

### Known gaps (see docs/devices.md for the full list)

- The raw direct-invoke (`POST /api/capabilities/:capability/invoke`), test-capability, and stream open/close routes are session-authenticated but not `PolicyEngine`-gated — owner-only debug/direct-control surfaces, not agent-reachable.
- No real cryptographic device pairing yet (the seam is documented; `device.metadata` can already carry a public key with no schema change).
- Only notifications has been unified into the capability model so far; the other connectors are untouched.
- No `listen()` (input's semantic counterpart to `present()`) yet.
- The realtime device bus's protocol is a natural transport for PROMPT.md §24's "Voice Satellite" concept (Milestone 6) but the two have not yet been connected — Milestone 6 still describes its own protocol as a separate future step.

## Continuous work across all milestones

- Keep unit, integration, security, migration, and browser tests green.
- Update documentation and known limitations in the same change as behavior.
- Add observability without logging message bodies, credentials, tokens, or private memory by default.
- Review schema indexes, event-log growth, retention, and backup performance with realistic datasets.
- Preserve portable exports and migration compatibility.
- Threat-model every new connector, tool, model input, and externally supplied event.
- Keep commits scoped and record architectural decisions that affect extension points or security boundaries.

## Definition of a usable alpha

U2OS reaches usable alpha when Milestones 1–3 are complete: a single owner can securely access a persistent local instance, configure a real or local model, run the core approval workflow, reconnect from multiple browser clients, and recover cleanly from ordinary network interruptions with automated end-to-end coverage.

Milestones 4–8 deepen the product toward the broader personal digital-agent vision; they are not reasons to postpone the security boundary required for alpha use.

**Status: usable alpha reached.** Milestones 1–3 are complete, with 369 Node tests and 65 Playwright scenarios running across Chromium, Firefox, and WebKit.
