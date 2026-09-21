# U2OS Tool Registry

Every tool declares whether it is `read`, `draft`, or `consequential` — the policy engine uses this classification plus a `domain` to decide the autonomy level. Tools never call the LLM and never call each other; only the agent orchestrates calls, and only through the registry, via `evaluateAndMaybeExecute()`'s policy-gated pipeline.

Most tools (`email.*`, `calendar.*`, `contacts.search`, `web.search`) are **provider-agnostic**: `execute()` calls `getProvider(domain)` and runs against whichever provider is currently configured -- CURRENTLY IMPLEMENTED mock providers for every domain, plus real Google Calendar/Gmail/Google Contacts/Brave Search adapters (see docs/connectors.md for exactly which are real vs MOCK-only, and how to configure a real one). `tasks.*` and `notifications.send` are MOCK/STUB only for now -- no real task-manager or push-notification integration exists yet.

`presentation.present`/`presentation.notify` (docs/devices.md) are a different shape from every other tool here: instead of calling a connector provider, they call `invokeCapability()` (server/devices/capabilities.js), which resolves an eligible *device* deterministically (trust/privacy/ownership-aware, never LLM-driven) and delegates to that device's adapter. They also take their dependencies via constructor injection (`deviceRegistry`/`capabilityRegistry`) rather than a module-level provider accessor -- see server/tools/presentation-tools.js's header comment for why.

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
| `email.search` | email | read | `{ query?, folder? }` | active provider (mock or real Gmail) |
| `email.read` | email | read | `{ id }` | reads one email via active provider, marks read |
| `email.draft` | email | draft | `{ to, subject, body, inReplyTo? }` | MOCK/STUB only -- creates a local draft row, no send, no event, regardless of active provider |
| `email.send` | email | consequential | `{ to, subject, body, inReplyTo?, draftId? }` | active provider (mock or real Gmail) → `email.sent` |
| `calendar.list` | calendar | read | `{ from?, to? }` | active provider (mock or real Google Calendar) |
| `calendar.create` | calendar | consequential | `{ title, startAt, endAt, attendees?, location? }` | active provider → `calendar.event_added` |
| `calendar.reschedule` | calendar | consequential | `{ eventId, newStartAt, newEndAt }` | active provider → `calendar.event_changed` |
| `contacts.search` | contacts | read | `{ query }` | active provider (mock or real Google Contacts) |
| `tasks.list` | tasks | read | `{ status? }` | MOCK/STUB only -- reads the local `tasks` table |
| `tasks.create` | tasks | consequential | `{ title, dueAt?, relatedEntityId? }` | MOCK/STUB only -- inserts a local row → `task.created` |
| `tasks.complete` | tasks | consequential | `{ id }` | MOCK/STUB only -- updates local status → `task.completed` |
| `web.search` | web | read | `{ query }` | active provider (mock canned results, or real Brave Search) |
| `notifications.send` | notifications | consequential | `{ title, body, priority? }` | MOCK/STUB only -- inserts a local row → `notification.sent` (this is how the agent "prominently notifies" the owner; no real push/desktop-notification integration exists) |
| `presentation.present` | presentation | consequential | `{ audience, privacy?, content }` | resolves a device via `ui.render` and invokes it → `capability.invoked`/`capability.failed` (docs/devices.md) |
| `presentation.notify` | presentation | consequential | `{ audience, privacy?, title, body? }` | resolves a device via `ui.notify` and invokes it → `capability.invoked`/`capability.failed` (docs/devices.md) |

See docs/connectors.md for which domains have a real (non-mock) provider implemented today, and how to configure one. See docs/devices.md for the device/capability model `presentation.*` sits on top of.

## Classification → policy mapping

The policy engine looks up `policies.yaml[domain][operationKey]` where `operationKey` is derived from the tool name's second segment (`reschedule`, `send`, `create`, ...) with `read` and `draft` categories defaulting to `always allowed, no approval` unless a policy explicitly overrides them. This is independent of the data-processing privacy policy (docs/policies.md's "Data-processing privacy policy" section), which separately governs what CONTEXT a model provider gets to see, regardless of which tool (if any) is ultimately called.

`presentation` has no entry in the shipped default `policies.yaml`, so `presentation.present`/`presentation.notify` fail safe to `confirm` (autonomy level 3) exactly like any other unconfigured domain -- add a `presentation:` section (e.g. `notify: autonomous`) to change that, the same way you would for any other domain.

## Provenance

Every proposed tool execution writes an `agent_actions` row (even autonomous ones, for audit). Authorized work is then persisted in `action_queue` before the registered tool runs; numbered attempts live in `action_attempts`. Every state-changing tool publishes an event whose `metadata.provenance` is `tool:<name>`, and committed delivery transitions publish metadata-only `agent.action.queue_updated` events.
