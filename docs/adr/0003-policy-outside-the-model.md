# 0003 — Authorization policy stays outside the model

## Status

Accepted

## Context

Model output is probabilistic and can be influenced by untrusted email, calendar, document, web, or user content. Prompt instructions cannot safely decide whether a consequential action is authorized.

## Decision

The model may propose only registered, schema-valid actions. Authoritative server code evaluates every consequential action through `ActionEvaluator` and `PolicyEngine`, persists the decision and approval state, then re-evaluates policy, approval, and freshness before durable execution. Browser identity, voice confidence, feedback, and model reasoning cannot weaken policy.

## Consequences

- Unknown tools and invalid arguments fail before authorization or execution.
- Autonomous, approval-required, and blocked outcomes are explicit and auditable.
- Queued actions cannot rely on stale authorization after a restart or policy change.
- New action paths must use the same policy/audit/durable pipeline; convenience routes that do not are owner-only gaps and must not become agent-reachable.
- The system sometimes asks rather than acting when context or authority is uncertain.

See [policies](../policies.md) and [tools](../tools.md).
