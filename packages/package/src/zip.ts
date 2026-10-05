import { deflateSync, inflateSync } from 'fflate';
import { crc32 } from './crc32.js';
import { PackageError } from './errors.js';
import { pathProblem } from './paths.js';

/**
 * The ZIP container (PKWARE APPNOTE 6.3.10, sections 4.3–4.4), written deterministically and read
 * defensively. Only what a package needs: stored (0) and deflated (8) entries, UTF-8 names, one
 * disk, no ZIP64, no encryption.
 *
 * **Writing** — the same entries give the same bytes, on any machine, at any time:
 *   - entries in the order given (the package sorts them), no directory entries;
 *   - every timestamp 1980-01-01 00:00:00, the earliest a ZIP can say, and no extra fields;
 *   - an entry is deflated at level 9 when that makes it smaller, and stored when it does not
 *     (a JPEG or PNG is compressed already) — the choice depends on the bytes alone;
 *   - flag bit 11 (names are UTF-8), "made by" Unix 2.0 with mode 0644, so an unzip creates
 *     ordinary files whatever the umask of the machine that made the archive;
 *   - no data descriptors, no archive comment.
 *
 * **Reading** — an archive is untrusted input:
 *   - the end-of-central-directory record is found exactly (its comment must end the file), and the
 *     central directory is what is believed; each local header must agree with it on the name;
 *   - entry data must lie inside the archive and before the central directory, and no two entries
 *     may share bytes (the overlapping-entry "zip bomb");
 *   - every name must be a safe path (paths.ts) — refusing zip-slip — and appear once;
 *   - a symbolic link, device or other special file (Unix mode in the external attributes) is
 *     refused; encryption, ZIP64, multiple disks and methods other than 0 and 8 are refused;
 *   - sizes are checked before anything is inflated, and inflation writes into a buffer of the
 *     declared size, so a lying header cannot make memory grow; then the length and CRC-32 must match.
 */

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface ZipLimits {
  /** The archive itself. */
  readonly maxArchiveBytes: number;
  /** File entries (directories are not counted). */
  readonly maxEntries: number;
  /** Any one file, uncompressed. */
  readonly maxEntryBytes: number;
  /** Every file together, uncompressed. */
  readonly maxTotalBytes: number;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** 1980-01-01 as an MS-DOS date: (year − 1980) << 9 | month << 5 | day. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;
const VERSION = 20;
/** Made by Unix (3), APPNOTE 2.0. */
const MADE_BY = (3 << 8) | VERSION;
/** S_IFREG | 0644, in the high 16 bits of the external attributes. */
const REGULAR_FILE = (0o100644 << 16) >>> 0;

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });

const human = (n: number): string => (n >= 1024 * 1024 ? `${String(Math.floor(n / 1024 / 1024))} MB` : n >= 1024 ? `${String(Math.floor(n / 1024))} KB` : `${String(n)} bytes`);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Deflate when it saves at least a byte; otherwise store. */
function compress(bytes: Uint8Array): { method: 0 | 8; data: Uint8Array } {
  if (bytes.length === 0) return { method: 0, data: bytes };
  const deflated = deflateSync(bytes, { level: 9, mem: 8 });
  return deflated.length < bytes.length ? { method: 8, data: deflated } : { method: 0, data: bytes };
}

/** Write a ZIP of these entries, in this order. Names must be safe paths and unique. */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > 0xfffe) throw new PackageError('conflict', 'a package holds at most 65,534 files');
  const seen = new Set<string>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const problem = pathProblem(e.name);
    if (problem !== null) throw new PackageError('unsafe-path', `${JSON.stringify(e.name)}: ${problem}`);
    if (seen.has(e.name)) throw new PackageError('duplicate-path', `two files at ${e.name}`);
    seen.add(e.name);
    const name = encoder.encode(e.name);
    const crc = crc32(e.bytes);
    const { method, data } = compress(e.bytes);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, LOCAL, true);
    l.setUint16(4, VERSION, true);
    l.setUint16(6, UTF8_NAMES, true);
    l.setUint16(8, method, true);
    l.setUint16(10, 0, true); // 00:00:00
    l.setUint16(12, DOS_DATE, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, e.bytes.length, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, CENTRAL, true);
    c.setUint16(4, MADE_BY, true);
    c.setUint16(6, VERSION, true);
    c.setUint16(8, UTF8_NAMES, true);
    c.setUint16(10, method, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, DOS_DATE, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, e.bytes.length, true);
    c.setUint16(28, name.length, true);
    // extra 0, comment 0, disk 0, internal attributes 0
    c.setUint32(38, REGULAR_FILE, true);
    c.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
    if (offset > 0xfffffffe) throw new PackageError('conflict', 'a package is at most 4 GB');
  }
  const directory = concat(centrals);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, END, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, directory.length, true);
  v.setUint32(16, offset, true);
  return concat([...locals, directory, end]);
}

export interface ReadZip {
  /** File entries, in central-directory order. */
  readonly entries: ZipEntry[];
  /** Directory entries (`name/`), which carry no data and are not files of the package. */
  readonly directories: string[];
}

/** True when the bytes begin as a ZIP archive does: a local header, or the end record of an empty one. */
export function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  return (bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06);
}

function findEnd(zip: Uint8Array, v: DataView): number {
  // The record is 22 bytes and may end in a comment of up to 65,535; it must end the file exactly.
  const lowest = Math.max(0, zip.length - 22 - 0xffff);
  for (let at = zip.length - 22; at >= lowest; at--) {
    if (v.getUint32(at, true) === END && at + 22 + v.getUint16(at + 20, true) === zip.length) return at;
  }
  throw new PackageError('not-a-zip', 'this is not a ZIP archive: it has no end-of-central-directory record');
}

