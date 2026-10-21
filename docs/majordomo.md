# Majordomo: the Rust daemon

Majordomo is the planned Rust daemon for U2OS's deterministic orchestration. The decision and its constraints are in [ADR 0011](adr/0011-rust-majordomo-migration.md). This page is the working reference: inventory, ownership, interfaces, threat model and phases.

> The filesystem is the storage. The vault is the digital self. The daemon is the majordomo. The AI is an advisor, not an authority.

**Status:** Phase 0 (design) complete; Phase 1 (foundation) in progress. Until a phase says otherwise, **Node is authoritative for everything** and Majordomo changes no behaviour.

## What stays, what moves

Reuse as-is: the Web Components UI, connectors (Gmail, calendar, IMAP/SMTP, Apple add-on, job-hunt MCP server), the model router and providers, voice, the Chrome extension, the backup/restore tooling and the MCP servers. Rust talks to these through narrow boundaries (MCP over stdio, a local socket), not by reimplementing them.

Move over time: vault indexing and safe writes, memory queries, policy evaluation, the durable action queue, scheduler and routines, event dispatch, capability invocation, audit.

## Migration inventory

Sizes are lines of JavaScript under `server/`.

| Subsystem | Existing implementation | Proposed Rust replacement | Migration risk |
|---|---|---|---|
| Vault | `server/vault/` (1.5k): `markdown.js` frontmatter + 256 KiB/regular-file/no-symlink rules, `indexer.js` projection into entities/facts, `watcher.js` 5 s stat polling, `writeback.js` minimal-edit atomic writes, `journal.js`, `exporter.js` | `vault::{parser,scanner,watcher,writer}`; same format and limits; `notify` + periodic reconcile | **Medium.** Must match YAML core-schema parsing and `id:` binding exactly; write-back must keep minimal line edits |
| Memory | `server/memory/` (0.8k) over `entities`, `facts`, `fact_revisions`, `relationships`, `embeddings`; authority labels, disputes, supersession, soft delete | Read-only index first (id/type/metadata/FTS/backlinks) built from files; DB-only facts (connectors, inference) stay in Node | **High.** Memory is part vault projection and part DB-authoritative; split ownership is the hard part. Rust owns only vault-sourced memory until Phase 7 |
| Policy | `server/policy/` (0.5k): `policy-engine.js`, `policies-loader.js` (home + vault overlay, fail-closed), `data-processing-policy.js` (classification × destination) | `policy::{evaluator,privacy}`; typed decision projection | **Medium.** Small, pure, highly testable; the risk is subtle context-resolution differences. Shared fixtures are mandatory |
| Runtime | `server/index.js`, `server/runtime/home-guard.js` (SQLite exclusive txn on `.runtime-lock.sqlite`), diagnostics, logging | `runtime::{lifecycle,supervisor,health}`, own lock file, `tracing` | **Low** for Phase 1 (separate lock). **Medium** at handoff |
| Events | `server/events/` (0.3k): `event-bus.js` persists then delivers; `events` table with correlation/causation; SSE hub; maintenance/retention | `events` module with a bounded bus and a durable log in Rust's store | **Medium.** The UI relies on SSE and the journal subscribes to the bus; Node must keep receiving events during coexistence |
| Queue | `server/agent/action-queue-store.js`, `action-queue-worker.js`, `approval-manager.js`: statuses `queued, leased, executing, retry_wait, completed, failed, dead_letter, cancelled`; idempotency keys; `outcome_uncertain` via error class; execution-time policy recheck | `actions` module with an explicit state machine in `majordomo.sqlite` | **High.** Duplicate side effects if ownership overlaps. Handoff only with the queue quiesced; uncertain outcomes carried over verbatim |
| Scheduler / routines | `server/triggers/` (0.8k, leased rows), `server/routines/` (`routine_runs` claims `(routine, slot)`; max 30 runs/hour) | `scheduler` with the same claim semantics, DST-aware | **High.** Same double-fire hazard as the queue |
| Capabilities / add-ons | `server/addons/`, `server/mcp/`, `server/tools/`, `server/packages/` (frozen workflow engine) | Capability registry + MCP stdio adapter (Phase 6); packages workflow language is **not** ported | **Medium** |
| Agent / models | `server/agent/` (6.2k): planner, plan validator, context assembly, privacy filters, providers | Narrow proposal interface; Node router stays the provider boundary | **Low** if kept as a boundary; **very high** if reimplemented, so do not |
| Auth | `server/security/`: scrypt owner passphrase, `u2os_session` cookie, CSRF, loopback | Phase 1: Unix socket + peer uid. No password handling in Rust until a phase needs it | **Medium.** Do not weaken the browser model |
| Integrations | `server/integrations/` (3.1k), `server/jobhunt/`, `server/coding-agent/`, `server/devices/`, `server/voice/` | Retain in Node | n/a |
| Backup / restore | `server/backup/` (1.2k): encrypted snapshots, inactive restore, recovery quarantine | Retain; Phase 8 adds Rust-store awareness | **Medium.** Backups must include `majordomo/` once it holds state |
| API / UI | `server/api/` (3.4k), `public/` | Retain; Node proxies or UI talks to Majordomo per ownership flips | **Medium** |

## State ownership

