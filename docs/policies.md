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

## Data-processing privacy policy (separate from the above)

Everything above answers "may this tool execute?" A SEPARATE question, answered by `server/policy/data-processing-policy.js` and `~/.u2os/policies/data-processing.yaml`, is "may this DATA reach this DESTINATION?" -- e.g. a local model may be allowed to summarize a sensitive document while the same content is forbidden from ever reaching a remote inference API, independent of whether any tool is involved at all.

Classifications (least to most restrictive): `public`, `personal`, `private`, `sensitive`. Every item type that can reach model-bound context carries one, deterministically, never from model output: `facts.classification`, `entities.classification` (people), `relationships.classification` (commitments, which are `promised` relationships), `calendar_events.classification`, `emails.classification`, and `tasks.classification` all default to `personal`. Event-derived summaries (`ContextAssembler`'s `recentEvents`) inherit their classification from the underlying email/calendar/task row where one exists, or default to `personal` otherwise. `calendar_events.category` is a distinct, unrelated policy-engine sub-category (business/interviews/personal) used only for `calendar.reschedule` autonomy decisions -- never conflate it with `classification`. Destinations: `local_model`, `configured_remote_model`, `external_tool`, `local_ui`. Each `ModelProvider` classifies its own `destination` from its configured endpoint (loopback/private-network baseUrl -> `local_model`, else `configured_remote_model` -- `server/agent/provider-destination.js`), never from model output.

```yaml
sensitive:
  local_models: allow
  remote_models: never
  external_tools: never
  local_ui: allow
```

Enforcement point: `Planner._planWith()` filters `personalContext` for the SPECIFIC provider it's about to call (re-filtered again if a fallback provider with a different destination ends up handling the request), immediately before that provider's `plan()` call -- not earlier in `ContextAssembler`, since the destination isn't known until a provider is actually resolved. `server/agent/context-privacy-filter.js`'s `filterPersonalContextForDestination()` evaluates every item at two independent levels: whole-item (each person in `relevantPeople`, each entry in `commitments`, each entry in `recentEvents`, evaluated on its own classification -- the entire item is dropped if the destination policy doesn't allow it) and per-fact (a person who passes the whole-item check can still have individually-sensitive facts filtered out of their `facts` array). A `confirm` decision is currently treated the same as `never` (omit) for every item type: there is no interactive mid-request confirmation mechanism yet, so omitting is the conservative, fail-safe choice, not a claim that confirmation is implemented. Every withheld item -- fact, person, commitment, or event -- is recorded on an `agent.context_restricted` event (docs/events.md) with its type, id, classification, destination, decision, and the rule that withheld it -- this is never a silent leak and never a silent restriction either.

## What Phase 1 deliberately does not do

- Does not let learned behavior change policy automatically (PROMPT.md explicitly forbids this: "Do not automatically modify security or authorization policies based on learned behavior").
- HTTP rate limiting is in-process and intentionally not a distributed limiter.
- `payments` domain exists in config only to show the shape for a future real integration; no payment tool exists in Phase 1.
- `presentation` (the device/capability subsystem's `presentation.present`/`presentation.notify` tools, docs/devices.md) is a real domain with real tools, unlike `payments` -- it just has no entry in the shipped default `policies.yaml`, so it fails safe to `confirm` like any other unconfigured domain. This is also the one place in the device subsystem that IS fully policy-gated end to end (`PolicyEngine` → `agent_actions` audit → approval → execution) -- capability invocation everywhere else (the raw `POST /api/capabilities/:capability/invoke` route, device management's "test capability") is a documented, deliberate exception, not an oversight; see docs/devices.md's "Known gaps".
