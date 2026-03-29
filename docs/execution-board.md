# Execution Board (90 Days)

This board translates the roadmap into sequenced implementation work.

## Legend
- Priority: P0 (must), P1 (important), P2 (nice)
- Size: S (1-2d), M (3-5d), L (1-2w)
- Status: Todo | In Progress | Blocked | Done

---

## Sprint 1 (Week 1): Contracts + Install Baseline

### [P0][L][Todo] E1-1 Contract docs freeze
- Owner: Chris
- Dependencies: none
- Outputs:
  - `docs/contracts/core-api-v1.md`
  - `docs/contracts/plugin-manifest-v1.md`
  - `docs/contracts/app-definition-v1.md`
- DoD:
  - stable/experimental sections present
  - semver/deprecation policy explicitly stated

### [P0][M][Todo] E2-1 Local setup command
- Owner: Chris
- Dependencies: E1-1
- Outputs:
  - `scripts/bootstrap-local.js`
  - `package.json` script `setup:local`
- DoD:
  - setup completes on fresh checkout
  - prints health and login URL

### [P0][M][Todo] E4-1 Tenancy mode tests
- Owner: Chris
- Dependencies: none
- Outputs:
  - `tests/tenancy-mode-routing.test.js`
- DoD:
  - local/hybrid/hosted route behavior asserted

---

## Sprint 2 (Week 2): Migration Safety + Isolation

### [P0][L][Todo] E3-1 Migration dry-run and checksums
- Dependencies: E1-1
- Outputs:
  - migration manifest/checksum support
  - dry-run command
- DoD:
  - dry-run lists all pending operations
  - checksum mismatch fails loudly

### [P0][M][Todo] E4-2 Cross-tenant leak tests
- Dependencies: E4-1
- Outputs:
  - `tests/tenancy-isolation.test.js`
- DoD:
  - read/write leakage attempts fail
  - module endpoints included in coverage

### [P1][S][Todo] E3-2 Release template
- Outputs:
  - `docs/releases/release-template.md`
- DoD:
  - includes migration, rollback, known risks sections

---

## Sprint 3 (Week 3): SDK Scaffold

### [P0][L][Todo] E5-1 Plugin starter CLI
- Dependencies: E1-1
- Outputs:
  - `packages/create-u2os-plugin/`
- DoD:
  - `npx create-u2os-plugin` produces runnable plugin

### [P1][M][Todo] E5-2 SDK docs
- Outputs:
  - `docs/sdk/getting-started.md`
  - `docs/sdk/plugin-lifecycle.md`
- DoD:
  - hello plugin tutorial validated end-to-end

---

## Sprint 4 (Week 4): Permissions + Audit Trail

### [P0][L][Todo] E6-1 Capability model enforcement
- Dependencies: E5-1
- Outputs:
  - capability policy in module loader/runtime
- DoD:
  - undeclared privileged actions blocked

### [P0][M][Todo] E6-2 Plugin audit events
- Dependencies: E6-1
- Outputs:
  - audit logging hooks + storage
- DoD:
  - logs include plugin, tenant, action, actor

---

## Sprint 5 (Week 5): Package Trust

### [P0][L][Todo] E7-1 Package metadata + verification
- Dependencies: E5-1
- Outputs:
  - package format schema
  - checksum validation on install
- DoD:
  - tampered package rejected

### [P1][M][Todo] E7-2 Signature verification (optional mode)
- Dependencies: E7-1
- DoD:
  - signed package accepted, invalid signature rejected

---

## Sprint 6 (Week 6): Control Plane Hardening

### [P0][M][Todo] E8-1 Instance lifecycle APIs
- Dependencies: existing tenancy APIs
- Outputs:
  - suspend/archive behaviors
- DoD:
  - suspended tenants blocked from authenticated runtime

### [P0][M][Todo] E8-2 Domain conflict validation
- DoD:
  - cannot assign duplicate active host/domain mapping

### [P1][M][Todo] E8-3 Admin scope tightening
- DoD:
  - scoped admins only see allowed instances

---

## Sprint 7 (Week 7): Registry MVP

### [P0][L][Todo] E9-1 Registry service/index
- Dependencies: E7-1
- Outputs:
  - publish/search/install/update flow
- DoD:
  - install by id/version works with compatibility checks

### [P1][M][Todo] E9-2 Registry auth/access control
- DoD:
  - publish requires auth; install can be policy-based

---

## Sprint 8 (Week 8): Remote Backup (Optional)

### [P0][L][Todo] E10-1 S3-compatible backup connector
- Dependencies: migration safety baseline
- DoD:
  - encrypted snapshot upload + metadata tracked

### [P0][M][Todo] E10-2 Restore validation command
- DoD:
  - restore test verifies data integrity in staging

---

## Sprint 9 (Week 9): Billing Primitives

### [P1][L][Todo] E11-1 Entitlements + gating
- DoD:
  - server-side feature checks tied to plan state

### [P2][M][Todo] E11-2 Grace + lock policy
- DoD:
  - expired/grace states deterministic and auditable

---

## Sprint 10–12 (Weeks 10–12): Hero Verticals + Pilot

### [P0][L][Todo] E12-1 Vertical A template
### [P0][L][Todo] E12-2 Vertical B template
### [P0][L][Todo] E12-3 Vertical C template
- DoD (each):
  - local + hosted validated
  - starter data + workflow docs

### [P0][M][Todo] Pilot onboarding runbook
- DoD:
  - first paying pilot can be deployed and supported

---

## Immediate Next 5 Issues (Create these first)

1. `platform: freeze core/plugin/app contracts v1`
2. `installer: add setup:local bootstrap flow`
3. `testing: add tenancy mode routing test matrix`
4. `migrations: implement dry-run + checksum validation`
5. `security: add cross-tenant isolation integration tests`

---

## Weekly Review Template

- What shipped?
- What slipped and why?
- Isolation/security regressions?
- Migration/upgrade incidents?
- Scope for next week (max 3 outcomes)
