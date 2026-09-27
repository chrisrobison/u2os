# Plugin architecture: capabilities, skills and automations

U2OS grows through **packages**: installable directories that contribute **capabilities**, **skills** and **automations**. Packages compose like Lego blocks. An automation depends on skills, skills are built from capabilities, and capabilities are implemented by providers. Every invocation that leaves a package passes permission checks, deterministic policy and the existing action gate, and lands in the same audit trail as everything else U2OS does ([ADR 0008](adr/0008-packages-capabilities-skills-automations.md)).

This document starts with the Phase 1 assessment of the existing runtime (what already exists and how the new concepts map onto it), then specifies the design as implemented. Author-facing guides: [packages](packages/README.md), [capabilities](packages/capabilities.md), [skills](packages/skills.md), [automations](packages/automations.md) and [security notes](packages/security.md). The [reference Job Hunter package](../packages/job-hunter/README.md) is a tested walkthrough.

## 1. Assessment of the existing architecture

### What exists

| Area | Existing implementation | Notes |
|---|---|---|
| Daemon/runtime | `server/index.js` starts one Node process: HTTP API, SSE, device WebSocket bus, and background workers (action queue tick, trigger engine, routine runner, sync scheduler, vault watcher, journal). `runtime/home-guard.js` ensures one runtime per `U2OS_HOME`. | Single machine, no external infrastructure. |
| Storage | SQLite via `node:sqlite` (`server/db/connection.js`, `schema.sql`). Idempotent DDL plus additive `ensureColumn` migrations. | Must stay additive; never delete owner data. |
| Events | `server/events/event-bus.js`: synchronous in-process pub/sub, every event persisted append-only in `events` with `{id,type,timestamp,source,actor,subject,data,metadata,correlationId,causationId}` ([events](events.md)). | Already the envelope the new design needs. |
| Tools | `server/tools/*`: `Tool` classes with `name` (`email.send`), `domain`, `category` (`read`/`draft`/`consequential`), JSON schema, `execute(args, context)`. `ToolRegistry` is in-memory and code-defined. Only the agent orchestrator calls tools. | These **are** capabilities in all but name. |
| Providers | `server/integrations/provider-registry.js` resolves a domain (`email`, `calendar`, `web`, …) to a connected provider (Gmail, IMAP/SMTP, Google Calendar, Brave, webhook), configured by the owner in `connectors.yaml`, with multiple connection instances. `skills/*/manifest.json` describe connectors (`provides: ["email.send"]`, auth, scopes). | Already "one capability, many providers, user-configured". The directory is called `skills/` but holds connector manifests. |
| Policy | `server/policy/policy-engine.js`: per `domain.operation` autonomy level (`always`/`autonomous`/`confirm`/`never`) from home and vault `policies.yaml`; sub-category only from server-derived context; invalid vault policy fails closed. Additive tightening gates: voice (`voice/authorize.js`), goal scope, account binding. | Deterministic, outside the model. Keep it as the ceiling. |
| Action gate | `Agent.evaluateAndMaybeExecute()` is the single gate: evaluate → audit row in `agent_actions` → blocked / pending approval / enqueue in `action_queue` → `ActionQueueWorker` re-evaluates policy at execution time, leases, retries idempotently, records uncertain outcomes. | Must remain the only path to side effects. |
| Audit | `agent_actions` (requested_by, tool, arguments, policy rule, autonomy level, status, approval, result, correlation, provenance) plus `events` and the vault journal. | The audit trail to extend, not replace. |
| Scheduler/triggers | `server/triggers/trigger-engine.js`: persisted `triggers` (timer/schedule/event_rule/condition_watch) with leases and a fixed action set (notify, create_task, evaluate, goal wakes). | Durable, leased, but not extensible by packages. |
| Routines | `server/routines/`: owner-written vault Markdown with `when:` (daily/every/event) and a natural-language instruction executed as an ordinary **LLM-planned** agent run; slots claimed in `routine_runs`. | Owner-authored intent, not deterministic workflows. |
| Agent loop | `server/agent/agent.js`: ContextAssembler → Planner (model) → plan validation → gate. Runs persisted in `agent_runs`/`agent_run_steps`, resumable after approvals. | The planner sees `ToolRegistry.list()`. |
| Devices | `server/devices/`: `CapabilityRegistry` of device capabilities (`image.capture`, `speech.say`), device registry, deterministic resolver, adapters. | A second, device-specific use of the word "capability". |
| Configuration | `U2OS_HOME/config/*.json|yaml`, vault files, `connectors.yaml`. | Package settings must live in user state, not package files. |
| Secrets | `server/security/vault.js`: AES-encrypted files under `U2OS_HOME/credentials/`, keyed by name, master key at 0700. | Reuse for package secrets. |
| CLI | npm scripts that run small `*-cli.js` entrypoints wrapped in `withOfflineHome()` (refuse to run while the runtime owns the home); the running system is changed through the owner-only API instead. | Follow this: offline CLI plus live API. |
| UI | No-build Web Components under `public/components`, hash routes in `u2-app.js`/`u2-nav.js`, a thin `services/api.js` client, owner-only API with CSRF. | Add a Packages view in the same style. |

