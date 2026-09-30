// Safe subprocess runner (docs/coding-agents.md). The one place a coding
// agent process is started.
//
// - argv array + shell:false: no string is ever parsed by a shell, so task
//   text, paths and model names cannot inject commands
// - the caller supplies the complete environment (see env.js)
// - the task goes in on stdin, never on the command line
// - stdout/stderr are delivered line by line as they arrive and also kept
//   (bounded) for the run record
// - a timeout or cancel stops the whole process group: SIGTERM, then SIGKILL
//   after a grace period
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX_CAPTURE = 1024 * 1024;
const MAX_LINE = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 3_000;
const POST_EXIT_PIPE_WAIT_MS = 1_000;

/**
 * runProcess({ executable, args, cwd, env, stdin, timeoutMs, signal,
 *              onSpawn(pid), onLine(stream, line), maxCaptureBytes, killGraceMs })
 *
 * Never rejects. Resolves to
 * { exitCode, signal, timedOut, cancelled, stdout, stderr, stdoutTruncated,
 *   stderrTruncated, pid, spawnError }
 * where stdout/stderr are the last `maxCaptureBytes` of each stream.
 */
export function runProcess({ executable, args = [], cwd, env, stdin = null, timeoutMs = null, signal = null, onSpawn, onLine, maxCaptureBytes = DEFAULT_MAX_CAPTURE, killGraceMs = DEFAULT_KILL_GRACE_MS }) {
  return new Promise((resolve) => {
    const result = { exitCode: null, signal: null, timedOut: false, cancelled: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, pid: undefined, spawnError: null };
    let child;
    let settled = false;
    let terminating = false;
    const timers = new Set();
    const cleanups = [];

    const settle = () => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      for (const stream of ['stdout', 'stderr']) flush(streams[stream]);
      resolve(result);
    };
    const later = (ms, fn) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; };

    const streams = {};
    for (const name of ['stdout', 'stderr']) streams[name] = { name, decoder: new StringDecoder('utf8'), partial: '' };
    const capture = (name, text) => {
      const joined = result[name] + text;
      if (joined.length > maxCaptureBytes) { result[name] = joined.slice(joined.length - maxCaptureBytes); result[`${name}Truncated`] = true; } else result[name] = joined;
    };
    const emit = (state, text) => {
      let data = state.partial + text;
      let index;
      while ((index = data.indexOf('\n')) >= 0) {
        deliver(state.name, data.slice(0, index));
        data = data.slice(index + 1);
      }
      while (data.length > MAX_LINE) { deliver(state.name, data.slice(0, MAX_LINE)); data = data.slice(MAX_LINE); }
      state.partial = data;
    };
    const deliver = (name, line) => {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      capture(name, `${clean}\n`);
      try { onLine?.(name, clean); } catch { /* a bad listener must not break the run */ }
    };
    function flush(state) {
      const rest = state.partial + state.decoder.end();
      state.partial = '';
      if (rest) deliver(state.name, rest);
    }

    const terminate = (reason) => {
      if (terminating || settled || !child) return;
      terminating = true;
      if (reason === 'timeout') result.timedOut = true;
      if (reason === 'cancel') result.cancelled = true;
      killGroup(child, 'SIGTERM');
      later(killGraceMs, () => killGroup(child, 'SIGKILL'));
    };

    try {
      child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', // own process group, so a stop reaches grandchildren
        windowsHide: true,
      });
    } catch (error) {
      result.spawnError = error;
      settle();
      return;
    }

    result.pid = child.pid;
    child.on('error', (error) => { result.spawnError = error; settle(); });
    child.on('spawn', () => { try { onSpawn?.(child.pid); } catch { /* listener errors are not the run's */ } });
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (chunk) => emit(streams[name], streams[name].decoder.write(chunk)));
      child[name].on('error', () => {});
    }
    child.stdin.on('error', () => {}); // EPIPE when the child exits before reading
    if (stdin !== null) child.stdin.end(stdin); else child.stdin.end();

    child.on('exit', (code, sig) => {
      result.exitCode = code;
      result.signal = sig;
      // A descendant that inherited the pipes can keep them open after the
      // agent itself is gone; do not wait for it forever.
      later(POST_EXIT_PIPE_WAIT_MS, settle);
    });
    child.on('close', (code, sig) => {
      result.exitCode = code;
      result.signal = sig;
      settle();
    });

    if (timeoutMs) later(timeoutMs, () => terminate('timeout'));
    if (signal) {
      if (signal.aborted) terminate('cancel');
      else {
        const onAbort = () => terminate('cancel');
        signal.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener('abort', onAbort));
      }
    }
  });
}

function killGroup(child, signal) {
  // Always signal the group, even if the leader already exited: descendants may remain (ESRCH is ignored).
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}
