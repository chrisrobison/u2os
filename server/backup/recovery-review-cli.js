#!/usr/bin/env node
import { reviewRecoveryWork } from './recovery-quarantine.js';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) throw new Error('Recovery review accepts only --apply; choose the recovery home with U2OS_HOME');
  const review = reviewRecoveryWork({ apply: args[0] === '--apply' });
  console.log(JSON.stringify(review, null, 2));
  console.log(`${args[0] === '--apply' ? 'Database work quarantined' : 'Preview only: no application records changed'}. Home remains INACTIVE; activation, original retirement and connectivity review are not supported yet.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
