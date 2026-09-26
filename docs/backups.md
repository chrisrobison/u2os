# Offline backups and encryption

Stop U2OS and wait for shutdown before creating a backup. Creation acquires
the canonical-home ownership guard, stages related regular files privately,
captures committed SQLite WAL data through SQLite backup without migrations,
checks staged database integrity and publishes an archive without overwriting
existing output. Output must be outside the source home; source links/special
files are refused. Runtime locks and raw application SQLite sidecars are not
archived. SQLite backup requires a supported Node release with the backup API
(Node 22.16+; early Node 23 releases before 23.8 lack it).

Prefer encrypted creation:

```sh
npm run backup -- --encrypt /private/backup-location/u2os.tar.gz.enc
```

The CLI requests an independent backup passphrase through masked terminal
input and confirmation. Use a strong, unique passphrase of at least 12
characters (maximum 4096 UTF-8 bytes), and retain it separately in a password
manager. The owner login passphrase, connector credentials and credential
master key are never automatically reused. Losing the independent passphrase
means the archive cannot be decrypted; there is no recovery backdoor.

For intentional noninteractive use, supply `U2OS_BACKUP_PASSPHRASE` through a
trusted secret-injection mechanism. Do not put literal secrets in shell
history, command-line arguments or files alongside the archive. Environment
secrets can be visible to privileged processes; prefer masked input. The CLI
removes this variable before child processes, and tar invocations explicitly
exclude it. Errors and progress output never print the passphrase.

Encrypted restore authenticates completely before extracting any files:

```sh
U2OS_HOME=/private/isolated-recovery npm run restore -- /private/backup-location/u2os.tar.gz.enc --encrypt
```

Use an isolated destination. `--encrypt` explicitly requires encrypted input;
it also protects a renamed archive from accidental plaintext interpretation.
Encrypted headers and `.enc` filenames request encryption automatically.
An explicitly supplied passphrase also requires encrypted input. Wrong
passphrases, corruption, truncation and unsupported formats fail without
extraction or target changes. Partial decrypted bytes stay in private temporary
staging until authentication succeeds, then are removed after validation/failure.

Without `--encrypt`, backup creation retains legacy plaintext `.tar.gz`
compatibility and prints `UNENCRYPTED`. Existing plaintext archives remain
readable and are explicitly labeled unencrypted by the CLI. These archives
include the master key that decrypts connector credentials: mode 0600 alone
does not protect them after copying. Do not mistake encrypted credential files
inside a plaintext tar archive for an encrypted backup.

All staging directories are mode 0700 and completed archives mode 0600.
Encryption/decryption streams the payload rather than buffering entire
archives. Interrupted processes may leave private `.u2os-backup-stage-*` in
the output parent or `u2os-backup-decrypt-*` / `u2os-restore-stage-*` in the OS temporary directory;
these can contain plaintext credentials. Review only after confirming the
operation stopped; never delete active staging or an ownership guard.

## Format and trust boundary

