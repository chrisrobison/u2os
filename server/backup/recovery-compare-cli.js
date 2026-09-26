#!/usr/bin/env node
import { compareRecoveryEvidence } from './recovery-compare.js';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--original' || !args[1]) throw new Error('Recovery comparison requires only --original <existing-home>; select the inactive recovery with U2OS_HOME');
  console.log(JSON.stringify(await compareRecoveryEvidence({ originalDataDir: args[1] }), null, 2));
  console.log('INACTIVE, read-only comparison of recorded evidence, not provider delivery truth. No records or budgets were reconciled; no execution, retirement or activation is authorized. The original may progress after ownership is released.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
