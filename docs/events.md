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
| `notification.sent` | `notifications.send` executes | `mock-notifications` |

Emitted by the agent/policy/tool pipeline (internal, domain-independent):

| Type | Meaning |
|---|---|
| `agent.action.proposed` | planner produced a structured action, policy evaluated it |
| `agent.action.approved` | user approved a pending action |
| `agent.action.rejected` | user rejected a pending action |
| `agent.action.completed` | a tool executed successfully (autonomous or after approval) |
| `agent.action.failed` | a tool execution threw / returned an error |
| `agent.memory_candidate.proposed` | a validated plan included `memoryCandidates`. A durable pending candidate is created, but no fact/entity is written until the owner accepts it through `/api/memory/candidates/:id/accept`. Rejection preserves the candidate and audit state without promoting it. |
| `agent.context_restricted` | the data-processing privacy policy (server/policy/data-processing-policy.js) withheld one or more facts from the context sent to a specific model provider for this request -- data(classification) x destination, separate from tool authorization. `data` includes `destination`, `providerId`, and the withheld fact ids/classifications/rules so the omission is auditable, never silent. |
| `user.feedback` | user accepted/rejected/edited a suggestion post-hoc (Phase 7 hook, schema reserved now) |

Derived/memory events (published by the memory projector after it updates entities/facts from a primary event — kept distinct from the primary event so consumers can tell "something happened externally" apart from "we changed what we believe"):

| Type | Meaning |
|---|---|
| `memory.fact_recorded` | a new fact was written |
| `memory.relationship_recorded` | a new relationship edge was written |
| `commitment.made` | the agent recognized a stated commitment ("I'll send the proposal") and created/linked a `Commitment` entity |

Not implemented until later phases (reserved names, do not repurpose): `document.created`, `document.changed`, `project.changed`, `purchase.completed`, `subscription.renewing`, `package.shipped`, `location.changed`, `message.received`.

## Subscribing

```js
eventBus.subscribe('calendar.*', handler);
eventBus.subscribe('agent.action.proposed', handler);
eventBus.subscribe('*', handler); // activity feed, SSE hub
```

## Replay

`GET /api/events?type=&since=&correlationId=&limit=` reads directly from the `events` table — the API never has a separate "history" store to keep in sync; it's the same log.

The SSE stream includes each event's durable id. Reconnecting clients send `Last-Event-ID`; the server replays later persisted events before resuming live delivery. Comment heartbeats keep otherwise-idle connections alive.
