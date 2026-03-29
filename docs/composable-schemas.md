# Composable Schemas (Draft v2026-03-14)

These schemas formalize the composable platform model:

- **Module**: top-level business area (Sales/Support/Finance/etc)
- **Process**: workflow inside a module
- **Template**: reusable UI workspace used by a process
- **Data Source**: process bootstrap query definition
- **Solution**: composition root
- **Client Overlay**: per-customer customization layer

## Schema files

Located in `config/schemas/`:

- `app-wrapper.schema.json` (legacy name; semantic role is **Solution**)
- `module.schema.json`
- `process.schema.json`
- `template.schema.json`
- `datasource.schema.json`
- `client-overlay.schema.json`

## Contract summary

## Module
- Groups one or more processes.
- Includes id/title/icon/order/visibility.
- `processes` can embed full process objects or references by id.

## Process
- Defines workflow metadata and template binding.
- Includes `dataSource` for load-time data environment.
- Supports role/capability visibility and lifecycle hooks.

## Template
- Defines reusable UI implementation (`componentTag` + props).
- Declares optional extension slots for wrappers/clients.

## Data Source
- Supports `type: sql | queryRef`.
- Includes parameter mapping, return dataset name, timeout, row limit, access scope, cache.
- Intentionally defaults to read-only execution mode.

## Client Overlay
- Extends a `baseAppId` without affecting other clients.
- Supports branding + module/process overrides + role mappings.
- Can add client-only modules/processes/templates.

## Solution
- Defines application identity and module composition.
- Optional process/template catalogs for reusable declarations.

## Security requirements for process data sources

These are runtime responsibilities (not fully enforceable by static schema alone):

1. Tenant scoping must always be enforced.
2. SQL must be parameterized; no raw string interpolation.
3. Read-only by default.
4. Timeout and row caps enforced per process.
5. Query validation/allowlisting before execution.
6. Query execution must be audited with tenant + actor context.

## Suggested resolver precedence

When loading effective configuration:

`core < solution < client-overlay`

## Current workbench implementation (MVP)

Implemented admin APIs:

- `GET /api/admin/schema-workbench/kinds`
- `GET /api/admin/schema-workbench/scaffold/:kind`
- `POST /api/admin/schema-workbench/lint`
- `POST /api/admin/schema-workbench/save` (superuser only)

Implemented admin UI:

- New **Schemas** section under `/admin`
- Guided scaffold inputs (app/module/process/template/client ids)
- Type-specific guided fields (app/module/process/template/datasource/client-overlay)
- Live JSON ⇄ form sync
- JSON editor + lint + preview panel
- Save workflow (with optional filename override) to `config/solutions`, `clients/<client>/schemas`, or `config/schemas/workbench/<kind>`
- Policy guardrails in lint path for SQL data sources (tenant scope, read-only checks, row/time bounds)

## Suggested validator integration

At startup:

1. Load all wrapper/module/process/template definitions.
2. Validate each document against its schema.
3. Fail startup on any schema violation.
4. Expose diagnostics endpoint showing merged effective config + source origin per field.

## Should we build a schema editor component?

**Yes — but in phases.**

Recommended approach:

### Phase A (immediate)
- Ship a **read-only schema inspector + JSON editor** with lint/validation errors.
- Add test-data preview for process data source outputs.

### Phase B
- Add guided form builder for Module/Process/Template records from JSON Schema.
- Keep raw JSON view available for power users.

### Phase C
- Add policy-aware guardrails:
  - reject unsafe SQL patterns,
  - enforce tenant placeholders,
  - auto-insert timeout/row limits,
  - show role/capability impact preview.

### Key principle
Use the editor as a **safe configuration workbench**, not as unrestricted code execution.

---

If this draft is accepted, next implementation step is wiring runtime validation + a resolver service that materializes effective config for a `(clientId, appId, role)` context.
