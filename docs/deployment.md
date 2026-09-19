# Deployment

U2OS is a persistent, single-owner pre-alpha service. Authentication exists, but it is not designed for direct public-internet exposure. Startup listens on `127.0.0.1` by default.

## Configuration

| Setting | Default | Purpose |
|---|---:|---|
| `U2OS_HOME` | `~/.u2os` | Identity store and data root |
| `PORT` / `port` | `4000` | HTTP port; `0` is valid for tests |
| `U2OS_BIND` / `bind` | `127.0.0.1` | Listen address; non-loopback must be explicit and requires an owner |
| `U2OS_SECURE_COOKIES` | off | Force `Secure` cookies |
| `U2OS_TRUST_PROXY` | off | Trust `X-Forwarded-Proto` only behind a known proxy |
| `U2OS_PUBLIC_ORIGIN` / `publicOrigin` | unset | Canonical origin for Host/Origin checks |
| `U2OS_SESSION_IDLE_SECONDS` | `43200` | Idle timeout |
| `U2OS_SESSION_ABS_SECONDS` | `604800` | Absolute lifetime |
| `U2OS_BODY_LIMIT_BYTES` | `1048576` | JSON body limit |
| `U2OS_MDNS` | `1` | Permit mDNS only for non-loopback binds |

Sessions store only token hashes server-side. Cookies are `HttpOnly`, `SameSite=Strict`, `Path=/`, and become `Secure` for HTTPS or explicit/trusted-proxy configuration. Sensitive rate limits are in-process per IP/account, reset on restart, and are not distributed.

## First run and recovery

Start on loopback and create the owner passphrase in the UI. There is no reset backdoor. If forgotten, restore a backup tied to a known passphrase or wipe `U2OS_HOME` and start over. Backups contain the owner hash, private data, encrypted credentials, and master key; protect them like the live identity store.

## Docker and service templates

Compose listens on `0.0.0.0` inside the container but publishes `127.0.0.1:4000:4000` by default. Changing it to `4000:4000` commonly publishes to the host LAN. The public redacted `/api/health` remains suitable for healthchecks.

A new non-loopback instance refuses startup until an owner exists. Initialize its data on loopback before enabling the container bind. This fail-closed bootstrap limitation is deliberate.

Systemd and launchd templates under `deploy/` retain loopback. Change the bind only after setup and intentionally. mDNS is disabled on loopback and best-effort on LAN binds. Use a firewall and carefully configured TLS reverse proxy for intentional remote access.

`npm run backup` creates a full snapshot; `npm run restore -- /path/to/archive.tar.gz` restores it. Authenticated `GET /api/export` produces portable JSON without connector secrets. U2OS has no built-in TLS termination, supported public-internet recipe, Windows service, distributed limiter, or production rollback system.
