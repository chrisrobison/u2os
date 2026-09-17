# U2OS Tool Registry — Phase 1

Every tool is a mock/demo implementation backed by SQLite. Every tool declares whether it is `read`, `draft`, or `consequential` — the policy engine uses this classification plus a `domain` to decide the autonomy level. Tools never call the LLM and never call each other; only the agent/planner orchestrates calls, and only through the registry.

## `Tool` interface (`server/tools/tool.js`)

```js
class Tool {
  get name() {}          // "calendar.reschedule"
  get domain() {}        // "calendar" — matches policies.yaml top-level key
  get category() {}      // "read" | "draft" | "consequential"
  get schema() {}         // JSON Schema for arguments
  async execute(args, context) {}  // context: { db, eventBus, correlationId, actor }
}
```

`ToolRegistry.get(name)`, `ToolRegistry.list()`, `ToolRegistry.register(tool)`.

## Phase 1 tools

| Tool | Domain | Category | Args | Effect / emitted event |
|---|---|---|---|---|
| `email.search` | email | read | `{ query?, folder? }` | reads `emails` table |
| `email.read` | email | read | `{ id }` | reads one email, marks read |
| `email.draft` | email | draft | `{ to, subject, body, inReplyTo? }` | creates a draft row, no send, no event |
| `email.send` | email | consequential | `{ to, subject, body, inReplyTo? }` | inserts into `emails` (folder=sent) → `email.sent` |
| `calendar.list` | calendar | read | `{ from?, to? }` | reads `calendar_events` |
| `calendar.create` | calendar | consequential | `{ title, startAt, endAt, attendees?, location? }` | inserts row → `calendar.event_added` |
| `calendar.reschedule` | calendar | consequential | `{ eventId, newStartAt, newEndAt }` | updates row → `calendar.event_changed` |
| `contacts.search` | contacts | read | `{ query }` | reads `entities` where type=Person |
| `tasks.list` | tasks | read | `{ status? }` | reads `tasks` |
| `tasks.create` | tasks | consequential | `{ title, dueAt?, relatedEntityId? }` | inserts row → `task.created` |
| `tasks.complete` | tasks | consequential | `{ id }` | updates status → `task.completed` |
| `web.search` | web | read | `{ query }` | returns canned/mock results, clearly labeled mock — no network call |
| `notifications.send` | notifications | consequential | `{ title, body, priority? }` | inserts row, → `notification.sent` (this is how the agent "prominently notifies" the owner) |

## Classification → policy mapping

The policy engine looks up `policies.yaml[domain][operationKey]` where `operationKey` is derived from the tool name's second segment (`reschedule`, `send`, `create`, ...) with `read` and `draft` categories defaulting to `always allowed, no approval` unless a policy explicitly overrides them (policies can still restrict reads for sensitive domains later — not needed in Phase 1 demo data).

## Provenance

Every tool execution writes an `agent_actions` row (even autonomous ones, for audit) and every state-changing tool publishes an event whose `metadata.provenance` is `tool:<name>`.
