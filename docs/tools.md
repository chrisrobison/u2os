# U2OS Tool Registry

Every tool declares whether it is `read`, `draft`, or `consequential` — the policy engine uses this classification plus a `domain` to decide the autonomy level. Tools never call the LLM and never call each other; only the agent orchestrates calls, and only through the registry, via `evaluateAndMaybeExecute()`'s policy-gated pipeline.

Most tools (`email.*`, `calendar.*`, `contacts.search`, `web.search`) are **provider-agnostic**: `execute()` calls `getProvider(domain)` and runs against whichever provider is currently configured -- CURRENTLY IMPLEMENTED mock providers for every domain, plus real Google Calendar/Gmail/Google Contacts/Brave Search adapters (see docs/connectors.md for exactly which are real vs MOCK-only, and how to configure a real one). `tasks.*` and `notifications.send` are MOCK/STUB only for now -- no real task-manager or push-notification integration exists yet.

## `Tool` interface (`server/tools/tool.js`)

```js
class Tool {
  get name() {}          // "calendar.reschedule"
  get domain() {}        // "calendar" — matches policies.yaml top-level key
  get category() {}      // "read" | "draft" | "consequential"
  get schema() {}         // JSON Schema for arguments
  async execute(args, context) {}  // context: { eventBus, correlationId, actor }
}
```

`ToolRegistry.get(name)`, `ToolRegistry.list()`, `ToolRegistry.register(tool)`.

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

See docs/connectors.md for which domains have a real (non-mock) provider implemented today, and how to configure one.

## Classification → policy mapping

The policy engine looks up `policies.yaml[domain][operationKey]` where `operationKey` is derived from the tool name's second segment (`reschedule`, `send`, `create`, ...) with `read` and `draft` categories defaulting to `always allowed, no approval` unless a policy explicitly overrides them. This is independent of the data-processing privacy policy (docs/policies.md's "Data-processing privacy policy" section), which separately governs what CONTEXT a model provider gets to see, regardless of which tool (if any) is ultimately called.

## Provenance

Every tool execution writes an `agent_actions` row (even autonomous ones, for audit) and every state-changing tool publishes an event whose `metadata.provenance` is `tool:<name>`.