/** S_IFMT of a Unix mode, and the two kinds a package may hold. */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** Read a ZIP archive under `limits`. Throws PackageError, never a crash, for anything it refuses. */
export function readZip(zip: Uint8Array, limits: ZipLimits): ReadZip {
  if (zip.length > limits.maxArchiveBytes) throw new PackageError('too-large', `the archive is larger than ${human(limits.maxArchiveBytes)}`);
  if (zip.length < 22) throw new PackageError('not-a-zip', 'this is not a ZIP archive: it is too short');
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = findEnd(zip, v);
  const disk = v.getUint16(end + 4, true);
  const directoryDisk = v.getUint16(end + 6, true);
  const onDisk = v.getUint16(end + 8, true);
  const total = v.getUint16(end + 10, true);
  const directorySize = v.getUint32(end + 12, true);
  const directoryOffset = v.getUint32(end + 16, true);
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new PackageError('zip64', 'ZIP64 archives are not read: a package is smaller than 4 GB');
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== total) throw new PackageError('multi-disk', 'a split or multi-disk archive is not a package');
  if (directoryOffset + directorySize > end) throw new PackageError('corrupt', 'the archive’s central directory lies outside it');

  const entries: ZipEntry[] = [];
  const directories: string[] = [];
  const names = new Set<string>();
  const spans: [number, number][] = [];
  let files = 0;
  let totalBytes = 0;
  let at = directoryOffset;
  for (let i = 0; i < total; i++) {
    if (at + 46 > directoryOffset + directorySize || v.getUint32(at, true) !== CENTRAL) throw new PackageError('corrupt', 'the archive’s central directory is damaged');
    const madeBy = v.getUint16(at + 4, true);
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const compressedSize = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true);
    const extraLength = v.getUint16(at + 30, true);
    const commentLength = v.getUint16(at + 32, true);
    const external = v.getUint32(at + 38, true);
    const localOffset = v.getUint32(at + 42, true);
    const nameBytes = zip.subarray(at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (at > directoryOffset + directorySize) throw new PackageError('corrupt', 'the archive’s central directory is damaged');

    let name: string;
    try {
      name = utf8.decode(nameBytes);
    } catch {
      throw new PackageError('unsafe-path', 'an entry’s name is not UTF-8');
    }
    if (flags & 0x0001 || flags & 0x0040) throw new PackageError('encrypted', `${name} is encrypted: a package is not`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new PackageError('zip64', 'ZIP64 archives are not read: a package is smaller than 4 GB');

    const host = madeBy >> 8;
    const mode = external >>> 16;
    const kind = host === 3 || host === 19 ? mode & S_IFMT : 0;
    if (kind === S_IFLNK) throw new PackageError('symlink', `${name} is a symbolic link: a package holds files only`);
    const directory = name.endsWith('/') || kind === S_IFDIR;
    if (kind !== 0 && kind !== S_IFREG && kind !== S_IFDIR) throw new PackageError('special-file', `${name} is not a regular file`);

    const path = directory ? name.replace(/\/$/, '') : name;
    const problem = pathProblem(path);
    if (problem !== null) throw new PackageError('unsafe-path', `${JSON.stringify(name)}: ${problem}`);
    if (names.has(path)) throw new PackageError('duplicate-path', `the archive holds ${path} twice`);
    names.add(path);
    if (directory) {
      if (size !== 0) throw new PackageError('corrupt', `${name} is a directory with data`);
      directories.push(path);
      continue;
    }

    if (method !== 0 && method !== 8) throw new PackageError('unsupported-method', `${name} is compressed with method ${String(method)}; a package is stored or deflated`);
    files += 1;
    if (files > limits.maxEntries) throw new PackageError('too-many-entries', `the archive holds more than ${String(limits.maxEntries)} files`);
    if (size > limits.maxEntryBytes) throw new PackageError('too-large', `${name} is larger than ${human(limits.maxEntryBytes)}`);
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) throw new PackageError('too-large', `the archive’s files come to more than ${human(limits.maxTotalBytes)}`);
    if (method === 0 && compressedSize !== size) throw new PackageError('corrupt', `${name}: a stored entry’s sizes disagree`);

    // The local header: where the data really starts, and a name that must match the directory's.
    if (localOffset + 30 > directoryOffset || v.getUint32(localOffset, true) !== LOCAL) throw new PackageError('corrupt', `${name}: its local header is missing`);
    const localNameLength = v.getUint16(localOffset + 26, true);
    const localExtraLength = v.getUint16(localOffset + 28, true);
    const localName = zip.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (localNameLength !== nameLength || localName.some((b, k) => b !== nameBytes[k])) throw new PackageError('corrupt', `${name}: its local header names another file`);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const stop = start + compressedSize;
    if (stop > directoryOffset) throw new PackageError('corrupt', `${name}: its data runs past the end of the archive’s files`);
    spans.push([localOffset, stop]);

    const data = zip.subarray(start, stop);
    let bytes: Uint8Array;
    if (method === 0) bytes = data;
    else {
      try {
        bytes = inflateSync(data, { out: new Uint8Array(size) });
      } catch {
        throw new PackageError('corrupt', `${name} could not be decompressed`);
      }
    }
    if (bytes.length !== size || crc32(bytes) !== crc) throw new PackageError('corrupt', `${name} is damaged: its contents do not match its checksum`);
    entries.push({ name: path, bytes });
  }
  if (at !== directoryOffset + directorySize) throw new PackageError('corrupt', 'the archive’s central directory is damaged');
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if ((spans[i]?.[0] ?? 0) < (spans[i - 1]?.[1] ?? 0)) throw new PackageError('corrupt', 'two entries share the same bytes');
  }
  return { entries, directories };
}
