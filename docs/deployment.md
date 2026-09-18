# U2OS Deployment (PROMPT.md §33 Deployment Phase)

U2OS is a persistent local service, not a desktop app (PROMPT.md §19-22). This document specifies what "install and run it somewhere that isn't a developer's `npm start`" means concretely for the current codebase, and defines the acceptance test this phase must pass.

## Acceptance test (PROMPT.md §33, verified literally)

```
Fresh machine
    -> install/start U2OS (docker compose up, or systemd/launchd unit)
    -> visit http://<host>:4000/  (or http://u2os.local/ where mDNS resolves)
    -> complete onboarding (already possible: seed data / connect real accounts via Connectors page)
    -> close browser
    -> U2OS continues operating (it's a server process, not a browser tab -- already true)
    -> a scheduled event occurs (a sync-scheduler tick, or the new trigger engine once Phase 6 lands)
    -> event is processed and appears in the event log
    -> reopen browser
    -> activity appears in history (GET /api/events, the Activity page)
```

The browser must never be responsible for running persistent agent logic — already true today (Phase 1's architecture), this phase is about *packaging and operating* that already-correct architecture, not changing it.

## What to add

### 1. `Dockerfile` + `.dockerignore`

Multi-stage not needed (no build step — Phase 1's core philosophy holds). Single stage: `node:22-slim`, `npm ci --omit=dev`, copy `server/`, `public/`, `skills/`, `package.json`. `ENV U2OS_HOME=/data`, `EXPOSE 4000`, `CMD ["node", "server/index.js"]`. `.dockerignore` excludes `node_modules`, `.git`, `tests/`, `data/`, `*.log`, the real `~/.u2os`-shaped local dev artifacts.

### 2. `docker-compose.yml`

One service (`u2os`), builds from the `Dockerfile`, `ports: ["4000:4000"]`, a named volume mounted at `/data` (this **is** `~/.u2os`'s container-world equivalent — same logical structure, see `docs/architecture.md`'s local-first data directory section), `restart: unless-stopped`, and a `healthcheck` hitting `GET /api/health`.

### 3. Linux systemd unit (`deploy/systemd/u2os.service`)

Template unit file: runs as a dedicated `u2os` system user (least privilege, PROMPT.md §17), `WorkingDirectory` at the install path, `Environment=U2OS_HOME=/var/lib/u2os`, `Environment=NODE_ENV=production`, `ExecStart=/usr/bin/node server/index.js`, `Restart=on-failure`, `WantedBy=multi-user.target`. Document the install steps (create user, `npm ci --omit=dev --production`, copy unit file to `/etc/systemd/system/`, `systemctl daemon-reload && systemctl enable --now u2os`) in this doc, not a separate one.

**Linux (systemd) install steps**, using `deploy/systemd/u2os.service`:

```
# 1. Create a dedicated, unprivileged system user + its data directory.
sudo useradd --system --home-dir /var/lib/u2os --shell /usr/sbin/nologin u2os
sudo mkdir -p /var/lib/u2os
sudo chown u2os:u2os /var/lib/u2os

# 2. Install the app to a fixed path (matches WorkingDirectory in the unit).
sudo mkdir -p /opt/u2os
sudo cp -r server public skills package.json package-lock.json /opt/u2os/
cd /opt/u2os && sudo npm ci --omit=dev
sudo chown -R u2os:u2os /opt/u2os

# 3. Install and enable the unit.
sudo cp deploy/systemd/u2os.service /etc/systemd/system/u2os.service
sudo systemctl daemon-reload
sudo systemctl enable --now u2os

# 4. Check it came up.
systemctl status u2os
journalctl -u u2os -f
curl http://localhost:4000/api/health
```

### 4. macOS launchd plist (`deploy/launchd/com.u2os.server.plist`)

Template `LaunchAgent`/`LaunchDaemon` plist: `ProgramArguments` = `node server/index.js`, `EnvironmentVariables` with `U2OS_HOME`, `RunAtLoad` + `KeepAlive` true, `StandardOutPath`/`StandardErrorPath` into a log file. Document `launchctl load`/`launchctl bootstrap` install steps here too.

**macOS (launchd) install steps**, using `deploy/launchd/com.u2os.server.plist`:

```
# 1. Install the app to a fixed path (matches the plist's paths).
sudo mkdir -p /opt/u2os
sudo cp -r server public skills package.json package-lock.json /opt/u2os/
cd /opt/u2os && sudo npm ci --omit=dev

# 2. Create the data + log directories the plist points at.
sudo mkdir -p /Users/Shared/u2os/logs
sudo chown -R "$(whoami)" /Users/Shared/u2os

# 3. Install the LaunchDaemon plist (runs at boot, any user; use
#    ~/Library/LaunchAgents/ + launchctl bootstrap gui/$(id -u) instead for a
#    per-user LaunchAgent that only runs while that user is logged in).
sudo cp deploy/launchd/com.u2os.server.plist /Library/LaunchDaemons/com.u2os.server.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.u2os.server.plist
sudo launchctl enable system/com.u2os.server
# Older launchctl (pre-bootstrap syntax) equivalent:
#   sudo launchctl load -w /Library/LaunchDaemons/com.u2os.server.plist

# 4. Check it came up.
sudo launchctl print system/com.u2os.server
tail -f /Users/Shared/u2os/logs/u2os.log
curl http://localhost:4000/api/health
```

### 5. mDNS discovery (`server/discovery/mdns.js`)

Advertise the server on the local network as `u2os.local` so PROMPT.md's onboarding flow ("visit u2os.local") works without the user knowing the machine's IP. Use the `bonjour-service` npm package (pure JS, no native bindings — acceptable per "few dependencies": this is the one narrowly-scoped exception, there is no zero-dependency way to speak multicast DNS from Node, and mDNS discovery is an explicit, named requirement in PROMPT.md §19/§33). Publish an `_http._tcp` service named `u2os` on the running port, with `host: 'u2os.local'` so the hostname itself resolves via mDNS on networks that support it (most consumer LANs; corporate/cloud networks often block multicast — document this as an expected, non-fatal limitation, and make startup continue normally with a clear log line if mDNS publish fails, never crash the server over it). Gate this behind an env var (`U2OS_MDNS=1` by default, settable to `0` to disable, e.g. for multi-instance dev or environments where multicast is blocked and the warning noise isn't wanted).

### 6. Structured logging (`server/logging/logger.js`)

A small logger — `log.info(component, message, fields)`, `log.warn`, `log.error` — emitting either human-readable lines (default, for interactive `npm start`) or single-line JSON (when `LOG_FORMAT=json`, the sane default inside Docker/systemd where log aggregators expect it), each with `timestamp`, `level`, `component`, `message`, and arbitrary structured `fields`. Replace the ad-hoc `console.log`/`console.warn` call sites in `server/index.js` (startup banner), `server/integrations/provider-registry.js` (the warn-once fallback), and `server/integrations/sync-scheduler.js` (sync errors) with this logger — do not do a blanket repo-wide sweep, just those clearly operationally-relevant spots. Add a minimal HTTP access log (method, path, status, duration_ms) via the same logger, wired into `server/index.js`'s `http.createServer` handler (wrap the existing router/static dispatch, log after it completes, do not change routing behavior).

### 7. Backup / export

Two distinct things, both needed per PROMPT.md §30 ("provide or plan for export... documented, portable formats") and the general "no vendor lock-in" principle:

- **`server/backup/snapshot.js`**, runnable as `npm run backup [outputPath]`: tars up the entire `U2OS_HOME` directory (db, config, policies, credentials — yes, including the encrypted credentials and the master key together, since a backup that can't decrypt its own credentials on restore isn't useful; document clearly in this file and in the CLI's own `--help`/usage text that **the resulting archive is as sensitive as the live data directory and must be stored/transmitted with that in mind**) into a single timestamped `.tar.gz`. A companion `npm run restore -- <path>` unpacks it back into `U2OS_HOME`, refusing to silently clobber an existing non-empty data directory without an explicit `--force` flag.
- **`GET /api/export`**: a portable, human-inspectable JSON export of exactly the domains PROMPT.md §30 names — events, entities (people/projects/etc.), facts, relationships, tasks, calendar events, emails, agent_actions (the audit log) — deliberately **excluding** `~/.u2os/credentials/*` (this endpoint is for taking your data to a different system or just inspecting it, not for moving live OAuth tokens around; the tar snapshot above is the mechanism for full-fidelity migration to new hardware). No auth gate exists anywhere else in this single-owner Phase 1-3 app, so none is added here either, but note in this doc that this endpoint becomes a real access-control concern once Phase 5+ multi-device/multi-user auth exists.

### 8. Health endpoint enrichment

`GET /api/health` already exists (`server/api/routes/health.js`) and is sufficient for the Docker/systemd healthcheck as-is. Optionally add a `version` field (from `package.json`) and a `connectors` summary (reusing `provider-registry.getHealth()`) so a glance at `/api/health` tells you if a configured real connector has gone unhealthy — small addition, not a redesign.

## What this phase deliberately does not do

- No TLS/HTTPS termination built in (the deployment target is a LAN-local service; put a reverse proxy like Caddy/Traefik/Cloudflare Tunnel in front if you need HTTPS or remote access — consistent with PROMPT.md §26's "optional cloud services layered on top" principle, not a U2OS-operated relay).
- No Windows Service packaging yet (PROMPT.md lists it as a target; Docker Desktop on Windows covers the near-term need, a native Windows Service wrapper is future work).
- No auth/access-control layer yet (tracked as existing technical debt since Phase 1; this phase doesn't add one, it just makes the *existing* single-owner model deployable).
