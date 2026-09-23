# U2OS Connectors (Phase 3)

Phase 1/2 shipped mock integrations behind a clean seam: `server/tools/*.js` (the policy-gated interface) never called an external system directly — it called `server/integrations/mock-*-provider.js`. Phase 3 exploits that seam: real connectors are just another provider module with the same function signatures, selected at runtime. **No tool's policy gating changes.** Swapping mock→real calendar data does not change who is allowed to call `calendar.reschedule` without approval — that is still entirely `server/policy/policy-engine.js`'s call, per `docs/policies.md`, and this must remain true after Phase 3 (verified explicitly in review, see bottom of this doc).

This document is the contract for: the skill/connector manifest format, the provider interface, credential encryption, the OAuth2 flow, provider selection, and per-connector setup instructions for you (the owner) to actually connect a real account.

## Catalog-driven setup UI

`GET /api/connectors` returns a versioned `catalog` alongside runtime health. Each catalog definition declares display metadata, capabilities, availability, account cardinality, and a constrained setup schema. The browser renders those definitions with the reusable `<u2-connector-setup>` native-dialog component; definitions cannot inject HTML or JavaScript. Supported controls are standard text, password, email, URL, number, and select fields.

The Connectors page is a compact catalog rather than a wall of provider-specific forms. Selecting a row opens the same keyboard-accessible setup dialog for Google OAuth, IMAP, SMTP, API-key, and webhook configuration. Planned definitions—including RSS/Atom, POP3, Discord, WhatsApp, iMessage, Slack, and Microsoft 365—are discoverable but explicitly unavailable until their adapters exist.

