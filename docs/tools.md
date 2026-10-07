# U2OS Tool Registry

Every tool declares whether it is `read`, `draft`, or `consequential` — the policy engine uses this classification plus a `domain` to decide the autonomy level. Tools never call the LLM and never call each other; only the agent orchestrates calls, and only through the registry, via `evaluateAndMaybeExecute()`'s policy-gated pipeline. That holds for every source of intent: chat, voice, triggers, goals, proactive evaluators and unattended vault [routines](routines.md).

Most tools (`email.*`, `calendar.*`, `contacts.search`, `web.search`, `notifications.send`) are **provider-agnostic**: `execute()` calls `getProvider(domain)` and runs against whichever provider is currently configured -- mock providers for every domain (used only in explicit demo homes), plus real Google Calendar/Gmail/Google Contacts, IMAP/SMTP, Brave Search and generic webhook/ntfy notification adapters (see docs/connectors.md for exactly which are real vs MOCK-only, and how to configure one). `tasks.*` is local-only: it reads and writes the native `tasks` table, and no external task-manager integration exists yet. The browser also edits tasks directly through `PATCH /api/tasks/:id` ([dashboards](dashboards.md)).

`presentation.present`/`presentation.notify` (docs/devices.md) are a different shape from every other tool here: instead of calling a connector provider, they call `invokeCapability()` (server/devices/capabilities.js), which resolves an eligible *device* deterministically (trust/privacy/ownership-aware, never LLM-driven) and delegates to that device's adapter. They also take their dependencies via constructor injection (`deviceRegistry`/`capabilityRegistry`) rather than a module-level provider accessor -- see server/tools/presentation-tools.js's header comment for why.

Every tool listed in `server/packages/core-capabilities.js` is also a **core capability** under the same id that installed packages may invoke, with the permissions it maps to ([capabilities guide](packages/capabilities.md)). Package-defined capabilities are registered in the same registry as **hidden** tools (`register(tool, { hidden: true })`): the gate and durable queue can execute them, but `list()` never shows them to the planner and plan validation refuses them.

Tools from **MCP servers** declared in the vault's `mcp.yaml` are registered as ordinary planner-visible tools named `<server>.<tool>` ([MCP tools](mcp.md)). They are `read` only when the owner's file says so, otherwise `consequential`, and their policy domain is the server name.

The `coding.agent` capability is not a planner tool: it is started from the `u2 coding-agent` CLI and reaches the gate as a capability ([coding agents](coding-agents.md)).

## `Tool` interface (`server/tools/tool.js`)

```js
class Tool {
  get name() {}          // "calendar.reschedule"
  get domain() {}        // "calendar" — matches policies.yaml top-level key
  get category() {}      // "read" | "draft" | "consequential"
  get schema() {}         // JSON Schema for arguments
  get supportsIdempotency() { return false; }
  async execute(args, context) {}  // context: { eventBus, correlationId, actor, idempotencyKey }
}
```

`ToolRegistry.get(name)`, `ToolRegistry.list()`, `ToolRegistry.register(tool)`.

`supportsIdempotency` is a security-relevant capability, not a model hint. It must remain `false` unless the concrete provider consumes `context.idempotencyKey` and guarantees that repeating a call with the same key cannot repeat its external side effect. After a crash during an unknown non-idempotent outcome, the durable worker stops for owner attention instead of guessing or replaying. Network/timeout retries likewise require either this explicit capability or an error deterministically marked `safeToRetry` by trusted provider code.

## Tools

