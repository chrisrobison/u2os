// DeviceRegistry: the persisted catalog of every device any registered
// DeviceAdapter has discovered, plus the adapter lifecycle
// (registerAdapter/stopAll) that populates it. This is Phase 1's "Device
// Registry" + the device-record half of the "U2OS Device Bus" from
// docs/devices.md -- capability INVOCATION (the resolver, execution
// context, trust/privacy-aware routing) is deliberately NOT implemented
// here yet; see docs/devices.md's phase notes.
//
// Storage pattern mirrors server/triggers/trigger-engine.js exactly: plain
// functions-on-a-class over `devices` rows, JSON-encoded array/object
// columns, id supplied by the caller (here: by the adapter, since device
// ids are meant to be human-legible -- "camera.kitchen" -- not opaque
// generated ids).
import { log } from '../logging/logger.js';

const VALID_STATUS = new Set(['online', 'offline']);
const VALID_TRUST = new Set(['untrusted', 'paired', 'trusted', 'revoked']);

export class DeviceRegistry {
  constructor({ db, eventBus, capabilityRegistry } = {}) {
    if (!db) throw new Error('DeviceRegistry requires db');
    this.db = db;
    this.eventBus = eventBus || null;
    this.capabilityRegistry = capabilityRegistry || null;
    this._adapters = new Map();
  }

  // --- adapter lifecycle --------------------------------------------------

  /** Starts `adapter` and runs its initial discovery pass. Devices it
   * returns are persisted immediately. Throws if an adapter with the same
   * `.id` is already registered (same "duplicate registration fails loudly"
   * posture as ToolRegistry.register()/PolicyEngine's tool lookups). */
  async registerAdapter(adapter) {
    if (!adapter || typeof adapter.id !== 'string' || !adapter.id) {
      throw new Error('DeviceAdapter.id is required');
    }
    if (this._adapters.has(adapter.id)) {
      throw new Error(`Adapter already registered: ${adapter.id}`);
    }
    this._adapters.set(adapter.id, adapter);

    const emit = (partial) => this._emit({ ...partial, source: partial?.source || `device-adapter:${adapter.id}` });
    // eventBus is exposed to adapters (Phase 3) so a realtime adapter can
    // forward bus events to connected clients that subscribe -- read-only
    // subscription, still only ever publishing back through `emit` above.
    try {
      await adapter.start({ emit, registry: this, eventBus: this.eventBus });
    } catch (err) {
      this._adapters.delete(adapter.id);
      throw new Error(`Adapter "${adapter.id}" failed to start: ${err.message}`);
    }

    await this.runDiscovery(adapter.id);
    return adapter;
  }

  /** Runs `discover()` again for an already-registered adapter and persists
   * whatever it returns. Adapters that push devices out-of-band (e.g. a
   * browser client registering over its own connection, added in a later
   * phase) don't need this called repeatedly -- it exists for adapters
   * whose only way to learn about devices is polling/probing. */
  async runDiscovery(adapterId) {
    const adapter = this._requireAdapter(adapterId);
    const found = (await adapter.discover()) || [];
    return found.map((record) => this.upsertDevice(adapterId, record));
  }

  listAdapters() {
    return [...this._adapters.keys()];
  }

  getAdapter(adapterId) {
    return this._adapters.get(adapterId) || null;
  }

  /** Stops every registered adapter and forgets them. Safe to call more
   * than once. Devices already persisted are left as-is (they simply stop
   * receiving updates) -- this never deletes rows. */
  async stopAll() {
    for (const [id, adapter] of this._adapters) {
      try {
        await adapter.stop();
      } catch (err) {
        log.warn('device-registry', `adapter "${id}" failed to stop cleanly`, { error: err?.message || String(err) });
      }
    }
    this._adapters.clear();
  }

  // --- device records ------------------------------------------------------

