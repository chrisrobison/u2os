# U2OS architecture

U2OS is a persistent personal digital agent—an operating system for a person's digital self—not a chatbot with storage attached. Its durable loop is **observe → remember → anticipate → act → observe outcome → learn**. The append-only event log is the source of truth; structured memory is a projection; models are replaceable infrastructure.

## Runtime and authority

U2OS is one Node.js 22 ESM process with native HTTP, SQLite through `node:sqlite`, and a no-build Web Component client. Data lives under `U2OS_HOME`. The server binds to `127.0.0.1` by default. First-run setup creates one owner with a scrypt passphrase hash. Private APIs and SSE require an expiring session; writes also require same-origin evidence and CSRF.

```text
owner, connector, or trigger
           ↓
 normalized event / structured request
           ↓
 planner proposes structured actions
           ↓
 policy engine (outside the model)
       ┌───┴──────────────┐
 block / confirm      authorize
       └──── audit ───────┤
                          ↓
                    registered tool
                          ↓
                 result + outcome event
```

The `MockModelProvider` is the only planner and records `mock-model-provider` in audit rows. It cannot call tools directly. Every consequential action passes through policy; feedback, login state, and voice confidence cannot loosen it. Object-keyed policies resolve only from authoritative server-derived context. Missing context confirms rather than guessing.

The event bus persists events before delivering them to memory projections and SSE. Memory uses entities, facts, and relationships with confidence and provenance. Connectors sit behind provider interfaces and implemented real adapters use the encrypted vault. Triggers and synchronization run in the server, not the browser. The browser uses same-origin REST/SSE and trusted Web Components.

## Approval vertical slice

“Move my 2 PM meeting with Sarah to tomorrow afternoon” produces a `calendar.reschedule` proposal. The server derives the stored event category, policy returns `confirm`, and a pending audit row is shown. Approval identity comes only from the session. Policy is re-evaluated before execution and correlated outcome events enter the log.

## Known gaps

- The planner is deterministic and narrow; there is no real model provider.
- Authentication is single-owner/passphrase only; there are no passkeys, roles, or supported internet exposure.
- Rate limits are memory-backed, not distributed or durable.
- SQLite has one synchronous in-process connection; durable leases and an external-action queue remain Milestone 5.
- Voice similarity is simplified and is not identity. Some dashboard types remain placeholders.
- SSE recovery, browser end-to-end coverage, and full accessibility verification remain Milestone 3.
- CalDAV/IMAP and skill network-permission enforcement are not implemented.
- `node:sqlite` remains experimental. Retention and production rollback tooling are not implemented.

See [PLAN.md](../PLAN.md) for current priorities and [PROMPT.md](../PROMPT.md) for the historical specification.
