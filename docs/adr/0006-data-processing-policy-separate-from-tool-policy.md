# 0006 — Data-processing policy is separate from tool policy

## Status

Accepted

## Context

“May U2OS perform this action?” and “May this information leave the machine?” are different questions. A harmless read or approved action can still leak private context to a remote model, embedding endpoint, or external tool if those decisions are conflated.

## Decision

Maintain a destination-aware data-processing policy, separate from tool authorization, across `public`, `personal`, `private`, and `sensitive` classifications and `local_model`, `configured_remote_model`, `external_tool`, and `local_ui` destinations. Classification comes from stored metadata and deterministic inheritance, never model output. Filter candidate text before remote embedding calls and filter the complete assembled context again for the actual planning provider, including fallbacks. Audit withheld items and remove their provenance references from what the plan is said to have seen.

## Consequences

- Local and remote providers may receive different context for the same objective.
- Derived values inherit the most restrictive contributing source unless a trusted deterministic rule explicitly permits otherwise.
- Adding a context type or outbound destination requires classification and policy coverage, not just a tool permission.
- A policy decision of `confirm` is fail-closed for synchronous context transfer until an interactive disclosure flow exists.
- Explainability can accurately distinguish used context from withheld context without exposing hidden reasoning.

See [policies](../policies.md), [models](../models.md), and [architecture](../architecture.md).
