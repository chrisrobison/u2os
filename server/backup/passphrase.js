import readline from 'node:readline';
import { validateBackupPassphrase } from './encryption.js';

export async function readBackupPassphrase({ confirm = false, env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const supplied = env.U2OS_BACKUP_PASSPHRASE;
  delete env.U2OS_BACKUP_PASSPHRASE; // Do not pass the secret to tar or other children.
  if (supplied !== undefined) { validateBackupPassphrase(supplied); return supplied; }
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('snapshot: use a terminal for masked backup passphrase input, or explicitly supply U2OS_BACKUP_PASSPHRASE; never pass it as an argument');
  }
  const passphrase = await maskedQuestion('Backup encryption passphrase (minimum 12 characters): ', input, output);
  validateBackupPassphrase(passphrase);
  if (confirm && passphrase !== await maskedQuestion('Confirm backup encryption passphrase: ', input, output)) {
    throw new Error('snapshot: backup passphrases do not match');
  }
  return passphrase;
}

function maskedQuestion(prompt, input, output) {
  output.write(prompt);
  readline.emitKeypressEvents(input);
  const wasRaw = Boolean(input.isRaw), wasFlowing = input.readableFlowing === true;
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.off('keypress', onKey); input.off('end', onEnd); input.off('error', onError);
      input.setRawMode(wasRaw); if (!wasFlowing) input.pause();
    };
    const fail = (message) => { cleanup(); reject(new Error(message)); };
    const onEnd = () => fail('snapshot: backup passphrase input ended');
    const onError = () => fail('snapshot: backup passphrase input failed');
    const onKey = (text, key) => {
      if (key?.ctrl && key.name === 'c') return fail('snapshot: backup cancelled');
      if (key?.name === 'return') { cleanup(); output.write('\n'); resolve(value); return; }
      if (key?.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (!key?.ctrl && !key?.meta && text) value += text;
      if (Buffer.byteLength(value) > 4096) fail('snapshot: backup passphrase input is too long');
    };
    input.on('keypress', onKey); input.on('end', onEnd); input.on('error', onError);
  });
}
