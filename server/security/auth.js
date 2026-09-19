import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'u2os_session';

export class AuthService {
  constructor(db, options = {}) {
    this.db = db;
    this.idleSeconds = positive(options.idleSeconds ?? process.env.U2OS_SESSION_IDLE_SECONDS, 12 * 60 * 60);
    this.absoluteSeconds = positive(options.absoluteSeconds ?? process.env.U2OS_SESSION_ABS_SECONDS, 7 * 24 * 60 * 60);
  }

  hasOwner() {
    return Boolean(this.db.prepare('SELECT id FROM owners LIMIT 1').get());
  }

  async setup(passphrase) {
    validatePassphrase(passphrase);
    if (this.hasOwner()) throw httpError(409, 'Owner setup is already complete');
    const salt = crypto.randomBytes(16);
    const params = { N: 16384, r: 8, p: 1, keylen: 64 };
    const hash = await derive(passphrase, salt, params);
    const id = 'owner';
    this.db.prepare('INSERT INTO owners (id, passphrase_hash, salt, scrypt_params, created_at) VALUES (?,?,?,?,?)')
      .run(id, hash.toString('base64'), salt.toString('base64'), JSON.stringify(params), new Date().toISOString());
    return id;
  }

  async login(passphrase) {
    const owner = this.db.prepare('SELECT * FROM owners LIMIT 1').get();
    if (!owner || typeof passphrase !== 'string') return null;
    const params = JSON.parse(owner.scrypt_params);
    const actual = await derive(passphrase, Buffer.from(owner.salt, 'base64'), params);
    const expected = Buffer.from(owner.passphrase_hash, 'base64');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    return this.createSession(owner.id);
  }

  createSession(ownerId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    this.db.prepare('INSERT INTO sessions (id_hash, owner_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?)')
      .run(hashToken(token), ownerId, csrf, iso(now), iso(now), iso(now + this.absoluteSeconds * 1000));
    return { token, csrf, ownerId };
  }

  authenticate(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(hashToken(token));
    if (!row) return null;
    const now = Date.now();
    if (Date.parse(row.expires_at) <= now || Date.parse(row.last_seen_at) + this.idleSeconds * 1000 <= now) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
      return null;
    }
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(iso(now), row.id_hash);
    return { id: row.id_hash, ownerId: row.owner_id, csrfToken: row.csrf_token };
  }

  logout(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashToken(token));
  }

  cookie(req, token, { clear = false } = {}) {
    const secure = process.env.U2OS_SECURE_COOKIES === '1' || isHttps(req);
    return `${COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${clear ? '; Max-Age=0' : ''}`;
  }
}

export function isHttps(req) {
  if (req.socket?.encrypted) return true;
  return process.env.U2OS_TRUST_PROXY === '1' && String(req.headers['x-forwarded-proto']).split(',')[0].trim() === 'https';
}

export function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((v) => v.trim()).filter(Boolean).map((v) => {
    const i = v.indexOf('='); return i < 0 ? [v, ''] : [v.slice(0, i), v.slice(i + 1)];
  }));
}

function hashToken(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function iso(ms) { return new Date(ms).toISOString(); }
function positive(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function validatePassphrase(value) { if (typeof value !== 'string' || value.length < 12) throw httpError(400, 'Passphrase must be at least 12 characters'); }
function httpError(status, message) { const err = new Error(message); err.status = status; return err; }
async function derive(passphrase, salt, p) {
  return scrypt(passphrase, salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 64 * 1024 * 1024 });
}
