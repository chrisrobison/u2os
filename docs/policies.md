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
```

## What Phase 1 deliberately does not do

- Does not let learned behavior change policy automatically (PROMPT.md explicitly forbids this: "Do not automatically modify security or authorization policies based on learned behavior").
- HTTP rate limiting is in-process and intentionally not a distributed limiter.
- `payments` domain exists in config only to show the shape for a future real integration; no payment tool exists in Phase 1.
