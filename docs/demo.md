# Five-minute daily-driver demo

This walkthrough uses U2OS's normal model, context, policy, queue, audit, memory, API, and browser paths. The default model and connectors are deterministic local mocks; they implement the same interfaces as configured real providers, but they do not contact Gmail, Google Calendar, or a hosted model.

## Start an isolated demo

```sh
npm install
npm run demo
```

The command binds to loopback and uses `~/.u2os-demo`, keeping the demo separate from `~/.u2os`. It refuses an existing demo database unless reuse is explicit:

```sh
npm run demo -- --reuse
```

Choose another location or port with `--home /absolute/path` and `--port 4100`. U2OS never resets or deletes that location for you.

Open <http://127.0.0.1:4000>, create the owner passphrase, and enter:

> What's going on today? Handle anything routine that doesn't need me and tell me what I need to pay attention to.

The seeded recruiter email reaches the planner through bounded, privacy-filtered context. The browser shows a useful briefing, an already-completed local notification, an email reply waiting for approval, and a proposed memory.

1. Expand **Why?** on the email card. Verify the stored decision summary, policy rule, model identifier, context references, and correlated event trail. This is an explanation summary, not hidden chain-of-thought.
2. Select **Approve**. The email runs through the durable SQLite queue and changes to **Approved and done**. With the mock connector, the sent message is stored locally; a real Gmail connector uses the same tool boundary.
3. Open **Memory**. Attach the follow-up candidate to **Jamie Alvarez**, enter `follow_up_request` as the fact key, and select **Accept**. The proposal becomes a confirmed fact with provenance.
4. Stop U2OS with Ctrl-C. Restart with `npm run demo -- --reuse`, then log in again.
5. Ask: **What do you remember about Jamie?** The answer is assembled from the confirmed fact persisted before restart.

## What the demo proves

- Implemented: context retrieval and privacy filtering, strict plan validation, policy outside the model, durable action delivery, approval, explainability, memory confirmation, provenance, and restart persistence.
- Mock by default: planning, email, calendar, tasks, search, and notification providers. Mock side effects stay in the local demo database/event log.
- Available when configured: OpenAI-compatible or Anthropic planning, Gmail, Google Calendar, Google Contacts, Brave Search, and webhooks.
- Degraded safely: a disconnected real connector falls back for reads with a health warning; an uncertain non-idempotent Gmail/Calendar outcome stops for owner attention rather than replaying.
- Not demonstrated as production-ready: internet exposure, strong voice authentication, distributed workers, or provider-backed idempotency for Gmail/Google Calendar.

The automated equivalents are `tests/e2e/daily-driver-demo.spec.js` for the coherent browser flow and `tests/daily-driver-demo.test.js` for the close/reopen persistence proof.