### Conflicts with the proposed model

1. **"Skill" already means connector.** `skills/*/manifest.json` and `integrations/skill-manifests.js` describe connectors. In this design they are **provider manifests**: they declare which capability contracts a connector implements. The directory keeps its name for compatibility; the capability registry reads it to list providers.
2. **"Capability" already means device capability.** `server/devices/capability-registry.js` is the device vocabulary resolved against devices. The package-level registry lives in `server/packages/` and is documented as the general contract registry; a device capability can later be exposed as a provider of a package capability. They are not merged in this work.
3. **Tools vs capabilities.** A capability contract with typed input/output, permissions, version and providers is a formalization of `Tool`. Every core tool is registered as a core capability with the same id (`web.search`, `email.send`). No tool is renamed.
4. **Routines vs automations.** Routines are owner-written natural-language instructions planned by a model; automations are package-defined deterministic workflows. Both remain. An automation never needs a model unless a step calls an LLM capability.
5. **Trigger engine vs automation triggers.** The trigger engine's fixed actions stay. Automations use their own trigger providers (schedule, event, manual) over the same event bus and the same lease-and-claim durability pattern. Moving system triggers onto automations is future work.
6. **The planner must not see package capabilities.** They are registered in the `ToolRegistry` so the gate, approval flow and queue can execute them, but they are hidden from `list()` and refused by plan validation. Package code cannot be invoked by the model.

### Recommended mapping

| New concept | Maps onto |
|---|---|
| Capability contract | `Tool` (core) or package capability definition, registered in `CapabilityRegistry` |
| Capability provider | Core tool + `provider-registry` connector (`gmail`, `imap`), or a package implementation (`fixture`, `static`, `module`) |
| Capability invocation | `Agent.evaluateAndMaybeExecute()` with a new additive **package authority** overlay |
| Permission check | New: declared package permissions ∩ owner grants, enforced in the invoker and re-checked by the queue worker |
| Package policy | New: deterministic conditions over structured facts; can only tighten the `policies.yaml` decision |
| Audit | `agent_actions`, plus a `package_context` column naming package, automation, run, step, permission and policy decision |
| Events | `EventBus` envelope unchanged; packages emit declared, non-reserved types with `source: package:<id>` |
| Automation durability | New `workflow_runs`/`workflow_steps` tables, leased like `triggers` and `action_queue` |
| Settings / secrets | New `package_settings` table; secrets through `security/vault.js` |
| CLI | `npm run u2 -- <noun> <verb>` offline entrypoint, plus `/api/packages/*` |
| UI | New `u2-packages` component and `#/packages` route |

## 2. Terminology

- **Package** (`package:com.u2os.job-hunter`): an installable, versioned directory with a `u2os.yaml` manifest. Its identity is the reverse-DNS id, never a path.
- **Capability** (`capability:web.search`): the lowest-level primitive action. A versioned contract (input/output schemas, effect, required permissions) with one or more providers. Stateless.
- **Provider**: an implementation of a capability contract: a core tool backed by a connector, or a package implementation.
- **Skill** (`skill:company-research`): short-lived reusable behaviour composed of capabilities and other skills, with typed input and output. Declarative workflow by default; code-backed as an escape hatch.
- **Automation** (`automation:job-hunter`): a durable, stateful workflow started by triggers, able to wait, sleep, retry, persist state and survive restarts.
- **Permission**: what a package may do at all (`email.send`, `network`). Declared by the package, granted by the owner.
- **Policy**: whether a specific action may happen automatically, decided by deterministic code over structured facts.

## 3. Architecture

