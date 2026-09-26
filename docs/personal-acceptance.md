# Personal acceptance and two-week dogfooding

This is an owner-run procedure, **not completed live validation**. Current
evidence is isolated fixtures listed below and in the [progress record](personal-agent-progress.md).
The demo does not prove real model quality, provider availability or a usable
upgraded personal installation. A consolidated six-workflow personal-mode
fresh/upgrade harness remains unfinished.

## Safe preparation

For CI and repeatable regression checks, run from the repository:

```sh
npm test
npm run test:e2e
```

Both suites create isolated fixtures. For a focused subset:

```sh
node --test tests/installation-mode.test.js tests/dashboard-generation.test.js tests/agent-continuation.test.js tests/gmail-provider.test.js tests/imap-provider.test.js tests/action-account-binding.test.js tests/goal-research-schedules.test.js tests/brave-search-deadline.test.js tests/recovery-compare.test.js
npx playwright test -c tests/e2e/playwright.config.js daily-driver-demo.spec.js job-research.spec.js goal-research-schedule.spec.js personal-connectors.spec.js
```

These are component and demo acceptance tests, not a single personal-mode
end-to-end proof. Never point test harnesses at an owner data directory.

For a fresh personal installation, choose a new, empty, private directory and
start with `U2OS_HOME=/absolute/new-personal-home npm start`. Do not run `seed`
or `demo` in it. Create the owner passphrase; expect no fictional contacts,
messages, meetings, commitments or tasks. Disconnected services and the
unconfigured planner must say unavailable. Configure only the accounts and
model destination you explicitly choose, through the normal owner UI; review
permissions and [privacy policy](policies.md) first. Remote models can receive
only the context permitted for their destination.

For an existing installation, record its release and privately note known
records, owner link, accounts, approvals, goals and spending. Follow the
[offline backup procedure](backups.md) before upgrading: use an independent
archive passphrase and keep the key outside the archive. Do not delete presumed
demo records or reset the data home. On upgrade, check record preservation,
stable owner identity after rename, account-specific routing, and retained
run/goal spending. Restore rehearsal must use a new isolated destination;
restored homes remain inactive. **Activation, original retirement and ledger
reconciliation are unsupported. Do not remove the recovery marker.**

Before any live check, the owner must explicitly choose its account, model
destination, read scope and timing. Repository authorization is not permission
to access accounts, send messages or change real events. Keep live checks
read-only by default. Existing automated triggers/notifications may have their
own permissions: inspect them and pause unwanted work first. Creating a new
connection does not authorize a test send.

## Six acceptance workflows

Record each as fixture-tested, owner live-pass, owner live-fail, or unavailable;
never silently substitute a demo pass for a personal failure.

