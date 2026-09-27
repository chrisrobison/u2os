// Filesystem safety for installed packages (docs/plugin-architecture.md §4).
// A package-relative path must resolve inside the package directory without
// passing through a symbolic link.
import fs from 'node:fs';
import path from 'node:path';
import { safeRelativePath } from './manifest.js';

export function resolveInside(packageDir, relativePath) {
  const safe = safeRelativePath(relativePath);
  if (!safe) throw pathError(`Unsafe package path: ${relativePath}`);
  const root = fs.realpathSync(packageDir);
  let current = root;
  for (const segment of safe.split('/')) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch { throw pathError(`Missing package file: ${safe}`); }
    if (stat.isSymbolicLink()) throw pathError(`Package paths may not use symbolic links: ${safe}`);
  }
  if (!current.startsWith(root + path.sep)) throw pathError(`Package path escapes the package: ${safe}`);
  return current;
}

/** Reads a package text file (regular file, bounded size). */
export function readPackageText(packageDir, relativePath, maxBytes = 256 * 1024) {
  const file = resolveInside(packageDir, relativePath);
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw pathError(`Not a regular file: ${relativePath}`);
  if (stat.size > maxBytes) throw pathError(`${relativePath} is larger than ${Math.round(maxBytes / 1024)} KiB`);
  return fs.readFileSync(file, 'utf8');
}

function pathError(message) {
  const error = new Error(message);
  error.code = 'PACKAGE_PATH_INVALID';
  return error;
}
