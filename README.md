# U2OS (Foundation)

U2OS is a modular, API-first operating system for modern service businesses, built on a reusable kernel with dynamically loaded capability packages.

Brand/site: **u2os.com**

## What is included

- Core kernel (`/core`) with:
  - universal business entity CRUD/search APIs
  - event bus with publish/subscribe
  - capability package loader
  - modular data connector abstraction
- Capability package examples (`/modules`):
  - `salon-module` (appointment scheduling + calendar + appointment events)
  - `example-module` (minimal reference capability package)
- Responsive dashboard (`/ui/dashboard`) with dynamic module panels
- User app runtime (`/ui/app`) driven by runtime app definitions and component hooks
- Composable solution manifests (`/config/solutions`) for Module/Process/Template hierarchy

## Data Connector Switching

The app uses a connector factory. Set `DB_CLIENT` to switch backend:

- `DB_CLIENT=mysql`
- `DB_CLIENT=postgres`
- `DB_CLIENT=sqlite` (uses `DB_FILE`, defaults to `./data/u2os.sqlite`)

Both connectors expose the same interface used by the kernel and capability packages.

## Authentication + Authorization

- All `/api/*` endpoints require `Authorization: Bearer <jwt>` except:
  - `/health`
  - `/ready`
  - `POST /api/auth/login`
  - `POST /api/admin/auth/login`
- Role model: `owner`, `admin`, `staff`, `viewer`
- Control-plane admin endpoints (`/api/admin/tenancy/*`) require admin-control JWT login.
- Entity mutation endpoints (`POST/PUT/DELETE` under `/api/*` entity routes) require `owner`, `admin`, or `staff`.

Auth env vars:

- `AUTH_JWT_SECRET` (required, 32+ chars)
- `AUTH_TOKEN_TTL_SECONDS` (default `28800`, 8 hours)
- `ADMIN_BOOTSTRAP_EMAIL` (default `admin@localhost`)
- `ADMIN_BOOTSTRAP_PASSWORD` (default `admin12345678`)
- `ADMIN_BOOTSTRAP_NAME` (default `Install Admin`)
- `ADMIN_BOOTSTRAP_ROLE` (default `owner`)

Security env vars:

- `TRUST_PROXY` (`false` by default)
- `TENANCY_TRUST_FORWARDED_HOST` (`false` by default)
- `TENANCY_ALLOW_OVERRIDE` (`false` by default; if `true`, tenant can be selected by explicit request value for local/CI testing)
- `TENANCY_OVERRIDE_HEADER` (`x-tenant-id` by default)
- `TENANCY_OVERRIDE_QUERY_PARAM` (`tenant_id` by default)
- `CORS_ALLOWLIST` (comma-separated origins; empty means allow all origins)
- `RATE_LIMIT_WINDOW_MS` (default `60000`)
- `RATE_LIMIT_MAX` (default `300`)
- `API_BODY_LIMIT` (default `1mb`)
- `AUTH_BODY_LIMIT` (default `32kb`)
- `MIGRATIONS_STRICT_STARTUP` (default `true`)

## Tenancy Packaging Model (Single Product, Multi-Mode)

U2OS now ships as **one product** with a default tenant and three runtime modes:

- `TENANCY_MODE=local` (default): always serve the default tenant unless an explicit override is enabled.
  - Best for local/self-hosted installs.
  - No host/domain setup required for a simple install.
- `TENANCY_MODE=hybrid`: attempt host/domain tenant routing first, then fall back to default tenant.
  - Best when you want mostly local behavior with optional hosted routing.
- `TENANCY_MODE=hosted`: require host/domain mapping per request.
  - Best for managed multi-tenant deployments.

This keeps one codebase for capability packages/business modules/vertical solutions while allowing WordPress-style local installs and hosted tenancy from the same runtime.

### Multi-Tenant Control Plane (One DB Per Tenant)

- A separate control-plane DB stores tenancy metadata:
  - `customers`
  - `instances` (each instance has its own DB connection config)
  - `instance_domains` (indexed host/domain lookup per request)
- Non-local modes resolve tenant by `Host` header + derived domain.
- When `TENANCY_ALLOW_OVERRIDE=true`, requests may explicitly choose tenant instance by id using
  `TENANCY_OVERRIDE_HEADER` or `TENANCY_OVERRIDE_QUERY_PARAM` (useful for local development and automated tests).
- Each tenant instance points to its own database (SQLite file, MySQL DB, or Postgres DB).
- Unknown host/domain mappings are rejected when `TENANCY_STRICT_HOST_MATCH=true`.

Control-plane env vars:

- `CONTROL_DB_CLIENT`
- `CONTROL_DB_HOST`
- `CONTROL_DB_PORT`
- `CONTROL_DB_USER`
- `CONTROL_DB_PASSWORD`
- `CONTROL_DB_NAME`
- `CONTROL_DB_FILE`
- `TENANCY_MODE` (`local` default, or `hybrid` / `hosted`)
- `TENANCY_STRICT_HOST_MATCH` (default follows mode: false for local/hybrid, true for hosted)
- `TENANCY_BOOTSTRAP_HOST` (default `localhost`)
- `TENANCY_BOOTSTRAP_DOMAIN` (default `localhost`)