```text
            ┌──────────────── triggers: schedule · event · manual ────────────────┐
            ▼                                                                       │
   Automation (durable workflow run, persistent state)                         EventBus
            │ steps: capability · skill · filter · transform · emit · state · sleep · wait
            ▼                                                                       ▲
   Skill (declarative workflow or trusted module) ──► may call other skills         │ emit
            │                                                                       │
            ▼                                                                       │
   CapabilityInvoker ── input schema ── permission check (declared ∩ granted) ──────┤
            │               package policy decision (automatic · approval · deny)   │
            ▼                                                                       │
   Agent.evaluateAndMaybeExecute  ◄── the one existing gate                         │
     policies.yaml ceiling → agent_actions audit → pending approval / action_queue  │
            │                                                                       │
            ▼                                                                       │
   Provider: core tool → provider-registry connector │ package fixture/static/module ─┘
```

Dependency direction is strictly downward. A skill never reaches a provider except through the invoker, and nothing below the invoker knows which package asked.

## 4. Package format

```text
packages/job-hunter/
  u2os.yaml            manifest (required)
  README.md
  capabilities/*.yaml  capability definitions and their implementation
  skills/*.yaml        skill definitions
  automations/*.yaml   automation definitions
  workflows/*.yaml     workflows referenced by skills/automations
  fixtures/*.json      static data for fixture capabilities
  schemas/ prompts/ policies/ migrations/ ui/ src/ tests/
```

Only `u2os.yaml` is required. Every path referenced by the manifest is relative, must resolve inside the package directory, and must not be or pass through a symlink. Files are limited to 256 KiB each, and packages to 1,000 files and 10 MiB.

## 5. Manifest schema (`apiVersion: u2os/v1`)

```yaml
apiVersion: u2os/v1
kind: Package
metadata:
  id: com.u2os.job-hunter          # reverse-DNS, lowercase
  name: Job Hunter
  version: 0.1.0                   # semver
  description: Job discovery, scoring and research.
requires:
  u2os: ">=0.1.0"
  capabilities:                    # list, or map of id -> semver range
    web.search: ">=1.0"
  skills:
    company-research: "^1.0"
exports:
  capabilities: [{ id: mock.job-search, file: capabilities/mock-job-search.yaml }]
  skills:       [{ id: score-job, file: skills/score-job.yaml }]
  automations:  [{ id: job-hunter, entrypoint: automations/job-hunter.yaml }]
permissions:
  network: true
  email: { read: true, send: true }
  filesystem: { read: [profile.resume], write: [jobs.*] }
policies:
  autoApply:
    description: Apply only to strong, well-paid matches.
    all: ["job.score >= settings.autoApplyThreshold", "job.salary >= settings.minimumSalary"]
    approval: automatic            # automatic | required | never
settings:
  autoApplyThreshold: { type: number, default: 85, minimum: 0, maximum: 100 }
secrets: [linkedin.session]        # names only, never values
events:
  emits: [job.candidate]
ui:
  dashboard: ui/dashboard.html     # recorded, not served, in v1
```

Validation is strict: unknown top-level keys, wrong types, invalid ids, unsafe paths, undeclared emitted events and reserved event domains are rejected with every error listed.

## 6. Permissions and delegated authority

Permissions are declared in the manifest and normalized to flat strings:

| Manifest | Permission |
|---|---|
| `network: true` | `network` |
| `email: {read, draft, send}` | `email.read`, `email.draft`, `email.send` |
| `calendar: {read, write}` | `calendar.read`, `calendar.write` |
| `contacts: {read}` · `tasks: {read, write}` · `notifications: {send}` | `contacts.read` · `tasks.read`, `tasks.write` · `notifications.send` |
| `browser: {navigate, submitForms}` | `browser.navigate`, `browser.submit_forms` |
| `filesystem: {read: [scope], write: [scope]}` | `filesystem.read:<scope>`, `filesystem.write:<scope>` |
| `microphone`, `camera`, `location`, `shell: {execute}`, `devices: {control}`, `payments: {spend}` | same names |
| `code: {execute: true}` | `code.execute` (required for `module` implementations) |

Each capability declares the permissions it requires; core capabilities map from their tool (for example `email.send` → `email.send`, `web.search` → `network`). A package-originated invocation is allowed only when **every** required permission is declared by the calling package **and** granted by the owner. Installing grants nothing; the owner grants after review (`--grant-all` or per permission). Denials are blocked and audited.

