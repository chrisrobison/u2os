# U2OS 90-Day Roadmap

Status: Draft v1 (execution-ready)
Owner: Chris
Model: One product, multi-mode tenancy (`local` / `hybrid` / `hosted`)

## North Star

**Build once, run local or hosted, no rewrite.**

## Delivery Cadence

- Weekly release train: Fri ship, changelog, migration note
- Scope cap: max 3 outcomes/week
- Every change tagged as one of: `platform`, `tenancy`, `sdk`, `security`, `ops`, `ecosystem`

## Milestone Plan

- **M1 (Days 1–30): Platform Trust**
- **M2 (Days 31–60): Ecosystem Foundations**
- **M3 (Days 61–90): Distribution + Monetization**

---

## M1 — Platform Trust (Days 1–30)

### Epic 1: Platform Contracts v1
**Goal:** Freeze and version extension/runtime contracts.

Tasks:
1. Define `core API v1` compatibility policy (semver + deprecation window)
2. Version app-definition schema (`schemaVersion`)
3. Version plugin/module manifest contract
4. Add compatibility matrix doc (core version ranges)

Acceptance criteria:
- Published contract docs with clear `stable` vs `experimental` sections
- CI fails if manifest/schema break rules are violated
- At least one migration path example documented

Deliverables:
- `docs/contracts/core-api-v1.md`
- `docs/contracts/plugin-manifest-v1.md`
- `docs/contracts/app-definition-v1.md`
- `docs/compatibility-matrix.md`

---

### Epic 2: Local-First Installer
**Goal:** One-command local setup without tenancy jargon.

Tasks:
1. Add bootstrap command/script (`scripts/bootstrap-local.js`)
2. Generate `.env` from profile presets (sqlite default)
3. Create owner + default tenant automatically
4. Health check summary + next-step output
5. Optional prompt: enable remote backup later

Acceptance criteria:
- Fresh machine setup under 10 minutes
- New user can login and create first entity without reading internals
- Installer is idempotent or safely re-runnable

Deliverables:
- `npm run setup:local`
- `docs/install/local-quickstart.md`

---

### Epic 3: Migration Safety + Release Discipline
**Goal:** No scary upgrades.

Tasks:
1. Migration manifest with checksum tracking
2. `--dry-run` mode for migrations
3. Pre-upgrade backup hook
4. Upgrade report output (applied/skipped/failures)
5. Rollback playbook template per release

Acceptance criteria:
- Dry-run output clearly shows planned changes
- Failed migration does not leave partial silent state
- Release notes always include migration/rollback section

Deliverables:
- `scripts/migrate.js` (or extension to existing scripts)
- `docs/ops/migration-runbook.md`
- `docs/releases/release-template.md`

---

### Epic 4: Tenant Isolation Verification
**Goal:** Detect cross-tenant leaks before deploy.

Tasks:
1. Add integration tests for cross-tenant reads/writes
2. Add auth scope tests for admin vs tenant users
3. Add mode tests for `local/hybrid/hosted` routing behavior
4. Add CI job gate: isolation tests required for merge

Acceptance criteria:
- Failing isolation test blocks merge
- Test fixtures include at least 2 tenants + distinct data
- Coverage includes entity routes + module routes

Deliverables:
- `tests/tenancy-isolation.test.js`
- CI workflow update

---

## M2 — Ecosystem Foundations (Days 31–60)

### Epic 5: Plugin SDK + DX
**Goal:** Third-party plugin in < 1 day.

Tasks:
1. Build plugin starter template (`create-u2os-plugin`)
2. Provide local dev harness with mock tenant context
3. Add hot-reload dev loop for plugin development
4. Publish “Hello Plugin in 30 min” tutorial

Acceptance criteria:
- New plugin scaffolds with one command
- Example plugin runs in local and hosted modes unchanged
- Tutorial verified by someone other than author

Deliverables:
- `packages/create-u2os-plugin/`
- `docs/sdk/getting-started.md`
- `docs/sdk/plugin-lifecycle.md`

---

### Epic 6: Plugin Permissions + Auditability
**Goal:** Reduce plugin risk and make actions observable.

