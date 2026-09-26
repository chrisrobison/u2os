# Goal drafts

Goals sit above runs and actions. The current implementation is deliberately draft-only: it records owner intent but does not schedule a wake-up, call a model, create a run, or authorize any tool. `executionEnabled: false`, `nextWakeAt: null`, empty `relatedRuns`, and zero `spent` values are truthful placeholders, not progress claims. Existing triggers and action queues are unchanged.

The authenticated, CSRF-protected API supports `POST /api/goals`, `GET /api/goals`, `GET /api/goals/:id`, and full-replacement `PUT /api/goals/:id`. A draft contains:

```json
{
  "objective": "Find suitable research roles",
  "completionCriteria": ["Report three relevant open roles with links"],
  "constraints": ["Remote or Bay Area only"],
  "permittedScope": { "domains": ["web"], "consequentialActions": false },
  "budgets": { "maxRuns": 10, "maxModelCalls": 20, "maxTokens": 50000 }
}
```

Use the returned `revision` as `expectedRevision` on `PUT`; a stale edit returns 409 without overwriting the other revision. Inputs are bounded and unknown fields rejected. The domain list and consequential-action flag record the owner's intended scope; they do not weaken the policy engine or grant execution authority. Budget caps are likewise stored, not yet spent or enforced. Only the authenticated owner can retrieve or revise a draft. The SQLite table is additive for existing installations and retains unrelated records.

Next slices must add explicit pause/resume/cancel semantics, related runs, cumulative budget enforcement, deterministic wake-up, evidence checkpoints, and an owner view before goals can claim to be working. The initial job-research workflow must be implemented and fixture-tested separately; no outreach or applications are authorized by a draft.