**Policy** is separate. A package policy is a set of deterministic conditions (`all`, `any`, `require`) over structured facts (`item`, `input`, `settings`, `state`, `inputs`) plus an approval mode. A step that names `policy:` is evaluated before invocation:

| Conditions | `approval` | Decision |
|---|---|---|
| not met | any | `deny` (step item skipped and audited) |
| met | `automatic` | `automatic`: `policies.yaml` decides |
| met | `required` | `approval`: forces owner approval |
| met | `never` | `deny` |

The owner may override a policy's `approval` in package settings. A package policy can only **tighten** the effective decision: `policies.yaml` is always the ceiling (`confirm` stays `confirm`, `never` stays blocked), exactly like the voice gate. A model may produce facts (a score), but code evaluates the conditions and the gate decides.

## 7. Execution model

### Capabilities

`CapabilityInvoker.invoke(id, input, context)`:

1. Resolve the contract and the selected provider (owner selection, else core, else first registered).
2. Validate input against `inputSchema` (JSON Schema subset: type, properties, required, items, enum, const, min/max, length, pattern, additionalProperties).
3. Compute the permission decision and the package policy decision.
4. Call `Agent.evaluateAndMaybeExecute()` with the package authority overlay. The gate audits, applies `policies.yaml`, and either blocks, parks for approval, or enqueues and executes through the durable queue.
5. Validate the output against `outputSchema` when one is declared.

Package capabilities are registered as hidden tools so the queue worker can execute them after approval; the worker re-checks the package is still enabled and the grant still held.

Implementation kinds for package capabilities:

- `fixture`: returns JSON from a package file, optionally filtered. Deterministic, no code.
- `static`: returns an interpolated template of the input. No code.
- `module`: an ES module export from `src/`. Requires the `code.execute` permission to be granted. It runs in-process with the runtime's privileges; it receives only its input and a narrow context (`invoke`, `settings`, `getSecret` for declared names). Install only trusted code packages. Isolation (worker threads, Node's permission model) is future work.

### Workflows

A workflow is a list of steps executed sequentially:

```yaml
inputs: { query: { type: string, default: "staff engineer" } }
steps:
  - id: discover
    use: capability:mock.job-search
    with: { query: "{{ inputs.query }}" }
    retry: { attempts: 3, backoff: 2s }
    timeout: 30s
  - id: score
    foreach: "{{ steps.discover.output.jobs }}"
    use: skill:score-job
    with: { job: "{{ item }}" }
  - id: strong
    use: filter
    with: { source: "{{ steps.score.output }}", where: "item.score >= settings.threshold" }
  - id: announce
    foreach: "{{ steps.strong.output }}"
    use: emit
    with: { type: job.candidate, data: { title: "{{ item.title }}" } }
output: "{{ steps.strong.output }}"
```

Step kinds (`use:`): `capability:<id>`, `skill:<id>`, `transform` (`value`), `filter` (`source`, `where`), `emit` (`type`, `subject`, `data`), and, in automations only, `state` (`set`), `sleep` (`duration` or `until`) and `wait` (`event`, `where`, `timeout`). Step options: `when`, `foreach`, `retry` (attempts ≤ 5, backoff), `timeout`, `policy`, `onError: fail | continue`.

Interpolation: `{{ expr }}` inside strings. A string that is exactly one expression yields the raw value; otherwise values are stringified. Scope: `inputs`, `steps.<id>.output`, `item`, `index`, `settings`, `state`, `trigger`, `run`.

Expressions are parsed by a small recursive-descent parser and interpreted over plain data. There is no `eval`, no `Function`, no property access to `__proto__`/`constructor`/`prototype`, no method calls, and only whitelisted pure functions (`len`, `lower`, `upper`, `contains`, `startsWith`, `endsWith`, `min`, `max`, `abs`, `round`, `floor`, `ceil`, `coalesce`, `join`, `keys`, `concat`, `pluck`, `unique`, `slice`, `now`, `daysSince`). Operators: `== != < <= > >= && || ! and or not in + - * / % ?:`. Expressions are length-, depth- and work-limited.

Retries apply to non-consequential failures; consequential capabilities are never re-proposed by the workflow because the action queue owns their retries and uncertain outcomes. Timeouts bound read-capability calls.