Tasks:
1. Define capability model (`entities.read`, `entities.write`, etc.)
2. Enforce permissions at module boundary
3. Add install-time permission disclosure
4. Log privileged plugin actions to audit trail

Acceptance criteria:
- Plugin denied when requesting undeclared privileged capability
- Audit logs include actor, tenant, plugin, action, timestamp
- Permission set visible in admin UI/API

Deliverables:
- `docs/security/plugin-capabilities.md`
- API endpoints/UI updates for capability inspection

---

### Epic 7: Plugin Packaging + Signing
**Goal:** Trusted install path.

Tasks:
1. Define package format and metadata schema
2. Add checksum validation during install
3. Add optional signature verification
4. Emit provenance info in install logs

Acceptance criteria:
- Tampered package is rejected
- Unsupported core version is rejected with clear error
- Install output shows package author/version/source hash

Deliverables:
- `docs/sdk/package-format.md`
- `scripts/plugin-install.js` (or equivalent)

---

### Epic 8: Hosted Control Plane Hardening
**Goal:** Operable hosted tenancy, not just possible hosted tenancy.

Tasks:
1. Instance lifecycle endpoints: create/suspend/archive
2. Domain mapping validation & conflict checks
3. Basic quotas/limits per instance
4. Admin RBAC cleanup + scoped views

Acceptance criteria:
- Admin can suspend tenant and block access cleanly
- Domain conflicts cannot be created
- Scoped admins cannot modify unauthorized instances

Deliverables:
- `docs/ops/control-plane-admin.md`
- Enhanced `/api/admin/tenancy/*` contract docs

---

## M3 — Distribution + Monetization (Days 61–90)

### Epic 9: Registry MVP (Private First)
**Goal:** Publish/search/install/update plugin lifecycle.

Tasks:
1. Stand up private plugin registry service or static index + signed artifacts
2. Add CLI/API for publish/search/install/update
3. Add compatibility filtering by core version

Acceptance criteria:
- Plugin can be published and installed by id/version
- Update command respects compatibility and pinning
- Registry has auth/access control

Deliverables:
- `docs/registry/overview.md`
- `docs/registry/publish-flow.md`

---

### Epic 10: Optional Remote Backup + Access
**Goal:** Advanced capability without local complexity tax.

Tasks:
1. Feature-flag remote backup connectors (S3-compatible first)
2. Scheduled encrypted snapshot support
3. Restore validation workflow
4. Optional remote admin access path with explicit enablement

Acceptance criteria:
- Local install works fully without remote setup
- Backup/restore can be tested in staging with integrity checks
- Remote access disabled by default

Deliverables:
- `docs/backup/remote-backups.md`
- `docs/backup/restore-validation.md`

---

### Epic 11: Hosted Billing Primitives
**Goal:** Charge safely for hosted usage.

Tasks:
1. Meter tenant usage (base counters)
2. Subscription state -> feature gating
3. Grace period and lock behavior

Acceptance criteria:
- Feature entitlements enforced server-side
- Trial/grace/expired states produce predictable behavior
- Audit logs capture billing state changes

Deliverables:
- `docs/billing/entitlements.md`

---

### Epic 12: Three Hero Verticals
**Goal:** Instant value installs.

Tasks:
1. Select 3 target verticals
2. Ship turnkey templates/workflows
3. Validate each in local + hosted modes

Acceptance criteria:
- Each vertical has starter data + key workflows
- Each vertical has success path doc in under 20 min
- At least one pilot user per vertical

Deliverables:
- `config/apps/<vertical>.json`
- per-vertical docs in `docs/verticals/`

---

## KPI Targets by Day 90

1. Local install first-attempt success > 90%
2. Upgrade success in staging > 99%
3. 0 known cross-tenant leaks
4. 10+ installable plugins
5. 3 production-ready vertical templates
6. At least 1 paying hosted pilot

---

## Kill List (Avoid These)

- Splitting repo into separate single-tenant vs multi-tenant products
- Building marketplace UI before package trust/compatibility works
- Complex distributed architecture before single-node hosted is stable
- Breaking extension contracts without migration + deprecation path
