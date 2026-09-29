import fs from 'node:fs';
import path from 'node:path';
import { COLLECTIONS, ROUTINES_DIR, SKILLS_DIR } from './vault-dir.js';
import { listMarkdownFiles } from './markdown.js';
import { loadMcpConfig } from '../mcp/config.js';

// Names a folder may contain and still count as "empty": version control and
// OS metadata are not the owner's notes.
const IGNORABLE = new Set(['.git', '.DS_Store']);

/**
 * Read-only summary of a folder the owner is considering as their vault. It
 * looks at names and counts only: no file content leaves the folder, nothing
 * is created, and nothing is executed (declared tool-server names come from
 * parsing mcp.yaml, never from starting it).
 */
export function inspectVaultCandidate(target) {
  const info = {
    path: target, exists: false, isDirectory: false, empty: false, writable: false,
    looksLikeVault: false, hasMe: false, hasPolicies: false, hasMcp: false,
    mcpServers: [], mcpError: null,
    counts: { people: 0, projects: 0, commitments: 0, routines: 0, skills: 0 },
  };
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return info; throw error; }
  info.exists = true;
  info.isDirectory = stat.isDirectory();
  if (!info.isDirectory) return info;
  try { fs.accessSync(target, fs.constants.W_OK); info.writable = true; } catch { /* read-only */ }

  const names = fs.readdirSync(target);
  info.empty = names.every((name) => IGNORABLE.has(name));
  const isFile = (name) => { try { return fs.lstatSync(path.join(target, name)).isFile(); } catch { return false; } };
  const isDir = (name) => { try { return fs.lstatSync(path.join(target, name)).isDirectory(); } catch { return false; } };
  info.hasMe = isFile('me.md');
  info.hasPolicies = isFile('policies.yaml');
  info.hasMcp = isFile('mcp.yaml');
  for (const dir of Object.keys(COLLECTIONS)) info.counts[dir] = listMarkdownFiles(target, dir).length;
  info.counts.routines = listMarkdownFiles(target, ROUTINES_DIR).length;
  info.counts.skills = listMarkdownFiles(target, SKILLS_DIR).length;
  info.looksLikeVault = info.hasMe || info.hasPolicies || info.hasMcp
    || [...Object.keys(COLLECTIONS), ROUTINES_DIR, SKILLS_DIR].some((dir) => isDir(dir));
  if (info.hasMcp) {
    const config = loadMcpConfig(target);
    info.mcpServers = config.servers.map((server) => ({ name: server.name, enabled: server.enabled !== false }));
    info.mcpError = config.error;
  }
  return info;
}
