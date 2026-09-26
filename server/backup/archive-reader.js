// Strict regular-file/directory subset of tar. Never ask an external extractor
// to interpret untrusted names, links, permissions or extension metadata.
import fs from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export const RESTORE_LIMITS = Object.freeze({ maxBytes: 4 * 1024 ** 3, maxEntries: 100000, maxMetadataBytes: 65536, maxPathBytes: 4096, maxDepth: 64 });
const decoder = new TextDecoder('utf-8', { fatal: true });
const metadataKeys = new Set(['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'SCHILY.dev', 'SCHILY.ino', 'SCHILY.nlink', 'LIBARCHIVE.creationtime']);

function invalid(reason) { const error = new Error(`snapshot: ${reason}; no destination files were published`); error.code = 'ARCHIVE_INVALID'; return error; }
function utf8(bytes) { try { return decoder.decode(bytes); } catch { throw invalid('archive text encoding is invalid'); } }
function field(bytes) { const end = bytes.indexOf(0); return utf8(end < 0 ? bytes : bytes.subarray(0, end)); }
function octal(bytes) {
  if (bytes.some((byte) => byte > 127)) throw invalid('archive numeric field is unsupported');
  const value = bytes.toString('ascii').replace(/[\0 ]+$/, '').trimStart();
  if (!/^[0-7]+$/.test(value)) throw invalid('archive numeric field is unsupported');
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw invalid('archive numeric field exceeds supported limits');
  return number;
}
function sizeDecimal(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid('archive size metadata is invalid');
  return Number(value);
}

function safePath(name, directory, limits) {
  if (Buffer.byteLength(name) > limits.maxPathBytes || /[\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name)) throw invalid('archive path is unsafe');
  while (name.startsWith('./')) name = name.slice(2);
  if (directory) name = name.replace(/\/$/, '');
  if (directory && (!name || name === '.')) return '';
  const pieces = name.split('/');
  if (!name || pieces.some((piece) => !piece || piece === '.' || piece === '..') || pieces.length > limits.maxDepth) throw invalid('archive path is unsafe');
  return pieces.join('/');
}

function pax(data) {
  const values = Object.create(null);
  const seen = new Set();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < offset || space - offset > 10) throw invalid('archive extended metadata is malformed');
    const length = sizeDecimal(data.subarray(offset, space).toString('ascii'));
    if (length <= space - offset + 2 || offset + length > data.length || data[offset + length - 1] !== 10) throw invalid('archive extended metadata is malformed');
    const record = data.subarray(space + 1, offset + length - 1);
    const equals = record.indexOf(61);
    if (equals < 1) throw invalid('archive extended metadata is malformed');
    const key = utf8(record.subarray(0, equals));
    // macOS/libarchive stores binary xattr values in PAX. Discard them;
    // never decode, apply, or delegate them to an external extractor.
    const ignoredAttribute = key.startsWith('LIBARCHIVE.xattr.') || key.startsWith('SCHILY.xattr.');
    if ((!metadataKeys.has(key) && !ignoredAttribute) || seen.has(key)) throw invalid('archive extended metadata is unsupported or ambiguous');
    seen.add(key);
    if (!ignoredAttribute) values[key] = utf8(record.subarray(equals + 1));
    offset += length;
  }
  return values;
}

class Reader {
  constructor(stream, limit) { this.iterator = stream[Symbol.asyncIterator](); this.chunk = Buffer.alloc(0); this.offset = 0; this.bytes = 0; this.limit = limit; }
  async read(length, allowEnd = false) {
    const result = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next();
        if (next.done) {
          if (!filled && allowEnd) return null;
          throw invalid('archive is truncated');
        }
        this.chunk = next.value; this.offset = 0;
      }
      const count = Math.min(length - filled, this.chunk.length - this.offset);
      this.bytes += count;
      if (this.bytes > this.limit) throw invalid('archive exceeds the restored byte limit');
      this.chunk.copy(result, filled, this.offset, this.offset + count);
      filled += count; this.offset += count;
    }
    return result;
  }
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!count) throw invalid('archive staging write failed');
    offset += count;
  }
}

/** Destination must be a fresh private staging directory, never the owner
 * home. All resource limits can only be reduced by trusted test callers. */