## Settings Layering

Configuration can be layered from global defaults + client overrides:

- Global: `config/settings.json` (or `SETTINGS_GLOBAL_FILE`)
- Client override: `clients/<CLIENT_NAME>/settings.json` (or `CLIENTS_DIR`)

`<CLIENT_NAME>` is derived from control-plane customer name and normalized to lowercase kebab-case.
Example: `Acme Wellness Group` -> `clients/acme-wellness-group/settings.json`.

API access:

- `GET /api/system/settings` (tenant-scoped effective settings)
- `GET /api/admin/settings/effective?instance_id=<id>` (admin view for a specific instance)

## Run

1. Copy `.env.example` to `.env` and set DB credentials.
   For SQLite local dev, set `DB_CLIENT=sqlite`.
2. Install dependencies:

```bash
npm install
```

3. Initialize schema:

```bash
npm run db:init
```

4. Create first owner login identity (required before using authenticated APIs):

```bash
npm run auth:create-owner -- --email owner@example.com --password 'change-this-password' --name 'Owner User'
```

Optional sample data for UI/module testing:

```bash
npm run db:seed
```

This seeds broad sample records plus two deterministic showcase customers with linked appointments,
orders, invoices, payments, tasks, documents, events, and clamps.

5. (Upgrade only) If your database already has existing data and you are upgrading to dual IDs,
run the additive migration/backfill:

```bash
npm run db:migrate:public-ids
```

6. Start server:

```bash
npm run start
```

- API: `http://localhost:3010/api`
- Readiness: `http://localhost:3010/ready`
- Dashboard: `http://localhost:3010/dashboard`
- Tenancy Admin: `http://localhost:3010/admin`
- User App Runtime: `http://localhost:3010/app`
  - Salon vertical app: `http://localhost:3010/app?app=salon`

Admin web login defaults:
- email: `admin@localhost`
- password: `admin12345678`
- Change these with `ADMIN_BOOTSTRAP_*` env vars in production.

Runtime app definitions are loaded from `config/apps/*.json` (legacy) and `config/solutions/*.json` (canonical composable model).

## Example APIs

- `POST /api/auth/login` with `{ "email": "...", "password": "..." }`
- `GET /api/auth/me`
- `POST /api/customers`
- `GET /api/invoices?q=acme`
- `GET /api/customers?limit=50&cursor=<token>` (cursor pagination)
- `POST /api/payments`
- `GET /api/events`
- `GET /api/analytics`
- `POST /api/modules/salon-module/appointments`
- `GET /api/modules/salon-module/dashboard`
- `GET /api/modules/salon-module/calendar?month=2026-03&date=2026-03-10`
- `GET /api/modules/salon-module/clients?q=emma`
- `GET /api/system/metrics`
- `GET /api/system/capability-packages`
- `GET /api/solutions`
- `GET /api/solutions/:solutionId`

Telemetry notes:
- every response includes `x-request-id` and `x-trace-id`
- request logs emit structured JSON with latency, tenant, user, and trace correlation fields

Tenancy admin APIs:

- `POST /api/admin/auth/login`
- `GET /api/admin/auth/me`
- `GET /api/admin/tenancy/summary`
- `GET /api/admin/tenancy/customers`
- `POST /api/admin/tenancy/customers`
- `GET /api/admin/tenancy/instances`
- `POST /api/admin/tenancy/instances`
- `GET /api/admin/tenancy/domains`
- `POST /api/admin/tenancy/domains`
- `GET /api/admin/settings/effective`

## Identifier Model

- Internal identity remains UUID in `id` for all entity relationships.
- Business entities also get a stable, human-facing `public_id` (for example `ORD-100001`).
- Entity routes support either UUID or `public_id`:
  - `GET /api/orders/<uuid>`
  - `GET /api/orders/ORD-100001`

## Developer Docs

- Composable platform terminology + plan: `docs/composable-platform-terminology-and-plan.md`
- Architecture language and hierarchy: `docs/architecture-language.md`
- Composable schemas (draft): `docs/composable-schemas.md`
- Interface runtime guide: `docs/interface-runtime-guide.md`
- Backup and restore playbook: `docs/backup-restore-playbook.md`
- Tenancy packaging model: `docs/tenancy-packaging-model.md`
- 90-day roadmap: `docs/roadmap-90-day.md`
- Execution board: `docs/execution-board.md`
- Migration policy: `docs/migration-policy.md`

## Testing

```bash
npm test
npm run test:migrations

# Optional control-plane admin user helper
npm run admin:create-user -- --email admin2@example.com --password 'change-me' --superuser
```

## Docker

```bash
docker compose up --build
```

Optional reverse proxy profile:

```bash
docker compose --profile proxy up --build
```
