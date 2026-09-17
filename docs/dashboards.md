# U2OS Dynamic Dashboards

Status: schema defined in Phase 1 groundwork; full dynamic generation (agent composing arbitrary layouts from context) is Phase 2. This document specifies the contract so Phase 1's static "morning" dashboard and Phase 2's generator emit the same shape.

## Principle

The LLM never emits HTML/JS. It emits a JSON **dashboard schema**. The frontend renders that schema using a fixed set of trusted Web Components. This is a hard security boundary (PROMPT.md §10, §17), not a style choice.

## Schema

```json
{
  "title": "Morning Briefing",
  "layout": "dashboard",
  "components": [
    { "type": "schedule", "source": "calendar.today" },
    { "type": "task-list", "source": "tasks.priority" },
    { "type": "email-summary", "source": "email.important" }
  ]
}
```

- `title` — string, shown as the workspace header.
- `layout` — `"dashboard"` (grid of cards) in Phase 1; more layouts later.
- `components[].type` — must be one of the registered component types below. Unknown types are rejected server-side before the schema is ever sent to the client (allowlist, not blocklist).
- `components[].source` — a named data query the frontend resolves via `services/api.js` (e.g. `calendar.today` → `GET /api/calendar/events?range=today`). Sources are also an allowlist resolved server-side.

## Registered component types (Phase 1 subset)

| `type` | Web Component | Backing source(s) |
|---|---|---|
| `schedule` | `<u2-schedule>` | `calendar.today`, `calendar.upcoming` |
| `task-list` | `<u2-task-list>` | `tasks.priority`, `tasks.all` |
| `email-summary` | `<u2-email-summary>` | `email.important`, `email.unread` |
| `approval` | `<u2-approval>` | `actions.pending` |
| `activity` | `<u2-timeline>` | `events.recent` |
| `alert` | `<u2-alert>` | inline `data` (no source needed) |

(`<u2-person>`, `<u2-project>`, `<u2-photo-grid>`, `<u2-document>`, `<u2-map>`, `<u2-chart>`, `<u2-conversation>`, `<u2-agent-status>` are reserved component names for Phase 2+ dashboards — e.g. "before a meeting" and "project work" briefings — and are not required to render anything in Phase 1 beyond a placeholder.)

## Phase 1 scope

`GET /api/dashboard/morning` returns a static instance of this schema (still going through the same validator Phase 2's generator will use) populated from live data: today's calendar, priority tasks, and the pending-approvals list — enough to prove the render pipeline end to end before the agent generates layouts dynamically.

## Server-side validation

`server/api/dashboard-schema.js` exports `validateDashboard(schema)` which throws if `layout`, any `components[].type`, or any `components[].source` falls outside the allowlists above. No dashboard schema reaches the HTTP response without passing this.
