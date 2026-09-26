import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export const MAX_VAULT_FILE_BYTES = 256 * 1024;

/**
 * Splits optional YAML frontmatter from a Markdown body. CORE_SCHEMA keeps
 * values to plain JSON types (dates stay strings, no custom tags).
 */
export function parseMarkdown(text) {
  const source = String(text).replace(/^﻿/, '');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { frontmatter: {}, body: source.trim() };
  let frontmatter;
  try {
    frontmatter = yaml.load(match[1], { schema: yaml.CORE_SCHEMA }) ?? {};
  } catch (error) {
    throw vaultError(`Invalid YAML frontmatter: ${error.reason || error.message}`);
  }
  if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) throw vaultError('Frontmatter must be a mapping of keys to values');
  return { frontmatter, body: source.slice(match[0].length).trim() };
}

/**
 * Lists regular `.md` files directly inside `dir`, relative to `vaultDir`.
 * Hidden files, symlinks and anything that is not a regular file are
 * ignored, so a link cannot pull content from outside the vault.
 */
export function listMarkdownFiles(vaultDir, dir) {
  const absolute = path.join(vaultDir, dir);
  let entries;
  try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => path.posix.join(dir, entry.name))
    .sort();
}

/** Reads one vault file safely; throws a vault error for unsafe or oversized files. */
export function readVaultFile(vaultDir, relativePath) {
  const absolute = path.join(vaultDir, relativePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile()) throw vaultError('Not a regular file');
  if (stat.size > MAX_VAULT_FILE_BYTES) throw vaultError(`File exceeds ${MAX_VAULT_FILE_BYTES} bytes`);
  return { ...parseMarkdown(fs.readFileSync(absolute, 'utf8')), mtimeMs: stat.mtimeMs, size: stat.size };
}

/** Cheap change signature (path, mtime, size) used by the polling watcher. */
export function fileSignature(vaultDir, relativePath) {
  try {
    const stat = fs.lstatSync(path.join(vaultDir, relativePath));
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : null;
  } catch { return null; }
}

export function vaultError(message) {
  const error = new Error(message);
  error.code = 'VAULT_INVALID';
  return error;
}
