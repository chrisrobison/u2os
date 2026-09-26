# U2OS Connectors (Phase 3)

Phase 1/2 shipped mock integrations behind a clean seam: `server/tools/*.js` (the policy-gated interface) never called an external system directly — it called `server/integrations/mock-*-provider.js`. Phase 3 exploits that seam: real connectors are just another provider module with the same function signatures, selected at runtime. **No tool's policy gating changes.** Swapping mock→real calendar data does not change who is allowed to call `calendar.reschedule` without approval — that is still entirely `server/policy/policy-engine.js`'s call, per `docs/policies.md`, and this must remain true after Phase 3 (verified explicitly in review, see bottom of this doc).

This document is the contract for: the skill/connector manifest format, the provider interface, credential encryption, the OAuth2 flow, provider selection, and per-connector setup instructions for you (the owner) to actually connect a real account.

## Catalog-driven setup UI

`GET /api/connectors` returns a versioned `catalog` alongside runtime health. Each catalog definition declares display metadata, capabilities, availability, account cardinality, and a constrained setup schema. The browser renders those definitions with the reusable `<u2-connector-setup>` native-dialog component; definitions cannot inject HTML or JavaScript. Supported controls are standard text, password, email, URL, number, and select fields.

The Connectors page is a compact catalog rather than a wall of provider-specific forms. Selecting a row opens the same keyboard-accessible setup dialog for Google OAuth, IMAP, SMTP, API-key, and webhook configuration. Planned definitions—including RSS/Atom, POP3, Discord, WhatsApp, iMessage, Slack, and Microsoft 365—are discoverable but explicitly unavailable until their adapters exist.

Definitions declare `accountMode: "single" | "multiple"`. Google, IMAP, SMTP, Brave Search, and webhook notifications support named connection instances. Their account list supports creation, renaming, credential updates where applicable, explicit domain selection, and removal. Google has one shared OAuth client configuration; each named account receives separate service tokens. Each IMAP account selects its own SMTP sender. A catalog entry is a connector type, not an account record.

The domain card shows the selected account label. With exactly one connected instance, selecting a real provider in the domain selector selects that instance. With multiple connected instances, choose **Use account** on the intended account row; U2OS never guesses. Removing a selected instance returns that domain to Mock and leaves other instances intact. Credential values are write-only in the API and browser. Existing single-account encrypted credentials are migrated to labeled instances on startup; the migration is idempotent.

## Principles carried over from PROMPT.md

- **User owns credentials** (§27, §29): you supply your own Google OAuth client, your own Brave Search API key, your own webhook URL. U2OS never depends on a U2OS-operated cloud service for any of this.
- **Encrypted credentials, least privilege, explicit scopes** (§17): every stored secret is encrypted at rest (see below); each connector declares exactly the OAuth scopes it needs and nothing more.
- **No mandatory vendor lock-in** (§30): mock providers remain available in isolated demo mode; a personal home with no real account reports the service as unavailable.
- **Fail toward safety, not silent breakage**: an unconnected real connector is unavailable in personal mode, with an actionable health state; it never returns mock reads. Only an explicitly isolated demo home may use fixtures.

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
server/integrations/provider-registry.js    getProvider(domain) -> active provider module, with demo-only mock fallback + health tracking
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
~/.u2os/credentials/imap__<instance-id>.enc.json    encrypted: that inbox's IMAP settings
~/.u2os/credentials/smtp__<instance-id>.enc.json    encrypted: that sender's SMTP settings
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

Concurrent polling and **Sync now** calls for the same data home, domain,
provider and account share one in-flight operation and its result or sanitized
failure. Other accounts/domains remain independent; health is recorded for the
account that actually ran. Timer reconciliation preserves in-flight work and
does not start catch-up retries. `await syncScheduler.stopAll()` clears timers
immediately, ignores stale timer callbacks and waits for already-started syncs
to settle. It does not cancel provider work or prohibit later explicit calls.
This drain is a shutdown prerequisite, not a coordinated backup guarantee:
the current archive tool still requires separate consistency hardening.