Outcomes: a package-policy denial or an owner rejection skips the item (audited, run continues); a missing permission, a `never` rule in `policies.yaml` or an invalid input fails the step (`onError: continue` records it and carries on).

**Principal rule.** Capability calls act with the grants of the package whose automation (or top-level skill run) started the work, never with the grants of a composed skill's own package. Otherwise an automation could borrow another package's permissions by calling its skill. Installation therefore checks that a package declares every permission needed by the capabilities it uses, transitively through skills. Settings and policies inside a skill remain the skill package's own.

## 8. Persistence model

| Table | Holds |
|---|---|
| `packages` | id, version, name, description, source, install path, manifest (JSON), enabled, status, timestamps |
| `package_grants` | owner-granted permissions per package |
| `package_settings` | owner values for settings and policy overrides |
| `capability_provider_selection` | owner's chosen provider per capability |
| `automation_instances` | per automation: enabled, paused, status, persistent `state`, `next_run_at`, last run/result |
| `workflow_runs` | automation and skill runs: kind, definition snapshot, defining and principal package, trigger, status, inputs, outputs, position (step, iteration, foreach items and results, wait handle), context (step outputs), wait condition, `wake_at`, lease, dedupe key, root and parent run, depth |
| `workflow_steps` | per step/iteration record: status, attempts, output, error, linked `agent_actions` id or child run |
| `automation_event_cursor` | last event row processed, so events published while stopped are caught up once |

`AutomationDefinition` and skill/capability definitions are in-memory registry entries rebuilt from installed package files. `Trigger` and `ScheduledTask` are the automation's trigger list plus `automation_instances.next_run_at`, and `workflow_runs.wake_at` for sleeps and wait timeouts. `Event` is the existing `events` table.

Runs are checkpointed after every step and every foreach item. Waiting records a structured handle (action id, child run id, wake time, awaited event), never JavaScript state. On restart, runs left `running` return to `pending` and resume at their checkpoint; a step that had already proposed an action re-reads that action's outcome instead of proposing again.

## 9. Durable automations

- **Triggers** are pluggable providers with `validate(config)`, and either `nextRun(config, from)` (schedule: 5-field cron or `every: 1h`) or `matches(config, event)` (event type plus an optional `where` expression). `manual` is always available. `watch` is reserved.
- **Dedupe**: each run has a unique key (`schedule:<instance>:<slot>`, `event:<instance>:<eventId>`), so duplicate delivery and catch-up never start a second run.
- **Recursion guard**: an automation never triggers on events its own runs emitted; at most 60 runs per automation per hour.
- **Concurrency**: `single` (default) records a new trigger as `skipped` while a run is active; `parallel` allows overlap.
- **Waiting**: runs wait for owner approval of a proposed action, child skill runs, timers, or events, and resume from the tick or the event that satisfies them.
- **Lifecycle**: install (disabled), enable (requires the grants its capabilities need), pause/resume, disable, run now, stop (cancel active runs), inspect, uninstall.
- Events: `automation.started`, `automation.waiting`, `automation.completed`, `automation.failed`, plus `package.installed`, `package.upgraded`, `package.uninstalled`, `package.enabled`, `package.disabled`, `package.permissions_changed`. They carry identifiers and status only.

## 10. Security model

- Installed packages are untrusted input. Manifests, workflows and definitions are validated strictly; YAML is parsed with the core schema; sizes are bounded.
- No install-time code. Installation copies validated files into `U2OS_HOME/packages/<id>/<version>/` and registers definitions. Archives are listed and checked (no absolute paths, `..`, links or devices) before extraction; git sources are cloned shallowly without hooks.
- No `eval`. Expressions are interpreted data.
- Permissions are enforced at the capability boundary in the runtime and re-checked at execution time by the queue worker. The UI is never the boundary.
- `policies.yaml` remains the ceiling; package policies only tighten.
- Package identity (`actor: {type: 'package'}`, `requested_by: package:<id>`) is distinct from the owner.
- Packages may only emit declared event types outside reserved core domains (`agent`, `action`, `run`, `vault`, `routine`, `automation`, `package`, `capability`, `device`, `email`, `calendar`, `contact`, `task`, `memory`, `notification`, …), always with `source: package:<id>`.
- Secrets are referenced by declared name and stored encrypted by `security/vault.js`; manifests carry no values.
- Package-level events and logs carry identifiers and statuses, never message bodies or secrets. Step inputs and outputs are persisted in the database to make runs resumable, like `agent_actions` arguments and results.

