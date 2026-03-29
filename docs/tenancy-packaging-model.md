# Tenancy Packaging Model (Local-first + Hosted-ready)

## Goal

Ship **one U2OS product** that supports:

1. Simple local installs (single tenant, minimal setup)
2. Hosted multi-tenant operation on one or more servers
3. Shared plugins/modules/verticals across both modes

## Decision

Use a **single runtime** with a **default tenant** and configurable tenancy mode.

- Do **not** split into separate single-tenant and multi-tenant repos.
- Keep one shared core and control plane.

## Runtime Modes

Configured via `TENANCY_MODE`:

- `local` (default)
  - Always serves the default tenant unless an explicit tenant override is enabled.
  - Best for local installs and developers.
- `hybrid`
  - Resolves tenant by host/domain when possible, otherwise falls back to default tenant.
  - Best for mixed setups.
- `hosted`
  - Requires explicit host/domain mappings per request.
  - Best for managed SaaS multi-tenancy.

`TENANCY_STRICT_HOST_MATCH` can still be set explicitly, but defaults by mode.

## Why this works

- Local users get WordPress-like install simplicity.
- Hosted users get domain-based tenant routing and isolation.
- Product team only maintains one code path for core features and modules.
- Migration from local -> hosted is straightforward because the default tenant is already a first-class tenant instance.

## Operational Notes

- Keep plugin/module code tenancy-agnostic where possible.
- Put tenant-specific behavior in:
  - request tenant resolution
  - auth scope/session context
  - control-plane provisioning/billing/admin
  - storage/backups/access policy
- Remote backups/access should be optional capability toggles, not required install-time complexity.