Definitions declare `accountMode: "single" | "multiple"`. Google, IMAP, Brave Search, and webhook notifications support named connection instances. Their account list supports creation, renaming, credential updates where applicable, explicit domain selection, and removal. Google has one shared OAuth client configuration; each named account receives separate service tokens. SMTP remains a single global configuration pending explicit IMAP-to-SMTP account association (tracked in #172). A catalog entry is a connector type, not an account record.

The domain card shows the selected account label. With exactly one connected instance, selecting a real provider in the domain selector selects that instance. With multiple connected instances, choose **Use account** on the intended account row; U2OS never guesses. Removing a selected instance returns that domain to Mock and leaves other instances intact. Credential values are write-only in the API and browser. Existing single-account encrypted credentials are migrated to labeled instances on startup; the migration is idempotent.

## Principles carried over from PROMPT.md

- **User owns credentials** (§27, §29): you supply your own Google OAuth client, your own Brave Search API key, your own webhook URL. U2OS never depends on a U2OS-operated cloud service for any of this.
- **Encrypted credentials, least privilege, explicit scopes** (§17): every stored secret is encrypted at rest (see below); each connector declares exactly the OAuth scopes it needs and nothing more.
- **No mandatory vendor lock-in** (§30): mock providers remain fully functional forever; nothing in Phase 1/2 breaks if you never connect anything real.
- **Fail toward safety, not silent breakage**: if a domain is configured to use a real connector that isn't actually connected (not yet authorized, token revoked, network error), the provider registry falls back to the mock provider for reads and surfaces a health warning — it does not throw a 500 into the user's face for a routine "not connected yet" state.

## Directory layout additions

```
skills/
    google-calendar/manifest.json
    gmail/manifest.json
    google-contacts/manifest.json
    web-search/manifest.json         (Brave Search)
    notify-webhook/manifest.json     (generic webhook / ntfy.sh)
    caldav/manifest.json             (stub only this phase -- see "Fast-follow" below)
    imap/manifest.json               (TLS-only inbox sync and reads)

server/security/vault.js             credential encryption (AES-256-GCM, local master key)
server/integrations/oauth/google-oauth.js   generic Google OAuth2 client (auth URL, code exchange, refresh)
server/integrations/provider-registry.js    getProvider(domain) -> active provider module, with mock fallback + health tracking
server/integrations/connectors-config.js    loads/writes ~/.u2os/config/connectors.yaml
server/integrations/sync-scheduler.js       interval-based polling sync for connected real providers
server/integrations/google-calendar-provider.js
server/integrations/gmail-provider.js
server/integrations/google-contacts-provider.js
server/integrations/brave-search-provider.js
server/integrations/webhook-notify-provider.js
server/api/routes/connectors.js      connector list/health, credential submission, OAuth start/callback, manual sync, disconnect
public/components/u2-connectors.js   Settings/Connectors page (paste credentials, Connect/Disconnect, status pills, Sync now)
```

`~/.u2os/credentials/` (already reserved, empty until now) starts being used for real:

```
~/.u2os/credentials/master.key           32 random bytes, mode 0600, generated on first run if absent, NEVER logged
~/.u2os/credentials/google.enc.json       encrypted: shared OAuth client id and secret
~/.u2os/credentials/google__<instance-id>.enc.json  encrypted: that account's service tokens
~/.u2os/credentials/web-search.enc.json   encrypted: {apiKey}
~/.u2os/credentials/notify-webhook.enc.json  encrypted: {webhookUrl, format}
```

`~/.u2os/config/connectors.yaml` (new; written with `active: mock` defaults on first run if absent):

```yaml
calendar:
  active: mock          # or google-calendar
  activeInstanceId: null # exact connected account ID when real
email:
  active: mock          # or gmail
contacts:
  active: mock          # or google-contacts
web:
  active: mock          # or brave-search
notifications:
  active: mock          # or webhook
```

## Skill manifest schema

```json
{
  "id": "google-calendar",
  "name": "Google Calendar",
  "version": "0.1.0",
  "domain": "calendar",
  "provides": ["calendar.list", "calendar.create", "calendar.reschedule"],
  "auth": { "type": "oauth2", "provider": "google", "service": "calendar",
            "scopes": ["https://www.googleapis.com/auth/calendar"] },
  "config": [{ "key": "syncIntervalMinutes", "type": "number", "default": 5 }],
  "eventsEmitted": ["calendar.event_added", "calendar.event_changed"],
  "permissions": ["network:googleapis.com"]
}
```

`server/integrations/skill-manifests.js` discovers every `skills/*/manifest.json` for the `/api/connectors` listing (name, domain, auth type, declared scopes/permissions). Manifests are metadata, not executable plugin code; provider logic remains in the explicit `server/integrations/*-provider.js` modules registered by `provider-registry.js`. Dynamic third-party loading and enforcement of declared network permissions are not implemented.

## Provider interface

A provider module for a given domain must export the same function shape the mock already does, so `server/tools/*.js` never needs to know which one is active:

```js
// calendar: listEvents({from,to}), getEvent(id), createEvent({...}), rescheduleEvent(id,{...})
// email:    listEmails({folder}), getEmail(id), sendEmail({...})
// contacts: searchContacts({query})
// web:      search({query})
// notifications: send({title, body, priority})
```

Real providers additionally implement `async syncChanges({ db, eventBus, correlationId })` (calendar/email/contacts only — web/notifications are call-and-response, nothing to sync) called by `sync-scheduler.js`. `syncChanges` fetches recent upstream state, **upserts into the existing `calendar_events` / `emails` / `entities` tables** (no schema changes — see ID convention below), and publishes exactly the event types the mocks already publish (`calendar.event_added`, `calendar.event_changed`, `email.received`), with `source` set to the real provider id (`google-calendar`, `gmail`) instead of `mock-*`. Consumers (memory projector, dashboards, activity feed) do not need to know or care which source produced an event.

The scheduler reconciles its per-domain timers immediately after OAuth completion, disconnect, or an active-provider change. Connecting a provider at runtime therefore does not require a server restart before recurring sync begins.

### External action idempotency

The durable action worker supplies a stable U2OS idempotency key to every tool call. A connector may advertise tool-level idempotency only when it forwards that key to a provider mechanism that guarantees duplicate-side-effect protection. The current Gmail and Google Calendar adapters do **not** advertise that guarantee. If a crash or timeout leaves one of their external outcomes unknown, U2OS surfaces the action for owner attention and does not automatically replay it. This is an intentional trust-first limitation.

**ID convention** so tool-level operations (e.g. "reschedule event X") work identically regardless of provider: real rows use a provider-prefixed id, e.g. `gcal_<googleEventId>`, `gmail_<messageId>`. This also makes accidental id collisions between providers structurally impossible.

## `server/integrations/provider-registry.js`

```js
getProvider(domain) // domain: 'calendar' | 'email' | 'contacts' | 'web' | 'notifications'
```

Resolution: read `connectors.yaml[domain].active`. If `'mock'` (or missing/invalid) → the mock provider. If it names a real connector → check that connector's stored credentials/tokens exist and are valid (per `server/security/vault.js` + the OAuth token's presence — not necessarily a live network check on every call, that's too slow; a cached "connected" flag updated by the OAuth callback and by sync-scheduler's error handling is fine). If configured-but-not-connected → **log a health warning once (not per-call)** and fall back to the mock provider for that call, so the app degrades gracefully instead of erroring. Track per-domain health (`lastSyncAt`, `lastError`, `connected`) in an in-memory map exposed via `GET /api/connectors`.