export async function readArchive(archive, destination, overrides = {}) {
  const limits = { ...RESTORE_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw invalid('restore limits are invalid');
    limits[key] = value;
  }
  fs.mkdirSync(destination, { mode: 0o700 });
  const source = fs.createReadStream(archive), gzip = createGunzip();
  let transferError;
  const transfer = pipeline(source, gzip).catch((error) => { transferError = error; });
  const reader = new Reader(gzip, limits.maxBytes + limits.maxEntries * 1024 + limits.maxMetadataBytes);
  const paths = new Set();
  let entries = 0, files = 0, bytes = 0, pending = null, longName = null, zeros = 0;
  try {
    while (true) {
      const header = await reader.read(512, true);
      if (!header) {
        if (zeros < 2 || pending || longName) throw invalid('archive end markers are incomplete');
        break;
      }
      if (header.every((byte) => byte === 0)) { zeros += 1; if (zeros > 128) throw invalid('archive end padding exceeds supported limits'); continue; }
      if (zeros) throw invalid('archive contains data after its end markers');
      if (++entries > limits.maxEntries) throw invalid('archive exceeds the entry limit');
      const checksum = octal(header.subarray(148, 156));
      let unsigned = 0, signed = 0;
      for (let index = 0; index < 512; index += 1) {
        const byte = index >= 148 && index < 156 ? 32 : header[index];
        unsigned += byte; signed += byte > 127 ? byte - 256 : byte;
      }
      if (checksum !== unsigned && checksum !== signed) throw invalid('archive header checksum is invalid');
      const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
      let size = octal(header.subarray(124, 136));
      if (['x', 'g', 'L'].includes(type)) {
        if (pending || longName || size > limits.maxMetadataBytes) throw invalid('archive extended metadata exceeds supported limits');
        const metadata = await reader.read(size);
        if (type === 'L') {
          longName = field(metadata);
          if (Buffer.byteLength(longName) > limits.maxPathBytes) throw invalid('archive path exceeds supported limits');
        } else {
          const values = pax(metadata);
          if (type === 'g' && (values.path !== undefined || values.size !== undefined)) throw invalid('global archive path or size overrides are unsupported');
          if (type === 'x') pending = values;
        }
      } else {
        if (type !== '0' && type !== '5') throw invalid('archive links and special file types are unsupported');
        if (field(header.subarray(157, 257))) throw invalid('archive contains unsupported link metadata');
        const prefix = header.subarray(257, 263).equals(Buffer.from('ustar\0')) ? field(header.subarray(345, 500)) : '';
        let name = pending?.path ?? longName ?? `${prefix ? `${prefix}/` : ''}${field(header.subarray(0, 100))}`;
        if (pending?.size !== undefined) size = sizeDecimal(pending.size);
        pending = null; longName = null;
        name = safePath(name, type === '5', limits);
        if (/^\.runtime-lock\.sqlite(?:$|[-/])/.test(name) || /^\.u2os-recovery(?:\.|$)/.test(name) || /^db\/u2os\.sqlite-(?:wal|shm|journal)(?:$|\/)/.test(name)) throw invalid('archive contains reserved runtime or recovery metadata');
        if (type === '5' && size !== 0) throw invalid('archive directory data is unsupported');
        if (size > limits.maxBytes - bytes) throw invalid('archive exceeds the restored byte limit');
        if (name) {
          const target = path.join(destination, name);
          if (type === '5') fs.mkdirSync(target, { recursive: true, mode: 0o700 });
          else {
            if (paths.has(name)) throw invalid('archive contains duplicate file entries');
            paths.add(name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            const fd = fs.openSync(target, 'wx', 0o600);
            try {
              let remaining = size;
              while (remaining) { const chunk = await reader.read(Math.min(65536, remaining)); writeAll(fd, chunk); remaining -= chunk.length; }
            } finally { fs.closeSync(fd); }
            files += 1; bytes += size;
          }
        }
      }
      const padding = (512 - size % 512) % 512;
      if (padding && !(await reader.read(padding)).every((byte) => byte === 0)) throw invalid('archive entry padding is invalid');
    }
    await transfer;
    if (transferError) throw invalid('archive compression is corrupt or truncated');
    return { files, bytes, entries };
  } catch (error) {
    if (error.code === 'ARCHIVE_INVALID') throw error;
    throw invalid('archive validation or private staging failed');
  } finally { source.destroy(); gzip.destroy(); await transfer; }
}