The scheduler reconciles its per-domain timers immediately after OAuth completion, disconnect, or an active-provider change. Connecting a provider at runtime therefore does not require a server restart before recurring sync begins. Each attempt records freshness and a sanitized error under the exact connection instance and domain that ran, even if the owner switches active accounts while a sync is in flight. Google Calendar, Gmail, and Contacts therefore keep separate health state even when they share one Google account instance. `GET /api/connectors` shows the selected connected account's state; the instance list includes per-domain `sync` status. A disconnected or deleted selection does not borrow an old success from another account.

### External action idempotency

The durable action worker supplies a stable U2OS idempotency key to every tool call. A connector may advertise tool-level idempotency only when it forwards that key to a provider mechanism that guarantees duplicate-side-effect protection. The current Gmail and Google Calendar adapters do **not** advertise that guarantee. If a crash or timeout leaves one of their external outcomes unknown, U2OS surfaces the action for owner attention and does not automatically replay it. This is an intentional trust-first limitation.

**ID convention** so tool-level operations (e.g. "reschedule event X") work identically regardless of provider: real rows use a provider-prefixed id, e.g. `gcal_<googleEventId>`, `gmail_<messageId>`. This also makes accidental id collisions between providers structurally impossible.

## `server/integrations/provider-registry.js`

```js
getProvider(domain) // domain: 'calendar' | 'email' | 'contacts' | 'web' | 'notifications'
```

Resolution: read `connectors.yaml[domain].active`. In explicit demo mode, `'mock'` resolves to a fixture provider and a disconnected real service may use that demo fallback. In personal mode, `'mock'`, unimplemented providers, and disconnected real accounts produce an actionable `SERVICE_UNAVAILABLE` error, never fabricated results. A real account must have the exact persisted status `connected`, be live, and have service credentials; retained credentials alone do not enable pending, disconnected, error or unknown-status accounts. This same local eligibility check applies to selection, sync, health, proposals and bound execution (not a live network probe on every call). An explicit ineligible selection never switches to another account. Persist sync health (`lastSyncAt`, `lastError`) per instance and domain; expose only the selected connected account's state alongside `connected` in `GET /api/connectors`.

The Mail and Calendar pages read locally stored records, not a live provider response. Their API responses include `cache.source`, the selected provider's connected state, and last sync time (or null when unknown). The UI labels these records as demo fixtures or local cache and warns that personal cache may include other accounts; account-scoped retrieval remains future work.

## Credential encryption (`server/security/vault.js`)

- On first use, generate `~/.u2os/credentials/master.key` (32 random bytes via `node:crypto.randomBytes(32)`), write with mode `0o600`.
- `encrypt(plainObject)` → AES-256-GCM with a random 12-byte IV per call; returns `{ iv, tag, ciphertext }` (all base64) written as the connector's `*.enc.json` file (plus a `v: 1` version field for future migration).
- `decrypt(fileContents)` → the original object, or throws clearly if the master key doesn't match (do not silently return garbage).
- **Never** log a decrypted credential, access/refresh token, or API key, anywhere — including error messages and the audit log. Errors reference the connector id only ("google token refresh failed"), never the token value.
- `GET /api/connectors` and any other read endpoint must never return decrypted secrets to the client — only booleans (`configured`, `connected`) and non-secret metadata (`lastSyncAt`, scopes, email address / calendar id if the API conveniently returns one, for the user to confirm which account is connected).

## OAuth2 flow (Google — Calendar, Gmail, Contacts share one client)

You create **one** Google OAuth client (Desktop or Web application type; if Web, add `http://localhost:4000/api/connectors/google/oauth/callback` — or whatever port you actually run on — as an authorized redirect URI) and enable the Calendar API, Gmail API, and People API in the same Google Cloud project. U2OS then lets you connect each of the three services independently (different scopes, independent tokens, independent disconnect) using that one client id/secret.

