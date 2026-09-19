import { checkEventLogIntegrity, pruneEvents } from './maintenance.js';

const args = process.argv.slice(2);
const daysIndex = args.indexOf('--retention-days');
const retentionDays = daysIndex >= 0 ? args[daysIndex + 1] : null;
const result = { integrity: checkEventLogIntegrity() };
if (retentionDays !== null) result.retention = pruneEvents({ retentionDays, apply: args.includes('--apply') });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.integrity.ok) process.exitCode = 1;
