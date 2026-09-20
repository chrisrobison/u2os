// StreamRegistry -- Phase 8 (docs/devices.md). Continuous/high-bandwidth
// data (video, audio, screen share) must never be pushed through the
// ordinary EventBus (server/events/event-bus.js) -- commands, events, and
// streams stay distinct per the whole device architecture. This module is
// deliberately METADATA AND REFERENCES ONLY: it never transports a single
// media byte. A stream is identified by a `stream://<deviceId>/<name>` id;
// "opening" one resolves a device's adapter-provided reference (a URL plus
// a protocol string -- WebRTC/RTSP/HTTP/WebSocket/a local device handle,
// whatever that specific adapter actually offers) and hands it back for
// the CALLER to connect to directly. U2OS does not proxy, transcode, or
// relay the stream itself -- "do not attempt to build a media server" is
// a hard constraint, not a simplification to revisit later.
const STREAMING_CAPABILITIES = ['video.stream'];

export class StreamRegistry {
  constructor({ deviceRegistry, eventBus } = {}) {
    if (!deviceRegistry) throw new Error('StreamRegistry requires deviceRegistry');
    this.deviceRegistry = deviceRegistry;
    this.eventBus = eventBus || null;
    this._open = new Map(); // streamId -> { id, deviceId, streamName, reference, openedAt }
  }

  /** The canonical stream id for a device+name pair. Exported as a pure
   * function of its inputs (no state) so callers can construct/compare ids
   * without needing to have called discover()/open() first. */
  streamId(deviceId, streamName) {
    return `stream://${deviceId}/${streamName}`;
  }

  /** Lists the streams a device advertises, WITHOUT opening any of them --
   * pure metadata. A device's own `metadata.streams` (an adapter-populated
   * array of stream name strings) is authoritative when present; otherwise
   * a device advertising a known streaming capability (video.stream) is
   * assumed to have exactly one stream named "main". A device with neither
   * simply has no discoverable streams -- an empty list, not an error. */
  discover(deviceId) {
    const device = this.deviceRegistry.getDevice(deviceId);
    if (!device) throw new Error(`Unknown device: ${deviceId}`);

    const declared = Array.isArray(device.metadata?.streams) ? device.metadata.streams : null;
    const names = declared && declared.length ? declared : STREAMING_CAPABILITIES.some((c) => device.capabilities.includes(c)) ? ['main'] : [];

    return names.map((name) => ({ id: this.streamId(deviceId, name), device: deviceId, name }));
  }

  /**
   * Opens (references) one stream: resolves the device's adapter and calls
   * its getStream() (server/devices/device-adapter.js), records the
   * resulting reference as active, and publishes stream.available. Subject
   * to the same trust gate as any device access -- a revoked device can
   * never have a stream opened against it, unconditionally, matching every
   * other enforcement path in the device subsystem (docs/devices.md's
   * Phase 7 trust lifecycle).
   *
   * Returns { id, deviceId, streamName, reference }. `reference` is
   * whatever the adapter returned -- typically { url, protocol } -- and is
   * meaningless to interpret generically; only code that already knows
   * that adapter's protocol can use it.
   */
  async open(deviceId, streamName) {
    const device = this.deviceRegistry.getDevice(deviceId);
    if (!device) throw new Error(`Unknown device: ${deviceId}`);
    if (device.trust === 'revoked') throw new Error(`Device "${deviceId}" is revoked`);

    const adapter = this.deviceRegistry.getAdapter(device.adapter);
    if (!adapter) throw new Error(`Adapter "${device.adapter}" for device "${device.id}" is not registered`);

    const reference = await adapter.getStream(device, streamName);
    const id = this.streamId(deviceId, streamName);
    const entry = { id, deviceId, streamName, reference, openedAt: new Date().toISOString() };
    this._open.set(id, entry);

    this._emit({
      type: 'stream.available',
      source: `device:${deviceId}`,
      subject: { type: 'stream', id },
      data: { streamId: id, deviceId, streamName, reference },
    });

    return entry;
  }

  /** Closes a previously-opened stream reference -- bookkeeping only
   * (there is no underlying transport connection for U2OS itself to tear
   * down; the caller that actually connected to `reference` is responsible
   * for closing that connection on its own). Returns false, not an error,
   * for a stream that was never opened or already closed -- closing twice
   * is not exceptional. */
  close(streamId) {
    const entry = this._open.get(streamId);
    if (!entry) return false;
    this._open.delete(streamId);
    this._emit({
      type: 'stream.closed',
      source: `device:${entry.deviceId}`,
      subject: { type: 'stream', id: streamId },
      data: { streamId, deviceId: entry.deviceId, streamName: entry.streamName },
    });
    return true;
  }

  /** The currently-open entry for `streamId`, or null. */
  getOpen(streamId) {
    return this._open.get(streamId) || null;
  }

  /** Every currently-open stream (across all devices). */
  listOpen() {
    return [...this._open.values()];
  }

  _emit(partial) {
    if (!this.eventBus) return;
    this.eventBus.publish(partial);
  }
}
