# Local runtime ownership

U2OS acquires a separate `.runtime-lock.sqlite` guard in the canonical local
data home before application migrations, interrupted-run reconciliation or
worker startup. A second runtime, even on another port or through a directory
symlink, fails with `HOME_IN_USE` and guidance to stop the other instance and
wait for shutdown. Different homes can acquire separate guards; this is not a
multi-instance scheduler or synchronization feature.

The guard contains only a format version, never accounts, credentials or
personal records. It uses a dedicated SQLite rollback-journal exclusive
transaction, not the application database's write lock or a time-expiring
lease. See SQLite's [file-locking documentation](https://www.sqlite.org/lockingv3.html).
The lock is released when its connection closes or the owning process dies.
Never delete or replace the guard file to bypass ownership: a new inode could
let two processes believe they own the same home. Unrecognized nonempty files, symlinks,
foreign ownership and invalid guard schemas fail closed without overwriting
them. Guard artifacts remain on disk after a normal stop; they are not stale
PID files that require manual deletion.
An empty reserved guard file from interrupted first-start initialization can
complete its atomic SQLite setup; it contains no owner records to overwrite.

Fresh personal and explicit demo startup remain supported. Only the current
bootstrap's successfully acquired guard artifacts are ignored when testing
whether a demo destination is empty. Existing application data and ambiguous
unmarked homes retain their previous conservative initialization rules.

The internal server handle provides:

- `closed`: settles after HTTP closes, started background work and HTTP
  handlers finish, and runtime ownership is released.
- `shutdown()`: idempotently stops accepting connections, closes existing
  connections, stops background workers and returns `closed`. A disconnected
  client does not cancel or make a running external action safe to repeat;
  started handlers are still drained and their durable outcomes retained.
- `stopBackgroundWorkers()`: drains background work only; HTTP and started
  request handlers are not stopped by this method alone.

A same-process restart can await an already-closing runtime. An active runtime
is never displaced. Early bootstrap failures clean prepared device adapters
and release ownership. Failed worker setup closes its listener and drains
started work. If cleanup reports failure, ownership is retained until process
exit rather than presenting an unsafe replacement as ready. A hung provider
can therefore hold shutdown open; this safety boundary is not a claim that all
provider calls already have useful deadlines.

After process interruption, the existing durable queue still determines
whether an action was not attempted, completed or outcome-uncertain. Acquiring
runtime ownership does not approve actions, reset leases or replay uncertain
non-idempotent effects.

`npm run setup-owner`, `npm run seed` and `npm run maintain` acquire the same
guard before opening/migrating application SQLite or changing initialization
mode. Stop the server and wait for shutdown before running them, including
maintenance previews: opening storage may apply additive migrations. They fail
immediately without application changes while a runtime or another offline
operation owns the home. Owner setup holds ownership through its prompt and
asynchronous hashing; success and failure release only after work settles.
Demo seeding still refuses personal homes. Low-level imported store helpers
are not independently guarded; runtime-owned callers must not recursively
acquire an offline guard.

Limitations: this guard coordinates supported local runtimes and the three
offline commands above, not arbitrary
external database/config writers, network filesystems, cross-host copies or
restored homes at different paths. Backup creation also acquires this guard
through private staging and publication. Restore validates privately before
acquiring destination ownership and publishing into an empty isolated home.
A durable `.u2os-recovery.json` marker precedes payload writes; any marker
blocks runtime and offline mutation startup before migrations or reconciliation,
even malformed metadata or an alleged active status. Interrupted publication
remains incomplete; successful verification remains inactive. No activation
bypass exists. Explicit original-instance retirement and restored-action
reconciliation are subsequent work; do not remove the marker to start a copy.
See [offline verification](backups.md). Stop older releases before upgrading: they do not participate
in this guard protocol. No live owner-account or hardware validation was used.

Installation initialization also assigns a stable random ID in existing
`config/installation.json`. Additive private atomic writes happen under this
guard; read-only identity inspection never assigns one. This is separate from
owner/account identity, carries no authority and is not a cross-path lock.
Inactive restore records the archived ID (or honest legacy absence) for the
future explicit original-instance retirement workflow. See [identity and
metadata compatibility](backups.md#installation-identity-prerequisite).

The preview-first `npm run recovery:review` command separately acquires this
guard on a verified inactive recovery home. `--apply` quarantines unfinished
database authorization, queues/runs and schedules, revokes archived sessions,
and retains completed evidence and resource counters. It never activates the
home or calls models/providers. Unsupported schemas are refused without
migrations. See [database-work review](backups.md#preview-and-quarantine-unfinished-database-work).

`npm run recovery:connectivity` uses the same guard after a verified stopped-work
checkpoint. Its explicit `--apply` preserves archived credential/config bytes
privately outside runtime lookup, disconnects account instances and revokes
cached device trust. Every failure and successful checkpoint remains inactive;
there is still no activation or original-retirement bypass. See
[connectivity review](backups.md#preview-and-quarantine-archived-connectivity).

`npm run recovery:compare -- --original <existing-home>` requires both distinct
canonical home guards and matching known personal installation/owner identity.
It privately snapshots committed original SQLite/WAL evidence, reports bounded
metadata drift and leaves application records/config/credentials untouched.
Both guards remain held through staging cleanup; once released, the original
may resume. Comparison grants no retirement, activation or execution authority.
See [post-capture comparison](backups.md#compare-with-the-explicitly-selected-original).
