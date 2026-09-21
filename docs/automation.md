# U2OS Automation: Task/Trigger Engine (PROMPT.md §9) + Proactive Agent (Phase 6)

These two are built together because they're one mechanism: the trigger engine is the scheduler/rule-matcher that decides **when** to look at something; the proactive agent's event evaluation is what decides **what to do** once something's worth looking at. Neither is useful alone — PROMPT.md's own examples (`WHEN email.received IF sender==recruiter THEN notify owner`) are a single rule spanning both.

## Why this needs a real design doc

Everything so far in U2OS only acts when the user is actively talking to it. This is the subsystem that makes it "operate when the user is not actively interacting with it" (PROMPT.md §9's opening line) — genuinely new capability, not a refinement of something that already existed.

## Data model (`server/db/schema.sql` additions)

```sql
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,             -- 'timer' | 'schedule' | 'event_rule' | 'condition_watch'
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',   -- JSON, shape depends on `kind` -- see below
  last_fired_at TEXT,
  next_check_at TEXT,              -- for timer/schedule; NULL for event_rule/condition_watch
  lease_owner TEXT,
  lease_expires_at TEXT,
  source TEXT NOT NULL DEFAULT 'system',  -- 'system' (seeded) | 'user' (created via API)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_kind ON triggers(kind);
CREATE INDEX IF NOT EXISTS idx_triggers_due_lease ON triggers(enabled, kind, next_check_at, lease_expires_at);
```

`config` shapes:

- `timer`: `{ fireAt: <ISO> }` — fires once, then disables itself.
- `schedule`: `{ everyMinutes: N }` or `{ dailyAt: "HH:MM" }` — recurring.
- `event_rule`: `{ eventType: "email.received", when: { path: "data.from", equals: "..." } | { path, matches: <regex> }, action: <see Actions below> }` — matched against every published event, not polled.
- `condition_watch`: `{ check: "calendar_approaching" | "task_overdue" | "birthday_approaching", params: {...} }` — one of a small fixed set of built-in condition checks (not arbitrary user code — same "trusted primitives, not arbitrary execution" principle as the dashboard schema).

## Trigger Engine (`server/triggers/trigger-engine.js`)

Two halves:

1. **Event-driven** (`kind: 'event_rule'`): subscribes to the event bus (`eventBus.subscribe('*', ...)`) at startup, matches every incoming event against enabled `event_rule` triggers' `eventType`/`when` clause, and if matched, hands off to `runAction()`.
2. **Polled** (`kind: 'timer' | 'schedule' | 'condition_watch'`): a single `setInterval` tick (default every 60s, configurable) that finds triggers whose `next_check_at <= now`, evaluates them, runs `runAction()` for any that fire, and reschedules `next_check_at` (once-only for `timer`, recurring for `schedule`, and for `condition_watch` re-checks the built-in condition each tick — e.g. "is any calendar event now within 60 minutes and not already flagged" — publishing the relevant synthetic event, per below, only once per underlying object so it doesn't re-notify every tick).

Polled work is claimed with an atomic lease stored on the trigger row (`lease_owner`, `lease_expires_at`) before evaluation begins. A heartbeat renews ownership while the action is in flight; completion consumes or reschedules timer/schedule state and releases the lease, while condition watches release it after their scan. Competing ticks therefore cannot execute the same trigger concurrently. If a process exits, its persisted lease eventually expires and a replacement scheduler can recover the still-due work. The columns are added through an additive migration for existing installations.

Built-in `condition_watch` checks produce the previously-reserved synthetic events from `docs/events.md`:

- `calendar_approaching` → publishes `calendar.event_approaching` (`data: { eventId, minutesUntil }`) once per event crossing the configured lead time (default 60 min), tracked via a small `trigger_fired_log` table (`trigger_id, object_id, fired_at`, unique on `(trigger_id, object_id)`) so it never double-fires for the same event.
- `task_overdue` → publishes `task.overdue` for any open task whose `due_at` has passed, same dedupe mechanism.
- `birthday_approaching` → publishes `contact.birthday_approaching` for any Person entity with a `birthday`-keyed fact within N days, same dedupe mechanism (re-checked yearly by nature of the date comparison, dedupe key includes the year so it fires again next year).

`stopAll()`/`resetForTests()` mirror `sync-scheduler.js`'s existing hermetic-testing pattern — reuse that exact shape, don't invent a new one.

## Actions (what `runAction()` can do)

A fixed, small, trusted set — **never arbitrary code**, same principle as tools/dashboards:

```
notify        -> policy-gated notifications.send (through agent.evaluateAndMaybeExecute, so it's audited like everything else)
create_task   -> policy-gated tasks.create
evaluate      -> hand the triggering event to the proactive agent's evaluateEvent() (below) for a full ignore/remember/notify/.../act decision instead of a fixed action
```

`notify` here is specifically `notifications.send` (docs/tools.md), not the device-aware `presentation.notify` (docs/devices.md) -- the two are not yet connected. Routing a trigger's `notify` action through the resolver (so it could land on a specific trusted device instead of always the notifications connector) is a natural extension, not yet built.

Every trigger firing publishes its own `agent.action.completed`/`.failed`-shaped bookkeeping the same way tool executions do, so triggers show up in the activity feed like everything else — no silent background magic (PROMPT.md §14's explicit "never feel like it is mysteriously doing things behind the user's back" applies just as much to scheduled automation as to chat-driven actions).

## Proactive agent: `agent.evaluateEvent(event, context)`

This is the method sketched as an abstraction back in Phase 1's `model-provider.js` interface but never implemented — Phase 6 implements it for real (still backed by the deterministic mock model, same honesty rule as everywhere else: real pipeline, a clearly-labeled deterministic mock model behind it, not a real LLM call).

For each event it's asked to evaluate, it answers PROMPT.md's own checklist and returns one of:

```
ignore      -> no-op, nothing recorded beyond the original event already in the log
remember    -> write a fact/relationship via the memory store (provenance: 'agent:evaluateEvent', inferred: true), no user-facing action
notify      -> policy-gated notifications.send
recommend   -> policy-gated tool proposal at LEVEL 1 (surfaced in the UI as a suggestion, not auto-executed and not blocking on approval either -- a new, lighter-weight "recommendation" concept distinct from a pending approval; rendered as a dismissible card, feeds Phase 7's feedback loop when accepted/dismissed)
prepare     -> policy-gated draft-category tool call (e.g. email.draft) -- level 2, nothing sent
request_approval -> the existing pending-action flow (level 3, unchanged)
act         -> durable autonomous execution through the policy-gated queue (level 4 -- evaluateEvent choosing "act" does not bypass policy-engine.evaluate(), it only proposes an action; policy is checked when proposed and again immediately before the leased worker invokes the registered tool)
```

Wired to fire on the event types PROMPT.md explicitly lists as proactive-worthy: `email.received`, `calendar.event_approaching`, `task.overdue`, `calendar.event_changed` (conflict detection), `contact.birthday_approaching`, `subscription.renewing`, `message.received`, and `project.changed`. The current implementation covers `email.received` (recruiter-sender heuristic → `notify`), `calendar.event_approaching` (→ `prepare` with a before-meeting dashboard), `calendar.event_changed` (deterministic local overlap detection → `notify`), `contact.birthday_approaching` (active local Person resolution → `notify`), `subscription.renewing` (validated bounded renewal data → `notify`), `message.received` (explicit direct + high/urgent metadata with bounded display text → `notify`), `project.changed` (blocked status or deadline signal confirmed against active local Project state → `notify`), `task.overdue` (→ `notify`), and `commitment.made` (→ `act` through policy).

## Seed data

`server/seed/seed.js` gains a small set of demo triggers matching PROMPT.md's own worked examples verbatim, so the feature is visibly alive immediately after install, not just present in code:

```
WHEN email.received IF sender contains "recruiter"/"talent" THEN notify prominently
WHEN calendar.event_approaching AT 60 minutes before THEN prepare a briefing
WHEN commitment.made IF no task exists THEN create task
```

## What this explicitly does not do

- No arbitrary user-authored automation scripting language — triggers are structured data (`kind`/`config`), matched and executed by fixed, audited, policy-gated engine code, never `eval`'d or interpreted as code. This is the same "trusted primitives" boundary as tools and dashboards, applied to automation.
- Does not modify policy/security configuration based on trigger outcomes (explicitly forbidden, same as the existing Phase 7 feedback-loop rule).

## Owner interface

The **Automation** screen (`#/automation`) lists every system and user trigger with its kind, source, current state, schedule summary, and next check where applicable. Owners can pause or resume any trigger and expand a recent-run history. `GET /api/triggers/:id/history?limit=` derives that bounded history from the immutable event log and exposes only run id/time, completed-or-failed status, event/action kind, and correlation id; action results, arguments, and raw errors are deliberately omitted. The constrained creation form supports one-time timers and recurring minute schedules; it sends only structured `kind` and `config` data to the existing validated trigger API. User-created triggers can also be deleted after confirmation. Seeded system triggers deliberately have no delete control so the built-in proactive behaviors remain recoverable, although they can be paused.

Event-rule and condition-watch authoring remain API-only because their richer action and matching configuration needs a purpose-built safe editor. Pause/resume, persisted next-run display, and bounded execution history are implemented; manual dry runs remain milestone-5 work.

## Security note: `when.matches` is a ReDoS surface, and is validated accordingly

`event_rule` triggers' `config.when.matches` becomes a live `RegExp` tested against every matching event, inline inside the event bus's synchronous dispatch loop (`matchesWhen()` in `server/triggers/trigger-engine.js`). A security review caught this as exploitable: a catastrophic-backtracking pattern (e.g. `^(a+)+$`) accepted with no validation could hang the entire single-threaded server for every user via one `POST /api/triggers` plus any subsequent ordinary event — verified live, 20+ seconds of hang from a 39-character input.

Fixed in `server/triggers/regex-safety.js`, enforced at the HTTP boundary (`server/api/routes/triggers.js`'s `POST`/`PATCH /api/triggers`), before a pattern ever reaches storage:

1. Length cap (200 chars).
2. A fast heuristic reject for the textbook nested-quantifier shape (`(a+)+`, `(a*)*`, ...).
3. A real timed probe: the pattern is tested against a couple of adversarial strings inside a disposable `Worker` thread with a hard timeout, forcibly terminated if it doesn't finish in time. This is the actual guarantee (the heuristic above is just a cheap fast-path; plenty of unsafe patterns, like ambiguous alternation `(a|a)+`, don't match it but are still caught by the timed probe). A `vm.Script` timeout was deliberately not used instead — V8's regex backtracking isn't reliably interruptible via `vm`'s interrupt checks, so that approach could itself hang.

This validation runs once, at creation/update time — never on the hot per-event path, so it can afford to cost a few milliseconds without affecting event throughput. As defense-in-depth, `matchesWhen()` also caps the length of the value it tests against (2000 chars) and each trigger's `when` evaluation is now individually wrapped so one bad/stale pattern can't stop other enabled triggers from being checked against the same event.

The same review also found `schedule` triggers had no minimum `everyMinutes`, letting an external caller create a tight-loop trigger that would spam a notification/task on every tick forever — fixed with a floor (1 minute) enforced at the same HTTP boundary (internal/test callers that construct a `schedule` trigger directly, bypassing the route, are unaffected — see `tests/trigger-engine.test.js`'s sub-minute stress test, which is intentionally exempt since it's not attacker-reachable input).
