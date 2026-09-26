#!/usr/bin/env node
import { reviewRecoveryConnectivity } from './recovery-connectivity.js';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) throw new Error('Recovery connectivity accepts only --apply; select the recovery home with U2OS_HOME');
  const result = reviewRecoveryConnectivity({ apply: args[0] === '--apply' });
  console.log(JSON.stringify(result, null, 2));
  console.log(`${args[0] === '--apply' ? 'Archived connectivity quarantined' : 'Preview only: no files or application records changed'}. Home remains INACTIVE; activation and original retirement are not supported. No provider or model was contacted.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
