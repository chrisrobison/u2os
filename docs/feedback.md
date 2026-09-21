# U2OS Feedback Loop (Phase 7)

PROMPT.md's last phase: "After actions occur, record outcomes... use feedback to improve future prioritization and behavior. Do not automatically modify security or authorization policies based on learned behavior." That last sentence is a hard constraint carried through this whole design — feedback tunes *what the agent surfaces and how it ranks things*, never *what it's allowed to do without asking*.

## Data model

```sql
CREATE TABLE IF NOT EXISTS feedback_events (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,     -- 'agent_action' | 'recommendation' | 'dashboard_card' | 'notification'
  subject_id TEXT NOT NULL,
  outcome TEXT NOT NULL,          -- 'accepted' | 'rejected' | 'edited' | 'ignored' | 'postponed' | 'dismissed' | 'marked_useful'
  detail TEXT NOT NULL DEFAULT '{}',  -- JSON, e.g. { editedFields: [...] } for an 'edited' outcome
  correlation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_subject ON feedback_events(subject_type, subject_id);
```

Every row is itself published as a `user.feedback` event on the normal event bus (already a reserved type in `docs/events.md`) — feedback is data like everything else in U2OS, not a side channel.

## What generates a feedback row

- `POST /api/actions/:id/approve` / `.../reject` (existing routes) — now also write a `feedback_events` row (`outcome: 'accepted'|'rejected'`) alongside their existing behavior. This is additive, not a rewrite of the approval flow.
- A new, small `POST /api/feedback` route for the cases that aren't already a distinct approve/reject action: dismissing a recommendation card (Phase 6's `recommend`-level suggestions), marking a notification useful/not useful, postponing a task, dismissing a dashboard card. The frontend components that render these (`<u2-approval>` for recommendations, a new lightweight dismiss control on notification/task cards) call this route with `{ subjectType, subjectId, outcome, detail }`.
- Editing a drafted email before sending (`email.draft` → user changes the body → `email.send`) is detected server-side, recorded automatically as `outcome: 'edited'` — no separate UI action needed for this one. **Matched by an explicit `draftId` argument on the `email.send` call, not by `correlation_id` alone.** An earlier version matched "the most recent draft sharing this exact correlation_id," which security review found unsound the moment more than one draft could share a correlation id (e.g. one turn drafting two different emails) — it could misattribute an edit to the wrong draft, or flag a send that was never drafted at all. `email.send`'s schema now has an optional `draftId` field; no `draftId` means no detection (a false negative, never a guess) — see `server/feedback/email-edit-detector.js`'s file comment for the exact, current scope of what this can and can't catch.

## What reads feedback back

`server/feedback/prioritizer.js` — a small, explicit scoring function, not a black box: `scoreForSuggestion({ tool, domain, requestedBy })` looks at recent `feedback_events` for that tool/domain (rejection rate, ignore rate) and returns a bounded adjustment (e.g. -0.2..+0.2) applied to Phase 6's `evaluateEvent()` when it's deciding between `notify`/`recommend`/`ignore` for borderline cases — a domain the user has dismissed 5 times in a row gets quietly deprioritized toward `ignore`/lower-urgency placement, never toward skipping the policy engine for consequential actions (that gate is untouched, per the hard constraint above). This adjustment is logged (which past feedback rows influenced this decision) so it's inspectable, not mysterious — same "never feel like it's mysteriously doing things" principle as the trigger engine.

## What this explicitly does not do

- Never changes `policies.yaml`, autonomy levels, or anything `policy-engine.js` reads, automatically. A user could always choose to hand-edit policy config themselves based on what they've noticed — that's a human decision through the existing config surface, not something feedback data writes to.
- Not a training loop or model fine-tuning. Real planning providers are supported, but this feedback path remains a small deterministic scoring adjustment over proactive suggestion prioritization; it never rewrites prompts, model weights, or authorization policy.
