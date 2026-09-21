# U2OS Event Model

The event log is the connective tissue of U2OS. Nothing important happens without an event being published. This document defines the envelope, the event taxonomy, and the persistence schema.

**Architectural stance (PLAN.md Phase 10):** the event log is the immutable history/provenance/correlation/replay spine, not the primary read path for application state. SQLite's relational tables (entities, facts, relationships, tasks, calendar_events, agent_actions, ...) are the authoritative, directly-queried materialized state; routes and tools read/write those tables directly. An event and its corresponding row are written together from the same code path, not derived from one another. See docs/architecture.md's "Event log and operational state" for the full reasoning -- U2OS is deliberately not a pure event-sourced system.

## Envelope

Every event published on the bus has this normalized shape:

```json
{
  "id": "evt_01HZY...",
  "type": "calendar.event_changed",
  "timestamp": "2026-09-17T10:30:00-07:00",
  "source": "mock-calendar",
  "actor": { "type": "agent", "id": "agent_default" },
  "subject": { "type": "calendar_event", "id": "cal_abc123" },
  "data": { "before": { "start_at": "..." }, "after": { "start_at": "..." } },
  "metadata": { "correlationId": "corr_...", "causationId": "evt_...", "provenance": "tool:calendar.reschedule" }
}
```

Field notes:

- `id` — `evt_` + ULID-ish (timestamp-sortable) id, assigned by the bus, never by the publisher.
- `type` — dotted namespace, `domain.event_name`, always past-tense/stateful (`event_changed`, not `change_event`).
- `source` — which subsystem/provider produced it (`mock-calendar`, `agent`, `user`, `policy-engine`).
- `actor` — who/what caused it: `{ type: 'user' | 'agent' | 'system' | 'person', id }`.
- `subject` — the primary entity/record the event is about.
- `data` — event-specific payload. Kept small; large content (email bodies, documents) is referenced by id, not inlined.
- `metadata.correlationId` — shared by every event descending from one originating request (a user message, an incoming webhook, a scheduled trigger). Used to replay one causal chain.
- `metadata.causationId` — the immediate event/action that directly caused this one (for building a causal graph, not just a flat correlation group).

