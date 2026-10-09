// Loopback checks for channels that must only ever run on the owner's own machine.
//
// These look at the TCP peer address and the Host header only. Forwarding
// headers (X-Forwarded-For, Forwarded, X-Real-IP) are never read: any client
// can send them, so they cannot establish where a request came from.

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/** True when the socket's peer address is the loopback interface. */
export function isLoopbackAddress(address) {
  return typeof address === 'string' && LOOPBACK_ADDRESSES.has(address.toLowerCase());
}

/**
 * True when the Host header names the loopback interface. This is what stops
 * DNS rebinding: a page on evil.example whose name resolves to 127.0.0.1 still
 * sends `Host: evil.example`.
 */
export function isLoopbackHost(hostHeader) {
  return typeof hostHeader === 'string' && LOOPBACK_HOST.test(hostHeader);
}

/** Both conditions, from the request itself. Independent of U2OS_BIND. */
export function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackHost(req.headers?.host);
}
