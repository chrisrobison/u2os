# U2OS Dynamic Dashboards

Status: implemented for `morning`, `before-meeting`, and `project` contexts. Schemas are composed from live calendar/task/memory data and validated before delivery. All currently registered component primitives render bounded, inert data; unknown future types use the explicit placeholder fallback.

## Principle

The LLM never emits HTML/JS. It emits a JSON **dashboard schema**. The frontend renders that schema using a fixed set of trusted Web Components. This is a hard security boundary (PROMPT.md §10, §17), not a style choice.

## Navigation groups

The left navigation is grouped and collapsible ([#435](https://github.com/chrisrobison/u2os/issues/435)):

| Group | Routes | Starts |
|---|---|---|
| Today | Home, Briefing, Dashboards | open |
| Apps | Mail, Calendar, Tasks, Projects | open |
| Memory & automation | Memory, Routines, Goals, Applications, Automation, Activity | open |
| Add-ons | Packages | collapsed |
| Settings | Connectors, Model, Devices, Voice, Vault, Setup wizard | collapsed |
| System | Operations, Diagnostics | collapsed |

Each group heading is a button with `aria-expanded`, operable with Enter or Space. The owner's open/closed choices are remembered in the browser; storage is optional and the navigation works without it. The group holding the current route is always shown, so following a link or going back never lands on a hidden entry. Every entry has an icon ([#450](https://github.com/chrisrobison/u2os/issues/450)). The icons are [Font Awesome Free](https://fontawesome.com) 6.5.2 (solid), **shipped with U2OS** in `public/vendor/fontawesome/` rather than loaded from a CDN: the Content-Security-Policy allows only this origin, and a CDN would make every page view contact a third party. The licence (icons CC BY 4.0, font SIL OFL 1.1, code MIT) is alongside the font. `public/styles/icons.css` lists only the codepoints in use. To add an icon, add one `.u2-icon--name::before` rule with its codepoint and name it in `NAV_GROUPS`. Icons are decorative (`aria-hidden`); the text label is the link's name.

Groups are defined in one list (`NAV_GROUPS` in `u2-nav.js`) so add-ons can contribute entries later ([ADR 0010](adr/0010-lean-core-bundled-addons.md)).

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
- `components[].source` — a named, allowlisted data query resolved by `server/agent/dashboard-source-resolver.js` before the schema reaches the browser. Components never choose endpoints or execute data access.
- `components[].provenance` — required bounded explanation metadata: a concise `reason` and at most 10 `{ type, id, label? }` references to the exact source, entity, event, task, action, fact, relationship, or recommendation that caused the card to be included. Unknown fields are rejected.

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

## Data sections: list, record modal and `+`

Sections that hold records follow one pattern ([#434](https://github.com/chrisrobison/u2os/issues/434)), so every one behaves the same way:

- The section opens on its **list** (or a dashboard), never on a detail form.
- A **`+` button** in the section header opens the record dialog **empty**, to create.
- Selecting a **list item** opens the same dialog **populated**.
- Nothing is saved until the owner submits. Writes go through the same policy-gated pipeline as every other action, so a result of "needs approval" or "blocked" is shown in the dialog instead of closing it as if it worked.

The pieces are plain Web Components with no dependencies:

| Piece | Role |
|---|---|
| `u2-section` | Header with title, optional subtitle and the `+` button. Fires `u2-section-add`. |
| `u2-modal` | A native `<dialog>`: focus is trapped, `Escape` and the backdrop close it, closing with unsaved edits asks first, and focus returns to the control that opened it. |
| `record-form.js` | Builds a form from a field schema (`text`, `textarea`, `date`, `select`, `checkbox`) and validates it. Every control has a real label, and errors are announced next to the field. |
| `u2-task-list[selectable]` | Rows become buttons that fire `u2-task-select`. Without the attribute (dashboard cards) rows stay read-only. |

Tasks is the first section on the pattern: `+` creates a task, and a row opens it with a **Mark complete** action. Editing task fields, and the other sections (mail, calendar, projects, people), follow in their own issues under [#433](https://github.com/chrisrobison/u2os/issues/433).

A date-only field is stored as the end of that local day.

### Mail

Selecting a message in Mail ([#436](https://github.com/chrisrobison/u2os/issues/436)) opens it in the record dialog (From, To, Date, Subject, body). `GET /api/email/:id` reads the message from the local cache; the body is private content and is never logged.

**Replying** is a link, not a send. U2OS needs no send permission for it, and nothing leaves U2OS:

- Gmail messages open Gmail compose in a new tab (`https://mail.google.com/mail/?view=cm`) with the recipient, a `Re:` subject and the original quoted. `authuser` selects the account the message arrived in.
- Other accounts get a `mailto:` link.
- The recipient is the server's conservative parse of the From header. If the header is ambiguous there is no link and the dialog says so, rather than guessing a recipient.
- The quoted original is cut at 2000 characters so the link stays within what browsers and mail clients accept. Subject line breaks are removed, and every part is URL-encoded so message text cannot add recipients or parameters.

Marking spam and deleting need permission to change the mailbox and are tracked in [#446](https://github.com/chrisrobison/u2os/issues/446).

### Projects and people

Projects and People ([#438](https://github.com/chrisrobison/u2os/issues/438), [#439](https://github.com/chrisrobison/u2os/issues/439)) are lists of vault records. `+` creates a file, and a row opens the same dialog filled from **what the file says today** (the file is the authority, not the database copy).

- **Create** writes `projects/<name>.md` or `people/<name>.md` in your vault, never over an existing file (a taken name gets `-2`, `-3`...), then indexes it. The file name is a safe slug of the name.
- **Edit** changes only the fields you supplied, in one atomic write. Comments, other keys and your `classification`, `sensitive_keys`, `id` and `classifications` are left exactly as you wrote them; privacy cannot be changed from the dialog. A file that no longer parses, or that you saved while the dialog was open, is refused rather than overwritten.
- A record that exists **only in the database** (for example one imported from contacts) is listed with a "Database only" note and opens read-only, with a pointer to export your memory to the vault first.
- The owner is not listed as one of their own contacts.

| Record | Fields you can set |
|---|---|
| Project | name, status (`active`, `planned`, `blocked`, `paused`, `done`), deadline, notes |
| Person | name, relationship to you, organization, email, phone, birthday, keep in touch every N days, last contact, notes |

**Staying in touch.** Set *Keep in touch every* and *Last contact* and the People list shows how each person stands: "Next in 9 days", "Overdue by 4 days" (highlighted), or "No contact recorded" when a cadence has no last contact. Days are counted on the calendar, so daylight-saving changes cannot shift them. Search matches name, relationship, organization and email, ignoring case and accents.

The API is owner-only: `GET /api/vault/records?type=Person|Project` (file values, never notes), `GET`/`PATCH /api/vault/records/:id`, and `POST /api/vault/records`. Person-to-person relationships ("Alice is Bob's sister") are not part of the file format yet; see [#448](https://github.com/chrisrobison/u2os/issues/448).

**Tasks** can now be edited (title and due date), completed and reopened. Like memory and vault edits, these are the owner changing their own data, so `PATCH /api/tasks/:id` is applied directly and recorded as a `task.updated` event (without the new values) rather than going through the agent's action pipeline.

### Calendar views

The Calendar section ([#437](https://github.com/chrisrobison/u2os/issues/437)) has **List**, **Day**, **Week** and **Month** views. Day, week and month have previous, next and today controls, and the view you chose is remembered in the browser.

- All views read the local cache of the selected calendar. Day, week and month ask `GET /api/calendar/events?from=…&to=…` for the events overlapping `[from, to)` (at most 100 days; invalid or reversed ranges are a 400).
- Events appear on every day they touch, and an event ending exactly at midnight does not spill into the next day. Days are calendar days in your local time, so daylight-saving changes cannot move an event.
- The month view is a real table. Each day number opens that day, and a day with more than three events shows "+N more".
- The week starts on the day your browser's locale says (Sunday if it does not say).
- Selecting an event, in any view, opens its details in the record dialog. `+` opens a **New event** dialog. Creating an event is an action on your behalf: `POST /api/calendar/events` goes through the policy-gated pipeline, so depending on your `policies.yaml` it is created straight away or waits for your approval, and the dialog says which.
- Editing and rescheduling existing events, recurring events and drag-and-drop are not part of this.

## Live updates

Dashboard instances subscribe to the shared authenticated SSE event stream while they are connected. Task, calendar, email, action, recommendation, and memory events trigger a short debounced reload through the same server-side generator that produced the current view. Dynamic dashboards retain their selected context and entity parameters. Existing cards remain visible if a refresh fails, with an owner-readable inline error instead of replacing the dashboard.

## Current scope

`GET /api/dashboard/morning` remains the compatibility route. `POST /api/dashboard/generate` accepts `morning`, `before-meeting`, or `project` plus context parameters and composes the schema from live data. Meeting preparation normally receives an `eventId`: the selected calendar title is presented explicitly as the topic, and all named attendees that match active Person records receive their own bounded context cards. Unknown attendees remain visible in an honest warning and are never silently written to memory. Legacy `personId` callers remain supported, and `personIds` can prepare a bounded combined view when no calendar-event selection is available.

Every named `source` is registered exactly once in `server/agent/dashboard-source-resolver.js`. Resolution reads bounded local synchronized stores, and schema validation imports the same registry-derived allowlist so validation and executable resolution cannot drift. Context planners may filter those bounded results for a selected person or project, then embed the resulting inert data in the validated schema.

Every validated card also carries provenance. The dashboard renderer passes this data to the inline mode of the same trusted `<u2-why>` component used for action and recommendation explanations. It builds DOM nodes and assigns untrusted values with `textContent`; it never interprets provenance as HTML and never exposes model chain-of-thought. The planned `travel` context remains open roadmap work.

Recommendation dashboards saved before this contract was introduced are upgraded when read with a candid compatibility reason and a reference to their recommendation record. U2OS does not fabricate missing historical source references.

The morning dashboard includes today's schedule, priority tasks, up to five important unread emails, pending approvals, and up to five open recommendations. A fixed, trusted **Review my day** control starts the daily-review agent workflow; it is application UI rather than schema-supplied behavior, so a generated dashboard cannot introduce executable controls. The agent handles routine work under the existing policy and still asks before consequential actions.

Recommendation cards carry only a recommendation ID in the outer schema. The trusted `<u2-recommendation>` component fetches the persisted record, offers Keep/Dismiss controls, renders an attached prepared dashboard only when that dashboard passed the same server-side validator, and exposes a `<u2-why>` source trail.

## Server-side validation

`server/api/dashboard-schema.js` exports `validateDashboard(schema)`. It rejects unknown fields, unregistered layouts/types/sources, excessive component counts, oversized data, unsafe object keys, and excessive nesting. No dashboard schema reaches the HTTP response without passing this.