## Persistence

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  causation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_correlation ON events(correlation_id);
```

Normal application operation is append-only: no route or agent workflow updates or deletes event rows. The explicit maintenance CLI can prune events older than an operator-selected retention period after a dry run; it records `system.event_retention_applied` before deletion. See `docs/deployment.md`.

## Event taxonomy

Emitted by mock tools/integrations:

| Type | Emitted when | source |
|---|---|---|
| `calendar.event_added` | a calendar event is created | `mock-calendar` |
| `calendar.event_changed` | a calendar event is rescheduled/edited | `mock-calendar` |
| `calendar.event_approaching` | trigger engine detects an event starting soon, deduplicated per trigger/event | `trigger-engine` |
| `email.received` | seed/demo inbound mail lands | `mock-email` |
| `email.sent` | `email.send` tool executes | `mock-email` |
| `contact.birthday_approaching` | derived from contacts + date (seed-time only in Phase 1) | `mock-contacts` |
| `task.created` | `tasks.create` executes | `mock-tasks` |
| `task.completed` | `tasks.complete` executes | `mock-tasks` |
| `task.overdue` | trigger engine detects an overdue open task, deduplicated per trigger/task | `trigger-engine` |
| `notification.sent` | `notifications.send` completes successfully | active provider: `mock-notifications` or `webhook` |
| `subscription.renewing` | an upstream source reports a future renewal with bounded name/date and optional price data | connector/import source |
| `message.received` | an upstream source reports a message with bounded sender/subject metadata, explicit importance, and whether it was direct | connector/import source |
| `project.changed` | an upstream source reports which aspect of a locally stored Project changed | connector/import source |

`message.received` uses `{ direct: boolean, importance: 'normal' | 'high' | 'urgent', sender: string, subject?: string, preview?: string }`. The built-in proactive evaluator requires `direct: true`, an exact `high` or `urgent` importance value (case-insensitive), a sender, and either a subject or preview. It truncates sender and display text before proposing the fixed `notifications.send` tool; the event cannot choose a tool or authorization level. This importance value is an upstream signal, not sender authentication or a model verdict.

`project.changed` identifies an active local Project with `subject: { type: 'entity', id }` (or `data.entityId`) and uses `data.change: 'status' | 'deadline'`. The proactive evaluator notifies only when the local Project is currently blocked or has a valid locally stored deadline, respectively. Names, status, and deadline values supplied in event data are ignored, and other change kinds are non-actionable.

Emitted by the agent/policy/tool pipeline (internal, domain-independent):

| Type | Meaning |
|---|---|
| `agent.action.proposed` | planner produced a structured action, policy evaluated it |
| `agent.action.approved` | user approved a pending action |
| `agent.action.rejected` | user rejected a pending action |
| `agent.action.completed` | a tool executed successfully (autonomous or after approval) |
| `agent.action.failed` | a tool execution threw / returned an error |
| `agent.action.queue_updated` | committed durable delivery state changed; metadata only, with no arguments or raw provider error |
| `agent.memory_candidate.proposed` | a validated plan included `memoryCandidates`. A durable pending candidate is created, but no fact/entity is written until the owner accepts it through `/api/memory/candidates/:id/accept`. Rejection preserves the candidate and audit state without promoting it. |
| `memory.fact_confirmed` | owner explicitly confirmed an existing fact; content is unchanged and `last_confirmed_at` advances |
| `memory.fact_reclassified` | owner changed the data-processing classification through the dedicated fact endpoint |
| `memory.fact_corrected` | owner created a replacement fact; the previous fact remains as `superseded` history |
| `memory.fact_deleted` | owner removed a fact from active retrieval; the row remains as an audited soft-deleted record |
| `memory.relationship_deleted` | owner removed a relationship from active graph reads; the row remains for audit history |
| `memory.entity_deleted` | owner confirmed an impact preview and removed an entity from active reads; linked records remain stored |
| `system.projections_replayed` | an operator explicitly applied a bounded derived-projection rebuild; counts only, with no projected content |
| `agent.context_restricted` | the data-processing privacy policy (server/policy/data-processing-policy.js) withheld one or more context items -- facts, people, commitments, or event-derived summaries -- from the context sent to a specific model provider for this request -- data(classification) x destination, separate from tool authorization. `data` includes `destination`, `providerId`, and an `omitted` list where each entry carries `type` (`fact`/`person`/`commitment`/`event`), `id`, `classification`, `destination`, `decision`, and `rule`, so the omission is auditable, never silent. |
| `user.feedback` | user accepted/rejected/edited a suggestion post-hoc (Phase 7 hook, schema reserved now) |

Derived/memory events (published by the memory projector after it updates entities/facts from a primary event — kept distinct from the primary event so consumers can tell "something happened externally" apart from "we changed what we believe"):

| Type | Meaning |
|---|---|
| `memory.fact_recorded` | a new fact was written |
| `memory.relationship_recorded` | a new relationship edge was written |
| `commitment.made` | the agent recognized a stated commitment ("I'll send the proposal") and created/linked a `Commitment` entity |

Device/capability/stream events (docs/devices.md's device/capability subsystem -- `source` is `device-adapter:<adapterId>` for registry-driven transitions, `device:<id>` for device-initiated ones like a heartbeat-derived status change or a trust transition):

| Type | Emitted when | source |
|---|---|---|
| `device.discovered` | a device row is inserted for the first time | `device-adapter:<adapterId>` |
| `device.connected` | a device's status transitions to `online` (first discovery, or coming back online) | `device-adapter:<adapterId>` or `device:<id>` |
| `device.disconnected` | a device's status transitions to `offline` | `device-adapter:<adapterId>` or `device:<id>` |
| `device.pairing_requested` | a genuinely new device sends its first `hello` over the realtime bus (`/ws/devices`) -- never fires again for a reconnect, and never fires for `MockDeviceAdapter`'s pre-trusted fixtures | `device:<id>` |
| `device.trust_changed` | `DeviceRegistry.setTrust()` sets any trust value other than `revoked` | `device:<id>` |
| `device.revoked` | `DeviceRegistry.setTrust()` sets `revoked` -- also force-disconnects any live realtime connection | `device:<id>` |
| `capability.invoked` | `invokeCapability()`/`invokeDeviceCapability()` successfully executed a capability on a resolved/named device | `device:<id>` |
| `capability.failed` | resolution found no eligible device, or the device's adapter itself threw | `capability-resolver` or `device:<id>` |
| `stream.available` | `StreamRegistry.open()` recorded a stream reference as active | `device:<id>` |
| `stream.closed` | `StreamRegistry.close()` removed an active stream reference | `device:<id>` |

Not implemented until later phases (reserved names, do not repurpose): `document.created`, `document.changed`, `purchase.completed`, `package.shipped`, `location.changed`.

## Subscribing

```js
eventBus.subscribe('calendar.*', handler);
eventBus.subscribe('agent.action.proposed', handler);
eventBus.subscribe('*', handler); // activity feed, SSE hub
```

## Replay

`GET /api/events?type=&since=&correlationId=&subjectType=&subjectId=&limit=` reads directly from the `events` table — the API never has a separate "history" store to keep in sync; it's the same log. `subjectType`/`subjectId` (added for the device management UI's "recent activity" panel, docs/devices.md) are generically useful for any subject, not device-specific — e.g. `?subjectType=device&subjectId=mock.camera.kitchen`.

The SSE stream includes each event's durable id. Reconnecting clients send `Last-Event-ID`; the server replays later persisted events before resuming live delivery. Comment heartbeats keep otherwise-idle connections alive.

Operators can deterministically rebuild registered derived projections in durable append order with `npm run maintain -- --replay-projections`. This is a dry run unless `--apply` is also supplied. Apply runs atomically, replaces only the registered rebuildable rows, and records `system.projections_replayed`; it does not republish historical events through the live bus, so tools, connectors, notifications, and agent actions cannot execute. The initial registry covers the memory projector's `calendar.event_changed` attendee facts. Authoritative connector rows and owner-entered memory are never rebuilt or deleted.