## 11. Audit

Every capability invocation made by a package produces an `agent_actions` row (the existing audit table) with `requested_by = package:<id>`, the tool, arguments, `policies.yaml` rule, status and result, and a `package_context` JSON column:

```json
{ "package": "com.u2os.job-hunter", "automation": "job-hunter", "skill": null, "run": "wfr_…", "rootRun": "wfr_…",
  "step": "notify", "capability": "mock.email-send", "provider": "com.u2os.job-hunter",
  "permission": { "allowed": true, "required": ["notifications.send"], "missingDeclared": [], "missingGrant": [] },
  "policy": { "name": "notifyCandidate", "decision": "approval", "reasons": ["approval: required"] } }
```

Permission and policy denials are recorded as `blocked` rows, so the trail answers what was done, why, by which automation, under which policy, with which input, and what happened next (the linked queue attempts and `agent.action.*` events). `GET /api/packages/audit` lists these rows.

## 12. Lifecycle

| Operation | CLI (offline) | API (live, owner-only) |
|---|---|---|
| Install | `npm run u2 -- package install <dir\|archive\|git+url> [--grant-all]` | `POST /api/packages/install` |
| Uninstall | `npm run u2 -- package uninstall <id>` | `DELETE /api/packages/:id` |
| List | `npm run u2 -- package list` | `GET /api/packages` |
| Grant/revoke | `npm run u2 -- package grant <id> <perm…\|--all>` | `POST /api/packages/:id/grants` |
| Enable/disable package | `npm run u2 -- package enable <id>` | `POST /api/packages/:id/enable` |
| Settings | `npm run u2 -- package config <id> key=value` | `PUT /api/packages/:id/settings` |
| Capabilities / skills | `npm run u2 -- capability list`, `skill list` | `GET /api/packages/capabilities`, `GET /api/packages/skills` (device capabilities keep `/api/capabilities`) |
| Automations | `npm run u2 -- automation list\|enable\|disable\|pause\|resume\|run\|stop\|inspect <id>` | `/api/automations/*` |

Installation: read manifest → validate → check `u2os` compatibility → resolve dependencies against installed and exported definitions → report requested permissions → copy files → merge additive state migrations → register capabilities, skills and automations → leave automations disabled.

Uninstalling refuses while another installed package depends on its exports, cancels its active runs, removes its files and registrations, and keeps run history, audit rows and automation state in the database.

## 13. Implementation status

Tracked in [#376](https://github.com/chrisrobison/u2os/issues/376); each phase landed as its own PR:

| Phase | Where |
|---|---|
| 1. Assessment and ADR 0008 | this document, [ADR 0008](adr/0008-packages-capabilities-skills-automations.md) |
| 2. Types and schemas | `server/packages/{manifest,json-schema,semver,expression,permissions,policy,events,workflow,cron,triggers,ids,types}.js` |
| 3. Registries | `capability-registry.js`, `registries.js`, `dependencies.js`, `core-capabilities.js` |
| 4-5. Invocation, permissions, policy, audit | `invoker.js`, `authority.js`, `providers.js`, `store.js`, `secrets.js`; gate overlay in `server/agent/agent.js`; queue re-check in `action-queue-worker.js`; hidden tools in `tools/registry.js` and `plan-validator.js` |
| 4. Workflow engine | `workflow-engine.js`, `workflow-store.js` |
| 6. Durable automations | `automation-runtime.js` |
| 7. Loader and lifecycle | `loader.js`, `manager.js`, `platform.js`, wired in `server/index.js` |
| 8. CLI, API, UI | `cli.js` (`npm run u2`), `server/api/routes/packages.js`, `public/components/u2-packages.js` (`#/packages`) |
| 9. Reference package | [`packages/job-hunter/`](../packages/job-hunter/README.md) |
| 10. Guides | [`docs/packages/`](packages/README.md) |

### Known limitations

- `module` code runs in-process without isolation; it is gated by an explicit `code.execute` grant.
- No `llm.*`, `browser.*` or `filesystem.*` capabilities yet; packages cannot provide alternative implementations of core capabilities.
- `watch` triggers, network host allow-lists, package signing, a registry, and serving package `ui.dashboard` files are not implemented.
- Recovery quarantine does not yet count automation work; restored homes are not executable, so no automation runs there.
- `emit` is at-least-once across a crash between publishing and checkpointing.
