// mDNS discovery. Per docs/deployment.md §5.
//
// Advertises the running server as `u2os.local` via `_http._tcp` so
// PROMPT.md's onboarding flow ("visit http://u2os.local/") works without
// the user needing to know the machine's IP.
//
// Uses the `bonjour-service` npm package -- the one narrowly-scoped
// dependency this phase adds beyond js-yaml. There is no zero-dependency
// way to speak multicast DNS from Node, and mDNS discovery is an explicit,
// named requirement (PROMPT.md §19/§33), so this is an accepted exception
// to "few dependencies", not a departure from it.
//
// Gated by U2OS_MDNS (default enabled; set to "0" to disable -- e.g. for
// multi-instance dev, or environments where multicast is blocked and the
// warning noise is unwanted). Publishing is best-effort: many
// corporate/cloud/container networks block multicast entirely. This must
// NEVER prevent the HTTP server itself from starting or serving requests --
// every failure path here logs a clear warning and returns, it never
// throws.
import { Bonjour } from 'bonjour-service';
import { log } from '../logging/logger.js';

/**
 * Starts advertising this server via mDNS.
 *
 * bonjour-service's `publish()` returns synchronously -- the actual
 * multicast probe/announce sequence happens asynchronously in the
 * background -- so calling this never delays server startup, and there is
 * nothing to await here.
 *
 * Returns a handle with `.stop()` (safe to call any time, including if
 * startup itself failed partway through), or `null` if mDNS is disabled or
 * publishing could not even be attempted.
 */
export function startMdns({ port } = {}) {
  if (process.env.U2OS_MDNS === '0') {
    log.info('mdns', 'mDNS publishing disabled (U2OS_MDNS=0)');
    return null;
  }

  let bonjour;
  try {
    bonjour = new Bonjour();
    const service = bonjour.publish({
      name: 'u2os',
      type: 'http',
      protocol: 'tcp',
      port,
      host: 'u2os.local',
    });

    service.on('up', () => {
      log.info('mdns', 'Published u2os.local via mDNS', { port });
    });
    // Fired asynchronously, well after publish() returns -- e.g. multicast
    // blocked at the socket/network level. Never let this crash the
    // process: log and move on, the HTTP server is unaffected either way.
    service.on('error', (err) => {
      log.warn('mdns', 'mDNS service error -- continuing without local discovery', {
        error: err?.message || String(err),
      });
    });

    return {
      stop() {
        try {
          bonjour.unpublishAll(() => bonjour.destroy());
        } catch {
          // best-effort teardown, e.g. if the socket is already gone
        }
      },
    };
  } catch (err) {
    log.warn(
      'mdns',
      'mDNS publish failed -- continuing without local discovery (multicast is often blocked in containers/sandboxed or corporate networks; this is expected and non-fatal)',
      { error: err?.message || String(err) }
    );
    try {
      bonjour?.destroy();
    } catch {
      // best-effort
    }
    return null;
  }
}
