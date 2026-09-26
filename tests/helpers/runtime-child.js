// IPC-only isolated runtime fixture. Never receives real account credentials.
import { startServer } from '../../server/index.js';

try {
  const handle = await startServer({ port: 0 });
  process.on('message', async (message) => {
    if (message === 'shutdown') {
      await handle.shutdown();
      process.send({ kind: 'closed' }, () => process.exit(0));
    }
  });
  process.send({ kind: 'ready', port: handle.port });
} catch (error) {
  process.send({ kind: 'failure', code: error.code, error: error.message }, () => process.exit(1));
}