| Tool | Domain | Category | Args | Effect / emitted event |
|---|---|---|---|---|
| `email.search` | email | read | `{ query?, folder? }` | selected account; bounded Gmail provider search or recent synchronized IMAP inbox, not exhaustive |
| `email.read` | email | read | `{ id }` | reads one email via bound provider, marks read |
| `email.draft` | email | draft | `{ to, subject, body, inReplyTo? }` | real local draft row, no send/event/provider call; personal sender unset until a later send proposal binds its account; fictional sender only in explicit demo |
| `email.send` | email | consequential | `{ to, subject, body, inReplyTo?, draftId? }` | provider/account captured at proposal → `email.sent` |
| `calendar.list` | calendar | read | `{ from?, to? }` | active provider (mock or real Google Calendar) |
| `calendar.create` | calendar | consequential | `{ title, startAt, endAt, attendees?, location? }` | active provider → `calendar.event_added` |
| `calendar.reschedule` | calendar | consequential | `{ eventId, newStartAt, newEndAt }` | captured account, with event ownership checked → `calendar.event_changed` |
| `contacts.search` | contacts | read | `{ query }` | active provider (mock or real Google Contacts) |
| `tasks.list` | tasks | read | `{ status? }` | reads the local `tasks` table |
| `tasks.create` | tasks | consequential | `{ title, dueAt?, relatedEntityId? }` | inserts a local row → `task.created` |
| `tasks.complete` | tasks | consequential | `{ id }` | updates local status → `task.completed` |
| `web.search` | web | read | `{ query }` | active provider (mock canned results, or real Brave Search) |
| `notifications.send` | notifications | consequential | `{ title, body, priority? }` | active provider: local mock audit event or real bounded JSON/ntfy webhook delivery → `notification.sent` only after success |
| `presentation.present` | presentation | consequential | `{ audience, privacy?, content }` | resolves a device via `ui.render` and invokes it → `capability.invoked`/`capability.failed` (docs/devices.md) |
| `presentation.notify` | presentation | consequential | `{ audience, privacy?, title, body? }` | resolves a device via `ui.notify` and invokes it → `capability.invoked`/`capability.failed` (docs/devices.md) |

See docs/connectors.md for which domains have a real (non-mock) provider implemented today, and how to configure one. See docs/devices.md for the device/capability model `presentation.*` sits on top of.

## Classification → policy mapping

The policy engine looks up `policies.yaml[domain][operationKey]` where `operationKey` is derived from the tool name's second segment (`reschedule`, `send`, `create`, ...) with `read` and `draft` categories defaulting to `always allowed, no approval` unless a policy explicitly overrides them. This is independent of the data-processing privacy policy (docs/policies.md's "Data-processing privacy policy" section), which separately governs what CONTEXT a model provider gets to see, regardless of which tool (if any) is ultimately called.

`presentation` has no entry in the shipped default `policies.yaml`, so `presentation.present`/`presentation.notify` fail safe to `confirm` (autonomy level 3) exactly like any other unconfigured domain -- add a `presentation:` section (e.g. `notify: autonomous`) to change that, the same way you would for any other domain.

## Provenance

Every proposed tool execution writes an `agent_actions` row (even autonomous ones, for audit). Authorized work is then persisted in `action_queue` before the registered tool runs; numbered attempts live in `action_attempts`. Every state-changing tool publishes an event whose `metadata.provenance` is `tool:<name>`, and committed delivery transitions publish metadata-only `agent.action.queue_updated` events.

An executing worker renews its lease while a provider call is in flight. The lease-renewal test waits for a persisted heartbeat and checks a second worker against a controlled clock just past the original expiry; it does not depend on a short wall-clock sleep under CI load. If a process or event loop cannot renew before expiry, the existing uncertain-outcome/idempotency rules still govern recovery rather than assuming the external action did not happen.

## Email attachments

`email.send` accepts an optional `attachments` list of **staged references**. It never accepts a file path, so a model or routine cannot attach (or exfiltrate) an arbitrary file.

A file is staged by copying it into the vault outbox under its own SHA-256, `<vault>/outbox/<sha256>/<filename>`, which the owner or software acting for them does deliberately (`stageAttachment()` in `server/tools/email-attachments.js`; `u2 job materials` stages the tailored resume and cover letter). The reference is `outbox/<sha256>/<filename>`. It is part of the approved arguments, so the approval screen shows the file name and the start of the hash.

At send time the tool re-reads the file and refuses, sending nothing, when it is not staged, is not a regular file (links are refused), lies outside the outbox, is larger than 10 MB, is not a document or image type (`pdf txt md rtf doc docx png jpg`), or no longer hashes to the reference. Limits are three files and 15 MB in total. The `email.sent` event and the action result record only each attachment's name, size, type and hash.

Gmail sends a `multipart/mixed` message (UTF-8 text, RFC 2047 subject); SMTP (including IMAP accounts) uses the same verified files. Drafts do not take attachments.