1. `POST /api/connectors/google/credentials { clientId, clientSecret }` — encrypts and stores under `google.enc.json`.
2. Create a named Google account in the setup dialog (`POST /api/connectors/google/instances { label }`). `GET /api/connectors/google/oauth/start?service=calendar|gmail|contacts&instanceId=<id>` builds the Google consent URL and binds its short-lived state to that instance's credential revision/status and effective OAuth client identity.
3. Google redirects back to `GET /api/connectors/google/oauth/callback?code=&state=`. The public callback consumes the state once and validates account revision/status, client and expiry both before exchange and after Google's response. Disconnect/removal, changed credentials/client, expiry or another completed flow prevents stale completion from writing or activating anything. Label-only rename and unrelated accounts do not invalidate consent. On success it stores tokens at that account's encrypted vault key and selects the exact instance. Complete one service before starting another consent for that same account; restart loses pending consent. A fixed failure banner asks the owner to review account/client status and start Connect again; private upstream exceptions are not logged or reflected. Other connector routes require an authenticated owner session.
4. `getValidAccessToken(vaultKey, service)` (in `google-oauth.js`) decrypts the selected account's stored token and refreshes via the refresh-token grant if expired. Immediately before persisting or returning a refreshed token, it verifies that the service credentials and effective OAuth client still match the pre-request snapshot. Disconnect/removal, replacement or another completed refresh discards the late result without restoring/overwriting credentials; retry with the intended connected account. Unrelated service edits remain intact. This credential check is not authorization: runtime account eligibility, exact approval identity and policy still govern actions.
5. `POST /api/connectors/google/instances/<id>/disconnect?service=calendar` clears that account's service tokens without affecting another account. It does not revoke Google's server-side grant.

Code exchange and refresh each have one 10-second request deadline covering
headers and JSON parsing. Timeout aborts/discards late results; no automatic
retry or refreshed credential persistence occurs. Sanitized failures distinguish
timeout, authorization/client problems, rate limits and provider unavailability
without exposing upstream text or secrets. Malformed token responses are not
success. After a failed exchange, review account status and start fresh consent,
not replay the consumed code/state; a refresh may be retried later by fresh work.
This bounds token requests only, not the complete Gmail/Calendar/Contacts read
or any consequential send/change. Provider-operation deadlines remain separate.

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
- Search: `email.search` passes a bounded query to Gmail's `messages.list?q=` for the selected account, optionally with an inbox/sent folder filter, then fetches full messages for the first 50 matches. The result is one provider-ranked page, not proof of exhaustive mailbox coverage; Gmail query syntax applies. Detail-fetch failure fails the search instead of silently presenting an incomplete page. A folder is checked again against returned labels so query operators cannot broaden it. Personal mode never substitutes demo messages for failed Gmail search.
- Send: `POST .../messages/send` with `raw` = base64url of a minimal hand-built RFC 2822 message (`To:`, `Subject:`, blank line, body) — no MIME/attachment support this phase, documented as a simplification.
- Map → `emails` row: `from_addr`, `to_addr`, `subject`, `body`, `folder` (`INBOX` label → `inbox`, else best-effort), `received_at` from the message's internal date.

## Google Contacts provider — real API calls

- `GET https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers`
- Map each connection → an `entities` row (`type: 'Person'`), upserted by `resourceName` (id convention: `gc_<resourceName-sanitized>`), plus `facts` rows for email/phone with `source: 'google-contacts'`, `inferred: false`, `confidence: 1.0`.

## Local email drafts

Local `email.draft` is independent of a connected provider and performs no
delivery. New personal/unmarked-legacy drafts leave `from_addr` empty: the
sender has not been selected, and no address is inferred from the owner's
name. A later consequential send binds its exact provider/account before
approval. Explicit isolated demo drafts retain their fictional demo sender.
Existing ambiguous drafts are preserved for review, not silently rewritten.

## Web search provider — Brave Search API

- Create or update a named `brave-search` instance through `/api/connectors/brave-search/instances`.
- `GET https://api.search.brave.com/res/v1/web/search?q=<query>` with header `X-Subscription-Token: <apiKey>`.
- Map top results → `{ title, url, snippet }[]`, same shape `web.search`'s mock already returns, so `server/tools/web-tools.js` doesn't change its return contract at all.
- If not configured in personal mode, web search reports unavailable. In explicit demo mode the mock's canned results stay labeled as mock in their response.
- Real search has a 10-second deadline covering connection/headers and JSON-body parsing. Timeout aborts the read and discards late results, including non-cooperating transports. There is no automatic retry or mock substitution. Authorization failures ask for reconnection of the selected account; rate limits ask for a later retry. Transport/parser errors are sanitized without query, key, upstream message or response body. This deadline does not yet cover Google reads/OAuth or model requests; consequential delivery retains its separate uncertain-outcome rules.

## Notifications provider — generic webhook (ntfy.sh-compatible)

