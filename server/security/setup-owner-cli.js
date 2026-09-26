import readline from 'node:readline';
import { getDb } from '../db/connection.js';
import { AuthService } from './auth.js';
import { withOfflineHome } from '../runtime/offline-home.js';

try {
  await withOfflineHome(async () => {
    const auth = new AuthService(getDb());
    if (auth.hasOwner()) {
      console.error('Owner setup is already complete for this U2OS_HOME.');
      process.exitCode = 1;
      return;
    }
    const passphrase = await maskedPrompt('New owner passphrase (minimum 12 characters): ');
    const confirmation = await maskedPrompt('Confirm passphrase: ');
    if (passphrase !== confirmation) throw new Error('Passphrases do not match');
    await auth.setup(passphrase);
    console.log('Owner created. The server may now bind to an explicitly configured non-loopback address.');
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function maskedPrompt(prompt) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(prompt, (answer) => { rl.close(); resolve(answer); }));
  }
  process.stdout.write(prompt);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onKey = (text, key) => {
      if (key?.ctrl && key.name === 'c') { cleanup(); reject(new Error('Setup cancelled')); return; }
      if (key?.name === 'return') { cleanup(); process.stdout.write('\n'); resolve(value); return; }
      if (key?.name === 'backspace') { value = value.slice(0, -1); return; }
      if (!key?.ctrl && !key?.meta && text) value += text;
    };
    const cleanup = () => { process.stdin.off('keypress', onKey); process.stdin.setRawMode(false); process.stdin.pause(); };
    process.stdin.on('keypress', onKey);
  });
}
