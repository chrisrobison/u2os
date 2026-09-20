// DeviceAdapter: the base class every device/service integration extends.
// This is the one seam future hardware (RTSP cameras, HomeKit, MQTT, a
// browser tab, a satellite mic) is normalized through -- adapters translate
// an external system into plain device records + capability ids;
// DeviceRegistry never knows anything protocol-specific.
//
// Adapted from the PROMPT-level sketch with one deliberate change: there is
// no adapter-owned `subscribe(callback)` for events. U2OS already has one
// durable, persisted, pattern-matchable pub/sub -- server/events/event-bus.js
// -- and a second parallel event mechanism living only inside the device
// subsystem would violate "prefer standard platform functionality... avoid
// speculative abstractions" for zero benefit. Instead, `start()` receives an
// `emit(partialEvent)` function (server/events/event-bus.js's `publish()`
// shape) already bound with this adapter as `source`, so adapter-originated
// events (motion detected, a browser connecting) flow through the exact
// same bus, log, and SSE feed as every other event in the system.
export class DeviceAdapter {
  /** Stable id for this adapter instance, e.g. "mock", "browser", "system".
   * Devices this adapter discovers are tagged with this id so
   * DeviceRegistry can route a later invoke()/getStream() call back to the
   * adapter that owns the device. */
  get id() {
    throw new Error('DeviceAdapter.id not implemented');
  }

  /** Called once by DeviceRegistry.registerAdapter(). `context`: {
   *   emit(partialEvent) -- publish an event with this adapter as source
   *   registry -- the owning DeviceRegistry, for adapters that need to look
   *               up other devices (rare; most adapters won't need this)
   * }
   * Adapters that need no setup can leave this as a no-op. */
  async start(_context) {}

  /** Called on shutdown. Must release any resources start() acquired
   * (timers, sockets, watchers). Safe to call even if start() was never
   * called or already failed partway through. */
  async stop() {}

  /** Returns freshly-discovered devices as plain device records (see
   * docs/devices.md for the shape) -- called once after start() and,
   * optionally, again on re-discovery. Adapters with no discovery step
   * (e.g. one device registered directly by start()) can leave this
   * returning []. */
  async discover() {
    return [];
  }

  /** Returns this adapter's currently-known devices without re-running
   * discovery -- a cheap "what do you have right now" read. Defaults to
   * empty; adapters that track their own device list should override this. */
  async getDevices() {
    return [];
  }

  /** Executes `capability` on `device` with `args`. `context` carries the
   * execution context (actor/session/sourceDevice/etc -- see
   * docs/devices.md's "execution context" section, added with capability
   * invocation in a later phase). Must throw if the device/adapter cannot
   * actually perform the capability. */
  async invoke(_device, _capability, _args, _context) {
    throw new Error(`${this.constructor.name}.invoke not implemented`);
  }

  /** Returns a stream reference (server/devices/stream-registry.js, added
   * when the stream abstraction lands) for a device that advertises a
   * streaming capability. Metadata/reference only in early phases -- never
   * a real media transport implemented in this class. */
  async getStream(_device, _streamName) {
    throw new Error(`${this.constructor.name}.getStream not implemented`);
  }
}