- Create or update a named `webhook` instance through `/api/connectors/webhook/instances` with `{ label, webhookUrl, format }`, where `format` is `'json'` or `'ntfy'`.
- `notifications.send` captures the selected provider, named connection instance and credential revision when proposed, before approval/enqueue. Execution resolves that persisted identity, never the currently active selection. Approval previews name the intended account without exposing the webhook URL. Delivery publishes `notification.sent` only after success.
- Deleted/disconnected or reconfigured accounts stop pending sends before delivery; legacy queued notifications without a binding require owner review and a new proposal. Changing the payload also requires a new approval. Account switching cannot redirect approved or queued work.
- Delivery has a 10-second default timeout. Network/timeout errors are sanitized so a credential-bearing URL cannot enter queue errors or logs; HTTP status is retained for trusted failure classification. The provider does not claim idempotency, so an uncertain outcome is sent to owner attention rather than automatically replayed.

## Relationship to the device/capability subsystem

The connector/provider system above and the device/capability model (docs/devices.md) are deliberately separate systems that can compose: `server/devices/adapters/notification-service-adapter.js` is a thin `DeviceAdapter` that wraps `getProvider('notifications')` (this doc's own `provider-registry.js`) and exposes it as a `type: 'service'` device providing the `notification.send` capability -- proof that a physical device and an existing connector are discoverable/invokable through the exact same resolver, with zero changes to anything documented above. This is a proof of concept covering one connector, not a migration; every other connector here is untouched and still reachable only through its existing Tool.

## Task system

PROMPT.md's Phase 3 list names "task system" alongside the real integrations. Tasks in U2OS are already a native, real (non-mocked) entity — `tasks.*` tools read/write the `tasks` table directly; there is no external task provider to swap in yet. Nothing changes here this phase; a future connector (e.g. a Todoist/Reminders skill) would slot into the exact same provider-registry pattern (`domain: 'tasks'`) when there's a concrete external system to target.

## IMAP inbox connector

The owner can enter an IMAP hostname, username, and app password for a named account on the Connectors page, then select that account as the active email provider. Credentials are encrypted under the account's instance vault key; the status API returns no password. IMAP uses TLS on port 993 with normal certificate validation. It fetches at most the latest 50 inbox messages per sync and skips messages over 512 KiB, storing text (not attachments) in the local email cache. IDs include an account hash, mailbox UIDVALIDITY, and UID so repeat syncs do not duplicate mail. Use **Sync now** to verify access; `lastError` reports a sanitized connection failure without credentials.

`email.search` refreshes that selected inbox and filters only its synchronized local records by subject, body, or sender, returning at most 50. It does not search older unsynchronized server mail, other folders, attachments, or skipped oversized messages. The active account's sync status and `lastSyncAt` indicate freshness; an empty search result is not an exhaustive-mailbox claim.

IMAP itself reads only. To send from this account, also configure and select the SMTP companion below. If IMAP is selected without a connected sender, `email.send` is blocked before approval. If a real email provider is selected but its credentials are missing, sending fails rather than silently creating a mock sent item. Inbox contents are private user data and remain subject to U2OS's normal data-processing policy when used as model context. No mailbox was contacted during automated tests; the tests use a fake IMAP client.

## SMTP companion for IMAP

Create one or more named SMTP accounts in Connectors with host, port, username, app password, and From address. Then open each IMAP account and explicitly select its SMTP sender. An unpaired inbox cannot propose a send. Only implicit TLS on port 465 or required STARTTLS on port 587 is supported; certificate validation stays enabled. Each sender's settings are encrypted under its own connection-instance vault key and never returned by the API. Existing legacy IMAP and SMTP credentials migrate to separate instances and are paired only when both are the unambiguous migrated accounts. An owner can unpair them permanently; newly created accounts are never paired by guesswork. The former global SMTP settings endpoints return a migration instruction instead of creating an invisible sender.

SMTP is used only for an IMAP send; Gmail continues to send through its own API. Every `email.send` still follows the consequential-action policy/approval and durable queue path. Approval displays the inbox and SMTP sender, and sender changes invalidate a pending approval. The transport accepts plain-text messages without attachments, validates recipients and headers, and records a local sent row only after provider acceptance. A timeout or rejection is reported as an uncertain outcome for owner review; it is not advertised as idempotent or automatically replayed. Automated delivery tests use a local capture SMTP server, not real recipients.

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