  /** Inserts or updates one device record. `record`: {
   *   id, name, type, owner?, location?, capabilities?, metadata?, status?, trust?
   * } `id`/`name`/`type` are required; everything else has a safe default.
   * `trust` is only applied on first insert -- re-discovery of an existing
   * device NEVER changes its trust level (that is owner-controlled state,
   * per docs/devices.md's trust lifecycle; an adapter re-announcing a
   * device must not be able to re-trust itself). */
  upsertDevice(adapterId, record) {
    this._requireAdapter(adapterId);
    if (!record || typeof record.id !== 'string' || !record.id) {
      throw new Error('Device.id is required');
    }
    if (!record.name || !record.type) {
      throw new Error(`Device "${record.id}" requires name and type`);
    }

    const capabilities = this._normalizeCapabilities(record.capabilities);
    const status = VALID_STATUS.has(record.status) ? record.status : 'online';
    const now = new Date().toISOString();
    const existing = this.getDevice(record.id);

    if (!existing) {
      const trust = VALID_TRUST.has(record.trust) ? record.trust : 'untrusted';
      this.db
        .prepare(
          `INSERT INTO devices (id, name, type, owner, location, status, trust, capabilities, metadata, adapter, last_seen_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          record.id,
          record.name,
          record.type,
          record.owner ?? null,
          record.location ?? null,
          status,
          trust,
          JSON.stringify(capabilities),
          JSON.stringify(record.metadata || {}),
          adapterId,
          now,
          now,
          now
        );
      this._emit({
        type: 'device.discovered',
        source: `device-adapter:${adapterId}`,
        subject: { type: 'device', id: record.id },
        data: { device: this.getDevice(record.id) },
      });
      if (status === 'online') {
        this._emit({
          type: 'device.connected',
          source: `device-adapter:${adapterId}`,
          subject: { type: 'device', id: record.id },
          data: { deviceId: record.id },
        });
      }
      return this.getDevice(record.id);
    }

    const wasOffline = existing.status !== 'online';
    this.db
      .prepare(
        `UPDATE devices SET name = ?, type = ?, owner = ?, location = ?, status = ?, capabilities = ?, metadata = ?, adapter = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        record.name,
        record.type,
        record.owner ?? existing.owner ?? null,
        record.location ?? existing.location ?? null,
        status,
        JSON.stringify(capabilities),
        JSON.stringify(record.metadata ?? existing.metadata ?? {}),
        adapterId,
        now,
        now,
        record.id
      );

    if (wasOffline && status === 'online') {
      this._emit({
        type: 'device.connected',
        source: `device-adapter:${adapterId}`,
        subject: { type: 'device', id: record.id },
        data: { deviceId: record.id },
      });
    } else if (!wasOffline && status === 'offline') {
      this._emit({
        type: 'device.disconnected',
        source: `device-adapter:${adapterId}`,
        subject: { type: 'device', id: record.id },
        data: { deviceId: record.id },
      });
    }
    return this.getDevice(record.id);
  }

  /** Marks a device online/offline without going through full
   * upsertDevice() -- the shape a heartbeat/presence update (Phase 3) will
   * use. Emits device.connected/device.disconnected on an actual
   * transition only, same rule as upsertDevice(). */
  setStatus(id, status) {
    if (!VALID_STATUS.has(status)) throw new Error(`Invalid device status: ${status}`);
    const existing = this.getDevice(id);
    if (!existing) throw new Error(`Unknown device: ${id}`);
    if (existing.status === status) return existing;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE devices SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?').run(status, now, now, id);
    this._emit({
      type: status === 'online' ? 'device.connected' : 'device.disconnected',
      source: `device:${id}`,
      subject: { type: 'device', id },
      data: { deviceId: id },
    });
    return this.getDevice(id);
  }

  /** Owner-driven metadata edit -- Phase 6's "Rename / Set location / Set
   * owner" management actions (docs/devices.md). Deliberately narrow: only
   * name/location/owner, never status/trust/capabilities/adapter, which
   * all have their own dedicated, more carefully-reasoned-about mutators
   * above. Passing `undefined` for a field leaves it unchanged; passing
   * `null` clears it. */
  updateDevice(id, { name, location, owner } = {}) {
    const existing = this.getDevice(id);
    if (!existing) throw new Error(`Unknown device: ${id}`);
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE devices SET name = ?, location = ?, owner = ?, updated_at = ? WHERE id = ?')
      .run(
        name !== undefined ? name : existing.name,
        location !== undefined ? location : existing.location,
        owner !== undefined ? owner : existing.owner,
        now,
        id
      );
    return this.getDevice(id);
  }

  /** Sets a device's trust level. This is deliberately the ONLY way trust
   * changes -- adapters can never set it via upsertDevice() re-discovery
   * (see the comment there). A full pairing/approval flow (PLAN.md-style
   * phased work) will call this from an owner-authorized route; for now it
   * is plumbing other code (including tests) can call directly. Revoking a
   * device must be effective immediately for any future resolver/invoke
   * path -- this function only records the state transition; enforcement
   * lives wherever invocation is added. */
  setTrust(id, trust) {
    if (!VALID_TRUST.has(trust)) throw new Error(`Invalid trust level: ${trust}`);
    const existing = this.getDevice(id);
    if (!existing) throw new Error(`Unknown device: ${id}`);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE devices SET trust = ?, updated_at = ? WHERE id = ?').run(trust, now, id);
    this._emit({
      type: trust === 'revoked' ? 'device.revoked' : 'device.trust_changed',
      source: `device:${id}`,
      subject: { type: 'device', id },
      data: { deviceId: id, trust },
    });
    return this.getDevice(id);
  }

  /** Updates last_seen_at only, with no status change and no event
   * published -- the lightweight "still there" update a heartbeat/pong
   * (Phase 3) makes far more often than an actual online/offline
   * transition. A no-op (not an error) for an unknown device, since a
   * heartbeat racing a disconnect/removal is expected, not exceptional. */
  touch(id) {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  }

  /** Permanently forgets a device (administrative removal, distinct from
   * going offline). */
  removeDevice(id) {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  getDevice(id) {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    return row ? rowToDevice(row) : null;
  }

  listDevices({ type, owner, location, status, trust, capability } = {}) {
    const clauses = [];
    const params = [];
    if (type) { clauses.push('type = ?'); params.push(type); }
    if (owner) { clauses.push('owner = ?'); params.push(owner); }
    if (location) { clauses.push('location = ?'); params.push(location); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (trust) { clauses.push('trust = ?'); params.push(trust); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM devices ${where} ORDER BY created_at DESC`).all(...params);
    const devices = rows.map(rowToDevice);
    return capability ? devices.filter((d) => d.capabilities.includes(capability)) : devices;
  }

  /** Every currently-known device that claims support for `capabilityId`.
   * This is intentionally NOT eligibility/ranking (no trust/online/privacy
   * filtering) -- it is the raw "who claims to support this" lookup the
   * capability resolver (added with invocation) will filter down from. */
  findProvidersFor(capabilityId, opts = {}) {
    return this.listDevices({ ...opts, capability: capabilityId });
  }

  _requireAdapter(adapterId) {
    const adapter = this._adapters.get(adapterId);
    if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
    return adapter;
  }

  _normalizeCapabilities(capabilities) {
    const list = Array.isArray(capabilities) ? [...new Set(capabilities)] : [];
    if (this.capabilityRegistry) {
      for (const id of list) {
        if (!this.capabilityRegistry.has(id)) {
          log.warn('device-registry', `device advertises unregistered capability "${id}"`, { capability: id });
        }
      }
    }
    return list;
  }

  _emit(partial) {
    if (!this.eventBus) return;
    this.eventBus.publish(partial);
  }
}

function rowToDevice(row) {
  return {
    ...row,
    capabilities: JSON.parse(row.capabilities || '[]'),
    metadata: JSON.parse(row.metadata || '{}'),
  };
}
