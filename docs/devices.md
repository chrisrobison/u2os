# U2OS device and capability subsystem

**Status: Phases 1–7 of a phased rollout — see "Phases" at the bottom.**
Implemented: devices, capabilities, the device registry, the adapter
interface, a mock adapter, a deterministic capability resolver + invocation,
a realtime WebSocket device bus, the browser itself as a registered device,
semantic presentation (`presentation.present`/`presentation.notify`) wired
into the real policy/approval pipeline, a device management UI, and the
trust lifecycle foundation (enforced revocation, pairing-request events,
the documented crypto-identity seam). `listen()` and streams are later
phases and are not implemented yet.

## Why this exists

U2OS should not expose arbitrary hardware/service APIs directly to an LLM.
Instead:

> Devices expose capabilities. Agents request semantic capabilities. U2OS
> resolves those requests to appropriate devices or services.

An agent should be able to express *intent* (`captureImage({ location:
"kitchen" })`) without knowing there's a specific camera, IP address, or
protocol behind it. This is the same posture U2OS already takes with tools
and connectors (docs/tools.md, docs/connectors.md) — a fixed, code-defined,
policy-gated seam between "what the model wants" and "what actually runs" —
generalized to physical/remote devices and the future satellite protocol
PROMPT.md §24 already anticipates.

```text
Physical / Remote Devices
        │
        ▼
Device Adapters
        │
        ▼
Device Registry  ───publishes───▶  existing EventBus (server/events/event-bus.js)
        │
        ▼
Capability Registry
        │
        ▼
Capability Resolver (deterministic; trust/privacy/ownership; never an LLM)
        │
        ▼
(Policy/authorization integration, semantic present()/listen() — later phase)
        │
        ▼
Agents
```

## Device model

A device is any physical or software endpoint capable of providing input,
output, state, events, or actions. Persisted in the `devices` table
(`server/db/schema.sql`), one row per device any registered adapter has
discovered:

```text
id            human-legible, adapter-assigned ("camera.kitchen", not a UUID)
name
type          "camera" | "display" | "microphone" | "sensor" | ...
owner
location
status        'online' | 'offline'               -- presence, not authorization
trust         'untrusted' | 'paired' | 'trusted' | 'revoked'
capabilities  [capability id, ...]
metadata      adapter-specific, deliberately unconstrained
adapter       which registered DeviceAdapter owns this device
lastSeen, createdAt, updatedAt
```

Trust is owner-controlled state: `DeviceRegistry.setTrust()` is the only way
it changes. Re-discovery of an already-known device (`upsertDevice()`) never
touches `trust` — an adapter re-announcing a device can never re-trust
itself. A full pairing/approval flow is future work (see Phases below); for
now `setTrust()`/`revoked` exist as plumbing other code and a future route
can call, and `MockDeviceAdapter`'s virtual devices are pre-trusted since
they're local test fixtures, not real hardware.

## Capability model

Capabilities are the semantic vocabulary devices/services are described in
terms of — `image.capture`, `ui.render`, `temperature.read` — registered
once, in code, at startup (`server/devices/register-capabilities.js`), the
same way `server/tools/register-all.js` populates the `ToolRegistry`.
`CapabilityRegistry` (`server/devices/capability-registry.js`) is in-memory
and mirrors `ToolRegistry`'s shape exactly (`register`/`get`/`has`/`list`,
duplicate registration throws).

A capability definition:

```js
{
  id: 'image.capture',
  description: '...',
  inputSchema: { /* JSON-Schema-like */ },
  outputSchema: { /* JSON-Schema-like */ },
  privacy: 'private',            // public | personal | private | sensitive
                                  //   -- same vocabulary as
                                  //   server/policy/data-processing-policy.js
  defaultAuthorization: 'confirm', // always | autonomous | confirm | never
                                    //   -- same vocabulary as
                                    //   server/policy/policy-engine.js
}
```

`privacy`/`defaultAuthorization` are advisory defaults only in this phase —
nothing enforces them yet. A capability definition never lists "supported
providers" itself; which devices currently support a capability is a
dynamic runtime fact, computed on demand.

