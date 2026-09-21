# Architecture decision records

These records capture U2OS's foundational, cross-cutting decisions. They describe why the boundary exists and its consequences; current implementation detail remains in [the architecture guide](../architecture.md).

- [0001 — Local-first, user-owned data](0001-local-first-user-owned-data.md)
- [0002 — Models are replaceable infrastructure](0002-model-is-replaceable-infrastructure.md)
- [0003 — Authorization policy stays outside the model](0003-policy-outside-the-model.md)
- [0004 — Event log plus relational state](0004-event-log-plus-relational-state.md)
- [0005 — Web Components and a no-build frontend](0005-web-components-no-build-frontend.md)
- [0006 — Data-processing policy is separate from tool policy](0006-data-processing-policy-separate-from-tool-policy.md)

New ADRs should use the next number and contain at least Status, Context, Decision, and Consequences. Supersede an accepted record with a new ADR rather than silently rewriting the original decision.
