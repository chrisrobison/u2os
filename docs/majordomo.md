# Majordomo: the Rust daemon

Majordomo is the planned Rust daemon for U2OS's deterministic orchestration. The decision and its constraints are in [ADR 0011](adr/0011-rust-majordomo-migration.md). This page is the working reference: inventory, ownership, interfaces, threat model and phases.

> The filesystem is the storage. The vault is the digital self. The daemon is the majordomo. The AI is an advisor, not an authority.

**Status:** Phase 0 (design) complete; Phase 1 (foundation) implemented in [`majordomo/`](../majordomo/README.md) ([#604](https://github.com/chrisrobison/u2os/issues/604)). Until a phase says otherwise, **Node is authoritative for everything** and Majordomo changes no behaviour.

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
| `GET /api/v1/status` | Home path, pid, uptime, version, per-responsibility ownership (Node owns all; Majordomo is `read-only` for `vault_index`, `disabled` elsewhere), socket path |
| `GET /api/v1/vault` | Index report: files, valid, invalid (with reasons), notes, link and dangling-link counts, relationship warnings |
| `GET /api/v1/memories` | List with filters: `type`, `classification`, `fact=key:value` (repeatable), `q`, `limit` (default 50, max 500), `offset`. Returns `{total, offset, limit, items}` |
| `GET /api/v1/search?q=` | Same as above with `q` required |
| `GET /api/v1/memories/{id}` | One record with its facts and per-fact classification |
| `GET /api/v1/memories/{id}/links` | Outgoing links and backlinks (with the other record's name and path) |

Errors are `{"error":{"code","message"}}`: 400 bad query or id, 404 unknown id or route, 405 non-GET, 503 `vault_unavailable` (the message never contains paths).

CLI `u2` (separate from `npm run u2`, which is the Node package CLI and is unchanged):

| Command | Phase |
|---|---|
| `u2 status` | 1, implemented |
| `u2 doctor` | 1, implemented (read-only: home, directory and lock-file permissions, socket health, Node data present) |
| `u2 vault check [--vault DIR] [--json]` | 2a, implemented (read-only, no daemon needed) |
| `u2 memory list\|search\|show\|links` (`--json`, `--vault DIR`) | 2b, implemented (reads the vault directly, no daemon needed, same library code as the API) |
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
| 2 | Vault + memory read engine (2a [#607](https://github.com/chrisrobison/u2os/issues/607) scanner and `u2 vault check`: implemented; 2b [#608](https://github.com/chrisrobison/u2os/issues/608) queries, search and links: implemented; 2c [#609](https://github.com/chrisrobison/u2os/issues/609) watcher), watcher, search, backlinks, `u2 vault check` | Externally edited vault indexed and queryable; unrelated files untouched; parity fixtures vs Node indexer |
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

## Vault reader (Phase 2a)

`majordomo::vault` reads the vault exactly as the Node indexer interprets it: `me.md` plus regular, non-hidden `.md` files directly in `people/`, `projects/` and `commitments/`; files over 256 KiB, invalid YAML, invalid classifications and duplicate ids are reported, never silently dropped; a path-derived id is `ent_vault_` + the first 20 hex characters of SHA-256 of the relative path. It never writes, never creates the vault and never follows symlinks.

Parity is enforced by a shared golden: `tests/majordomo-vault-golden.test.js` indexes `majordomo/tests/fixtures/vault/` with the Node indexer and must equal `majordomo/tests/fixtures/vault-expected.json`; the Rust test `matches_the_node_indexer_golden` asserts the same file. Regenerate on purpose with `UPDATE_MAJORDOMO_GOLDEN=1 node --test tests/majordomo-vault-golden.test.js`.

Deliberate differences from Node (none affects a vault Node accepts, except where noted):

| Area | Node | Majordomo |
|---|---|---|
| `id:` | must match `ent_…` and name a record in the database | also accepts a hyphenated UUID (for new canonical memories, ADR 0011); cannot check the database, so existence is not verified |
| Symlinked `people/`, `projects/`, `commitments/` | followed | skipped with a note (no escape from the vault) |
| Unknown `!!` YAML tags | error | ignored (custom `!tag` is an error in both) |
| `me.md` | linked to the owner account's entity | read as a record with a path-derived placeholder id |
| `id:` given as a list | accepted if it stringifies to a valid id | invalid |
| Case where `^` follows a lone `\r` in the heading fallback | matches | does not match |

## Memory queries (Phase 2b)

`majordomo::memory` builds everything from the files and holds it only in memory; deleting the daemon loses nothing.

- **Search** is case-insensitive substring matching, and every term must match somewhere. Weights: name 10, path and id 3, fact key or value 2, notes 1. Results report where terms matched (`name`, `id`, `path`, `fact:<key>`, `notes`) and a snippet for notes. Queries are limited to 256 characters and 8 terms. No embeddings.
- **Relationships** come only from explicit declarations: a `relationships:` list in frontmatter (`- predicate: sister_of`, `target: ent_bob`; predicates are lowercase identifiers) and inline `[text](u2os:TARGET)` or `<u2os:TARGET>` links in the body (predicate `links_to`; fenced code blocks are ignored). A name that is merely mentioned in text creates no link. A target resolves by record id, then by vault-relative path; one that matches nothing is kept and reported as dangling. Malformed `relationships` entries are ignored with a warning in `/api/v1/vault`. Node still treats `relationships` as an ordinary fact, so existing vaults are unaffected.
- **Freshness.** The daemon's index checks a fingerprint of the vault files (path, size, mtime, inode) at most every 500 ms and rescans only when it changed, so edits made in any editor appear without a restart. A watcher that pushes changes instead is #609.
- **Privacy.** These routes serve the owner over the owner-only socket and return every classification, each labelled. The data-processing policy that decides what a model may see applies when context is assembled for a model (Phases 5-6), not here.
- **Not yet:** merges and redirect records, lifecycle/archival metadata, Node's implicit owner-to-commitment "promised" relationship.