## Credential encryption (`server/security/vault.js`)

- On first use, generate `~/.u2os/credentials/master.key` (32 random bytes via `node:crypto.randomBytes(32)`), write with mode `0o600`.
- `encrypt(plainObject)` → AES-256-GCM with a random 12-byte IV per call; returns `{ iv, tag, ciphertext }` (all base64) written as the connector's `*.enc.json` file (plus a `v: 1` version field for future migration).
- `decrypt(fileContents)` → the original object, or throws clearly if the master key doesn't match (do not silently return garbage).
- **Never** log a decrypted credential, access/refresh token, or API key, anywhere — including error messages and the audit log. Errors reference the connector id only ("google token refresh failed"), never the token value.
- `GET /api/connectors` and any other read endpoint must never return decrypted secrets to the client — only booleans (`configured`, `connected`) and non-secret metadata (`lastSyncAt`, scopes, email address / calendar id if the API conveniently returns one, for the user to confirm which account is connected).

## OAuth2 flow (Google — Calendar, Gmail, Contacts share one client)

You create **one** Google OAuth client (Desktop or Web application type; if Web, add `http://localhost:4000/api/connectors/google/oauth/callback` — or whatever port you actually run on — as an authorized redirect URI) and enable the Calendar API, Gmail API, and People API in the same Google Cloud project. U2OS then lets you connect each of the three services independently (different scopes, independent tokens, independent disconnect) using that one client id/secret.

1. `POST /api/connectors/google/credentials { clientId, clientSecret }` — encrypts and stores under `google.enc.json`.
2. Create a named Google account in the setup dialog (`POST /api/connectors/google/instances { label }`). `GET /api/connectors/google/oauth/start?service=calendar|gmail|contacts&instanceId=<id>` builds the Google consent URL and binds its short-lived state to that instance.
3. Google redirects back to `GET /api/connectors/google/oauth/callback?code=&state=`. The public callback validates the short-lived, single-use state and that its bound account still exists. It stores tokens at that account's encrypted vault key, selects the exact instance for the corresponding domain, and redirects to the Connectors page. Other connector routes require an authenticated owner session.
4. `getValidAccessToken(service)` (in `google-oauth.js`) decrypts the stored token, refreshes via the refresh-token grant if expired (updating the stored access token), and returns a usable bearer token for the provider modules to call the real APIs with.
5. `POST /api/connectors/google/instances/<id>/disconnect?service=calendar` clears that account's service tokens without affecting another account. It does not revoke Google's server-side grant.

## Google Calendar provider — real API calls

REST v3, via native `fetch` (no `googleapis` SDK dependency):

- List: `GET https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=&timeMax=&singleEvents=true&orderBy=startTime`
- Create: `POST .../events`
- Reschedule: `PATCH .../events/{googleEventId}` with new `start`/`end`
- Map Google's shape → our `calendar_events` row: `summary→title`, `start.dateTime→start_at`, `end.dateTime→end_at`, `location→location`, `attendees[].displayName||email→attendees`, `category` defaults to `'personal'` (Google doesn't have an equivalent field we can trust — documented simplification; a future pass could infer from calendar id or colorId).

  **⚠️ Policy implication of this simplification:** *every* real event synced from your primary Google Calendar gets `category: 'personal'`, with no way (yet) to distinguish an actual personal event from an interview, a work meeting, or anything else. If you configure `calendar.reschedule.personal: autonomous` in `policies.yaml`, that autonomy applies to **all** of them once Google Calendar is your active calendar connector — not just the events you'd think of as personal. Until category inference improves, keep `calendar.reschedule.personal` at `confirm` (the shipped default) if you connect a real calendar, or scope autonomy to a category Google can't populate (e.g. leave `personal` alone and only ever set more specific rules you're certain your real calendar can't accidentally match).

