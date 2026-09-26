# Deployment

U2OS is a persistent, single-owner pre-alpha service. Authentication exists, but it is not designed for direct public-internet exposure. Startup listens on `127.0.0.1` by default.

Queue delivery, connector sync polling and trigger workers start only after a
successful HTTP bind. A bind failure (for example an occupied port) cleans
prepared device adapters and does not leave these execution workers running.
Worker-setup failure after binding closes the listener and drains partial setup.
The internal server handle offers `stopBackgroundWorkers()` for an idempotent
background drain; it does not close HTTP or cancel in-flight request handlers.
Local initialization and additive migrations may still occur before binding.
This safeguard is not a cross-process singleton or maintenance lock; coordinated
backup/recovery and complete startup/shutdown handling remain unfinished.

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

The realtime device bus (docs/devices.md) upgrades WebSocket connections at `/ws/devices` on the **same** port/process above -- no additional port to open or firewall. It requires a per-installation connect token, generated on first use at `<U2OS_HOME>/credentials/device-connect-token.key` (mode `0600`, same pattern as `master.key`); an authenticated browser session can also fetch it via `GET /api/devices/connect-token`. This token gates transport only, not device trust -- see `server/devices/realtime/device-token.js`.

## First run and recovery

Start on loopback and create the owner passphrase in the UI. There is no reset backdoor. If forgotten, restore a backup tied to a known passphrase or wipe `U2OS_HOME` and start over. Backups contain the owner hash, private data, encrypted credentials, and master key; protect them like the live identity store.

## Docker and service templates

Compose listens on `0.0.0.0` inside the container but publishes `127.0.0.1:4000:4000` by default. Changing it to `4000:4000` commonly publishes to the host LAN. The public redacted `/api/health` remains suitable for healthchecks.

Authenticated owners can open **Diagnostics** in the browser (`#/diagnostics`) or use `GET /api/diagnostics` for deeper operational health. It reports server and database health, bounded action counts, connector/model/embedding states, SSE client and memory counts, and recent warning/error summaries. The browser refreshes relevant counts from the live event feed. Diagnostics deliberately excludes action arguments, provider errors, connector credentials, endpoints, API keys, and private memory or message content. A configured mock model is reported as degraded rather than presented as a production dependency.

The Diagnostics page also offers a deliberate **Download sanitized bug bundle** action (`POST /api/diagnostics/bug-bundle`). The JSON bundle contains version/platform data, boolean configuration-presence flags, schema health, dependency summaries, and bounded failed-operation metadata. It never includes configuration values, endpoints, credentials, tokens, raw errors, action arguments/results/identifiers, database files, full logs, or email/calendar/task/document/memory content. The owner should still inspect the small JSON file before sharing it because operational timestamps and tool names may reveal usage patterns.

A new non-loopback instance refuses startup until an owner exists. Initialize a Compose volume without exposing HTTP by running `docker compose run --rm u2os npm run setup-owner`; the masked prompt writes only the scrypt hash into the mounted `U2OS_HOME`. Then start normally with `docker compose up -d`. This keeps the bootstrap fail-closed.

Systemd and launchd templates under `deploy/` retain loopback. Change the bind only after setup and intentionally. mDNS is disabled on loopback and best-effort on LAN binds. Use a firewall and carefully configured TLS reverse proxy for intentional remote access.

`npm run backup` creates a full snapshot; `npm run restore -- /path/to/archive.tar.gz` restores it. Authenticated `GET /api/export` produces portable JSON without connector secrets. U2OS has no built-in TLS termination, supported public-internet recipe, Windows service, distributed limiter, or production rollback system.

`npm run maintain` runs SQLite and event-log integrity checks. `npm run maintain -- --retention-days 365` previews event pruning; add `--apply` only after taking a backup. Applied retention writes a `system.event_retention_applied` audit event before removing older rows. Retention is intentionally manual rather than an automatic background deletion policy.

`npm run maintain -- --replay-projections` previews a deterministic rebuild of registered event-derived projections. Add `--apply` to atomically replace those projection rows and write a `system.projections_replayed` audit event. Historical events are passed only to registered pure projector functions—they are never republished through the live bus, so replay cannot invoke tools, connectors, notifications, or agent actions. Owner-entered and connector-authoritative state is outside the rebuild boundary.
