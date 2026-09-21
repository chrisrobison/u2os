# 0001 — Local-first, user-owned data

## Status

Accepted

## Context

U2OS observes and remembers highly personal information. Making a U2OS-operated backend authoritative would turn privacy, availability, and portability into promises made by a vendor rather than properties of the system.

## Decision

The owner's `U2OS_HOME` is the authoritative home for database state, policy, configuration, encrypted credentials, and caches. U2OS runs as a persistent local service, binds to loopback by default, and requires no hosted U2OS backend. Remote models and connectors are optional, owner-configured destinations. Backup, restore, and credential-free export are first-class operations.

## Consequences

- The owner can run the default demonstration offline and move or back up the complete installation.
- Connector and remote-model use must be explicit about which data leaves the machine.
- Local operations, schema compatibility, and recovery are product responsibilities rather than cloud-service concerns.
- `U2OS_HOME` backups are as sensitive as the live installation because they contain the credential master key.
- Multi-device and internet access require carefully designed trust and transport layers; direct public exposure is unsupported.

See [deployment](../deployment.md), [connectors](../connectors.md), and [policies](../policies.md).
