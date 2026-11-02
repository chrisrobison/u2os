# Majordomo: the Rust daemon

Majordomo is the planned Rust daemon for U2OS's deterministic orchestration. The decision and its constraints are in [ADR 0011](adr/0011-rust-majordomo-migration.md). This page is the working reference: inventory, ownership, interfaces, threat model and phases.

> The filesystem is the storage. The vault is the digital self. The daemon is the majordomo. The AI is an advisor, not an authority.

**Status:** Phase 0 (design) complete; Phase 1 (foundation) implemented in [`majordomo/`](../majordomo/README.md) ([#604](https://github.com/chrisrobison/u2os/issues/604)); Phase 4 (4a durable events and action state machine; 4b leased scheduler; mock capabilities only) implemented, fixture-tested and isolated ([#650](https://github.com/chrisrobison/u2os/issues/650)). Until a phase says otherwise, **Node is authoritative for everything** and Majordomo changes no behaviour.

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
| `GET /api/v1/vault` | Index report: files, valid, invalid (with reasons), notes, link and dangling-link counts, relationship warnings, `generation` (rescans so far) and `lastChange` (added / modified / removed records of the latest rescan that found a difference) |
| `GET /api/v1/memories` | List with filters: `type`, `classification`, `fact=key:value` (repeatable), `q`, `limit` (default 50, max 500), `offset`. Returns `{total, offset, limit, items}` |
| `GET /api/v1/search?q=` | Same as above with `q` required |
| `GET /api/v1/memories/{id}` | One record with its facts and per-fact classification |
| `GET /api/v1/memories/{id}/links` | Outgoing links and backlinks (with the other record's name and path) |
| `GET /api/v1/git` | Repository health (see Git below) |
| `GET /api/v1/memories/{id}/history?limit=` | Commits that touched the record, newest first, across renames |
| `GET /api/v1/memories/{id}/diff?since=&until=` | Unified diff of the record (and its earlier paths) from `since` to `until` or the working tree |
| `GET /api/v1/actions?status=&limit=`, `/actions/{id}`, `GET /api/v1/events?after=&limit=` | 4a: read-only views of `majordomo.sqlite` (opened read-only, never created; lists omit action arguments; events never carry them) |

Errors are `{"error":{"code","message"}}`: 400 bad query or id, 404 unknown id or route, 405 non-GET, 503 `vault_unavailable` (the message never contains paths).

CLI `u2` (separate from `npm run u2`, which is the Node package CLI and is unchanged):

| Command | Phase |
|---|---|
| `u2 status` | 1, implemented |
| `u2 doctor` | 1, implemented (read-only: home, directory and lock-file permissions, socket health, Node data present) |
| `u2 vault check [--vault DIR] [--json]` | 2a, implemented (read-only, no daemon needed) |
| `u2 memory list\|search\|show\|links` (`--json`, `--vault DIR`) | 2b, implemented (reads the vault directly, no daemon needed, same library code as the API) |
| `u2 git status`, `u2 history <id\|path>`, `u2 diff <id\|path> --since …`, `u2 rewind <date\|commit>` | 3a, implemented (read-only; no daemon needed) |
| `u2 git checkin`, `u2 forget` | 3b, 3c |
| `u2 scheduler runs`, `GET /api/v1/scheduler/runs?limit=` | 4b, implemented (read-only; newest claims, `enabled: false`) |
| `u2 actions list\|show`, `u2 events tail` | 4a, implemented (read-only; no daemon needed; read the isolated Phase 4a store) |
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
| 2 | Vault + memory read engine (2a [#607](https://github.com/chrisrobison/u2os/issues/607) scanner and `u2 vault check`: implemented; 2b [#608](https://github.com/chrisrobison/u2os/issues/608) queries, search and links: implemented; 2c [#609](https://github.com/chrisrobison/u2os/issues/609) watcher: implemented), watcher, search, backlinks, `u2 vault check` | Externally edited vault indexed and queryable; unrelated files untouched; parity fixtures vs Node indexer |
| 3 | Git history: 3a read-only health, history, diff, snapshots ([#613](https://github.com/chrisrobison/u2os/issues/613), implemented); 3b check-in of dirty trees ([#614](https://github.com/chrisrobison/u2os/issues/614), implemented); 3c removal with optional history scrub ([#615](https://github.com/chrisrobison/u2os/issues/615), implemented, fixture-tested only; Node remains authoritative and no scrub has been run on a real vault) | Rename-surviving history, read-only snapshots; never pushes |
| 4 | Events, scheduler, action state machine, mock capabilities. 4a ([#650](https://github.com/chrisrobison/u2os/issues/650)): events and action state machine, implemented, fixture-tested, Node authoritative, no handoff. 4b ([#650](https://github.com/chrisrobison/u2os/issues/650)): leased scheduler with durable `(routine, slot)` claims, implemented, fixture-tested, Node authoritative, no handoff. Phase 4 is implemented, fixture-tested and isolated | Simulated crash never duplicates a consequential action |
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
- **Freshness.** The daemon's index checks a fingerprint of the vault files (path, size, mtime, inode) at most every 500 ms and rescans only when it changed, so edits made in any editor appear without a restart. The daemon also runs the watcher described below, so changes are normally picked up within a fraction of a second even with no requests.
- **Privacy.** These routes serve the owner over the owner-only socket and return every classification, each labelled. The data-processing policy that decides what a model may see applies when context is assembled for a model (Phases 5-6), not here.
- **Not yet:** merges and redirect records, lifecycle/archival metadata, Node's implicit owner-to-commitment "promised" relationship.

## Vault watcher (Phase 2c)

`VaultWatcher` keeps the daemon's index current without waiting for a request.

- **Events.** A `notify` watcher (FSEvents on macOS, inotify on Linux) watches the vault recursively, but only `me.md` and the `people/`, `projects/` and `commitments/` folders wake the index; journal writes, `.git`, the README and other files do not. Events are debounced (200 ms of quiet), so forty saves in a row cost one rescan.
- **Reconcile.** Independently, every 30 seconds the index re-checks its fingerprint. This catches what events miss (overflow, network filesystems) and a vault that did not exist at start: the watcher keeps retrying, never creates the vault, and starts watching once it appears. The first refresh after a watch is established also covers anything that changed before it began.
- **One path.** Events, reconcile and requests all end in `IndexHandle::refresh`/`current`, which rescans only when the fingerprint changed, diffs the old and new index, bumps `generation` and announces an `IndexChange` (added, modified and removed `{id, path}`, plus the count of invalid files) to `subscribe()`rs. A rename appears as one removal and one addition; following identity across renames belongs to the history layer (Phase 3). Later phases consume these announcements instead of polling. A subscriber more than 64 events behind gets `Lagged` and should re-read `current()`.
- **Logging.** A change logs counts only (`vault changed added=1 modified=0 …`), never names or contents.
- **Safety.** The watcher is read-only: it writes nothing into the vault (a test checks files, mtimes and the directory listing), stops and joins its thread when the daemon shuts down, and degrades to reconcile-only (with a warning) if the OS watcher cannot be created.

Phase 2 (vault and memory engine) is complete. Merges/redirects and lifecycle metadata remain open ideas, not scheduled work.

## Git history (Phase 3)

Git is the vault's history layer. Majordomo uses the `git` command line rather than a library: no C dependency, the same behaviour as the owner's own git, and Phase 3 needs only plumbing commands. It never pushes, fetches or contacts a remote.

### Owner decisions

- **Dirty trees are checked in** (3b): changes found in the working tree, including edits made in other editors, are pulled in and committed.
- **Conflicts keep the current content** (3b): conflict markers or the repository's conflicted text are never committed; the current content wins.
- **Removal never rewrites history by default** (3c): history is changed only when the owner explicitly asks to scrub it. Git history keeps deleted material, and Majordomo says so whenever it removes a record.

### Read-only features (3a)

- **Runner.** Every call is an argument array run as `git -C <vault>` with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and similar variables removed, no prompts, `GIT_OPTIONAL_LOCKS=0` (so `status` does not rewrite the index), `core.fsmonitor` off, a 30 s timeout and a 16 MiB output cap. Diffs run with `--no-ext-diff --no-textconv`, so configured helper programs never execute. Paths, record ids and revisions are validated before use and follow `--`; dates are parsed by Majordomo, not by git.
- **Health** (`u2 git status`, `GET /api/v1/git`, a `u2 doctor` line): repository present, whether the vault is its top level, branch/HEAD, commit count, staged/modified/untracked/unmerged counts, merge/rebase/cherry-pick/revert/bisect in progress, shallow clone, remote **names** (URLs can carry credentials and are never reported), whether `user.name`/`user.email` are set, and warnings. A vault inside a larger repository is flagged: Majordomo will read it but will not commit to it.
- **History** (`u2 history`, `/memories/{id}/history`): `git log --follow` plus, for files that carry an `id:`, a search of history for that id so a record renamed and rewritten in one commit (which defeats similarity detection) is still followed. Paths are relative to the vault, also when the vault is nested in a bigger repository. Plain paths work too, including for deleted records. Without an `id:`, only similarity-based following is possible; a record's path-derived id changes when its file is renamed.
- **Diff** (`u2 diff <id|path> --since DATE|COMMIT [--until …]`): the record, with all its earlier paths, from that point to another or to the working tree. Before the record existed the diff is against nothing. Output is capped at 1 MiB. Untracked files are not part of a diff until they are checked in.
- **Rewind** (`u2 rewind DATE|COMMIT [--to DIR]`): extracts the vault as of a commit into a new private directory (default `<home>/majordomo/snapshots/<time>-at-<when>`, mode 0700) using `git archive`. The working tree, index and HEAD are never touched (a test compares HEAD, status, index bytes and file contents). The destination must be new or empty and outside the vault and its repository; symlinks and hard links in the archive are not extracted; a failed extraction removes only the directory it created. The snapshot is an ordinary vault: `u2 vault check --vault DIR` and `u2 memory … --vault DIR` read it. It holds private data; delete it when done.
- **Dates.** `YYYY-MM-DD` means the end of that day in UTC, so `rewind 2025-06-01` shows the vault as it was at the close of June 1. A full RFC 3339 time (`2025-06-01T09:30:00-07:00`) is exact. Commit time and the real-world validity of a fact are different things: history answers "what did the vault say then", not "what was true then".

### Check-in (3b)

`u2 git checkin` commits everything dirty in the vault; with `MAJORDOMO_CHECKIN=1` the daemon does the same in the background.

- **When it acts.** Only if the vault directory is the repository's top level and HEAD is on a branch. Otherwise it reports why and does nothing: not a repository (it never runs `git init`), a larger enclosing repository, detached HEAD, or a rebase, cherry-pick, revert or bisect in progress. A merge in progress is concluded (see conflicts).
- **What it commits.** `git add -A` then one commit, honouring `.gitignore`. Edits made in other editors are included. The subject names the records (`vault: update people/alice.md, notes/x.md and 2 more`); the body lists every path with its change letter. Nothing is excluded by default, including `journal/`; the quiet period keeps commits from piling up.
- **Conflicts.** The current content wins and conflict-marker text is never committed. For each unmerged path: if the file on disk has no conflict markers (you already fixed it, or deleted it) that is what is kept; if it still has the `<<<<<<<` / `=======` / `>>>>>>>` markers, this branch's own version is restored and kept. A conflicted path with markers and no version of our own is left alone and the whole check-in is skipped. Majordomo never starts a merge or pull itself; if one is already in progress, the check-in concludes it as a merge commit. The commit body lists the resolved paths.
- **Unattended means quiet.** The commit is never signed, runs no user hooks (`--no-verify`, `core.hooksPath=/dev/null`), and never prompts. It uses your configured identity and falls back to `Majordomo <majordomo@localhost>` only if `user.name`/`user.email` are not set. It never pushes, fetches or touches a remote.
- **Contention.** A present `index.lock` is reported as `busy`, never removed (another git, or an editor's git plugin, may own it). The daemon retries a few times, two seconds apart, then waits for the next change.
- **Background mode.** Off by default (the daemon is not yet the owner of any vault write; see ADR 0011), turned on with `MAJORDOMO_CHECKIN=1`. It does one pass at startup for anything left dirty while the daemon was down, then waits for the vault to be quiet (`MAJORDOMO_CHECKIN_QUIET_SECS`, default 5, at most 3600) after each change the watcher announces and commits once. Changes to non-Markdown files are picked up on the next Markdown change or restart.
- **Limits.** Large binary files in the vault are committed like any other file; keep them in `.gitignore`. A check-in that is killed by the 120 s timeout may leave git's own `index.lock` behind, which Majordomo will then report as busy until it is removed by hand.

### Removal and history scrub (3c)

`u2 forget` removes a record. Ordinary removal never rewrites history; scrubbing is a separate, explicit act. Both are CLI-only (the daemon API stays read-only, as for check-in).

```
u2 forget <id|path> [--vault DIR] [--json]
u2 forget <id|path> --scrub-history --confirm-scrub <vault path> [--acknowledge-remotes]
u2 forget --restore-scrub <backup-id>
```

**Removing.**
- The target is a record id or a vault-relative path (an absolute path is accepted only if it is inside the vault). Only what the vault engine reads as a record qualifies: a visible `.md` file directly in `people/`, `projects/` or `commitments/`. Refused: paths outside the vault or with `..`, symlinks (the file or its collection directory), hidden files, other extensions, deeper folders, anything else in the vault, `me.md` (the owner record), a missing file, an unknown id, and an id claimed by more than one file.
- It refuses unless the vault is the root of its own Git repository with HEAD on a branch and no merge/rebase/cherry-pick/revert/bisect in progress, so the removal can always be checked in. The file must be tracked by Git (an ignored file is left alone: removing it could not be undone).
- Order: first a normal check-in of whatever is pending (so the record's current content, and other edits made elsewhere, are in history and the removal is a commit of its own), then the file is deleted, then the removal is checked in with the 3b check-in (`vault: remove people/x.md`). If that last check-in cannot commit, the file is restored.
- Every result states that Git history still holds the removed material, and that remote and backup copies are unaffected. It never contacts a remote.

**Scrubbing** (`--scrub-history`). This rewrites history of the vault's own repository and cannot be undone except from the backup described below.
- Confirmation: `--confirm-scrub` must equal the record's vault-relative path exactly (not the id, not a glob, no trailing space). Without it the command only prints what it would erase (the commit count and every path in the record's rename trail) and the exact flags to repeat; nothing is changed. There is no prompt and no environment variable that confirms or bypasses it.
- Trail: the paths come from the 3a history across renames (`git log --follow` plus the `id:` search; for an already-removed record its last committed `id:` is used). The scrub removes every one of those paths from every commit. If a trail path exists in the vault now (a different record reused the name) or the record has 2000 or more commits (the trail may be incomplete), it refuses.
- Preconditions, all checked before anything changes: the vault is the repository root (`.git` is a real directory, not a worktree or submodule; a vault nested in a larger repository is refused and that repository is never touched), a clean working tree including untracked files, no operation in progress, not a shallow clone, and no leftover `refs/original/` or `.git-rewrite` from an earlier `filter-branch`.
- Remotes: if any remote exists the scrub is refused unless `--acknowledge-remotes` is also given. Even then Majordomo never pushes, fetches or force-pushes. The output states that remote copies are NOT erased; other clones and backups keep the material, and publishing the rewritten history would need a force-push that the owner must do. Remote-tracking refs inside the vault are rewritten like branches, and a later fetch can bring the material back.
- Steps: save every branch, tag and other commit ref as `refs/majordomo/scrub-backup/<id>/...`; run `git filter-branch --index-filter 'git rm --cached --ignore-unmatch' --prune-empty --tag-name-filter cat` over exactly those refs (filter-branch ships with git; nothing else is needed); delete filter-branch's own `refs/original/`; expire all reflogs; `git gc --prune=now`; check that no rewritten ref reaches a commit touching the paths. Hooks do not run. Annotated tags are re-created (signatures are not kept) and commits that become empty are dropped.
- Failure: the backup stays; branches and tags are put back from it, `.git-rewrite` is removed and the tree is reset to HEAD. The error names the backup and `u2 forget --restore-scrub <id>`. If the cleanup after a successful rewrite fails, the message says which command to run.
- The backup still holds the material. The scrub is not final until the backup refs are deleted; the output prints the command (delete `refs/majordomo/scrub-backup/<id>/*`, expire reflogs, `git gc --prune=now`). `--restore-scrub` puts all refs back (clean tree required) and the material is in history again.
- If the record still exists it is removed (and checked in) first, as above; the scrub then covers that commit too. A record that is already gone is scrubbed by path (an id cannot name it).

**Limits.** Content-level redaction inside records that remain is not done (follow-up). Other records that merely mention a removed record's id or link to it are left as they are. Rewriting a large history with filter-branch is slow. The 3c code is verified with fixture repositories only.

## Events and action state machine (Phase 4a)

**Node remains authoritative.** `majordomo::events` and `majordomo::actions` are an isolated implementation in `<U2OS_HOME>/majordomo/majordomo.sqlite`. Nothing is wired to Node's event bus or action queue, the daemon does not run the executor (`status` still reports `action_queue`, `scheduler` and `event_log` as `disabled`), and there is no handoff. The scheduler is Phase 4b (below); real execution-time policy is Phase 5; there are no real connectors (Phase 6).

### Store

`majordomo.sqlite` (mode 0600, WAL, `synchronous=FULL`, foreign keys on) holds `events`, `actions`, `action_attempts` and a `schema_version` table. Migrations are additive and forward-only; a store written by a newer build is refused. The store never opens `db/u2os.sqlite` or `.runtime-lock.sqlite`: `guard_store_path` accepts only an absolute path, without `.` or `..`, named `majordomo.sqlite` directly inside a directory named `majordomo`, with no symlink at the file or its directory. Tests assert that Node-named files are refused and left byte-identical. All timestamps are integer milliseconds.

### Events

Append-only (database triggers abort `UPDATE` and `DELETE`), with a monotonic `seq` as replay cursor, `id`, `type`, `ts_ms`, `source`, optional actor and subject, JSON `data` (at most 64 KiB), `correlation_id` and `causation_id`. `EventBus::publish` persists first, then delivers from the log in `seq` order under one lock to bounded per-subscriber channels (default 256, at most 64 subscribers). A subscriber that falls behind is marked lagged and refills from the log, so delivery is gap-free and ordered. `subscribe(pattern, Cursor::Start | After(seq) | Now)` replays from a sequence cursor, also after a restart. Patterns are `*`, `domain.*` or an exact type, as in Node. Events carry ids, states and error classes, never action arguments or error text, and `Debug` output redacts payloads.

### Action state machine

`actions::state::TRANSITIONS` is the only source of legality. An action is `awaiting_approval` when consequential, otherwise `queued`.

| From | Trigger | To |
|---|---|---|
| awaiting_approval | approve | queued |
| awaiting_approval | reject, cancel | cancelled |
| queued, retry_wait | cancel | cancelled |
| queued, retry_wait | lease | leased |
| leased | expire_lease | queued |
| leased | begin_attempt | executing |
| leased | stop_failed / stop_cancelled / stop_dead_letter | failed / cancelled / dead_letter |
| executing | complete | completed |
| executing | fail_retry | retry_wait |
| executing | fail_dead_letter | dead_letter |
| executing | fail_terminal | failed |
| executing | mark_uncertain, expire_lease | outcome_uncertain |
| failed, cancelled | requeue | queued |
| outcome_uncertain | resolve_done | completed |
| outcome_uncertain | resolve_not_done | queued |

`completed` and `dead_letter` have no exits. Every other pair returns a typed `ActionError::Illegal` and writes nothing. Each transition and its `action.transition` event commit in one transaction; events chain through `causation_id` and share the action's `correlation_id`.

- **Idempotency.** `idempotency_key` is `UNIQUE`; the default key is Node's `tool:(correlation||id):id`. Submitting an existing key (or id) returns the stored action untouched (`created: false`), whatever its state or arguments.
- **Approval gate.** A consequential action cannot be leased until approved (checked in the lease query, again in the executor, together with a SHA-256 of the arguments taken at submit time). `requeue` refuses an unapproved consequential action. The `Authorizer` is injected and mocked; real policy parity is Phase 5.
- **Leases.** Owner plus expiry; expired means `lease_expires_at <= now`, as in Node. `begin_attempt` needs the live lease. Settling an attempt needs the attempt to be `executing` for the same owner, so a late "zombie" worker cannot rewrite an outcome.
- **Retries.** Node's classification and backoff: `min(60 s, 1 s * 2^(n-1))`, five attempts, then `dead_letter`. A `retryable` error on a tool that does not support idempotency is only retried if the capability marks it `safe_to_retry` (known to have failed before the effect handoff); otherwise it becomes `owner_attention_required` and `failed`, as in Node.

### Crash semantics

`begin_attempt` commits `executing` before any capability runs. If the process dies, the lease eventually expires and `recover` (run first by every lease call and at start) moves that action to `outcome_uncertain` and closes its attempt as `uncertain`; a lease that never reached `executing` simply returns to `queued`. An uncertain action is never leased, retried or requeued automatically. `requeue` is refused; only `resolve_uncertain(ConfirmedDone)` (completes) or `resolve_uncertain(ConfirmedNotDone)` (back to `queued`, attempt count kept) leaves the state, by an explicit owner call recorded in the event. A capability panic or an `outcome_uncertain` error class takes the same path. This is conservative: a crash between recording `executing` and the effect is also uncertain. Tests drop and reopen the store, kill a child process with `SIGKILL` mid-execution, and assert exactly one recorded effect, `outcome_uncertain`, refused requeue and the same action on re-submission.

### Parity with Node

`majordomo/tests/fixtures/actions-parity.json` is read by `tests/majordomo-parity-actions.test.js`, which drives Node's real queue store (no Rust binary needed) and asserts the `node` column, and by `majordomo/tests/actions_parity.rs`, which asserts the `rust` column and that the table equals the fixture exactly. It covers the transition table, classification, backoff, failure outcomes, idempotency keys and lease/retry scenarios. Recorded differences (each carries a `note` in the fixture):

| Case | Node | Rust |
|---|---|---|
| Executing when the lease expires | re-leased to the next worker, which refuses a non-idempotent retry as `failed` + `outcome_uncertain` | `outcome_uncertain` status, never leased again |
| Capability reports an unknown outcome | `failed` with `error_class = outcome_uncertain` | `outcome_uncertain` status |
| Expired lease before execution | handed straight to the next owner | recovered to `queued`, then leased |
| Approval and cancel-before-approval | in `agent_actions`, not the queue | `awaiting_approval` in the same table |
| Owner resolution of uncertain outcomes | none (requeue is refused) | `resolve_uncertain` |
| Identity of a duplicate | `action_id` is unique | the idempotency key and the id are both unique |

### What is mock, what remains

Mock: capabilities (counting, failing, hanging, panicking) and the authorizer, in `actions::mock`. No heartbeat renewal is wired into the executor (`renew_lease` exists); keep `lease_ms` above a capability's worst case, or accept `outcome_uncertain`. Remaining: policy parity at execution time (Phase 5), real capabilities and the agent bridge (Phase 6), ownership handoff and any import of Node's queue (Phase 7).

## Scheduler (Phase 4b)

**Node remains authoritative.** `majordomo::scheduler` is isolated in the same `majordomo.sqlite` (additive migration 2: `scheduler_runs`, `scheduler_lease`); it never opens Node's databases. Routine definitions are supplied programmatically (`Routine`, `Trigger`, or `Trigger::from_when` on a front-matter-shaped `when:` mapping). **Reading routine files from the vault, and taking over routines, is Phase 7**; nothing here parses the vault. The daemon does not run a ticker: `status` still reports the scheduler as disabled and `u2 scheduler runs` says so. A "run" only enqueues a mock `routine.run` action through the 4a actions API.

### Semantics

- **Slots** (Node's formats): `daily:YYYY-MM-DD` (local date), `every:<minutes>:<floor(epoch_ms / window)>`, `event:<event id>`, `manual:<random id>`. `daily` is due from its local time until 60 minutes later and on the listed `days`; a late tick claims only the current slot. Missed runs are never caught up (an `every` tick after hours of downtime claims one current window; a missed morning brief is skipped). `every_minutes` is at least 15. Event routines cannot name `routine.`, `vault.`, `agent.`, `action.` or `run.` events, and `routine.*` events dispatch nothing (recursion ban).
- **Claim.** `INSERT OR IGNORE` into `scheduler_runs` with `UNIQUE(routine, slot)` in an immediate transaction, before any work. A claimed slot never runs again, across restarts, threads or processes, even if it was throttled or the process died.
- **Cap.** At most 30 non-throttled claims created in the last rolling hour (the new claim excluded, throttled rows excluded, manual runs counted but never throttled). Over the cap the row becomes `throttled` (reason `hourly_routine_limit`) and no action is created. The cap check, the status change and the event commit with the claim.
- **Events.** `routine.fired` (data: routine, routineRunId, trigger, slot, eventId) and, for a throttled claim, `routine.failed` with reason `hourly_routine_limit`, which is what Node publishes; Node has no `routine.throttled`. Only identifiers are recorded or put in the action arguments, never triggering event content.
- **Enqueue and crash recovery.** After the claim, the action is submitted with idempotency key `routine:<routine>:<slot>` and the claim moves `started` to `enqueued`. A crash in between leaves a `started` claim; `recover()` (run by every leader tick) submits with the same key and gets the same action, so there is never a second one. Tests cover the crash before enqueue, the crash after enqueue before marking, and a SIGKILLed child process.
- **Lease.** One row `scheduler_lease('tick', owner, expires_at_ms)`. `tick()` takes or renews it; another owner's unexpired lease means the tick does nothing; `expires_at <= now` is takeable (Node's rule); `release_lease()` frees it. Default lease 5 minutes (the trigger engine's). The lease stops two daemons both ticking; the claim, not the lease, is the correctness guarantee, so event and manual fires need no lease.
- **Time zone and DST.** Node uses the server's local zone through JavaScript `Date`. Rust has no IANA database here, so the zone is injected: `Zone::Fixed{offset_min}` or `Zone::UsDst{std_offset_min}` (US rules). A wall time skipped by spring-forward (02:30) resolves with the pre-change offset, so it fires at 03:30 local; a repeated wall time (fall-back 01:30) resolves to the earlier instant, and the repeated hour shares the day's slot, so it fires once. Both match Node under a real `TZ=America/Los_Angeles` in the parity test. Other DST rules are not implemented.

### Parity

`majordomo/tests/fixtures/scheduler-parity.json` is read by `tests/majordomo-parity-scheduler.test.js` (Node's real `parseTrigger`, `dueSlot` and routine runner with a temp home, vault and fake agent) and `majordomo/tests/scheduler_parity.rs`. It has 27 due-slot cases (grace edges, days, DST gap/overlap, half-hour offsets, midnight, `every` windows), valid and invalid `when` shapes, and scenarios for no re-fire, no catch-up, event redelivery, the 30 per hour cap with manual and aging. Recorded differences (also under `differences` in the fixture):

| Area | Node | Rust |
|---|---|---|
| Time zone | process-local | injected `Zone` (fixed or US DST) |
| Throttle event | `routine.failed` | same |
| Cap clock | `Date.now()` | injected clock |
| Lease | routine runner has none; the trigger engine leases its rows | one ticker lease; claims still dedupe |
| Run | runs the agent in-process; status `completed` | enqueues a mock `routine.run` action; status `enqueued` |
| Event matching `if.equals` | `String(value)` of any scalar | same for scalars; objects are not matched |

### Status of the Rust migration

Phase 4 (4a and 4b) is implemented, fixture-tested and isolated: no handoff, Node owns events, the queue and the scheduler. **Phases 5 to 8 are not started** (policy parity at execution time, real capabilities and the agent bridge, vault routine loading and ownership handoff, cutover) and need a separate scope decision before any begins.
