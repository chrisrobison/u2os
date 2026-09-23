# U2OS Policy Engine — Phase 1

No LLM output executes a consequential tool without passing through this engine. The planner proposes; this evaluates; the tool layer (only after this returns `requiresApproval: false`, or after explicit user approval) executes.

## Autonomy levels

```
LEVEL 0 — Observe     inform the user, no action
LEVEL 1 — Recommend   suggest an action
LEVEL 2 — Prepare     draft/prepare, do not execute
LEVEL 3 — Confirm     execute only after explicit user approval
LEVEL 4 — Delegated   act automatically within configured limits
LEVEL 5 — Domain      manage an explicitly delegated domain autonomously
```

Phase 1 implements levels 0, 2, 3, and 4 end to end (level 1/5 are representable in config but not exercised by the demo scenario).

## Config file

`~/.u2os/policies/policies.yaml`, loaded at startup and on `SIGHUP`/explicit reload endpoint. Example (also the Phase 1 seed default, written by `server/seed/` on first run if the file doesn't exist):

```yaml
email:
  read: always        # level 0/no gate
  draft: always
  send:
    friends: autonomous   # level 4
    business: confirm     # level 3
    legal: never           # level 5 boundary, always blocked in Phase 1

calendar:
  create: autonomous
  reschedule:
    interviews: confirm
    default: confirm    # anything not explicitly categorized (including 'personal') requires confirmation
                          # NOTE: the doc example above this file originally sketched
                          # `personal: autonomous`, but the shipped seed policy
                          # deliberately omits it -- see the vertical slice acceptance
                          # test in docs/architecture.md, which requires the Sarah
                          # reschedule (a 'personal' event) to genuinely require
                          # confirmation. Add `personal: autonomous` yourself once you
                          # actually want personal reschedules to be autonomous.
                          #
                          # ⚠️ If you've connected a real Google Calendar (see
                          # docs/connectors.md), know that EVERY event synced from it
                          # is tagged category:'personal' -- Google gives us nothing
                          # more specific to key off yet. Setting `personal: autonomous`
                          # then means ALL of your real calendar's reschedules become
                          # autonomous, not just the ones you'd personally call
                          # "personal". Leave this at `confirm` unless you're sure
                          # that's what you want.

contacts:
  search: always

tasks:
  create: autonomous
  complete: autonomous

notifications:
  send: autonomous

payments:
  under_50: confirm
  over_50: never
```

`always` / `autonomous` / `confirm` / `never` map to autonomy levels 0, 4, 3, 5(blocked) respectively for the purpose of `requiresApproval`.

## Evaluation

`policyEngine.evaluate({ tool, arguments, context })`:

1. Look up `domain = tool.domain`, `operation = tool.name.split('.')[1]`.
2. If `tool.category === 'read'` → always `{ autonomyLevel: 0, requiresApproval: false }` (Phase 1 does not restrict reads).
3. Else look up `policies[domain][operation]`. A plain string governs directly. For an object keyed by sub-category, the engine resolves **from `context` only**. A known but unmatched category may use `default`; missing context always becomes `confirm`, even if `default` is autonomous.
4. `never` → `{ autonomyLevel: 5, requiresApproval: true, blocked: true }` — the tool layer refuses to execute even if "approved"; this is a hard boundary, surfaced to the user as blocked, not as an approvable action.
5. Every evaluation is written to `agent_actions` regardless of outcome (audit trail), including the resolved `domain`, `rule`, and `reason`.

**Security note:** sub-category resolution never reads proposed action `arguments`. Only `context`, derived from authoritative server data by `_buildEvalContext`, is trusted. New object-keyed domains require a server-side context builder before they can resolve to anything other than `confirm`.

## Audit log fields (`agent_actions` table)

```
who requested it       requested_by (user id / 'user')
what requested it       request_text (original utterance, if any)
what model proposed it  model
which policy evaluated it  policy_domain, policy_rule
whether approval was required  requires_approval
who approved it         approved_by, approved_at
who rejected it         rejected_by, rejected_at
what tool executed it    tool, arguments
the result               result, status
what memory informed it  context_provenance (retrieved fact/entity/event ids, after data-processing filtering -- see Explainability below)
```

## Explainability

`server/agent/explain.js`'s `explainAction(id)` (also `GET /api/actions/:id/explain`) assembles the reasoning summary, model, policy domain/rule, autonomy level, approval/rejection identity, result, `contextProvenance` (which retrieved facts/entities/events actually reached the model for this plan), and the full correlated event chain in causal order. The browser's reusable `<u2-why>` component exposes this from pending/resolved approval cards and action-related activity entries.

Recommendations use the parallel `explainRecommendation(id)` / `GET /api/recommendations/:id/explain` path. It exposes the deterministic evaluator summary, source-event reference, relevant prepared-dashboard title, and correlated event trail. Both paths render concise stored summaries and references as inert text; neither stores, reconstructs, or displays raw model chain-of-thought.

## Durable execution re-evaluation

Authorization is not frozen when an action enters the durable queue. Immediately before a worker invokes a tool, U2OS re-resolves the registered tool and re-evaluates current policy, approval/rejection state, and action freshness from authoritative server state. A newly blocked action is cancelled, a newly confirmation-required action returns to owner attention, and stale intent does not execute silently. Provider failures are classified deterministically outside the model. Uncertain expired executions are never replayed for a non-idempotent tool; they stop for owner review.

For `email.send`, `calendar.create`, and `calendar.reschedule`, the runtime also stores the selected provider, connection instance, display label, and credential revision in the action audit record before approval or enqueueing. The approval card shows this account identity. Approval and queue execution resolve that exact instance even if the active provider changes; a deleted, disconnected, or reconnected account stops before an external call. A queued payload differing from its audited proposal also stops. Calendar reschedules reject events from another account. Older pending actions without a binding require owner review. IMAP still delegates sends to a single global SMTP transport; its sender identity is shown and checked again before delivery, and explicit per-IMAP sender pairing is tracked in #176.

## Data-processing privacy policy (separate from the above)

Everything above answers "may this tool execute?" A SEPARATE question, answered by `server/policy/data-processing-policy.js` and `~/.u2os/policies/data-processing.yaml`, is "may this DATA reach this DESTINATION?" -- e.g. a local model may be allowed to summarize a sensitive document while the same content is forbidden from ever reaching a remote inference API, independent of whether any tool is involved at all.

Classifications (least to most restrictive): `public`, `personal`, `private`, `sensitive`. Every item type that can reach model-bound context carries one, deterministically, never from model output: `facts.classification`, `entities.classification`, `relationships.classification`, `calendar_events.classification`, `emails.classification`, and `tasks.classification` all default to `personal`. Derived items use the strongest contributing source classification: a standalone fact includes its entity identity, and a commitment includes both its relationship and entity content, so neither may become less restricted than either source. Event summaries inherit classification from the underlying email/calendar/task row where one exists. `calendar_events.category` is a distinct, unrelated policy-engine sub-category used only for action policy. Destinations: `local_model`, `configured_remote_model`, `external_tool`, `local_ui`; provider destinations come from authoritative endpoint configuration, never model output.

```yaml
sensitive:
  local_models: allow
  remote_models: never
  external_tools: never
  local_ui: allow
```

Enforcement points: `ContextAssembler` filters each candidate before sending text to a configured embedding provider, whose destination is known there. Later, `Planner._planWith()` filters the complete assembled context for the specific planning provider and repeats that work for a fallback with a different destination. `filterPersonalContextForDestination()` evaluates people, standalone `relevantFacts`, commitments, events, and facts nested under an allowed person independently. A `confirm` decision is treated as omit because no interactive mid-request confirmation path exists. Withheld items are recorded on `agent.context_restricted`, and filtered provenance references are removed so action explainability describes only context that actually reached the planner.

## What Phase 1 deliberately does not do

- Does not let learned behavior change policy automatically (PROMPT.md explicitly forbids this: "Do not automatically modify security or authorization policies based on learned behavior").
- HTTP rate limiting is in-process and intentionally not a distributed limiter.
- `payments` domain exists in config only to show the shape for a future real integration; no payment tool exists in Phase 1.
- `presentation` (the device/capability subsystem's `presentation.present`/`presentation.notify` tools, docs/devices.md) is a real domain with real tools, unlike `payments` -- it just has no entry in the shipped default `policies.yaml`, so it fails safe to `confirm` like any other unconfigured domain. This is also the one place in the device subsystem that IS fully policy-gated end to end (`PolicyEngine` → `agent_actions` audit → approval → execution) -- capability invocation everywhere else (the raw `POST /api/capabilities/:capability/invoke` route, device management's "test capability") is a documented, deliberate exception, not an oversight; see docs/devices.md's "Known gaps".
