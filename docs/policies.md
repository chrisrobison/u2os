# U2OS Policy Engine

No LLM output executes a consequential tool without passing through this engine. The planner proposes; this evaluates; the tool layer (only after this returns `requiresApproval: false`, or after explicit user approval) executes.

This engine is what makes it safe for U2OS to act **on the owner's behalf** ([ADR 0007](adr/0007-owned-vault-is-the-digital-self.md)). Every source of intent goes through it with the same result for the same action: chat, voice, [routines](routines.md) running unattended, triggers, goals, and proactive evaluators. A routine has exactly the authority policy grants and no more. With the default policy, a routine that wants to send email leaves a pending approval, just as chat does. Delegated authority lives in your vault as `policies.yaml` (see [Where the policy lives](#where-the-policy-lives)).

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

## Where the policy lives

The effective policy is the home policy (`U2OS_HOME/policies/policies.yaml`, written with the defaults below on first run), overridden **per domain operation** by your vault policy (`<vault>/policies.yaml`) when that file exists. The vault file is the one you own and edit ([vault](vault.md)):

```yaml
# <vault>/policies.yaml: only what differs from the home policy is needed
tasks:
  create: confirm          # ask me first
calendar:
  reschedule:
    personal: autonomous   # I delegate personal reschedules
    default: confirm
```

- `npm run vault:export` copies the current home policy into the vault unchanged, so nothing changes until you edit it. An existing vault policy is never replaced.
- Edits apply on the next decision, without a restart. Every evaluation checks both files' change signature.
- Only `always`, `autonomous`, `confirm` and `never` are accepted, as a level per operation or per sub-category.
- **An invalid vault policy fails closed.** This includes bad YAML, an unknown level, the wrong shape, a non-regular file, or more than 64 KiB. Every non-read action then requires confirmation, `never` blocks still apply, reads are unaffected, and the error is reported by `GET /api/vault` (`policy.error`). U2OS never falls back to a possibly looser home policy just because your file is broken.
- Sub-categories (`friends`, `business`, `personal`, …) are still resolved only from authoritative server context, never from the proposed action.

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

For `email.send`, `calendar.create`, and `calendar.reschedule`, the runtime also stores the selected provider, connection instance, display label, and credential revision in the action audit record before approval or enqueueing. The approval card shows this account identity. Approval and queue execution resolve that exact instance even if the active provider changes; a deleted, disconnected, or reconnected account stops before an external call. A queued payload differing from its audited proposal also stops. Calendar reschedules reject events from another account. Older pending actions without a binding require owner review. IMAP sends additionally bind the explicitly associated SMTP instance and credential revision; changing or removing that sender blocks an earlier approval before delivery.

## Package authority

Actions requested by installed packages ([plugin architecture](plugin-architecture.md#6-permissions-and-delegated-authority)) go through the same evaluation, audit, approval and queue path, with one additive, tighten-only overlay applied after the voice, goal and account-binding gates (`server/packages/authority.js`):

1. **Permission**: the capability's required permissions must be declared by the package and granted by the owner. Otherwise the action is `blocked` with rule `package-permission`.
2. **Package policy**: a deterministic package policy may deny (`blocked`, rule `package-policy:<name>`) or require approval. `automatic` leaves this policy file's decision unchanged, so a package can never make an action more permissive than `policies.yaml`.

Package capabilities use their id as `domain.operation` here (`mock.email-send` → domain `mock`, operation `email-send`); with no rule they require confirmation. Audit rows carry `requested_by = package:<id>` and a `package_context` JSON column naming the package, automation, skill, run, step, permission and policy decision. When a queued package action executes, the worker re-checks that the package is still installed, enabled and granted, and blocks it otherwise (or when no package runtime is attached).

## Data-processing privacy policy (separate from the above)

Assistant transcript outputs also inherit a runtime classification floor from the exact filtered inputs used for their model call. The runtime records `private` or `sensitive` on the run; sensitive contributing context, history, summaries or observations tighten the output, and later rounds/continuations cannot lower it. Model JSON cannot supply this authority. Historical assistant turns use the stricter of their stored label and the run floor before each destination's history/summary filtering. Ordinary known-private outputs remain reusable under owner policy.

Upgrade is additive and preserves transcript rows and execution state. Existing runs, orphaned assistant turns and unknown output metadata lack trustworthy provenance and are conservatively treated as sensitive for model reuse; this can reduce remote historical context, not erase it from the owner transcript. User-authored turns retain their existing private/sensitive semantics. This is source-label inheritance, not content-based secret detection or automatic retroactive reclassification following every later source edit. Broader artifact taint propagation remains separate work.

Everything above answers "may this tool execute?" A SEPARATE question, answered by `server/policy/data-processing-policy.js` and `~/.u2os/policies/data-processing.yaml`, is "may this DATA reach this DESTINATION?" -- e.g. a local model may be allowed to summarize a sensitive document while the same content is forbidden from ever reaching a remote inference API, independent of whether any tool is involved at all.

Classifications (least to most restrictive): `public`, `personal`, `private`, `sensitive`. Vault files set them with frontmatter `classification`, `sensitive_keys` and per-key `classifications` ([vault](vault.md)); an invalid value rejects the file rather than lowering privacy. Every item type that can reach model-bound context carries one, deterministically, never from model output: `facts.classification`, `entities.classification`, `relationships.classification`, `calendar_events.classification`, `emails.classification`, and `tasks.classification` all default to `personal`. Derived items use the strongest contributing source classification: a standalone fact includes its entity identity, and a commitment includes both its relationship and entity content, so neither may become less restricted than either source. Event summaries inherit classification from the underlying email/calendar/task row where one exists. `calendar_events.category` is a distinct, unrelated policy-engine sub-category used only for action policy. Destinations: `local_model`, `configured_remote_model`, `external_tool`, `local_ui`; provider destinations come from authoritative endpoint configuration, never model output.

```yaml
sensitive:
  local_models: allow
  remote_models: never
  external_tools: never
  local_ui: allow
```

Enforcement points: `ContextAssembler` filters each candidate before sending text to a configured embedding provider, whose destination is known there. Later, `Planner._planWith()` filters the complete assembled context for the specific planning provider and repeats that work for a fallback with a different destination. `filterPersonalContextForDestination()` evaluates people, standalone `relevantFacts`, commitments, events, and facts nested under an allowed person independently. A `confirm` decision is treated as omit because no interactive mid-request confirmation path exists. Withheld items are recorded on `agent.context_restricted`, and filtered provenance references are removed so action explainability describes only context that actually reached the planner.

## What the policy engine deliberately does not do

- Does not let routines, model output, or retrieved content change policy. A routine's instruction is an objective for the planner, not an authorization.
- Does not let learned behavior change policy automatically (PROMPT.md explicitly forbids this: "Do not automatically modify security or authorization policies based on learned behavior").
- HTTP rate limiting is in-process and intentionally not a distributed limiter.
- `payments` domain exists in config only to show the shape for a future real integration; no payment tool exists in Phase 1.
- `presentation` (the device/capability subsystem's `presentation.present`/`presentation.notify` tools, docs/devices.md) is a real domain with real tools, unlike `payments` -- it just has no entry in the shipped default `policies.yaml`, so it fails safe to `confirm` like any other unconfigured domain. This is also the one place in the device subsystem that IS fully policy-gated end to end (`PolicyEngine` → `agent_actions` audit → approval → execution) -- capability invocation everywhere else (the raw `POST /api/capabilities/:capability/invoke` route, device management's "test capability") is a documented, deliberate exception, not an oversight; see docs/devices.md's "Known gaps".