```text
                 Node today                         Majordomo (Phase 1+)
 U2OS_HOME/
   db/u2os.sqlite          Node only (all tables)      never opened
   .runtime-lock.sqlite    Node runtime guard          never opened
   config/                 Node reads/writes           read-only (config.json, installation.json)
   credentials/            Node only                   never read
   majordomo/              -                           Majordomo only (0700)
     majordomo.lock        -                           single-instance flock
     run/majordomo.sock    -                           owner-only local API
     majordomo.sqlite      -                           from Phase 4
 <vault>/                  Node indexer + write-back   Majordomo reads from Phase 2;
                                                       writes only after a recorded handoff
```

Per-responsibility owner, flipped only by the Phase 7 procedure (quiesce → export → import → verify → record handoff → start in the new owner → disable in the old):

| Responsibility | Owner now | Planned first Rust phase |
|---|---|---|
| Vault index (read) | Node | 2 (shadow, read-only) |
| Vault writes | Node | 7 |
| Policy decisions | Node | 5 (shadow comparison), 7 (authoritative) |
| Action queue | Node | 4 (mock capabilities only), 7 |
| Schedules / routines | Node | 4 (isolated), 7 |
| Event log | Node | 4, 7 |
| Sessions / owner auth | Node | stays Node until the UI is served differently |

A handoff is recorded in a small owner-readable file (`majordomo/ownership.json`, introduced with the first handoff) that both runtimes check at startup; a runtime that is not the recorded owner of a responsibility starts that responsibility disabled and says so in `status`.

## Interfaces (Phase 1)

Local API over `majordomo/run/majordomo.sock` (HTTP/1.1 over a Unix socket). Versioned under `/api/v1`, deliberately matching Node's `/api/health` naming where there is an equivalent.

| Route | Purpose |
|---|---|
| `GET /api/v1/health` | Liveness: `{status, version}` only. No dependency detail |
| `GET /api/v1/status` | Home path, pid, uptime, version, per-responsibility ownership (all `disabled` in Phase 1), socket path |

CLI `u2` (separate from `npm run u2`, which is the Node package CLI and is unchanged):

| Command | Phase |
|---|---|
| `u2 status` | 1 |
| `u2 doctor` | 1 (home, permissions, lock, socket, Node coexistence, toolchain-independent checks) |
| `u2 vault check`, `u2 memory ...` | 2 |
| `u2 history`, `u2 diff`, `u2 rewind` | 3 |
| `u2 actions list` | 4 |
| `u2 daemon start`/`stop` | later (foreground `majordomo` first; units documented) |

The CLI is a client of the same socket API; it contains no business logic of its own.

## Threat model (summary)

Assets: vault contents, credentials, the action queue and audit trail, owner authority.

| Threat | Mitigation |
|---|---|
| Another local user reads or calls the API | Socket in a 0700 directory, socket 0600, `SO_PEERCRED`/`getpeereid` uid must equal the daemon's uid, no TCP |
| Stale or hijacked socket path | Lock acquired before the socket is touched; only a socket we own (matching uid, type socket) is replaced; symlinks refused |
| Two daemons / Node and Rust both act | flock on `majordomo.lock`; ownership file; non-owner disabled; Rust never opens Node's SQLite |
| Path traversal / symlink escape in vault | Canonicalise under root, refuse symlinks and non-regular files (Phase 2) |
| Prompt injection or a model widening its own authority | Models only propose; policy check before data reaches a model and again before execution; policy files not writable by agent capabilities (Phases 5–6) |
| Confused deputy / stale approval | Approved action keeps its original target account and arguments; revalidated at execution (Phase 4–5) |
| Secrets in logs, argv or Markdown | Structured logs carry ids and codes only; no secrets in config or argv; credentials stay in Node's vault until a phase owns them |
| Replay after crash causing duplicate effect | Durable state machine, idempotency keys, `outcome_uncertain` requires owner review (Phase 4) |
| Malformed untrusted input (YAML, JSON) | Size limits, typed parsing, fuzz/property tests in Phase 2 |
| Git history retains deleted private data | Documented; never auto-commit external edits, never push (Phase 3) |

Out of scope: a compromised owner account, a malicious root user, network attackers (no network exposure).

## Phases

| Phase | Deliverable | Acceptance |
|---|---|---|
| 0 | This page and ADR 0011 | Reviewed; no code |
| 1 | Cargo crate, config, lock, lifecycle, logging, socket API, `u2 status`/`doctor` | Clean start/stop, second instance refused, peer checks, tests green |
| 2 | Vault + memory read engine, watcher, search, backlinks, `u2 vault check` | Externally edited vault indexed and queryable; unrelated files untouched; parity fixtures vs Node indexer |
| 3 | Git history | Rename-surviving history, read-only snapshots; no auto-publish |
| 4 | Events, scheduler, action state machine, mock capabilities | Simulated crash never duplicates a consequential action |
| 5 | Policy parity | Shared fixtures identical to Node; no bypass via routine/agent/event/API |
| 6 | Capability registry, MCP adapter, agent proposal interface | End-to-end task with a replaceable agent and a mock capability |
| 7 | Ownership handoffs, one subsystem at a time | Parity, restart recovery, UI still works, then retire Node code |
| 8 | Benchmarks (1k/10k/100k memories), packaging (launchd/systemd units) | Measured numbers, optimisation of observed bottlenecks only |

## Compatibility rules

- Fixtures live under `majordomo/tests/fixtures/` and are shared with a Node-side test that records Node's observable output; a Rust test compares.
- Existing `U2OS_HOME` installations stay valid. Majordomo only adds `<home>/majordomo/`. Deleting that directory returns the home to pure-Node operation.
- Everything Majordomo reads must tolerate being run against a copy of a real home in tests; tests never touch the owner's real home or vault.
