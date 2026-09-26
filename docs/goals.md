# Goals: manual read-only runs

Goals sit above runs and actions. An owner can save a draft and explicitly start one bounded, read-only pass. There is no automatic wake-up: `executionEnabled: false` and `nextWakeAt: null` remain truthful. The run's `objectiveStatus` stays `unverified` even if individual read actions succeed. Existing triggers do not consume goals.

The native **Goals** view creates and edits drafts, shows real linked runs and resource usage, and offers **Run once (read-only)** while budget remains. Starting the first run makes the goal active and freezes the draft fields; pause, scope editing, and completion controls are not yet available. A stale draft revision asks the owner to reload instead of overwriting another edit.

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

Next slices must add goal-level pause/resume/cancel and scope revision, deterministic wake-up, evidence checkpoints, and job-research deduplication before goals can claim to be working persistently. Applications and outreach remain separate consequential actions requiring explicit authorization.