## Device registry

`server/devices/device-registry.js`'s `DeviceRegistry` is the persisted
catalog plus the adapter lifecycle that populates it — the device-record
half of the "Device Bus". Key operations:

```text
registerAdapter(adapter)          start() the adapter, run its initial discover()
runDiscovery(adapterId)           re-run discover(), upsert whatever it returns
upsertDevice(adapterId, record)   insert or update one device record
getDevice(id) / listDevices(filters) / findProvidersFor(capabilityId)
setStatus(id, status)             online/offline, emits device.connected/disconnected
setTrust(id, trust)               owner-controlled trust transition
removeDevice(id)                  administrative permanent removal
stopAll()                         stop() every adapter; devices rows are left as-is
```

`findProvidersFor(capabilityId)` returns every device currently claiming
that capability — the raw "who claims to support this" lookup. It does
**not** filter by trust/online/privacy/ownership; that eligibility-and-
ranking logic is the capability resolver, added with invocation in a later
phase (see docs/devices.md's Phases section).

## Events

Device lifecycle reuses the **existing** `EventBus`
(`server/events/event-bus.js`) rather than a second parallel pub/sub — its
envelope (`id`, `type`, `source`, `timestamp`, `data`, plus `subject`/
`correlationId`/`causationId`) already is the "common event envelope" the
device architecture calls for. Emitted today: `device.discovered`,
`device.connected`, `device.disconnected`, `device.trust_changed`,
`device.revoked`. Subscribe the same way as any other event:

```js
eventBus.subscribe('device.*', (event) => { ... });
```

## Device adapters

`server/devices/device-adapter.js`'s `DeviceAdapter` is the base class every
integration extends:

```js
class DeviceAdapter {
  get id() {}                                   // stable adapter id, e.g. "mock"
  async start({ emit, registry }) {}             // emit(event) publishes on the shared EventBus
  async stop() {}
  async discover() { return []; }                // freshly-discovered device records
  async getDevices() { return []; }               // currently-known devices, no re-discovery
  async invoke(device, capability, args, context) {}
  async getStream(device, streamName) {}
}
```

This deviates from a literal reading of the original sketch in one place:
there is no adapter-owned `subscribe(callback)`. Adapter-originated events
flow through the same `EventBus` every other event in U2OS uses, via the
`emit` function passed into `start()` — a second parallel event mechanism
living only inside this subsystem would add nothing but two ways to do the
same thing.

### Writing a new adapter

```js
import { DeviceAdapter } from './device-adapter.js';

export class MyCoolDeviceAdapter extends DeviceAdapter {
  get id() { return 'my-cool-thing'; }
  async discover() {
    return [{ id: 'my-thing.living-room', name: 'My Thing', type: 'light', capabilities: ['light.set'] }];
  }
  async invoke(device, capability, args) { /* ... */ }
}
```

```js
await deviceRegistry.registerAdapter(new MyCoolDeviceAdapter());
```

Devices and capabilities then simply appear in `GET /api/devices` and
`GET /api/capabilities` — no other code needs to change. `capabilities`
referenced by a device that aren't yet registered in the
`CapabilityRegistry` log a warning (never a hard failure) so an adapter can
ship ahead of the capability catalog being extended.

### Mock adapter

`server/devices/adapters/mock-device-adapter.js` registers four virtual
devices with no real hardware behind them (a kitchen camera, an office
microphone, a living-room display, an office temperature sensor) — the same
role `server/integrations/mock-*-provider.js` play for connectors. Always
registered at startup, so the registry is never empty even with zero real
adapters configured, and the subsystem is fully testable offline
(`tests/device-registry.test.js`).

## Capability resolver (Phase 2)

`server/devices/capability-resolver.js` answers, deterministically, "which
device should handle this?" — the one place PROMPT.md's "security-sensitive
routing is deterministic and enforced outside the LLM" invariant is
implemented for devices. No model is ever consulted.

```js
explainResolution(capabilityId, { audience, privacy, location }, { deviceRegistry, capabilityRegistry })
// -> { capability, request, candidates: [{ device, eligible, score, reasons }], chosen }

resolveCapability(capabilityId, request, deps)  // -> the chosen device record, or null
```

Rules, in order, per candidate (every candidate that advertises the
capability is evaluated and explained, eligible or not):

1. `trust: 'revoked'` → always ineligible, for anything, unconditionally.
2. `status !== 'online'` → ineligible ("device is offline").
3. Trust caps the maximum privacy tier a device may ever receive:
   `untrusted → public`, `paired → personal`, `trusted → sensitive`.
   Requesting above a device's cap makes it ineligible.
4. Ownership: a device owned by a specific *other* person (not the
   `household`/shared owner, not ownerless) is never eligible for content
   addressed to a different audience. At `private`/`sensitive` tiers this
   tightens further — the device's owner must exactly match the
   audience; a `household`-owned display is never eligible no matter how
   trusted it is (mirrors the PLAN-level "kitchen TV rejected for private
   data" example exactly).
5. `location` is a scoring boost only, never disqualifying.

Candidates are sorted eligible-first, then by descending score, so
`chosen` is simply `candidates[0]` when it's eligible.

### Capability invocation

`server/devices/capabilities.js`'s `invokeCapability(capabilityId, args,
request, { deviceRegistry, capabilityRegistry, eventBus })` resolves via the
function above, builds the documented execution context (`actor`,
`session`, `sourceDevice`, `location`, `authenticationLevel`, `privacy`,
`targetDevice`), delegates to the chosen device's adapter, and publishes
exactly one of `capability.invoked` / `capability.failed`. A device revoked
between resolution and execution is refused (defense in depth) even though
the resolver already excludes revoked devices.

This is **not yet** wired into `server/policy/policy-engine.js`'s
tool-authorization pipeline or the `agent_actions` audit log — see Known
gaps.

## Realtime device bus (Phase 3)

`server/devices/adapters/websocket-device-adapter.js`'s `WebSocketDeviceAdapter`
lets any process that can speak WebSocket + a small JSON protocol register
itself as a device over a persistent connection -- the transport a future
satellite, Raspberry Pi node, or (Phase 4) the browser client itself will
use. It attaches to the **same** `http.Server` U2OS already runs (no new
port) via the `'upgrade'` event, routed at `/ws/devices`
(`server/index.js`).

```text
device -> server   {type:'hello', device:{id,name,type,owner?,location?,capabilities,metadata?}}
device -> server   {type:'event', event:{type, data?, subject?}}
device -> server   {type:'heartbeat'}
device -> server   {type:'subscribe', pattern}
device -> server   {type:'command_result'|'command_error', requestId, result|error}

server -> device   {type:'hello_ack', deviceId}
server -> device   {type:'command', requestId, capability, args}
server -> device   {type:'event', event}
server -> device   {type:'error', message}
```

- **Connections**: `hello` upserts the device (`online`); an abrupt drop or
  clean close marks it `offline`. Reconnecting with the same device id
  brings it back online and replaces the stale connection outright, and
  never touches `trust` (same rule as any other adapter's re-discovery).
- **Heartbeats**: two independent mechanisms, deliberately not one --
  application-level `heartbeat` messages update `last_seen_at`
  (`DeviceRegistry.touch()`) without status/event churn on every beat;
  protocol-level WebSocket ping/pong (server-initiated, `heartbeatIntervalMs`)
  detects a connection that's gone silent without ever closing, and
  terminates it (which then flows through the normal disconnect path).
- **Event publication**: a device's `event` message is published on the
  **same shared EventBus** everything else in U2OS uses, with
  `source: "device:<id>"`.
- **Event subscription**: a device can `subscribe` to an EventBus pattern
  (e.g. `"calendar.*"`) and receive matching events pushed to it as
  `{type:'event', ...}`; all subscriptions for a connection are torn down
  on disconnect (no leaked subscribers across reconnects).
- **Device commands**: `WebSocketDeviceAdapter.invoke(device, capability,
  args)` sends a `command` message and returns a promise resolved/rejected
  by the device's `command_result`/`command_error` reply, or rejected on
  timeout (`commandTimeoutMs`) or "not connected". This is the realtime
  transport's implementation of the same `DeviceAdapter.invoke()` contract
  every other adapter implements -- `invokeCapability()` (Phase 2) doesn't
  need to know or care which adapter a device came from.
- **Streams stay separate**: there is no bulk/media payload path in this
  protocol, by design -- see Known gaps and the Phases list.

### Transport-level authentication

`server/devices/realtime/device-token.js` generates and persists (0600,
under `<U2OS_HOME>/credentials/`) a single per-installation connect token,
required as `?token=` on the `/ws/devices` upgrade request or the
connection is refused before the WebSocket handshake completes. This is
deliberately **not** device identity or authorization -- it answers "is
this caller even allowed to speak the device protocol at all", nothing
more. A device that connects successfully still starts at `trust:
'untrusted'` in the registry, same as any other adapter's freshly
discovered device. Phase 7's per-device cryptographic pairing is the
intended replacement; this token is the explicit seam it plugs into.

## Browser/UI device (Phase 4)

Every connected U2OS browser tab registers itself as a `type: 'browser'`
device over the realtime bus above -- there is no single privileged concept
called "the UI"; a browser tab is exactly one more device, discoverable and
addressable through the same resolver as a physical camera or display.

- **`public/services/device-client.js`**'s `DeviceClientService` connects
  to `/ws/devices` (token fetched from the session-gated `GET
  /api/devices/connect-token`), sends `hello` with a device id persisted in
  `localStorage` (stable across reloads -- "the same device reconnecting",
  not a new one every page load), and advertises exactly the capabilities
  the page can honor with **no browser permission prompt**:
  `ui.render`, `ui.notify`, `ui.prompt`, `audio.play`. Capabilities needing
  a permission (`camera.capture`, `audio.capture`, `geolocation.read`) are
  deliberately not advertised yet -- adding one is a later, explicit
  opt-in, never a silent capability-list change (PROMPT.md's "do not
  request every browser permission at startup").
- **`public/components/u2-device-panel.js`** renders what arrives:
  `ui.notify` -> an auto-dismissing toast, `ui.render` -> a persistent,
  dismissible card, `ui.prompt` -> an interactive card whose answer is sent
  back as that command's actual result. Only fixed, known fields are ever
  rendered (never raw HTML) -- the same "generated UI, not generated code"
  rule the rest of the trusted component set follows.
- **`public/components/u2-app.js`** owns one `DeviceClientService` for the
  life of the app, the same lifetime as its one SSE connection.

### Known single-owner simplification

A browser device reports `owner: 'owner'` -- a fixed sentinel standing in
for "the one authenticated owner of this instance", since there is not yet
a formal mapping from an authenticated session to a `device.owner` string
(see Phase 2's Known gaps; the same gap this inherits). A freshly-connected
browser starts `trust: 'untrusted'` like any other device -- it is eligible
for `public`-tier content immediately, but `personal`/`private`/`sensitive`
content requires an explicit trust promotion (`DeviceRegistry.setTrust()`)
until Phase 7 adds a real pairing flow.

## Semantic presentation (Phase 5)

`server/tools/presentation-tools.js` registers `presentation.present` and
`presentation.notify` as ordinary Tools (`server/tools/register-all.js`) --
which is what actually closes the "capability invocation isn't
policy-gated yet" gap earlier phases left open. Because they're real
Tools, a call goes through the exact same pipeline every other tool
already uses: `PolicyEngine.evaluate()` -> an `agent_actions` audit row ->
(per `policies.yaml`, `presentation` is unconfigured by default, so this
fails safe to `confirm`) an approval step -> `ActionExecutor.execute()` ->
`invokeCapability()` -> the resolver -> the chosen device's adapter. No
bespoke authorization code was needed in the device subsystem itself.

```js
// what an agent effectively calls, via the planner or a direct tool call:
await evaluateAndMaybeExecute({
  tool: 'presentation.present',
  arguments: { audience: 'chris', privacy: 'private', content: { title: 'Today', body: '3 meetings' } },
});
// -> resolves to Chris's phone (owner match, trusted, online);
//    the household living-room display is evaluated and rejected
//    (docs/devices.md's resolver rules), never silently used instead.
```

`presentation.notify` is the lighter-weight sibling (`{audience, privacy?,
title, body?}` -> `ui.notify`, a toast rather than a full card). Both
tools are constructed with `{deviceRegistry, capabilityRegistry}` via
`server/index.js` (constructor injection, not a module-singleton accessor
like `getProvider()` -- see the file header comment for why); a caller
that builds a `ToolRegistry` without a device subsystem configured (most
existing tests) still gets a complete registry -- the two tools simply
throw clearly if actually executed, the same fail-safe-at-use posture as
an unconnected real connector.

## Device management UI (Phase 6)

`public/components/u2-devices.js` (`#/devices` in the nav) lists every
known device -- status dot, name, type/location, trust badge -- and
expands a row into its detail: owner/location/adapter/last-seen,
capability chips (click one to test it directly against that device),
recent activity (the last 20 events with this device as `subject`, via the
new `subjectType`/`subjectId` filters on `GET /api/events`), and
management controls:

- **Rename / Set location / Set owner** -- a small form, `PATCH
  /api/devices/:id`.
- **Pair / Trust / Revoke** -- one trust-level `<select>`, `POST
  /api/devices/:id/trust`. A real pairing *flow* (device-initiated request,
  credential exchange) is Phase 7; this is the owner-driven "just set it"
  primitive that flow will eventually call into.
- **Test capability** -- clicking a capability chip calls `POST
  /api/devices/:id/test`, which directly invokes THAT device (bypassing
  the resolver on purpose -- see `invokeDeviceCapability()` below) and
  shows the raw result inline.
- **Remove device** -- `DELETE /api/devices/:id`, administrative/permanent.

Same "self-fetching custom element" pattern as `u2-connectors.js`: the
component owns its own data-fetching and state; `u2-app.js` just mounts it.

### `invokeDeviceCapability()` (direct/admin invoke)

`server/devices/capabilities.js`'s `invokeDeviceCapability(deviceId,
capabilityId, args, deps)` is new alongside the Phase 2 resolver-driven
`invokeCapability()`: it targets exactly the device the owner picked in the
UI, skipping resolution entirely -- but still refuses a revoked device or
one that doesn't actually advertise the capability, and still publishes
`capability.invoked`/`capability.failed` (tagged `direct: true`). Like the
raw `POST /api/capabilities/:capability/invoke` route, this does **not**
go through `PolicyEngine` -- it is explicitly an owner-only debug/test
primitive, never something an agent's planning loop should reach.

## Trust lifecycle foundation (Phase 7)

The lifecycle diagram from the original spec --
`discovered -> pairing request -> user approval -> trusted -> revoked` --
was already mostly real by Phase 1 (`untrusted` is what "discovered" means
here; `DeviceRegistry.setTrust()` is "user approval"). This phase closes
the two pieces that weren't: a **pairing request** signal, and revocation
that's actually **enforced everywhere**, not just recorded.

- **Pairing request**: `WebSocketDeviceAdapter` emits `device.pairing_requested`
  the moment a genuinely new device id sends its first `hello` -- captured
  by checking `deviceRegistry.getDevice(id)` for `null` *before*
  `upsertDevice()` runs. A reconnecting *known* device never re-requests
  pairing. `MockDeviceAdapter`'s fixtures don't emit this either -- they're
  pre-trusted local dev fixtures, not remote devices actually being paired.
- **Enforced revocation**: setting a device's trust to `revoked`
  (`DeviceRegistry.setTrust()`) now does three things atomically-in-effect:
  1. Writes `trust = 'revoked'` (already true since Phase 1) -- this row is
     what every resolver/invoke check actually reads, and is authoritative
     the instant this returns.
  2. Force-disconnects any live realtime connection: `setTrust()` calls the
     owning adapter's new `disconnect(deviceId)` hook
     (`DeviceAdapter.disconnect()` -- default no-op; `WebSocketDeviceAdapter`
     overrides it to `ws.terminate()` the live connection, if any). This is
     fire-and-forget -- the trust row above is already the actual
     enforcement point, this is wire-level cleanup.
  3. `WebSocketDeviceAdapter._handleEvent()` separately re-checks the
     device's trust on every single `event` message, refusing anything from
     an already-revoked device even in the race window before its
     connection is actually torn down.

  Combined with the resolver (excludes `revoked` unconditionally) and
  `invokeCapability()`/`invokeDeviceCapability()`'s own re-checks (Phases
  2/6), a revoked device is refused on every path at once: it cannot be
  resolved, cannot be invoked (via either the resolver or the direct/test
  path), cannot publish another event, and loses its live connection.

### Cryptographic device identity (the documented seam)

A full PKI is explicitly not required by this phase unless it fits
naturally -- it doesn't yet, so here is the seam a future phase plugs into
without changing anything else:

- **Where a public key would live**: `device.metadata` (a free-form JSON
  column since Phase 1) -- e.g. `metadata.publicKey`. No schema change
  needed; `tests/device-trust-lifecycle.test.js` demonstrates storing this
  today.
- **How verification would work**: a future adapter's `hello` handling
  would require the device to sign a server-issued nonce/challenge with
  its private key, verified with `node:crypto`'s `verify()` against the
  stored public key, BEFORE that hello is accepted at all.
- **What changes when it lands**: nothing about `DeviceRegistry`,
  the resolver, or the invocation paths -- only what's allowed to CALL
  `setTrust()` beyond the owner. A verified signature could justify
  auto-promoting `untrusted -> paired` (never straight to `trusted`,
  and never bypassing `setTrust()` itself) -- still one deterministic
  function, still fully auditable, still never influenced by anything
  the device merely *claims* about itself in a `hello` payload's plain
  fields (`name`/`type`/`owner`/etc, which remain exactly as
  self-reported and untrusted as they are today).
- The realtime bus's connect token (`server/devices/realtime/device-token.js`)
  is the transport-level gate this identity layer is *layered on top of*,
  not a replacement for it -- see that file's header comment.

## API

```text
GET  /api/devices                              filter: type/owner/location/status/trust/capability
PATCH /api/devices/:id                          { name?, location?, owner? }
POST /api/devices/:id/trust                     { trust: 'untrusted'|'paired'|'trusted'|'revoked' }
POST /api/devices/:id/test                      { capability, args? }  -- direct, resolver-bypassing (owner-only)
DELETE /api/devices/:id
GET  /api/devices/:id
GET  /api/capabilities
GET  /api/capabilities/:capability/providers
GET  /api/capabilities/:capability/resolve      ?audience=&privacy=&location=  (explanation output; never invokes)
POST /api/capabilities/:capability/invoke        { args, audience?, privacy?, location?, sourceDevice? }
WS   /ws/devices?token=<connect-token>           realtime device connections (see above)
GET  /api/devices/connect-token                  session-gated; lets an authenticated browser obtain the WS token itself
```

All require an authenticated session; `POST` additionally requires CSRF,
like every other private write route (`server/api/router.js`). `audience`
on the invoke route is client-supplied and not yet bound to the
authenticated owner — see Known gaps.

## Known gaps (by design, this phase)

- **`POST /api/capabilities/:capability/invoke` still bypasses
  `PolicyEngine`/`agent_actions` entirely** -- it calls
  `invokeCapability()` directly, not through a Tool. This is the one place
  in the device subsystem that does not yet fully honor "the device bus
  MUST NOT bypass authorization checks": it is gated by session
  authentication + CSRF like every other private write route, but NOT by
  autonomy level or an approval step, and produces no audit trail. Contrast
  with `presentation.present`/`presentation.notify` (Phase 5, above), which
  ARE fully policy-gated because they're real Tools reached through
  `evaluateAndMaybeExecute()` -- exactly the pattern every other
  consequential route in this codebase uses (e.g. `POST /api/tasks` ->
  `tasks.create`). Closing this for every capability, not just the two
  wrapped as tools, needs either a Tool per capability or teaching
  `invokeCapability()` itself to consult `PolicyEngine` generically using
  each capability's own `defaultAuthorization` -- deliberately deferred
  rather than rushed into this phase; treat the raw invoke route as a
  trusted-owner-only debug/direct-control surface until this is closed,
  not as something meant to be reachable by an agent's own planning loop.
- `audience` on `POST .../invoke` is client-supplied, not derived from the
  authenticated session — see the SECURITY comment in
  `server/api/routes/devices.js`. It only affects device *selection*; it
  is never treated as proof of identity or used to unlock anything the
  resolver's trust/privacy rules wouldn't already allow.
- No **cryptographic** pairing yet -- trust is entirely owner-driven via
  `DeviceRegistry.setTrust()` (directly, or through the Phase 6 management
  UI's Pair/Trust/Revoke control); there is no device-presented credential
  that could ever auto-promote trust. See "Cryptographic device identity"
  below for the documented seam this is expected to plug into.
- `WebSocketDeviceAdapter.invoke()`'s pending-command bookkeeping is keyed
  by request id only, not by device -- a device that disconnects mid-command
  leaves that specific call to resolve via its own timeout rather than
  failing immediately.
- No browser/DOM test coverage for `device-client.js`/`u2-device-panel.js`
  (this repo has no browser test runner yet -- PLAN.md Milestone 3's
  Playwright coverage is separate, future work); Phase 4 is instead proven
  end to end by `tests/browser-device-end-to-end.test.js` using a raw `ws`
  client that sends the exact hello shape the real browser client sends,
  plus manual verification in a real browser.
- No stream abstraction (`stream://device/name`) yet — `getStream()` is
  defined on the adapter interface but unimplemented beyond the mock's
  metadata-only reference.
