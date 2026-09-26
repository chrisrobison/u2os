import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/connection.js';

// The vault is the owner's digital self as plain files (docs/vault.md,
// ADR 0007). Everything else under U2OS_HOME is runtime state.
export const COLLECTIONS = Object.freeze({
  people: 'Person',
  projects: 'Project',
  commitments: 'Commitment',
});

export const ROUTINES_DIR = 'routines';

const README = `# Your U2OS vault

This folder is your digital self, as plain files you own. U2OS reads it; you
can edit it with any text editor, keep it in git, or sync it however you like.

- \`me.md\`: who you are. Frontmatter keys become facts about you.
- \`people/\`: one Markdown file per person.
- \`projects/\`: one file per project.
- \`commitments/\`: things you have promised (\`status: open\` or \`done\`).
- \`routines/\`: standing instructions U2OS carries out on your behalf.

Each file may start with YAML frontmatter:

    ---
    name: Alice Chen
    email: alice@example.com
    relationship: sister
    classification: personal   # public | personal | private | sensitive
    sensitive_keys: [phone]    # keys that must never reach a remote model
    ---
    Free-form notes go here.

See docs/vault.md in the U2OS repository for the full format.
`;

/**
 * Vault location: U2OS_VAULT, then config.json `vaultDir`, then
 * U2OS_HOME/vault. Read fresh on every call so tests can point separate
 * homes at separate vaults.
 */
export function getVaultDir() {
  if (process.env.U2OS_VAULT) return path.resolve(process.env.U2OS_VAULT);
  const dataDir = getDataDir();
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'config.json'), 'utf8'));
    if (typeof config.vaultDir === 'string' && config.vaultDir.trim()) return path.resolve(dataDir, config.vaultDir);
  } catch { /* no config yet */ }
  return path.join(dataDir, 'vault');
}

/** Creates the default layout without touching anything that already exists. */
export function ensureVaultLayout(vaultDir = getVaultDir()) {
  fs.mkdirSync(vaultDir, { recursive: true });
  for (const dir of [...Object.keys(COLLECTIONS), ROUTINES_DIR]) fs.mkdirSync(path.join(vaultDir, dir), { recursive: true });
  const readme = path.join(vaultDir, 'README.md');
  try { fs.writeFileSync(readme, README, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return vaultDir;
}
