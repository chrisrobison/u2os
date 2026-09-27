# Automation author guide

An automation is a durable, triggered workflow with persistent state: `job-hunter`, `inbox-triage`, `server-watchdog`. It is not an LLM loop. U2OS stores its progress as structured data after every step, so it survives restarts, waits for approvals and events, and never repeats an action it already proposed.

```yaml
# automations/job-hunter.yaml
id: job-hunter
name: Job Hunter
description: Weekday-morning search.
triggers:
  - type: schedule
    cron: "0 8 * * 1-5"
  - type: manual
  - type: event
    event: job.search.requested
    where: "event.data.query != null"
    with: { query: "{{ trigger.event.data.query }}" }
state:
  schema: { type: object, properties: { seen: { type: array, maxItems: 500 } } }
  initial: { seen: [] }
concurrency: single            # single (default) | parallel
workflow: workflows/daily-job-search.yaml   # or inline inputs/steps/output
```

Automations install **disabled**. Enabling requires the owner to have granted every permission the automation needs, including through skills.

## Triggers

| Type | Fields | Behaviour |
|---|---|---|
| `schedule` | `cron: "m h dom mon dow"` or `every: 1h` (≥ 1m) | Local server time. One run per scheduled slot, even across restarts. A slot missed by more than an hour (downtime) is recorded as a skipped run, not replayed. |
| `event` | `event: type`, optional `where` expression over `event` and `settings` | One run per matching event. Events published while U2OS was stopped are delivered once at start. |
| `manual` | — | Run on the owner's request (`automation run`, **Run now**). Always available, even when disabled; refused while paused. |
| `watch` | — | Reserved; rejected for now. |

Every trigger may have `with:`, a template over `trigger`, `event` and `settings` producing the run's `inputs` (merged over workflow input defaults). For schedule runs `trigger.slot` is the scheduled time.

Guards:

- An automation never triggers on events its own runs emitted.
- At most 60 runs per automation per rolling hour; further triggers are recorded as `throttled`.
- With `concurrency: single`, a trigger arriving while a run is active is recorded as `skipped` (`already_running`).

## State

`state.initial` is the automation's persistent state at install. `use: state` steps merge values into it; the result is validated against `state.schema`. State survives restarts, disables and uninstall/reinstall. Upgrades add keys that are new in `initial` and never remove existing ones. Read it in expressions as `state.<key>`.

## Workflow reference

```yaml
inputs:                      # optional: name -> schema (defaults applied)
  query: { type: string, default: engineers }
steps:
  - id: search               # unique step id
    use: capability:web.search
    with: { query: "{{ inputs.query }}" }
output: "{{ steps.search.output }}"   # optional; else the last completed step's output
```

### Step kinds

| `use:` | `with:` | Output |
|---|---|---|
| `capability:<id>` | the capability input | the capability output |
| `skill:<id>` | the skill input | the skill output |
| `transform` | `value` | the resolved value |
| `filter` | `source` (a list), `where` (expression over `item`) | matching items |
| `emit` | `type` (literal, declared in `events.emits`), optional `subject: {type, id}`, `data` | `{ eventId, type }` |
| `state` *(automation only)* | `set: { key: value }` | the new state |
| `sleep` *(automation only)* | `duration: 10m` (≤ 366d) or `until: <date>` | `{ sleptUntil }` |
| `wait` *(automation only)* | `event: type`, optional `where` (over `event`, `inputs`), optional `timeout` | the event `{id, type, timestamp, source, subject, data}`, or `{ timedOut: true }` |

### Step options

| Option | Meaning |
|---|---|
| `when: <expr>` | Skip the step (or foreach item) when false. Recorded as `skipped`; the step's output is `null`. |
| `foreach: "{{ list }}"` | Run once per item (≤ 500), with `item` and `index` in scope. Output is the list of item outputs; skipped items are left out, failed items (with `onError: continue`) are `null`. |
| `retry: { attempts: 1-5, backoff: 5s }` | Retry failures. Backoffs are durable timers. Not applied to consequential (write) capabilities, whose retries belong to the action queue, nor to input or permission errors. |
| `timeout: 30s` | Bounds read-capability calls (≤ 1h). |
| `policy: <name>` | Capability steps only: evaluate a package policy over `input`, `item`, `settings`, `state`, `inputs`. A `deny` skips the item and is audited. |
| `onError: continue` | Record the failure and carry on (`fail` is the default). |

Outcomes: a package-policy denial or an owner rejection **skips** the item; a missing permission or a `never` rule in `policies.yaml` **fails** the step, because that is a configuration problem the owner should see.

### Expressions and templates

`{{ expr }}` inside any string. A string that is exactly one expression yields the raw value (a list, a number); otherwise values are stringified. Conditions (`when`, `where`) are bare expressions.

Scope: `inputs`, `steps.<id>.output` (and `.status`), `item`, `index`, `settings`, `state`, `trigger`, `run.id`.

Operators: `== != < <= > >= && || ! and or not in "not in" + - * / % ? :`, literals, `[lists]`, `a.b`, `a[expr]`. Missing properties are `undefined`, never errors.

Functions: `len`, `lower`, `upper`, `contains` (case-insensitive for text), `startsWith`, `endsWith`, `min`, `max`, `abs`, `round`, `floor`, `ceil`, `coalesce`, `join`, `keys`, `concat`, `pluck`, `unique`, `slice`, `now`, `daysSince`.

There is no assignment, no method call, no access to `__proto__`, `constructor` or `prototype`, and no `eval`. Expressions are length-, depth- and work-limited.

## Durability

- A run is checkpointed after every step and every foreach item: position, step outputs, foreach progress and a wait handle.
- Before proposing an action, the run records the action's id. After a crash it reads that action's outcome instead of proposing again.
- Waiting runs hold a handle (action id, child run id, wake time, awaited event), not JavaScript state. Approvals, child completion, timers and events wake them.
- A run records the definition it started with, so an upgrade does not change a run in flight.
- `emit` is at-least-once: a crash between publishing and checkpointing can publish an event twice. Consumers should use `subject` ids to de-duplicate.

## Lifecycle and inspection

`npm run u2 -- automation list | enable | disable | pause | resume | run | stop | inspect <id>`, `automation run-detail <run-id>`, or `/api/automations/*` and the **Packages** view.

- **disable** stops new triggered runs; active runs continue.
- **pause** stops triggered runs and holds active runs where they are; **resume** continues them.
- **stop** cancels active runs and withdraws any approval they are waiting for.
- **inspect** shows triggers, next and last run, state, requirements, policy summaries and recent runs; **run-detail** shows every step and item with its status, policy decision, action id and error.

Events: `automation.started`, `automation.waiting`, `automation.completed`, `automation.failed` (identifiers and status only).
