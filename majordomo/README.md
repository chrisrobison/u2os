# Majordomo (foundation phase)

A small Rust daemon for U2OS's deterministic core. Read [ADR 0011](../docs/adr/0011-rust-majordomo-migration.md) and [docs/majordomo.md](../docs/majordomo.md) first.

**In this phase Majordomo owns nothing.** Node remains authoritative for the vault index, policy, queue, scheduler and events. The daemon provides configuration, single-instance protection, lifecycle, logging and an owner-only local API, so later phases have a safe base. It never starts, stops or reads Node's SQLite files.

## Build and test

Requires stable Rust 1.89 or newer.

```sh
cd majordomo
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release     # target/release/{majordomo,u2}
```

Tests use temporary homes and never touch `~/.u2os`.

## Run

```sh
./target/release/majordomo          # foreground; SIGINT/SIGTERM stop it gracefully
./target/release/u2 status          # or: u2 status --json
./target/release/u2 doctor
./target/release/u2 vault check    # read-only; no daemon needed; --vault DIR, --json
./target/release/u2 memory search peanut
./target/release/u2 git status       # health of the vault's Git repository (read-only)
./target/release/u2 history ent_abc123   # across renames; also: diff --since DATE, rewind DATE
./target/release/u2 memory show ent_abc123   # or a vault path; also: list, links
```

| Variable | Meaning |
|---|---|
| `U2OS_HOME` | Data home, same as Node (default `~/.u2os`). Must be an absolute path. |
| `MAJORDOMO_LOG` | `tracing` filter (default `info`) |
| `MAJORDOMO_LOG_FORMAT` | `json` for JSON lines on stderr |

Exit codes: `majordomo` exits `75` when another instance already owns the home, `1` on other errors. `u2` exits `0` on success, `1` on failure or when the daemon is not running, `64` on usage errors.

## What it creates

Only inside `<U2OS_HOME>/majordomo/` (mode `0700`):

```text
majordomo/
  majordomo.lock     flock single-instance guard (mode 0600); the file stays after stop, never delete it to bypass the lock
  run/majordomo.sock owner-only API socket (mode 0600), removed on clean shutdown
```

A crash (`SIGKILL`) leaves the socket file behind. The next start, which holds the lock, replaces it. `u2 doctor` reports it as a stale socket. A symlink, regular file or foreign-owned socket at that path is refused and never deleted.

## Local API

HTTP/1.1 over the Unix socket. There is no TCP listener. Only a peer running as the daemon's own user is served (checked with the kernel's peer credentials); other users are dropped.

| Route | Response |
|---|---|
| `GET /api/v1/health` | `{"status":"ok","version":"…"}` |
| `GET /api/v1/status` | version, pid, uptime, home, socket, and per-responsibility ownership (always `owner: node`; Majordomo is `read-only` for the vault index, `disabled` for the rest) |
| `GET /api/v1/vault`, `/memories`, `/memories/{id}`, `/memories/{id}/links`, `/search?q=` | read-only memory queries; see [docs/majordomo.md](../docs/majordomo.md#memory-queries-phase-2b) |

Anything else is 404, or 405 for non-GET methods. The vault is read-only for Majordomo. At most 64 connections are served at once; header reads time out after 5 s.

## Service units (not installed automatically)

Run it in the foreground under a supervisor. Example units for a later packaging step; adapt paths before use.

systemd user unit, `~/.config/systemd/user/majordomo.service`:

```ini
[Service]
ExecStart=%h/bin/majordomo
Restart=on-failure
RestartPreventExitStatus=75
```

launchd, `~/Library/LaunchAgents/io.u2os.majordomo.plist`: run `~/bin/majordomo` with `KeepAlive` set to `{SuccessfulExit = false}`.

## Vault reader

`u2 vault check` scans the vault (located like Node: `U2OS_VAULT`, then `config/config.json` `vaultDir`, then `<home>/vault`) and prints counts, notes and every invalid file with its reason. It exits 1 if any file is invalid or the vault is missing, and never writes or creates anything. Details and differences from Node: [docs/majordomo.md](../docs/majordomo.md#vault-reader-phase-2a).

## Staying current

The daemon watches the vault (debounced filesystem events plus a 30 s reconcile) and re-indexes when files change; see [docs/majordomo.md](../docs/majordomo.md#vault-watcher-phase-2c). `GET /api/v1/vault` shows `generation` and `lastChange`. It never writes to the vault.

## Not in this phase

Writing to Git (check-in, removal), policy, events, scheduler, action queue, capabilities, TCP/HTTP exposure, configuration reload, Windows. See the phase table in [docs/majordomo.md](../docs/majordomo.md).