## Gmail provider — real API calls

- Sync: `GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox+newer_than:1d`, then `GET .../messages/{id}?format=full` for unseen messages so the local row includes its plain-text body.
- Read: `GET .../messages/{id}?format=full`, extract plain-text body from the MIME parts.
- Send: `POST .../messages/send` with `raw` = base64url of a minimal hand-built RFC 2822 message (`To:`, `Subject:`, blank line, body) — no MIME/attachment support this phase, documented as a simplification.
- Map → `emails` row: `from_addr`, `to_addr`, `subject`, `body`, `folder` (`INBOX` label → `inbox`, else best-effort), `received_at` from the message's internal date.

## Google Contacts provider — real API calls

- `GET https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers`
- Map each connection → an `entities` row (`type: 'Person'`), upserted by `resourceName` (id convention: `gc_<resourceName-sanitized>`), plus `facts` rows for email/phone with `source: 'google-contacts'`, `inferred: false`, `confidence: 1.0`.

## Web search provider — Brave Search API

- Create or update a named `brave-search` instance through `/api/connectors/brave-search/instances`.
- `GET https://api.search.brave.com/res/v1/web/search?q=<query>` with header `X-Subscription-Token: <apiKey>`.
- Map top results → `{ title, url, snippet }[]`, same shape `web.search`'s mock already returns, so `server/tools/web-tools.js` doesn't change its return contract at all.
- If not configured, `provider-registry` resolves `'web'` to the mock provider automatically (this is just the normal fallback path, not a special case) — the mock's canned results stay clearly labeled as mock in their response.

## Notifications provider — generic webhook (ntfy.sh-compatible)

