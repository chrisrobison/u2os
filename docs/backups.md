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
staging until authentication succeeds, then are removed after extraction/failure.

Without `--encrypt`, backup creation retains legacy plaintext `.tar.gz`
compatibility and prints `UNENCRYPTED`. Existing plaintext archives remain
readable and are explicitly labeled unencrypted by the CLI. These archives
include the master key that decrypts connector credentials: mode 0600 alone
does not protect them after copying. Do not mistake encrypted credential files
inside a plaintext tar archive for an encrypted backup.

All staging directories are mode 0700 and completed archives mode 0600.
Encryption/decryption streams the payload rather than buffering entire
archives. Interrupted processes may leave private `.u2os-backup-stage-*` in
the output parent or `u2os-backup-decrypt-*` in the OS temporary directory;
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

Encryption is not yet the complete recovery boundary. Restore still uses the
legacy tar extraction path, lacks inactive-by-default recovery and does not
coordinate original/restored executors. Do not force-merge into an existing
home or run original/restored copies concurrently. Do not accept arbitrary
untrusted archives. Safe entry validation, isolated restore verification and
explicit activation/duplicate-effect safeguards are subsequent work. The
local guard does not coordinate older releases, external editors or cross-host
copies. No live owner backup/restore validation has been performed.
