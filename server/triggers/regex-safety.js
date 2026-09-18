// Bounded safety check for user-supplied regex patterns before they're
// accepted into an event_rule trigger's `config.when.matches`.
//
// SECURITY: matchesWhen() (in trigger-engine.js) runs this pattern
// synchronously against every event published on the bus, inline inside
// EventBus.publish()'s dispatch loop -- a catastrophic-backtracking pattern
// (e.g. "^(a+)+$") combined with an adversarial input string can hang the
// entire single-threaded server for seconds to minutes on the very next
// matching event, denying service to every user, not just whoever created
// the trigger. Verified live during security review: exactly this pattern
// hung event dispatch for 20+ seconds against a 39-character input.
//
// This is checked ONCE, at trigger creation/update time (a cheap place to
// pay a few milliseconds of validation cost), never on the hot per-event
// path -- so the mitigation here does not need to be fast, only reliable.
//
// A `vm.Script` timeout is NOT used: V8's regex backtracking loop is not
// guaranteed to yield to vm's interrupt checks, so a vm-based timeout could
// itself hang for the same reason it's trying to guard against. A worker
// thread is the only mechanism that reliably bounds worst-case time
// regardless of what the regex engine is doing internally, because
// Worker.terminate() forcibly kills the thread no matter what it's stuck on.
import { Worker } from 'node:worker_threads';

const MAX_PATTERN_LENGTH = 200;
const PROBE_TIMEOUT_MS = 150;
// Short, cheap probe strings chosen to make catastrophic backtracking blow
// up fast (exponential in length) while staying fast for any genuinely
// linear-time pattern -- these are NOT meant to be exhaustive, just to
// reliably trip the textbook nested-quantifier/ambiguous-alternation cases.
const PROBE_STRINGS = ['a'.repeat(22) + '!', 'a'.repeat(26) + '!'];

// Fast-path reject for the single most common catastrophic-backtracking
// shape (a quantified group inside another quantifier, e.g. "(a+)+",
// "(a*)*", "(a+)*"). This is a heuristic, not a proof -- plenty of unsafe
// patterns don't match it (e.g. ambiguous alternation like "(a|a)+"), which
// is exactly why the timed worker probe below is the real guarantee, not
// this. It just avoids paying worker-thread overhead for the obvious cases.
const NESTED_QUANTIFIER_HEURISTIC = /\([^()]*[+*][^()]*\)[+*]/;

/**
 * Throws a clear, specific Error if `pattern` is unsafe to accept as a
 * `when.matches` value: too long, invalid regex syntax, or measured to be
 * dangerously slow against adversarial probe input. Resolves silently
 * (no return value) if the pattern is accepted.
 */
export async function assertSafeRegexPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('when.matches must be a non-empty string');
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`when.matches must be ${MAX_PATTERN_LENGTH} characters or fewer`);
  }
  if (NESTED_QUANTIFIER_HEURISTIC.test(pattern)) {
    throw new Error(
      'when.matches contains a nested quantifier (e.g. "(a+)+"), a classic catastrophic-backtracking shape -- simplify the pattern'
    );
  }

  for (const probe of PROBE_STRINGS) {
    const result = await runProbeInWorker(pattern, probe, PROBE_TIMEOUT_MS);
    if (result === 'invalid') {
      throw new Error('when.matches is not a valid regular expression');
    }
    if (result === 'timeout') {
      throw new Error(
        'when.matches took too long to evaluate against a test string -- likely a catastrophic-backtracking pattern, rejected'
      );
    }
  }
}

// Runs `new RegExp(pattern, 'i').test(probe)` inside an isolated, disposable
// worker thread with a hard wall-clock timeout. Returns 'ok', 'invalid'
// (bad regex syntax), or 'timeout' (worker forcibly terminated -- treat as
// unsafe, never as "probably fine").
function runProbeInWorker(pattern, probe, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
      resolve(result);
    };

    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      try {
        new RegExp(workerData.pattern, 'i').test(workerData.probe);
        parentPort.postMessage('ok');
      } catch {
        parentPort.postMessage('invalid');
      }
      `,
      { eval: true, workerData: { pattern, probe } }
    );

    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    worker.once('message', (msg) => settle(msg === 'ok' ? 'ok' : 'invalid'));
    worker.once('error', () => settle('invalid'));
  });
}
