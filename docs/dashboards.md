# U2OS Dynamic Dashboards

Status: implemented for `morning`, `before-meeting`, and `project` contexts. Schemas are composed from live calendar/task/memory data and validated before delivery. Several richer component types still render placeholders.

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
| `recommendation` | `<u2-recommendation>` | `recommendations.open` |

All reserved primitives are implemented. Person, project, conversation, and document cards consume bounded domain structures and render supplied text through DOM text nodes. Chart accepts up to four labeled finite-number series, map accepts bounded valid coordinates and uses a local CSS plot (no mapping SDK or tile requests), and photo-grid accepts only local media paths or bounded image data URLs. `<u2-agent-status>` exposes the agent's current observable state. No primitive accepts HTML, JavaScript, or arbitrary component code.

## Current scope

`GET /api/dashboard/morning` remains the compatibility route. `POST /api/dashboard/generate` accepts `morning`, `before-meeting`, or `project` plus context parameters and composes the schema from live data.

The morning dashboard also includes up to five open recommendations. Its outer schema carries only a recommendation ID. The trusted `<u2-recommendation>` component fetches the persisted record, offers Keep/Dismiss controls, renders an attached prepared dashboard only when that dashboard passed the same server-side validator, and exposes a `<u2-why>` source trail.

## Server-side validation

`server/api/dashboard-schema.js` exports `validateDashboard(schema)`. It rejects unknown fields, unregistered layouts/types/sources, excessive component counts, oversized data, unsafe object keys, and excessive nesting. No dashboard schema reaches the HTTP response without passing this.
