import fs from 'node:fs';
import path from 'node:path';

export const RECOVERY_FILE = '.u2os-recovery.json';

/** No archive-supplied status can authorize execution. Activation is a
 * separately scoped operation; even an alleged 'active' marker fails closed. */
export function assertExecutableHome(home) {
  try { fs.lstatSync(path.join(home, RECOVERY_FILE)); }
  catch (error) { if (error.code === 'ENOENT') return; }
  const error = new Error('Recovery home is inactive or incomplete. Review it offline; activation and original-instance retirement are not yet supported. Do not remove the recovery marker to bypass this safeguard');
  error.code = 'RECOVERY_INACTIVE';
  throw error;
}

export function writeRecoveryState(home, state, { initial = false } = {}) {
  const file = path.join(home, RECOVERY_FILE);
  const staging = initial ? null : fs.mkdtempSync(path.join(home, '.u2os-recovery-stage-'));
  try {
    if (staging) fs.chmodSync(staging, 0o700);
    const temporary = initial ? file : path.join(staging, 'marker.json');
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify({ version: 1, ...state })}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (!initial) fs.renameSync(temporary, file);
    syncDirectory(home);
  } finally { if (staging) fs.rmSync(staging, { recursive: true, force: true }); }
}

export function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
