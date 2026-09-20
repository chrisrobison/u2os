# U2OS device and capability subsystem

**Status: Phases 1–2 of a phased rollout — see "Phases" at the bottom.**
Implemented: devices, capabilities, the device registry, the adapter
interface, a mock adapter, and a deterministic capability resolver +
invocation. The semantic `present()`/`listen()` agent API, realtime device
connections, pairing, and streams are later phases and are not implemented
yet.

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

## API

```text
GET  /api/devices                              filter: type/owner/location/status/trust/capability
GET  /api/devices/:id
GET  /api/capabilities
GET  /api/capabilities/:capability/providers
GET  /api/capabilities/:capability/resolve      ?audience=&privacy=&location=  (explanation output; never invokes)
POST /api/capabilities/:capability/invoke        { args, audience?, privacy?, location?, sourceDevice? }
```

All require an authenticated session; `POST` additionally requires CSRF,
like every other private write route (`server/api/router.js`). `audience`
on the invoke route is client-supplied and not yet bound to the
authenticated owner — see Known gaps.

## Known gaps (by design, this phase)

- Capability invocation is **not** gated by `PolicyEngine`/autonomy levels
  or recorded in `agent_actions` — a capability's `defaultAuthorization` is
  advisory metadata only right now. Wiring this in is expected alongside
  the semantic agent-facing API (`present()`), not bolted on ahead of an
  actual caller that needs it.
- `audience` on `POST .../invoke` is client-supplied, not derived from the
  authenticated session — see the SECURITY comment in
  `server/api/routes/devices.js`. It only affects device *selection*; it
  is never treated as proof of identity or used to unlock anything the
  resolver's trust/privacy rules wouldn't already allow.
- No realtime device connections (WebSocket), heartbeats, browser/UI client
  registration, or pairing/approval flow.
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
3. Realtime device bus (WebSocket connections, heartbeats, online/offline).
4. Browser/UI device (a connected U2OS browser session registers itself).
5. Semantic presentation (`present()`) with privacy-aware routing.
6. Device management UI.
7. Pairing/trust lifecycle, enforced revocation.
8. Stream registry/reference abstraction.
9. One existing service (e.g. Gmail) exposed through the same capability
   model, proving devices and services share one resolver.