| Workflow | Owner check and observable result | Existing fixture evidence / limit |
|---|---|---|
| Morning brief | Inspect today's schedule, tasks and important mail. Verify each included item against its source and cache freshness. Ask for a read-only summary: no sends, calendar changes or task completion. Missing sources must remain explicit. | [Dashboard tests](../tests/dashboard-generation.test.js), [demo story](../tests/e2e/daily-driver-demo.spec.js); demo routine actions are not live approval authority. |
| Relevant mail and grounded reply | Choose one connected account. Ask to find the latest message from a named sender, read it, check availability and draft only. Verify sender/message, time zone, actual conflicting events and draft text. No invented IDs or send. | [Continuation](../tests/agent-continuation.test.js), [Gmail](../tests/gmail-provider.test.js), [IMAP](../tests/imap-provider.test.js); Gmail provider query and bounded IMAP cached coverage differ. These fixtures do not prove real-model judgment. |
| Meeting preparation | In the dashboard context selector choose **Before a meeting**, then the intended event. Check topic, date/time, attendees, relevant contacts/history and provenance. Unknown attendees must not become invented personal facts. | [Event-based dashboard tests](../tests/dashboard-generation.test.js); locally synchronized data, not a live-provider completeness guarantee. |
| Persistent research | Follow the [job research walkthrough](job-research-walkthrough.md). Save actual criteria, inspect two bounded passes, review one finding, reload/restart, verify deduplication and cumulative spending, then pause. No applications or outreach. | [Two-pass browser fixture](../tests/e2e/job-research.spec.js), [finite schedule fixtures](../tests/goal-research-schedules.test.js); current openings and fit quality need owner validation. |
| Exact approval | In fixtures, inspect account, recipient and complete proposed change before approval; switch active account and verify the approved identity cannot change. In personal mode, inspect a proposal without approving delivery; reject it when finished. IMAP must identify its associated SMTP sender. | [Account-binding tests](../tests/action-account-binding.test.js), [notification binding](../tests/notification-account-binding.test.js). Any real send/event mutation requires a separately explicit owner-driven test with exact account, recipient/change and timing. |
| Restart and outage | In fixtures, interrupt a run, resume, and check that completed effects are not repeated. Stalled search must fail clearly with retained evidence/spending, not mock success. In personal use, inspect durable runs/approvals after an ordinary restart; do not deliberately interrupt a live consequential action. | [Model checkpoints](../tests/agent-model-checkpoints.test.js), [queue worker](../tests/action-queue-worker.test.js), [search deadline](../tests/brave-search-deadline.test.js), [inactive recovery comparison](../tests/recovery-compare.test.js). Recovery comparison is recorded evidence, not delivery proof or activation. |

Action success is not objective success. Inspect completed, pending, failed,
skipped and uncertain actions independently. Run `objectiveStatus` remains
`unverified`; the owner must judge whether the requested outcome was achieved.
If an external outcome is uncertain, inspect the provider manually before
making any fresh proposal. Never requeue an archived recovery action or repeat
a request merely because the browser lost its response.

## Two-week private scorecard

Keep the record locally; do not commit private prompts, recipients, credentials,
provider responses or diagnostic bundles. Use anonymous task labels. Each day:

1. Choose one morning/read/draft task with an observable outcome before starting.
2. Record outcome (success/partial/failed/uncertain), evidence checked and whether
   the stated completion was correct. Record account-routing errors separately.
3. Count owner interventions: clarifications, corrections, reconnects and manual
   recovery. Mark expected approval separately from an avoidable intervention.
4. Count duplicate external effects, false completion claims and irrelevant
   notifications. Zero duplicates is a safety gate, not an average target.
5. Record elapsed time to useful result and time waiting on approval/provider.
   Record planning-model calls, reported input/output tokens and measurement
   coverage. Goal runs skip unmetered optional embeddings; ordinary chat's
   optional embedding usage is not in that ledger. Monetary cost remains
   unavailable; missing usage is unknown, not free.
6. Inspect **Goals** for evidence, blockers, next wake and spending. Pause/cancel
   unwanted work and confirm no further pass starts. Retain useful evidence.

Days 1–3: read-only brief/retrieval, one draft and meeting preparation. Days 4–7:
two research passes and scope/review corrections. Days 8–10: finite daily-or-
slower research, browser closure and ordinary restart while no consequential
action is running. Days 11–14: repeat successful responsibilities, inspect an
outage if naturally encountered, and compare fresh versus upgraded behavior.
Use fixtures for deliberate outages, interrupted sends and restore rehearsals.

At days 7 and 14, report task success rate with denominator, intervention count,
duplicate effects, false completion claims, irrelevant notifications, median/
worst useful-result latency and usage coverage. Do not imply a dollar total.
Treat any wrong-account effect, privacy leak or duplicate delivery as a stop-
and-investigate failure. File focused issues using redacted reproduction steps.
Report unperformed workflows and unavailable sources alongside passes.

Live Google read/sync validation remains [#150](https://github.com/chrisrobison/u2os/issues/150).
No two-week dogfooding or live checks are claimed by this document. A future
coding workspace runner is [separately deferred in #291](https://github.com/chrisrobison/u2os/issues/291):
isolated execution, filesystem and resource boundaries, Git/tests/artifacts—not
unrestricted shell access in the personal-agent loop.
