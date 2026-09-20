# U2OS device and capability subsystem

**Status: Phase 1 of a phased rollout — see "Phases" at the bottom.** This
covers the core model only: devices, capabilities, the device registry, the
adapter interface, and a mock adapter. Capability *invocation* through a
trust/privacy-aware resolver, the semantic `present()`/`listen()` agent API,
realtime device connections, pairing, and streams are later phases and are
not implemented yet.

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
(Capability Resolver / Policy — later phase)
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

## API

Read-only for this phase — inspecting the registry grants no new authority,
since anything here was already knowable to server-side code:

```text
GET /api/devices                              filter: type/owner/location/status/trust/capability
GET /api/devices/:id
GET /api/capabilities
GET /api/capabilities/:capability/providers
```

All require an authenticated session, like every other private route
(server/api/router.js).

## Known gaps (by design, this phase)

- No capability **invocation** route or resolver yet — `DeviceAdapter.invoke()`
  exists and is exercised directly in tests, but nothing routes an agent's
  semantic request (`present()`, `captureImage()`) through trust/privacy-aware
  device selection yet.
- No execution context (`actor`/`session`/`sourceDevice`/`privacy`) is
  threaded through anything yet — there is nothing to thread it through
  until invocation exists.
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

1. **Core model** (this phase) — device/capability model, registry, adapter
   interface, mock adapter, read-only API, tests.
2. Capability invocation + a deterministic, testable resolver + execution
   context + trust/privacy filtering + resolver explanation output.
3. Realtime device bus (WebSocket connections, heartbeats, online/offline).
4. Browser/UI device (a connected U2OS browser session registers itself).
5. Semantic presentation (`present()`) with privacy-aware routing.
6. Device management UI.
7. Pairing/trust lifecycle, enforced revocation.
8. Stream registry/reference abstraction.
9. One existing service (e.g. Gmail) exposed through the same capability
   model, proving devices and services share one resolver.