- Services (Gmail, calendar, etc.) are not yet exposed as capability
  providers — `server/integrations/provider-registry.js`'s per-domain
  connector model is untouched by this phase.

## Phases

Following the same "implement incrementally, verify before continuing"
discipline as PLAN.md's milestones:

1. **Core model** (done) — device/capability model, registry, adapter
   interface, mock adapter, read-only API, tests.
2. **Capability invocation + resolver** (done) — deterministic, testable
   resolver, execution context, trust/privacy filtering, resolver
   explanation output, invoke route, tests.
3. **Realtime device bus** (done) — WebSocket connections at `/ws/devices`,
   heartbeats (application + protocol-level), online/offline presence,
   event publication/subscription over the shared EventBus, device
   commands (`invoke()` over the live connection), reconnect handling.
4. **Browser/UI device** (done) — a connected U2OS browser tab registers
   itself over the realtime bus and advertises `ui.render`/`ui.notify`/
   `ui.prompt`/`audio.play`, rendered by `<u2-device-panel>`.
5. **Semantic presentation** (done) — `presentation.present`/
   `presentation.notify` registered as real Tools, routed through the
   existing PolicyEngine/approval/audit pipeline and the Phase 2 resolver.
6. **Device management UI** (done) — `#/devices`: list, detail (metadata/
   capabilities/status/trust/owner/location/recent activity), rename/
   relocate/reassign owner, pair/trust/revoke, remove, test a capability
   directly against one device.
7. **Pairing/trust lifecycle, enforced revocation** (done) --
   `device.pairing_requested` on a genuinely new realtime connection;
   revocation forcibly disconnects a live connection and is checked on
   every event/invoke path, not just recorded; documented (not yet
   implemented) crypto-identity seam via `device.metadata`.
8. Stream registry/reference abstraction.
9. One existing service (e.g. Gmail) exposed through the same capability
   model, proving devices and services share one resolver.
