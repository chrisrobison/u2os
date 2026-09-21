# 0004 — Event log plus relational state

## Status

Accepted

## Context

U2OS needs durable provenance and causal history, but product reads also need direct, inspectable queries over people, facts, tasks, email, calendar, actions, and queue state. Treating every read as event replay would add complexity without improving the personal-scale product.

## Decision

Use an append-only SQLite event log as the history, correlation, causation, SSE, and explainability spine. Use normalized relational tables as authoritative current/materialized state. The same trusted code path writes a state change and its corresponding event; U2OS is deliberately not purely event-sourced.

## Consequences

- UI and tool reads remain straightforward and efficient.
- Events preserve where observations and actions came from and connect outcomes to requests.
- Some state can be projected from events, but a general replay-to-rebuild system is not required.
- Cross-write consistency must be considered whenever state and its event are changed.
- Retention is a deliberate audited maintenance operation, not silent background deletion.

See [events](../events.md) and [architecture](../architecture.md).