- Create or update a named `webhook` instance through `/api/connectors/webhook/instances` with `{ label, webhookUrl, format }`, where `format` is `'json'` or `'ntfy'`.
- `notifications.send` tool, when this provider is active, does the real `fetch(webhookUrl, {...})` and still also inserts the `notification.sent` event exactly as the mock does (the event log doesn't care which provider delivered it).
- Delivery has a 10-second default timeout. Network/timeout errors are sanitized so a credential-bearing URL cannot enter queue errors or logs; HTTP status is retained for trusted failure classification. The provider does not claim idempotency, so an uncertain outcome is sent to owner attention rather than automatically replayed.

## Relationship to the device/capability subsystem

The connector/provider system above and the device/capability model (docs/devices.md) are deliberately separate systems that can compose: `server/devices/adapters/notification-service-adapter.js` is a thin `DeviceAdapter` that wraps `getProvider('notifications')` (this doc's own `provider-registry.js`) and exposes it as a `type: 'service'` device providing the `notification.send` capability -- proof that a physical device and an existing connector are discoverable/invokable through the exact same resolver, with zero changes to anything documented above. This is a proof of concept covering one connector, not a migration; every other connector here is untouched and still reachable only through its existing Tool.

## Task system

PROMPT.md's Phase 3 list names "task system" alongside the real integrations. Tasks in U2OS are already a native, real (non-mocked) entity — `tasks.*` tools read/write the `tasks` table directly; there is no external task provider to swap in yet. Nothing changes here this phase; a future connector (e.g. a Todoist/Reminders skill) would slot into the exact same provider-registry pattern (`domain: 'tasks'`) when there's a concrete external system to target.

## IMAP inbox connector

The owner can now enter an IMAP hostname, username, and app password on the Connectors page, then select IMAP as the active email provider. Credentials are encrypted in `imap.enc.json`; the status API returns no password. IMAP uses TLS on port 993 with normal certificate validation. It fetches at most the latest 50 inbox messages per sync and skips messages over 512 KiB, storing text (not attachments) in the local email cache. IDs include an account hash, mailbox UIDVALIDITY, and UID so repeat syncs do not duplicate mail. Use **Sync now** to verify access; `lastError` reports a sanitized connection failure without credentials.

IMAP itself reads only. To send from this account, also configure the SMTP companion below. If IMAP is selected without SMTP, `email.send` fails clearly. If a real email provider is selected but its credentials are missing, sending fails rather than silently creating a mock sent item. Inbox contents are private user data and remain subject to U2OS's normal data-processing policy when used as model context. No mailbox was contacted during automated tests; the tests use a fake IMAP client.

## SMTP companion for IMAP

Enter SMTP host, port, username, app password, and From address in the Connectors page. Only implicit TLS on port 465 or required STARTTLS on port 587 is supported; certificate validation stays enabled. These settings are encrypted separately in `smtp.enc.json`. SMTP is used only when IMAP is the active email provider; Gmail continues to send through its own API. Every `email.send` still follows the existing consequential-action policy/approval and durable queue path. The transport accepts plain-text messages without attachments, validates recipients and headers, and records a local sent row only after provider acceptance. A timeout or rejection is reported as an uncertain outcome for owner review; it is not advertised as idempotent or automatically replayed. Automated delivery tests use a local capture SMTP server, not real recipients.

## Remaining fast-follow stubs

`skills/caldav/manifest.json` remains a calendar stub. Live-account validation is still owner-driven and tracked separately.

## Setting up your Google OAuth client (do this yourself, in your own browser)

U2OS never has your Google login — you do this in Google's own UI, then paste two non-password values (a client ID and client secret) into U2OS's Connectors page.

1. Go to <https://console.cloud.google.com/> and create a new project (or reuse one) — e.g. "U2OS".
2. **APIs & Services → Library**: enable "Google Calendar API", "Gmail API", and "People API".
3. **APIs & Services → OAuth consent screen**: choose "External" (unless you have a Workspace org for "Internal"), fill in the required app name/support email, and add yourself as a **test user** (unverified apps only allow explicitly listed test users to complete consent — this is fine and expected for a personal self-hosted tool; you do not need Google's app-verification review for personal use).
4. Add these scopes on the consent screen: `.../auth/calendar`, `.../auth/gmail.readonly`, `.../auth/gmail.send`, `.../auth/contacts.readonly`.
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID**. Application type **Web application**. Under "Authorized redirect URIs" add `http://localhost:4000/api/connectors/google/oauth/callback` (adjust the port if you run U2OS elsewhere).
6. Copy the **Client ID** and **Client secret** it gives you.
7. In **Connectors → Google**, save the OAuth client, add a named account, then choose **Connect** for Calendar, Gmail, or Contacts in that account's row. Google's consent screen opens in the same browser tab; after approval, U2OS selects that exact account for the service's domain.
8. To change accounts later, choose **Use account** in the desired account's service row.

## Setting up Brave Search (optional, for real `web.search`)

1. Get a free API key at <https://brave.com/search/api/>.
2. Paste it into the Web Search card on the Connectors page.
3. Flip `web.active` to `brave-search` (same toggle/config-file mechanism as above).

## Setting up notifications (optional, for real delivery)

Any endpoint that accepts a POST works. The easiest is [ntfy.sh](https://ntfy.sh/): pick a topic name (it's public-by-obscurity unless you self-host ntfy or use their paid private topics), and your webhook URL is `https://ntfy.sh/<your-topic>` with format `ntfy`. Paste that into the Notifications card, flip `notifications.active` to `webhook`, and subscribe to the same topic in the ntfy app/website to actually see U2OS's notifications arrive on your phone.

## Security invariants to verify before this phase is considered done

1. Switching a domain's active provider from `mock` to a real connector does **not** create any new path to execute a consequential tool (`calendar.create/reschedule`, `email.send`) without going through `server/policy/policy-engine.js` exactly as today. The provider is swapped underneath the tool; the tool's policy gating is untouched.
2. No decrypted credential, access token, or refresh token ever appears in: an HTTP response body, a log line, an event's `data`/`metadata`, or the `agent_actions` audit row.
3. The OAuth `state` parameter is checked and single-use/expiring — the callback route must reject a replayed or unknown `state`.
4. `server/api/static.js` / the new connectors routes must not expose `~/.u2os/credentials/*` as static files (they're outside `public/`, so this should already be structurally impossible — worth confirming, not re-deriving).
