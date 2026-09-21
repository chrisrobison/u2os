# U2OS Dynamic Dashboards

Status: implemented for `morning`, `before-meeting`, and `project` contexts. Schemas are composed from live calendar/task/memory data and validated before delivery. All currently registered component primitives render bounded, inert data; unknown future types use the explicit placeholder fallback.

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

## Registered component types

| `type` | Web Component | Backing source(s) |
|---|---|---|
| `schedule` | `<u2-schedule>` | `calendar.today`, `calendar.upcoming` |
| `task-list` | `<u2-task-list>` | `tasks.priority`, `tasks.all` |
| `email-summary` | `<u2-email-summary>` | `email.important`, `email.unread` |
| `approval` | `<u2-approval>` | `actions.pending` |
| `activity` | `<u2-timeline>` | `events.recent` |
| `alert` | `<u2-alert>` | inline `data` (no source needed) |
| `recommendation` | `<u2-recommendation>` | `recommendations.open` |
| `person` | `<u2-person>` | bounded inline person data |
| `project` | `<u2-project>` | bounded inline project data |
| `conversation` | `<u2-conversation>` | bounded inline conversation data |
| `document` | `<u2-document>` | bounded inline document data |
| `chart` | `<u2-chart>` | bounded inline numeric series |
| `map` | `<u2-map>` | bounded inline coordinates; no external tiles |
| `photo-grid` | `<u2-photo-grid>` | local paths or bounded image data URLs |
| `agent-status` | `<u2-agent-status>` | bounded inline observable state |

All reserved primitives are implemented. Person, project, conversation, and document cards consume bounded domain structures and render supplied text through DOM text nodes. Chart accepts up to four labeled finite-number series, map accepts bounded valid coordinates and uses a local CSS plot (no mapping SDK or tile requests), and photo-grid accepts only local media paths or bounded image data URLs. `<u2-agent-status>` exposes the agent's current observable state. No primitive accepts HTML, JavaScript, or arbitrary component code.

## Live updates

Dashboard instances subscribe to the shared authenticated SSE event stream while they are connected. Task, calendar, email, action, recommendation, and memory events trigger a short debounced reload through the same server-side generator that produced the current view. Dynamic dashboards retain their selected context and entity parameters. Existing cards remain visible if a refresh fails, with an owner-readable inline error instead of replacing the dashboard.

## Current scope

`GET /api/dashboard/morning` remains the compatibility route. `POST /api/dashboard/generate` accepts `morning`, `before-meeting`, or `project` plus context parameters and composes the schema from live data.

The browser still resolves the compatibility schema's small allowlist of named `source` values through `services/api.js`. New generated rich cards use bounded inline data assembled by the server. A single documented server-side resolver for every named source, universal per-card provenance, and the planned `travel` context remain open roadmap work.

The morning dashboard also includes up to five open recommendations. Its outer schema carries only a recommendation ID. The trusted `<u2-recommendation>` component fetches the persisted record, offers Keep/Dismiss controls, renders an attached prepared dashboard only when that dashboard passed the same server-side validator, and exposes a `<u2-why>` source trail.

## Server-side validation

`server/api/dashboard-schema.js` exports `validateDashboard(schema)`. It rejects unknown fields, unregistered layouts/types/sources, excessive component counts, oversized data, unsafe object keys, and excessive nesting. No dashboard schema reaches the HTTP response without passing this.
