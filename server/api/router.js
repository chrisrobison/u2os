import { URL } from 'node:url';

/**
 * Tiny dependency-free router. Supports :param path segments, JSON body
 * parsing for POST/PUT, and uniform 404/405/JSON-error handling.
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  get(path, handler) { this._add('GET', path, handler); }
  post(path, handler) { this._add('POST', path, handler); }
  put(path, handler) { this._add('PUT', path, handler); }
  patch(path, handler) { this._add('PATCH', path, handler); }
  delete(path, handler) { this._add('DELETE', path, handler); }

  _add(method, path, handler) {
    const paramNames = [];
    const patternStr = path
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          paramNames.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, pattern: new RegExp(`^${patternStr}$`), paramNames, handler });
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const pathMatches = this.routes.filter((r) => r.pattern.test(pathname));
    const match = pathMatches.find((r) => r.method === req.method);

    if (!match) {
      return sendJson(res, pathMatches.length ? 405 : 404, {
        error: pathMatches.length ? 'Method Not Allowed' : 'Not Found',
      });
    }

    const execMatch = match.pattern.exec(pathname);
    req.params = {};
    match.paramNames.forEach((name, i) => {
      req.params[name] = execMatch[i + 1];
    });
    req.query = Object.fromEntries(url.searchParams.entries());

    try {
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        req.body = await readJsonBody(req);
      }
      await match.handler(req, res);
    } catch (err) {
      console.error('[router] handler error', err);
      if (!res.writableEnded) sendJson(res, 500, { error: err.message || 'Internal Server Error' });
    }
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) return resolve({});
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