Version 1 starts with `U2OSENC1`, a random 16-byte salt, random 12-byte nonce,
and 16-byte authentication tag, followed by encrypted tar/gzip payload.
AES-256-GCM authenticates the payload and magic/salt/nonce header. Async scrypt
derives a 32-byte key using fixed versioned parameters `N=131072, r=8, p=1`
(approximately 128 MiB; implementation cap 256 MiB). Archives cannot select
arbitrary KDF cost parameters. No passphrase or derived key is serialized.
See [Node crypto](https://nodejs.org/api/crypto.html) and the
[OWASP scrypt guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).

## Isolated offline verification (not activation)

Restore authenticates encrypted input, then streams tar/gzip through a strict
regular-file/directory parser in private staging. No external extractor runs.
Traversal, links, devices, duplicate files, unsafe paths, checksum/compression
errors and unsupported metadata fail before destination changes. Supported
PAX path/size and GNU long names undergo the same checks; binary macOS xattrs
are discarded, never applied. Archive owners, modes, ACLs and timestamps do
not grant authority: directories are 0700, files 0600. Current limits are
4 GiB compressed input and restored file bytes, 100,000 entries, 64 KiB per
metadata entry/end padding, 4096-byte paths and 64 path components. Sparse
files, base-256 numeric fields and unknown extensions are unsupported.
Oversized homes require a separately reviewed strategy, not a bypass.

SQLite is checked read-only without migrations. Database absence is recorded
honestly rather than called a usable installation. Raw application WAL/SHM/
journal files and archived runtime/recovery metadata are rejected. Current
snapshot creation makes the database self-contained and excludes locks.
Legacy WAL-mode databases and live-directory archives containing sidecars need separate recovery
review; they are not silently accepted.

Choose a new, empty, private destination. Nonempty homes and `--force` are
refused; nothing merges or overwrites owner records. Destination ownership is
held throughout publication. Before any payload writes, restore fsyncs
`.u2os-recovery.json` with `status: incomplete`. Completed publication and
SQLite verification change it to `inactive` with counts and verification time.
Failure/interruption may leave partial files, but cannot enable that home.
Do not retry into it, delete its marker, or run maintenance/seed/setup there.
Runtime and supported offline commands deny **any** recovery marker before
migrations, action reconciliation or providers/workers start.

For an owner-driven rehearsal, use an explicitly chosen backup and the isolated
restore command above; confirm CLI reports `INACTIVE`, inspect the marker's
database result and counts, and review expected records using read-only SQLite
and offline file inspection. Startup refusal is intentional. The archive/source
remain untouched; queued attempts/approvals remain historical, not permission
to execute. Keep the original runtime unchanged during this verification.

Explicit activation, original-instance retirement and stale/uncertain-action
reconciliation are not yet supported. No safe failover is claimed by offline
verification alone. The local guard does not coordinate older releases,
external editors or cross-host copies. No live owner backup/restore validation
has been performed.

## Installation identity prerequisite

`config/installation.json` now includes a canonical random UUIDv4
`installationId`, assigned during normal initialization, retained across
restart/home rename and independent of owner display name, personal entity
or account credentials. Existing configurations gain only this root property;
their unknown JSON fields, integer precision, escapes and formatting are
preserved. Persistence is private and atomic, with file/directory fsync under
the runtime/offline guard. Invalid metadata is preserved and rejected, not
replaced with a guessed identity. Metadata must be valid UTF-8 JSON, at most
1 MiB, and a regular single-link file under a real config directory. Review
unsupported/corrupt metadata offline; do not erase an established ID to bypass
validation. Interrupted writes can leave private `.installation-stage-*`
directories under config; never remove an active operation's staging.

Backup creation stays read-only with respect to installation metadata. An
older stopped home or archive may have no ID; it is not initialized or guessed
from its owner name/path. Validated recovery records the archived ID in its
inactive marker, or `null` when absent. The ID is matching evidence, **not**
permission to execute, authentication or distributed locking; copied IDs do
not yet prevent two independent paths from running. Every recovery marker
still blocks startup, even when a valid identity is present. Matching and
explicit retirement/reconciliation belong to the subsequent activation flow.

## Preview and quarantine unfinished database work

For a verified inactive recovery with a known installation ID and supported
application schema, inspect unfinished-work counts without changing records:

```sh
U2OS_HOME=/private/isolated-recovery npm run recovery:review
```

Only after reviewing those counts, the explicitly owner-driven apply command
stops archived database work (it does **not** enable the home):

```sh
U2OS_HOME=/private/isolated-recovery npm run recovery:review -- --apply
```

The canonical-home guard excludes other supported processes. Preview is
read-only and does not migrate. Normal homes, incomplete/mismatched metadata,
legacy identity absence, linked storage and unsupported/custom executable
schemas are refused and preserved. No objectives, arguments, recipients,
tokens or results are printed. Neither command calls a provider or model.

Apply transactionally revokes pending/approved authorization while retaining
historical approval fields and results; unfinished queue items require owner
review and cannot be retried with their archived approval. If the audit already
proves an individual action executed, its queue is made terminal without
another attempt. Unfinished runs lose continuations and are cancelled; their
started steps can still report unknown outcomes from the restored snapshot.
Goals pause with a new revision, triggers disable, pending wakes/finite schedules
cancel, and archived sessions revoke. Completed evidence, attempt history,
personal records, findings/reviews and measured resource counters remain.

A private metadata-only event/checkpoint records counts, not task content.
Every restore has its own recovery ID, so historical recovery events cannot
stand in for a new review. Repeated apply checks stopped-state invariants and
does not duplicate the audit or increment revisions again. A transaction
failure/process interruption rolls back through SQLite; explicit retry can
finish a committed database checkpoint whose marker publication failed. The
home stays inactive throughout. Interrupted marker replacement may leave
private `.u2os-recovery-stage-*` directories; review only after confirming the
operation stopped, never delete active staging or the execution barrier.

An unfinished item in a snapshot is **not** proof that the original failed or
never attempted it: the original may have progressed after capture. Retain and
review its ledger before any fresh consequential proposal. Future owner views
can distinguish this as `recovery_review_required` / `outcome_uncertain`, not
successful objective completion or definite failed delivery.

This checkpoint covers **database work only**. Connector/model configuration,
cached devices and credentials still require separate activation review.

## Preview and quarantine archived connectivity

After completing database-work quarantine above, review a verified inactive
home's connectivity counts without changing its files or records:

```sh
U2OS_HOME=/private/isolated-recovery npm run recovery:connectivity
```

Only after reviewing them, explicitly quarantine archived connectivity:

```sh
U2OS_HOME=/private/isolated-recovery npm run recovery:connectivity -- --apply
```

This is **not activation**. Startup remains denied. Neither command decrypts
credentials, contacts a provider/model, or migrates application SQLite. The
known identity, validated schema, stopped-work checkpoint and canonical-home
ownership are required; normal homes and unsupported/changed storage fail
closed. CLI output contains counts and inactive/progress flags, not account
names, endpoints, filenames, hashes, tokens or personal content.

Apply keeps the credential master key in place and preserves archived encrypted
credential files (including legacy single-account files), the old device
transport token, `config/config.json` and `config/connectors.yaml` byte-for-byte
under private `recovery-review/<recovery-id>/<preparation-id>/` directories.
Normal vault/config loaders never read this area. Whole runtime configuration
is held, including unrelated settings, so defaults cannot silently reuse an
archived endpoint; those settings remain available for offline inspection.
Legacy macOS AppleDouble sidecars associated with these files are preserved
there too, not interpreted. New backup creation suppresses tar-generated
AppleDouble files; actual source sidecar bytes still remain source records.

Live account instances become disconnected with new credential revisions and
cleared IMAP/SMTP associations. Deleted instances remain deleted. Cached
devices become offline/revoked; their names, capabilities and last-observed
evidence remain. The old transport token is no longer available to runtime
startup. Owner identity, personal records, completed results, uncertain attempt
history and measured resource counters are retained. After a separately
implemented activation, accounts/models and device trust will require explicit
fresh owner configuration; do not copy held files back to bypass this review.

A private bounded inventory records original byte fingerprints before files
move. Each staged copy is verified and fsynced before its active source file is
removed; the preserved copy remains recoverable in the review area. Under the
cooperative guard, publication is synchronous and does not overwrite a known
existing destination. Changed, missing, linked or unexpected files are refused,
not replaced. The supported limits are 1 MiB per reviewed file/inventory,
1,000 connectivity files, 64 MiB aggregate and 10,000 accounts/devices each.
Encrypted files require a retained 32-byte master key; unsupported layouts or
missing keys require offline inspection, not an invented successful recovery.

Process interruption can leave preparation or partially moved files while the
home stays inactive. Preview reports an in-progress inventory when available;
explicit apply can finish that same verified inventory. A database transaction
failure rolls back only database updates, not already preserved file moves.
The metadata-only SQLite checkpoint prevents duplicate account revisions or
audit events; retry repairs a failed final marker publication. Private
`.inventory-stage-*`/`.copy-stage-*` directories may remain after interruption;
preserve them for stopped-operation inspection, never remove active staging.
Original source/archive bytes are untouched. This cooperative protocol does
not coordinate external editors or older releases.

Original-instance retirement, post-capture evidence/budget reconciliation and
activation remain unsupported. These commands do not prove that the original
has stopped or that an absent snapshot result was never delivered. No owner
accounts, backups or device connections were used for validation.

## Compare with the explicitly selected original

Stop both supported runtimes and await complete request/background drain.
After work and connectivity quarantine, explicitly select the existing original
home for a read-only comparison:

```sh
U2OS_HOME=/private/isolated-recovery npm run recovery:compare -- --original /private/original-u2os
```

Both distinct, non-nested canonical homes must be owned by this command. It
refuses an active runtime or aliased same home; it does not displace a process,
initialize a missing directory, guess an original from archive content, assign
legacy identity, migrate SQLite, or read original connector credentials. Known matching
personal installation IDs and the same authenticated owner/entity link are
required. Changing the person's display name does not affect that link. Unknown
identity, incomplete/changed quarantine or unsupported storage is preserved
and refused, not converted into an apparent successful recovery.
Recovered offline-byte fingerprints are checked without decrypting credentials
or exposing credential/master-key fingerprints.

The original's committed SQLite/WAL state is copied consistently into a private
temporary database while both guards remain held. Only that private copy is
made self-contained. Its files use mode 0600 under a mode-0700 directory and
are cleaned on success/failure. Original/recovered application records,
credentials, configuration, marker and resource ledgers are unchanged. SQLite
locking/read-mark metadata and the cooperative guard are not personal records
and can change during inspection. This local boundary does not coordinate
external editors or older releases.

Output contains flags, counts and a comparison timestamp only:

- Original-only actions/runs, recorded completions beyond the snapshot, new or
  changed attempt evidence and original in-flight attempts.
- Recorded additional model calls and measured input/output token counters,
  including original-only runs. Unmetered calls and regressed counters remain
  explicit; monetary cost is unavailable. These numbers do **not** reconcile
  goal budgets or reset spending.
- Original-only/missing goals, changed stored objective/criteria/constraints/
  scope/budgets and cancellations beyond the snapshot. Stored values are
  compared conservatively; formatting changes can require review too.
- Owner-authentication and authorization/data-processing policy-byte change
  flags, without hashes, passwords, policy contents or owner/entity IDs.

No objectives, arguments, results, recipients, endpoints, identifiers, private
file paths or secrets are printed. The supported comparison limits are 4 GiB
combined main-database/sidecar bytes per home, 100,000 records per compared
action/attempt/run/goal/owner table and 1 MiB per policy file. Missing or unsafe
measurements and unsupported/executable schemas fail closed. There is no live
provider or model validation in this operation.

A completion in the original audit is **recorded evidence**, not an independent
provider-delivery check. In-flight/absent snapshot outcomes are not proved
failed or unattempted. `executionAuthorized`, `originalRetired`,
`providerOutcomesVerified` and `resourceLedgerReconciled` remain false; recovery
remains inactive. The original may progress again after the guards release.
This comparison is neither a retirement receipt nor activation permission;
post-capture reconciliation and explicit retirement/activation are still
separate unfinished work. Fixtures, not owner accounts/backups, were used.
