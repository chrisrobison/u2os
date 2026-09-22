import { URL } from 'node:url';
import { log } from '../logging/logger.js';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC = new Set(['GET /api/health', 'GET /api/auth/status', 'POST /api/auth/setup', 'POST /api/auth/login', 'POST /api/auth/logout']);

export class Router {
  constructor({ auth = null, publicOrigin = null, bodyLimit = Number(process.env.U2OS_BODY_LIMIT_BYTES) || 1048576 } = {}) {
    this.routes = []; this.auth = auth; this.publicOrigin = publicOrigin; this.bodyLimit = bodyLimit; this.limiter = new RateLimiter();
  }
  get(p, h, o) { this._add('GET', p, h, o); } post(p, h, o) { this._add('POST', p, h, o); }
  put(p, h, o) { this._add('PUT', p, h, o); } patch(p, h, o) { this._add('PATCH', p, h, o); } delete(p, h, o) { this._add('DELETE', p, h, o); }
  _add(method, path, handler, options = {}) {
    const paramNames = [];
    const patternStr = path.split('/').map((s) => { if (s.startsWith(':')) { paramNames.push(s.slice(1)); return '([^/]+)'; } return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('/');
    this.routes.push({ method, path, pattern: new RegExp(`^${patternStr}$`), paramNames, handler, options });
  }
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost'); let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return sendJson(res, 400, { error: 'Bad Request' }); }
    const paths = this.routes.filter((r) => r.pattern.test(pathname)); const match = paths.find((r) => r.method === req.method);
    if (!match) return sendJson(res, paths.length ? 405 : 404, { error: paths.length ? 'Method Not Allowed' : 'Not Found' });
    if (this.publicOrigin && !validHost(req, this.publicOrigin)) return sendJson(res, 400, { error: 'Invalid Host' });
    req.session = this.auth?.authenticate(req) || null; if (req.session) req.owner = { id: req.session.ownerId };
    if (this.auth && !match.options.public && !PUBLIC.has(`${req.method} ${match.path}`) && !req.session) return sendJson(res, 401, { error: 'Authentication required' });
    const bucket = rateBucket(req.method, match.path);
    if (bucket && !this.limiter.take(`${bucket}:${req.session?.ownerId || req.socket?.remoteAddress || 'unknown'}`, bucket === 'login' ? 8 : 60, 60000)) return sendJson(res, 429, { error: 'Rate limit exceeded', code: 'RATE_LIMITED' });
    if (req.session && WRITES.has(req.method) && (!sameOrigin(req, this.publicOrigin) || req.headers['x-u2os-csrf'] !== req.session.csrfToken)) return sendJson(res, 403, { error: 'CSRF validation failed' });
    const found = match.pattern.exec(pathname); req.params = {}; match.paramNames.forEach((n, i) => { req.params[n] = found[i + 1]; }); req.query = Object.fromEntries(url.searchParams.entries());
    try {
      if (WRITES.has(req.method)) req.body = await readJsonBody(req, match.options.bodyLimit || this.bodyLimit);
      await match.handler(req, res);
    } catch (err) {
      log.error('router', 'Request handler failed', { method: req.method, path: pathname, error: err?.message || String(err) });
      if (!res.writableEnded) sendJson(res, err.status || 500, { error: err.status || process.env.NODE_ENV !== 'production' ? err.message : 'Internal Server Error' });
    }
  }
}

export function sendJson(res, status, body, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); }
export function readJsonBody(req, limit = 1048576) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').includes('application/json')) return resolve({});
    let size = 0; const chunks = []; let stopped = false;
    req.on('data', (c) => { if (stopped) return; size += c.length; if (size > limit) { stopped = true; req.resume(); reject(httpError(413, 'Request body too large')); } else chunks.push(c); });
    req.on('end', () => { if (stopped) return; const data = Buffer.concat(chunks).toString('utf8'); if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch { reject(httpError(400, 'Invalid JSON body')); } }); req.on('error', reject);
  });
}
class RateLimiter { constructor() { this.entries = new Map(); } take(key, max, ms) { const now = Date.now(); let e = this.entries.get(key); if (!e || e.until <= now) e = { count: 0, until: now + ms }; e.count++; this.entries.set(key, e); return e.count <= max; } }
function rateBucket(m, p) { if (m === 'POST' && p === '/api/auth/login') return 'login'; if (m === 'POST' && p.startsWith('/api/actions/')) return 'actions'; if (m === 'POST' && p.startsWith('/api/agent/')) return 'agent'; if (WRITES.has(m) && p.startsWith('/api/triggers')) return 'triggers'; if (WRITES.has(m) && (p.includes('/credentials') || p === '/api/model')) return 'credentials'; if (WRITES.has(m) && p === '/api/voice/enrollment') return 'enrollment'; return null; }
function validHost(req, origin) { try { return req.headers.host === new URL(origin).host; } catch { return false; } }
function sameOrigin(req, configured) { const forwardedHttps = process.env.U2OS_TRUST_PROXY === '1' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; const expected = configured || `${req.socket?.encrypted || forwardedHttps ? 'https' : 'http'}://${req.headers.host}`; if (req.headers.origin) return req.headers.origin === expected; if (req.headers.referer) { try { return new URL(req.headers.referer).origin === expected; } catch { return false; } } return false; }
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
