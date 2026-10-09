import { isLoopbackAddress, isLoopbackHost } from '../security/loopback.js';
import { EXTENSION_ORIGIN } from './pairings.js';

// The gate every extension route passes before its handler runs. It is
// enforced by the Router (option `extension`), so a new route cannot forget it.
//
//   1. peer address is loopback AND Host names loopback (independent of U2OS_BIND);
//      X-Forwarded-For and friends are never consulted
//   2. an Origin header, if sent, is a chrome-extension origin
//   3. bearer token (Authorization header only) belongs to a live pairing, and
//      the Origin, if sent, is the one recorded at pairing
//   4. CORS: that one origin is echoed back; never a wildcard, never credentials

// No lockout on bad tokens: they are 256-bit random values, so guessing is infeasible, and a lockout would let any web page
// (a no-cors GET to 127.0.0.1 needs no credentials) lock the real extension out. Pairing-code guesses are limited in pairings.js.
export function createExtensionChannel({ pairings }) {
  const refuse = (res, status, error) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error }));
    return null;
  };
  const cors = (res, origin) => {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'X-Content-SHA256');
    res.setHeader('Vary', 'Origin');
  };
  const local = (req, res) => {
    if (isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackHost(req.headers.host)) return true;
    refuse(res, 403, 'The extension channel is only available on localhost');
    return false;
  };

  return {
    pairings,

    /** Returns { pairing } / { origin } to proceed, or null after answering the request. */
    gate(req, res, mode) {
      if (!local(req, res)) return null;
      res.setHeader('Cache-Control', 'no-store');
      const origin = req.headers.origin;
      if (origin !== undefined && !EXTENSION_ORIGIN.test(origin)) return refuse(res, 403, 'Origin not allowed');
      if (mode === 'pair') {
        if (!origin) return refuse(res, 403, 'Pairing must come from the extension');
        cors(res, origin);
        return { origin };
      }
      const header = String(req.headers.authorization ?? '');
      const pairing = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header) ? pairings.authenticate(header.slice(7)) : null;
      if (!pairing) return refuse(res, 401, 'Extension token required');
      if (origin !== undefined && origin !== pairing.origin) return refuse(res, 403, 'Origin not allowed');
      if (origin) cors(res, origin);
      return { pairing };
    },

    /** CORS preflight: carries no token, so the origin must already be paired (or be pairing). */
    preflight(req, res, mode) {
      if (!local(req, res)) return;
      const origin = req.headers.origin;
      if (!origin || !EXTENSION_ORIGIN.test(origin) || (mode !== 'pair' && !pairings.origins().has(origin))) {
        refuse(res, 403, 'Origin not allowed');
        return;
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
        'Cache-Control': 'no-store',
      });
      res.end();
    },
  };
}
