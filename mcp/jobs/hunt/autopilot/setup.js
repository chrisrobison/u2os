import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// One-time wiring of the autopilot into the owner's vault, written by an
// explicit owner command (`job autopilot setup`):
//   mcp.yaml       registers the jobs tool server with ONLY the two narrow tools
//   policies.yaml  (with --autonomous) lets exactly those two tools run without
//                  approval; every other action keeps its own policy
// Both files are merged, never replaced; comments are not preserved.

const TOOLS = ['send_application', 'submit_application'];

function readYaml(file) {
  try { const data = yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.CORE_SCHEMA }); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function writeYaml(file, header, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${header}\n${yaml.dump(data, { lineWidth: 120, noRefs: true })}`, { mode: 0o600 });
}

export function setupAutopilot(vaultDir, { autonomous = false } = {}) {
  const changes = [];
  const mcpFile = path.join(vaultDir, 'mcp.yaml');
  const mcp = readYaml(mcpFile);
  mcp.servers ??= {};
  const existing = mcp.servers.jobs;
  const wanted = { command: 'node', args: ['${U2OS_ROOT}/mcp/jobs/server.js', '--vault', '${VAULT}'], timeout_seconds: 600 };
  const tools = { ...(existing?.tools ?? {}) };
  for (const name of TOOLS) tools[name] = { classification: 'personal' };
  if (!existing || JSON.stringify({ ...existing, tools: undefined }) !== JSON.stringify({ ...wanted, tools: undefined }) || TOOLS.some((name) => !existing?.tools?.[name])) {
    mcp.servers.jobs = { ...(existing ?? {}), ...wanted, tools };
    writeYaml(mcpFile, '# Tool servers U2OS may start for you (docs/mcp.md).', mcp);
    changes.push('mcp.yaml: registered the jobs tool server with send_application and submit_application');
  }
  if (autonomous) {
    const policyFile = path.join(vaultDir, 'policies.yaml');
    const policies = readYaml(policyFile);
    policies.jobs ??= {};
    let changed = false;
    for (const name of TOOLS) if (policies.jobs[name] !== 'autonomous') { policies.jobs[name] = 'autonomous'; changed = true; }
    if (changed) { writeYaml(policyFile, '# What U2OS may do without asking (docs/policies.md).', policies); changes.push('policies.yaml: jobs.send_application and jobs.submit_application run without asking (every other action keeps its own policy)'); }
  }
  return changes;
}

/** Removes the autonomy (not the tool registration): the two tools go back to needing approval. */
export function revokeAutonomy(vaultDir) {
  const policyFile = path.join(vaultDir, 'policies.yaml');
  const policies = readYaml(policyFile);
  let changed = false;
  for (const name of TOOLS) if (policies.jobs?.[name] === 'autonomous') { policies.jobs[name] = 'confirm'; changed = true; }
  if (changed) writeYaml(policyFile, '# What U2OS may do without asking (docs/policies.md).', policies);
  return changed;
}
