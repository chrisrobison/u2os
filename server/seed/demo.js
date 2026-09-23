import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseDemoArgs(argv = []) {
  const options = { home: path.join(os.homedir(), '.u2os-demo'), port: 4000, reuse: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--reuse') options.reuse = true;
    else if (arg === '--home') options.home = path.resolve(requireValue(argv, ++index, '--home'));
    else if (arg === '--port') options.port = parsePort(requireValue(argv, ++index, '--port'));
    else throw new Error(`Unknown demo option: ${arg}`);
  }
  options.home = path.resolve(options.home);
  return options;
}

export function assertDemoHomeAvailable(home, { reuse = false } = {}) {
  const dbPath = path.join(home, 'db', 'u2os.sqlite');
  if (fs.existsSync(dbPath) && !reuse) {
    throw new Error(`Demo home already contains data: ${home}. Pass --reuse to keep and reopen it; U2OS will not erase it automatically.`);
  }
  return home;
}

export async function startDemo(argv = process.argv.slice(2)) {
  const options = parseDemoArgs(argv);
  assertDemoHomeAvailable(options.home, options);
  process.env.U2OS_HOME = options.home;
  const { startServer } = await import('../index.js');
  const handle = await startServer({ port: options.port, bind: '127.0.0.1', mode: 'demo' });
  console.log(`[demo] U2OS demo is ready at http://127.0.0.1:${handle.port}`);
  console.log(`[demo] Data home: ${options.home}`);
  console.log('[demo] Open the URL, create the owner passphrase if needed, then use the daily-driver prompt from docs/demo.md.');
  return handle;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535');
  return port;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startDemo().catch((error) => {
    console.error(`[demo] ${error.message}`);
    process.exitCode = 1;
  });
}
