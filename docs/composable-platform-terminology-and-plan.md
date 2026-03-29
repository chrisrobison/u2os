# Composable Platform Terminology + Implementation Plan

Generated: 2026-03-14

## Goal

Evolve U2OS from vertical-specific capability packages into a composable platform where:

- shared building blocks are reused across domains,
- modules/processes stay declarative,
- each client can customize safely in isolation under `./clients/<client-id>/`.

---

## Canonical Terminology

### 1) Module
Top-level business area that maps loosely to a department/domain.

Examples: `Sales`, `Support`, `Finance`, `HR`, `Operations`.

**Module responsibilities**
- Owns a cohesive set of related workflows.
- Defines navigation grouping and default visibility.
- Contains one or more Processes.

### 2) Process
A concrete workflow/action within a Module.

Examples: `Create Invoice`, `Support Inbox`, `Schedule Appointment`, `Run Payroll`.

**Process contract**
- metadata: id, title, icon, description
- routing: template URL or template ID
- data bootstrap: process-scoped data source definition
- access: role/capability requirements

### 3) Template
Reusable UI workspace/screen implementation loaded by a Process.

Examples: `table+detail`, `kanban`, `calendar`, `intake-form`, `approval-workflow`.

### 4) Solution
A configured experience that assembles Modules + Processes + role/process mappings.

### 5) Client Overlay
Per-customer customization layer under `./clients/<client-id>/` that can:
- enable/disable/relabel modules/processes,
- add client-only processes/templates,
- override approved extension points,
- customize role mapping and policy,
without affecting other customers.

---

## Composition Hierarchy

`Client Overlay -> Solution -> Modules -> Processes -> Template`

Resolution precedence for configuration and UI overrides:

`core < solution < client-overlay`

No cross-client imports are allowed.

---

## Process Data Bootstrap (SQL)

Each Process may define a **Data Source** to populate runtime data on load.

### Data Source fields
- `type`: `sql` | `queryRef` (future adapters can be added)
- `query`: parameterized SQL (or query reference)
- `params`: mappings from context/session/process inputs
- `returns`: named dataset exposed to the template
- `timeoutMs`: max query execution time
- `rowLimit`: hard row cap
- `cache`: optional TTL/revalidate behavior
- `access`: required role/capability + tenant scope

### Security and safety requirements (non-negotiable)
1. Tenant scoping enforced in every query path (`tenant_id = :tenantId` or equivalent enforced policy).
2. Parameterized inputs only (no string concatenation).
3. Read-only by default for process bootstraps.
4. Enforced timeout and row limits per process.
5. Query allowlist/validation before execution.
6. Full audit logging: processId, actor, tenant, duration, rows, queryRef/hash.

---

## Target Directory Model

```text
/core
/ui
  /core                # primitives (inputs, layout, table, modal, form controls)
  /composites          # reusable domain widgets (calendar, timeline, kanban, etc.)
  /templates           # reusable process templates
/config
  /solutions
    <solution-id>.json
/clients
  /<client-id>
    app.json
    modules/
    processes/
    templates/
    overrides/
    policies/
```

---

## Implementation Plan (Next Steps)

## Phase 1 — Lock contracts (1-2 days)

1. Define JSON schemas:
   - `module.schema.json`
   - `process.schema.json`
   - `template.schema.json`
   - `datasource.schema.json`
   - `client-overlay.schema.json`
2. Add schema validation at startup (fail fast).
3. Add version field to each contract (`schemaVersion`).

**Done when** invalid definitions fail startup with actionable errors.

## Phase 2 — Build registry + resolver (2-3 days)

1. Introduce a registry that loads from:
   - core/runtime defaults,
   - solution manifest,
   - client overlay.
2. Implement deterministic precedence:
   - core < solution < client-overlay.
3. Emit diagnostics endpoint showing effective resolved config.

**Done when** we can inspect final resolved modules/processes per client deterministically.

## Phase 3 — Process Data Source runtime (3-4 days)

1. Implement `dataSource` executor with:
   - parameter binding,
   - tenant enforcement,
   - timeout + row caps,
   - read-only guard.
2. Add query normalization and query hash logging.
3. Add process bootstrap endpoint:
   - `GET /api/processes/:processId/bootstrap`.

**Done when** process templates load data solely from declarative data sources.

## Phase 4 — UI composition split (3-5 days)

1. Create `/ui/core` primitives and migrate common controls first.
2. Extract `/ui/composites` (calendar/table-detail/kanban etc.) from vertical-specific code.
3. Refactor existing vertical module(s) to consume primitives/composites.

**Done when** no vertical module owns a duplicate copy of core controls.

## Phase 5 — Client overlays (2-3 days)

1. Add `/clients/<client-id>/` loader.
2. Add override allowlist (which fields/components are overridable).
3. Enforce no cross-client references.
4. Add role/process mapping by client.

**Done when** one client can customize a solution without affecting another.

## Phase 6 — Testing and hardening (2-3 days)

1. Integration tests for:
   - resolution precedence,
   - tenant-safe query execution,
   - role-based process visibility,
   - client isolation guarantees.
2. Add golden tests for effective resolved config per client.
3. Add perf budget checks for bootstrap query latency.

**Done when** CI fails on contract drift, unsafe queries, or cross-client leakage.

---

## Immediate Work Queue (Concrete)

1. Add schemas + validator wiring.
2. Add `core/registry` with merged config view.
3. Add `Process.dataSource` executor (read-only, parameterized).
4. Convert one existing flow (e.g., salon dashboard) into Process + Template + DataSource.
5. Add first client overlay example under `clients/demo-client/`.

---

## Risks and Mitigations

### Risk: Configuration sprawl
- Mitigation: strict schemas + lints + diagnostics endpoint.

### Risk: SQL footguns / noisy tenant leaks
- Mitigation: mandatory tenant guard + prepared statements + query policy checks.

### Risk: Over-customization fragmentation
- Mitigation: override allowlist and extension points only (no arbitrary patching).

### Risk: Duplicate UI resurfacing
- Mitigation: enforce primitives/composites usage in code review + module scaffolding templates.

---

## Decision Summary

- Keep **Module** and **Process** as core business language.
- Use **Template** for reusable workspaces loaded by processes.
- Allow process-defined SQL-backed data bootstrap with strict runtime guardrails.
- Introduce `./clients/<client-id>/` for isolated customer-specific wrappers and overrides.
- Build platform around composability first, not vertical-specific component duplication.
