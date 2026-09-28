import fs from 'node:fs';
import path from 'node:path';
import { getVaultDir } from './vault-dir.js';
import { U2OS_ROOT } from '../mcp/config.js';

// Starter content: ready-to-copy routine + skill pairs (docs/routines.md,
// examples/vault/README.md) an owner -- or the onboarding wizard, a
// follow-up feature -- can provision into a live vault without hand-copying
// files out of examples/vault. This module only copies files into the
// vault; it never touches the workflow engine or the agent runtime.
//
// Installing an item never overwrites a file the owner already has at that
// vault-relative path, the same first-run convention used by
// ensureVaultLayout() for README.md and by the policy/data-processing
// loaders for their default files.

const EXAMPLES_VAULT_DIR = path.join(U2OS_ROOT, 'examples', 'vault');

export const STARTER_CONTENT = Object.freeze([
  Object.freeze({
    id: 'morning-brief',
    label: 'Morning brief',
    description: "A daily digest of today's meetings, commitments due soon, and urgent email.",
    files: Object.freeze([{ from: 'routines/morning-brief.md', to: 'routines/morning-brief.md' }]),
  }),
  Object.freeze({
    id: 'meeting-prep',
    label: 'Meeting prep',
    description: 'A short briefing before each upcoming meeting: who is attending and your history with them.',
    files: Object.freeze([{ from: 'routines/meeting-prep.md', to: 'routines/meeting-prep.md' }]),
  }),
  Object.freeze({
    id: 'commitment-follow-up',
    label: 'Commitment follow-up',
    description: 'Reviews open commitments each afternoon and drafts follow-ups for anything due or overdue.',
    files: Object.freeze([{ from: 'routines/commitment-follow-up.md', to: 'routines/commitment-follow-up.md' }]),
  }),
  Object.freeze({
    id: 'job-hunting',
    label: 'Job hunter',
    description: 'Searches job boards, scores postings against your preferences, and applies to strong matches. Disabled until you review it.',
    files: Object.freeze([
      { from: 'routines/job-hunter.md', to: 'routines/job-hunter.md' },
      { from: 'skills/job-hunting.md', to: 'skills/job-hunting.md' },
    ]),
  }),
]);

/** The catalog an onboarding UI or CLI can list, without exposing source paths. */
export function listStarterContent() {
  return STARTER_CONTENT.map(({ id, label, description, files }) => ({
    id, label, description, files: files.map((file) => file.to),
  }));
}

function findStarterItem(id) {
  const item = STARTER_CONTENT.find((entry) => entry.id === id);
  if (!item) throw starterContentError(`Unknown starter content id "${id}"`);
  return item;
}

/**
 * Copies one starter item's files into the live vault (getVaultDir() by
 * default). Never overwrites a file already at the destination path.
 * Returns which files were newly installed and which already existed.
 */
export function installStarterContent(id, vaultDir = getVaultDir()) {
  const item = findStarterItem(id);
  const installed = [];
  const skipped = [];
  for (const file of item.files) {
    const source = path.join(EXAMPLES_VAULT_DIR, file.from);
    const dest = path.join(vaultDir, file.to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      installed.push(file.to);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      skipped.push(file.to);
    }
  }
  return { id, installed, skipped };
}

function starterContentError(message) {
  const error = new Error(message);
  error.code = 'STARTER_CONTENT_UNKNOWN';
  return error;
}
