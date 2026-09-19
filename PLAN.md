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

- Implement an OpenAI-compatible provider that can target hosted APIs, Ollama, llama.cpp servers, and other compatible local endpoints.
- Add at least one separately implemented provider adapter to verify the abstraction is real rather than nominal.
- Store provider credentials in the existing encrypted vault.
- Validate every model-produced plan against strict schemas before policy evaluation.
- Add configurable model roles for classification, planning, summarization, extraction, and embeddings.
- Add policy-aware routing, timeout, retry, fallback, and offline behavior.
- Define bounded context assembly from memory and events, with provenance on retrieved facts.
- Add prompt-injection regression cases from email, web search, documents, and calendar text.
- Retain `MockModelProvider` as the deterministic test fixture and offline demo fallback.

### Acceptance criteria

- The owner can configure a local OpenAI-compatible endpoint without a cloud account.
- A natural-language request outside the mock intent set can produce a schema-valid plan.
- Invalid or malicious model output cannot invoke an unregistered tool or skip policy evaluation.
- Provider failure degrades to an explicit unavailable/fallback state rather than losing requests or executing stale actions.
- Tests prove that switching models cannot change tool authorization semantics.

## Milestone 3 — Browser reliability and end-to-end coverage

Turn the current UI from a largely backend-tested shell into a dependable client.

### Work

- Add Playwright coverage for onboarding/login, navigation, chat, approval/rejection, dashboards, connectors, triggers, feedback, themes, and responsive layouts.
- Add SSE reconnect with exponential backoff, last-event recovery, duplicate suppression, and session-expiry handling.
- Make dashboards update in place from relevant events.
- Surface offline, degraded connector, and queued-action states consistently.
- Complete keyboard navigation, focus management, semantic labels, contrast checks, and reduced-motion support.
- Add error boundaries and actionable user-facing error messages for failed API operations.

### Acceptance criteria

- Critical owner workflows pass in Chromium, Firefox, and WebKit automation.
- Approval and activity views update correctly across two simultaneously connected clients.
- Temporary server/network loss recovers without duplicate actions or a full page reload.
- The core UI meets WCAG 2.2 AA checks for tested workflows.

## Milestone 4 — Complete contextual dashboards and memory controls

Finish the trusted UI primitive set and give the owner meaningful control over remembered information.

### Work

- Implement functional person, project, document, conversation, chart, map, and photo-grid components.
- Extend dashboard sources through a documented server-side resolver rather than embedding arbitrary data access in components.
- Add dashboard provenance so the owner can see why each card was included.
- Add memory correction, confirmation, deletion, and contradiction-resolution APIs and UI.
- Add safe entity and relationship deletion with impact previews and audit events.
- Distinguish explicit, imported, derived, and inferred facts visually.
- Implement deterministic event replay for rebuilding derived projections, with dry-run support.
- Expand demo data to exercise every supported component and memory state.

### Acceptance criteria

- Morning, before-meeting, project, and travel contexts render without placeholder components.
- The owner can inspect, correct, confirm, export, and delete a remembered fact.
- Weak inference is never silently promoted to an explicit fact.
- Rebuilding projections from the event log produces repeatable results without replaying external side effects.

## Milestone 5 — Automation durability and degraded operation

Make proactive behavior reliable across restarts and intermittent connectivity.

### Work

- Persist scheduler leases/state so restarts do not lose or double-run due work.
- Add idempotency keys and execution leases for consequential actions.
- Introduce an explicit durable queue for unavailable external actions.
- Re-evaluate policy, freshness, and owner intent before executing a queued consequential action.
- Add retry classes, exponential backoff, dead-letter handling, and operator-visible recovery controls.
- Expand event evaluation beyond the initial email, approaching-meeting, overdue-task, and commitment cases.
- Add calendar-conflict, birthday, renewal, important-message, and project-activity evaluators.
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

### Acceptance criteria

- A fresh supported machine can install, onboard, run headlessly, restart, upgrade, back up, restore, and export U2OS using documented procedures.
- The same core application runs on Docker amd64/ARM64, Linux, macOS, and Windows targets.
- Core capabilities require no U2OS account, subscription, or hosted service.

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
