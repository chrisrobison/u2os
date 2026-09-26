# Goals: manual read-only runs

Goals sit above runs and actions. An owner can save a draft and explicitly start one bounded, read-only pass. There is no automatic wake-up: `executionEnabled: false` and `nextWakeAt: null` remain truthful. The run's `objectiveStatus` stays `unverified` even if individual read actions succeed. Existing triggers do not consume goals.

The native **Goals** view creates and edits drafts, shows real linked runs and resource usage, and offers **Run once (read-only)** while budget remains. Starting the first run makes the goal active and freezes its fields until paused. A stale revision asks the owner to reload instead of overwriting another edit.

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

Use the returned `revision` as `expectedRevision` on `PUT`; a stale edit returns 409 without overwriting the other revision. Inputs are bounded and unknown fields rejected. Only the authenticated owner can retrieve or revise a draft or call `POST /api/goals/:id/runs`. A run requires at least one selected domain; each call creates one linked run using the existing bounded agent path. Only registered tools with category `read` and a domain in `permittedScope.domains` can execute. The `consequentialActions` flag records future intent only; it does **not** permit a send, edit, application, or outreach in a goal run. The policy gate and account binding still apply, and the queue rechecks goal scope before execution.

Only one unfinished run is allowed per goal; a new pass waits until that run is resolved. Run count and model-call budgets are enforced before work starts; provider-reported tokens are accumulated and checked before accepting a model plan or beginning another step. Token spending is only as complete as provider usage reporting; unknown usage is not invented. Cost remains unavailable. Runs, usage, and failures persist across restart. The additive `agent_runs.goal_id` migration leaves unrelated runs and existing data intact. No run is automatically retried just because an HTTP response was lost: inspect the goal's linked runs before invoking another pass.

The owner can inspect a linked run in the Goals view after reload. `GET /api/goals/:id/runs/:runId` checks both goal ownership and the exact run link, then returns current run/step statuses, action IDs, the stored run response, and bounded previews of **executed** read results, with `Cache-Control: no-store`. It omits action arguments and account bindings. Credential-like result fields are redacted; large previews are marked truncated. Pending, blocked, failed, and uncertain steps have no completed-result preview. The UI renders provider/model text as text, not markup. Results are evidence to review, not proof that the completion criteria were met.

**Pause goal**, **Resume goal**, and **Cancel goal** persist across restart. `POST /api/goals/:id/control` takes `{ operation: "pause" | "resume" | "cancel", expectedRevision }`. A changed-state request with a stale revision returns 409; same-state retries are harmless. Pause/cancel blocks new runs immediately and requests safe cancellation of unfinished linked runs. Each run is bound to its original goal revision; a lifecycle revision invalidates old planning, steps, and queued work even after resume. The additive snapshot migration binds older runs once because their active goal scope was immutable before these controls shipped. A provider call already in flight retains its real outcome. Resume permits a new bounded pass only after unfinished work is resolved; it does not replay the old run or automatically start work. Goal cancellation is terminal. Spending and evidence are never reset or deleted by these controls.

To change a started goal, pause it, edit its objective, criteria, constraints, domains, or budgets, then **Save revised goal**. The existing full-replacement `PUT` accepts draft or paused goals only. Saving increments the revision but leaves the goal paused, preserves all linked runs and cumulative usage, and never starts work. Lowering a budget below already-spent resources prevents another pass; raising it explicitly permits more work without resetting the ledger. Resume is a separate owner action. Old runs cannot use the revised scope or regain validity. Run evidence labels the original goal revision and a bounded preview of the original run objective (including its saved criteria/constraints), not the current goal text. Historical observations remain evidence from their original scope, not proof of progress against changed criteria.

Next slices must add deterministic wake-up, evidence checkpoints, and job-research deduplication before goals can claim to be working persistently. Applications and outreach remain separate consequential actions requiring explicit authorization.
