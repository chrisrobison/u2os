---
name: Security-sensitive architecture change
about: Propose a reviewed change to a trust, privacy, or authorization boundary
title: "security: "
labels: security,architecture
---

> Do not use this public template to disclose a vulnerability, exploit, secret, or personal data. Follow `SECURITY.md` for private reporting.

## Boundary being changed

Identify the current trust, authorization, privacy, identity, credential, or external-side-effect boundary.

## Threat model

Who or what is untrusted? What failure or abuse is being prevented?

## Proposed invariant

State the property that must remain true after the change.

## Compatibility and migration

Describe existing-installation behavior, rollback, and any additive schema migration.

## Verification

- [ ] Security regression tests
- [ ] Failure/recovery tests
- [ ] Secret and private-data review
- [ ] Documentation/ADR update
