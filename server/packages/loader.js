// Package loading (docs/plugin-architecture.md §4, §12): fetch a source into
// a local directory, check every file, and read a validated bundle.
//
// SECURITY: nothing here executes package content. Archives are listed and
// checked before extraction and the extracted tree is checked again; git
// sources are cloned shallowly without submodules; every file is a regular
// file (no links, devices or FIFOs) within count and size limits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseYaml, validateManifest, validateCapabilityDefinition, validateSkillDefinition, validateAutomationDefinition, ManifestError } from './manifest.js';
import { readPackageText } from './package-files.js';

const run = promisify(execFile);
export const MAX_FILES = 1_000;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

/**
 * Classifies a source string: a local directory, a .tar/.tar.gz/.tgz/.zip
 * archive, or a git repository (git+https://, git+file://, or an https URL
 * ending in .git; optional #ref).
 */
export function classifySource(source) {
  if (typeof source !== 'string' || !source.trim()) throw loaderError('A package source is required');
  const text = source.trim();
  if (/^git\+(https|file):\/\//.test(text) || /^https:\/\/.+\.git(#.+)?$/.test(text)) {
    const [url, ref] = text.replace(/^git\+/, '').split('#');
    if (ref !== undefined && !/^[A-Za-z0-9._/-]{1,100}$/.test(ref)) throw loaderError('Invalid git ref');
    return { type: 'git', url, ref: ref || null, ref_text: text };
  }
  if (/^[a-z]+:\/\//i.test(text)) throw loaderError('Only local paths, archives and git+https/git+file repositories are supported');
  const resolved = path.resolve(text);
  let stat;
  try { stat = fs.statSync(resolved); } catch { throw loaderError(`No such package source: ${text}`); }
  if (stat.isDirectory()) return { type: 'directory', path: resolved };
  if (/\.(tar\.gz|tgz)$/.test(resolved)) return { type: 'archive', format: 'tgz', path: resolved };
  if (/\.tar$/.test(resolved)) return { type: 'archive', format: 'tar', path: resolved };
  if (/\.zip$/.test(resolved)) return { type: 'archive', format: 'zip', path: resolved };
  throw loaderError('Package sources must be a directory, a .tar, .tar.gz, .tgz or .zip archive, or a git repository');
}

/**
 * fetchSource(source) -> { dir, cleanup, sourceType, sourceRef }
 * `dir` is a local directory containing u2os.yaml.
 */
export async function fetchSource(source) {
  const info = classifySource(source);
  if (info.type === 'directory') return { dir: info.path, cleanup: () => {}, sourceType: 'directory', sourceRef: info.path };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-package-'));
  const cleanup = () => fs.rmSync(temp, { recursive: true, force: true });
  try {
    const target = path.join(temp, 'src');
    fs.mkdirSync(target);
    if (info.type === 'archive') {
      await extractArchive(info, target);
    } else {
      const args = ['clone', '--depth', '1', '--no-tags', '--single-branch', '--no-recurse-submodules', ...(info.ref ? ['--branch', info.ref] : []), '--', info.url, target];
      try {
        await run('git', ['-c', 'protocol.file.allow=always', '-c', 'core.symlinks=false', ...args], { timeout: COMMAND_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      } catch (error) {
        throw loaderError(`git clone failed${error.code === 'ENOENT' ? ' (git is not installed)' : ''}`);
      }
      fs.rmSync(path.join(target, '.git'), { recursive: true, force: true });
    }
    return { dir: packageRoot(target), cleanup, sourceType: info.type, sourceRef: info.type === 'git' ? info.ref_text : info.path };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function extractArchive(info, target) {
  if (info.format === 'zip') {
    let listing;
    try { listing = (await run('unzip', ['-Z', info.path], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout; }
    catch (error) { throw loaderError(error.code === 'ENOENT' ? 'unzip is not installed; use a .tar.gz archive' : 'Could not read the zip archive'); }
    for (const line of listing.split('\n')) {
      const match = /^([-dlbcps?])[rwxsStT-]{9}\s.*\s(\S.*)$/.exec(line);
      if (!match) continue;
      if (match[1] !== '-' && match[1] !== 'd') throw loaderError(`Archive entry is not a regular file or directory: ${match[2]}`);
      checkEntryName(match[2]);
    }
    await run('unzip', ['-q', '-o', info.path, '-d', target], { timeout: COMMAND_TIMEOUT_MS });
  } else {
    const flags = info.format === 'tgz' ? 'z' : '';
    let listing;
    try { listing = (await run('tar', [`-t${flags}vf`, info.path], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout; }
    catch { throw loaderError('Could not read the tar archive'); }
    const names = (await run('tar', [`-t${flags}f`, info.path], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
    for (const line of listing.split('\n').filter(Boolean)) {
      if (line[0] !== '-' && line[0] !== 'd') throw loaderError('Archive contains links or special files');
    }
    if (names.length > MAX_FILES * 2) throw loaderError('Archive has too many entries');
    names.forEach(checkEntryName);
    await run('tar', [`-x${flags}f`, info.path, '-C', target, '--no-same-owner', '--no-same-permissions'], { timeout: COMMAND_TIMEOUT_MS });
  }
  scanTree(target);
}

function checkEntryName(name) {
  const clean = name.replace(/\/$/, '');
  if (!clean || clean.startsWith('/') || clean.includes('\\') || /^[A-Za-z]:/.test(clean) || clean.split('/').some((part) => part === '..')) {
    throw loaderError(`Unsafe archive entry: ${name}`);
  }
}

/** The directory holding u2os.yaml: the root, or its single top-level directory. */
function packageRoot(dir) {
  if (fs.existsSync(path.join(dir, 'u2os.yaml'))) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
  if (entries.length === 1 && entries[0].isDirectory() && fs.existsSync(path.join(dir, entries[0].name, 'u2os.yaml'))) return path.join(dir, entries[0].name);
  throw loaderError('No u2os.yaml found at the package root');
}

/**
 * Walks a package tree: only regular files and directories, within limits.
 * Hidden entries (".git", ".DS_Store") are ignored and never copied.
 */
export function scanTree(root) {
  const files = [];
  let total = 0;
  const walk = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw loaderError(`Packages may not contain symbolic links: ${rel}`);
      if (stat.isDirectory()) { walk(full, rel); continue; }
      if (!stat.isFile()) throw loaderError(`Packages may only contain regular files: ${rel}`);
      if (stat.size > MAX_FILE_BYTES) throw loaderError(`${rel} is larger than 1 MiB`);
      total += stat.size;
      files.push(rel);
      if (files.length > MAX_FILES) throw loaderError(`Packages may contain at most ${MAX_FILES} files`);
      if (total > MAX_TOTAL_BYTES) throw loaderError('Packages may be at most 10 MiB');
    }
  };
  walk(root, '');
  return files;
}

/** Copies a checked package tree to `dest` (regular files only). */
export function copyPackage(src, dest) {
  const files = scanTree(src);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of files) {
    const to = path.join(dest, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, ...rel.split('/')), to, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, 0o644);
  }
  return files;
}

/**
 * Reads and validates a package directory into a bundle:
 * { manifest, capabilities, skills, automations }.
 */
export function readPackageDirectory(dir) {
  scanTree(dir);
  const manifest = validateManifest(parseYaml(readPackageText(dir, 'u2os.yaml'), 'u2os.yaml'));
  const policies = Object.keys(manifest.policies);
  const emits = manifest.events.emits;
  const errors = [];
  const load = (file) => parseYaml(readPackageText(dir, file), file);
  const collect = (entries, validateOne) => entries.map((entry) => {
    try { return validateOne(load(entry.file), entry); } catch (error) {
      errors.push(...(error.errors?.length ? error.errors : [`${entry.file}: ${error.message}`]));
      return null;
    }
  }).filter(Boolean);
  const capabilities = collect(manifest.exports.capabilities, (raw, { id }) => validateCapabilityDefinition(raw, { id, version: manifest.version }));
  const skills = collect(manifest.exports.skills, (raw, { id }) => validateSkillDefinition(raw, { id, version: manifest.version, policies, emits, loadWorkflow: load }));
  const automations = collect(manifest.exports.automations, (raw, { id }) => validateAutomationDefinition(raw, { id, policies, emits, loadWorkflow: load }));
  for (const capability of capabilities) {
    const file = capability.implementation?.file || capability.implementation?.module;
    if (file) { try { readPackageText(dir, file, MAX_FILE_BYTES); } catch (error) { errors.push(`capability ${capability.id}: ${error.message}`); } }
  }
  for (const skill of skills) {
    if (skill.implementation?.module) { try { readPackageText(dir, skill.implementation.module, MAX_FILE_BYTES); } catch (error) { errors.push(`skill ${skill.id}: ${error.message}`); } }
  }
  if (manifest.ui.dashboard) { try { readPackageText(dir, manifest.ui.dashboard, MAX_FILE_BYTES); } catch (error) { errors.push(`ui.dashboard: ${error.message}`); } }
  if (errors.length) throw new ManifestError(`Invalid package ${manifest.id}`, errors);
  return { manifest, capabilities, skills, automations };
}

function loaderError(message) {
  const error = new Error(message);
  error.code = 'PACKAGE_SOURCE_INVALID';
  error.status = 400;
  return error;
}
