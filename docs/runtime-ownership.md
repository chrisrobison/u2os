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

Limitations: this guard coordinates supported local runtimes, not arbitrary
external database/config writers, network filesystems, cross-host copies or
restored homes at different paths. Maintenance/backup CLI coordination,
encrypted coherent archives and inactive-by-default isolated restore remain
separate work. Stop older releases before upgrading: they do not participate
in this guard protocol. No live owner-account or hardware validation was used.
