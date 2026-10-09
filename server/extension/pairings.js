// Pairing store for the browser extension channel (docs/job-hunt.md, SECURITY.md).
//
// The owner, signed in to the web UI, generates a short-lived one-time code.
// The extension exchanges it for a long-lived bearer token. Only SHA-256
// hashes of codes and tokens are stored (tokens are 256-bit random values, so
// a fast hash is sufficient), in <U2OS_HOME>/credentials/ with mode 0600,
// following server/devices/realtime/device-token.js. A token is shown once.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CODE_TTL_MS = 5 * 60_000;
const MAX_LIVE_CODES = 5;
const MAX_PAIRINGS = 20;
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
const EXCHANGE_FAILURES = { max: 10, windowMs: 60_000 };
export const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const equalDigest = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const normalizeCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export class PairingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class ExtensionPairings {
  constructor({ dataDir, now = () => Date.now() }) {
    this.dir = path.join(dataDir, 'credentials');
    this.file = path.join(this.dir, 'extension-pairings.json');
    this.now = now;
    this.failures = [];
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { codes: Array.isArray(data.codes) ? data.codes : [], pairings: Array.isArray(data.pairings) ? data.pairings : [] };
    } catch { return { codes: [], pairings: [] }; }
  }

  _save(state) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* best-effort */ }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
    fs.renameSync(tmp, this.file);
  }

  /** A fresh one-time code (shown to the owner once). */
  createCode() {
    const state = this._load();
    const now = this.now();
    state.codes = state.codes.filter((entry) => entry.expiresAt > now).slice(-(MAX_LIVE_CODES - 1));
    const raw = Array.from({ length: 10 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
    const expiresAt = now + CODE_TTL_MS;
    state.codes.push({ hash: sha256(raw).toString('hex'), expiresAt });
    this._save(state);
    return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Exchanges a one-time code for a token bound to the extension's origin. The code is consumed whether or not it was valid for this caller. */
  exchange({ code, origin, label }) {
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < EXCHANGE_FAILURES.windowMs);
    if (this.failures.length >= EXCHANGE_FAILURES.max) throw new PairingError('Too many failed pairing attempts; wait a minute', 429);
    if (!EXTENSION_ORIGIN.test(origin ?? '')) throw new PairingError('Pairing needs a chrome-extension origin', 403);
    const state = this._load();
    const digest = sha256(normalizeCode(code));
    const index = state.codes.findIndex((entry) => equalDigest(Buffer.from(entry.hash, 'hex'), digest));
    const entry = index >= 0 ? state.codes[index] : null;
    if (entry) { state.codes.splice(index, 1); this._save(state); } // one-time, even when expired
    if (!entry || entry.expiresAt <= now) {
      this.failures.push(now);
      throw new PairingError('Invalid or expired pairing code', 403);
    }
    if (state.pairings.length >= MAX_PAIRINGS) throw new PairingError('Too many paired extensions; revoke one first', 409);
    const token = `u2x_${crypto.randomBytes(32).toString('base64url')}`;
    const id = crypto.randomBytes(8).toString('hex');
    const cleanLabel = String(label ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 60) || 'Browser extension';
    state.pairings.push({ id, tokenHash: sha256(token).toString('hex'), origin, label: cleanLabel, createdAt: new Date(now).toISOString(), lastUsedAt: null });
    this._save(state);
    return { token, id, label: cleanLabel };
  }

  /** The pairing a bearer token belongs to (comparison is constant-time over every stored hash), or null. */
  authenticate(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const digest = sha256(token);
    const state = this._load();
    let found = null;
    for (const pairing of state.pairings) if (equalDigest(Buffer.from(pairing.tokenHash, 'hex'), digest)) found = pairing;
    if (!found) return null;
    const now = this.now();
    if (!found.lastUsedAt || now - Date.parse(found.lastUsedAt) > 60_000) {
      found.lastUsedAt = new Date(now).toISOString();
      try { this._save(state); } catch { /* usage time is informational */ }
    }
    return { id: found.id, origin: found.origin, label: found.label };
  }

  list() {
    return this._load().pairings.map(({ id, origin, label, createdAt, lastUsedAt }) => ({ id, origin, label, createdAt, lastUsedAt }));
  }

  /** Origins of every paired extension (for CORS preflight, which carries no token). */
  origins() { return new Set(this._load().pairings.map((pairing) => pairing.origin)); }

  revoke(id) {
    const state = this._load();
    const before = state.pairings.length;
    state.pairings = state.pairings.filter((pairing) => pairing.id !== id);
    if (state.pairings.length === before) return false;
    this._save(state);
    return true;
  }
}
