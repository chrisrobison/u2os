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

The deterministic `MockModelProvider` remains the default. An optional OpenAI-compatible chat-completions provider can target local or hosted endpoints; its API key is stored in the encrypted vault. Every returned plan is locally schema-validated against the registered tools before policy evaluation. Neither provider can call tools directly. Feedback, login state, and voice confidence cannot loosen policy. Object-keyed policies resolve only from authoritative server-derived context.

The event bus persists events before delivering them to memory projections and SSE. Memory uses entities, facts, and relationships with confidence and provenance. Connectors sit behind provider interfaces and implemented real adapters use the encrypted vault. Triggers and synchronization run in the server, not the browser. The browser uses same-origin REST/SSE and trusted Web Components.

## Agent decomposition

`server/agent/agent.js` is an orchestrator, not a monolith: it composes focused services rather than implementing planning, policy, execution, and approval state inline.

```text
Agent
├── ContextAssembler   bounded context for a planning request (server/agent/context-assembler.js)
├── Planner            objective + context -> structured candidate plan (server/agent/planner.js)
├── ActionEvaluator     tool resolution + authoritative policy context + decision (server/agent/action-evaluator.js)
│   └── PolicyEngine    (server/policy/policy-engine.js, unchanged)
├── ActionExecutor      executes an already-authorized tool, records outcome (server/agent/action-executor.js)
├── ApprovalManager      pending-approval lifecycle: create/get/approve/reject, re-evaluates
│                        policy immediately before an approved action executes (server/agent/approval-manager.js)
└── EvaluatorRegistry    proactive per-event-type decision logic, keyed by event pattern
    └── built-in evaluators for email.received / calendar.event_approaching /
        task.overdue / commitment.made (server/agent/proactive/)
```

`evaluateAndMaybeExecute()` remains the one gate every consequential action passes through, regardless of whether it originated from a chat message, a trigger, or a proactive evaluator's `context.proposeAction(...)`. `ContextAssembler` in this form is a Phase 1 seam (it currently assembles the same minimal `{toolRegistry, eventBus, correlationId, actor}` Agent always built inline); bounded, ranked, provenance-tagged personal-context assembly is planned work, not yet implemented -- see PLAN.md. `EvaluatorRegistry` lets new proactive behavior (including future skills) register `{eventPattern, evaluate(event, context)}` without editing Agent; it can add new decisions, never a new way to bypass `ActionEvaluator`/`PolicyEngine`.

## Approval vertical slice

“Move my 2 PM meeting with Sarah to tomorrow afternoon” produces a `calendar.reschedule` proposal. The server derives the stored event category, policy returns `confirm`, and a pending audit row is shown. Approval identity comes only from the session. Policy is re-evaluated before execution and correlated outcome events enter the log.

## Known gaps

- `ModelRouter` resolves a provider per role (planner/classifier/summarizer/extractor/response/embeddings) with one deterministic fallback retry, and a second, non-identical Anthropic adapter exists alongside the OpenAI-compatible one (docs/models.md). Bounded personal-context retrieval for the Planner, an HTTP route for multi-provider/role config, and an embeddings-capable provider remain Milestone 2 work.
- Authentication is single-owner/passphrase only; there are no passkeys, roles, or supported internet exposure.
- Rate limits are memory-backed, not distributed or durable.
- SQLite has one synchronous in-process connection; durable leases and an external-action queue remain Milestone 5.
- Voice similarity is simplified and is not identity. Some dashboard types remain placeholders.
- SSE recovery, browser end-to-end coverage, and full accessibility verification remain Milestone 3.
- CalDAV/IMAP and skill network-permission enforcement are not implemented.
- `node:sqlite` remains experimental. Retention and production rollback tooling are not implemented.

See [PLAN.md](../PLAN.md) for current priorities and [PROMPT.md](../PROMPT.md) for the historical specification.
