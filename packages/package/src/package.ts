import { sha256, toHex } from '@floorspec/engine';
import { PackageError } from './errors.js';
import { comparePaths, pathProblem } from './paths.js';
import { readZip, writeZip, type ZipEntry, type ZipLimits } from './zip.js';

/**
 * The `.floorspec` package (FLR-T-9.1, FLR-REQ-126): a Floorspec document and the files of its
 * assets, as one ZIP archive or as the identical unpacked folder. See README.md for the layout.
 *
 * Core 0.3 (18.4) defines a document's package as the directory that holds its file, and an
 * asset's `path` as relative to that directory; it names the one-file ZIP form, "a ZIP archive
 * holding model.json and its assets", and defers it to a later draft (9.4). This is that form as
 * this implementation writes it: the directory, zipped, with the document at `model.json`.
 */

/** The document's name in a package, at its root. */
export const DOCUMENT_NAME = 'model.json';
/** The extension of the one-file form. */
export const PACKAGE_EXTENSION = '.floorspec';
/** The media type a package is served as, until one is registered for it. */
export const PACKAGE_MEDIA_TYPE = 'application/zip';

export interface PackageLimits extends ZipLimits {
  /** The document file. */
  readonly maxDocumentBytes: number;
}

const MB = 1024 * 1024;

/**
 * Generous for a house — a 20 MB texture is a large one, and a model is a few MB at most — and
 * small enough that a hostile archive is refused before it costs anything. The server narrows
 * `maxEntryBytes` to its own upload limit.
 */
export const DEFAULT_LIMITS: PackageLimits = {
  maxArchiveBytes: 256 * MB,
  maxEntries: 4096,
  maxEntryBytes: 64 * MB,
  maxTotalBytes: 512 * MB,
  maxDocumentBytes: 32 * MB,
};

/** An asset the document locates by `path`: where its file is, and what the file must be. */
export interface PackagedAsset {
  readonly asset: string;
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string | null;
  readonly byteLength: number | null;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** The parsed document, or null when the bytes are not a JSON object (the validator says why). */
export function parseDocument(bytes: Uint8Array): Json | null {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The assets a document locates by a safe `path`, by asset ID. One located by `uri` is not in the
 * package (18.4: someone else's file on the web), and one whose path is not safe is not looked
 * for — the validator reports it (FS-CORE-8.6.2) — so no path a document names can reach outside.
 */
export function packagedAssets(document: unknown): PackagedAsset[] {
  const assets = isObject(document) && isObject(document['assets']) ? document['assets'] : {};
  const out: PackagedAsset[] = [];
  for (const id of Object.keys(assets).sort(comparePaths)) {
    const a = assets[id];
    if (!isObject(a) || typeof a['path'] !== 'string' || typeof a['sha256'] !== 'string') continue;
    if (pathProblem(a['path']) !== null || a['path'] === DOCUMENT_NAME) continue;
    out.push({
      asset: id,
      path: a['path'],
      sha256: a['sha256'],
      mediaType: typeof a['mediaType'] === 'string' ? a['mediaType'] : null,
      byteLength: typeof a['byteLength'] === 'number' ? a['byteLength'] : null,
    });
  }
  return out;
}

export interface BuiltPackage {
  /** `model.json` first, then each asset's file at its path, in code-point order of path. */
  readonly entries: ZipEntry[];
  /** Assets whose file was not given, or whose given bytes are not the digest the document names. */
  readonly missing: PackagedAsset[];
}

/**
 * The files of a package: the document's bytes as they are, at `model.json`, and each asset's
 * file at its path, taken from `files` by its SHA-256 (the asset store's key). Bytes whose digest is
 * not the one asked for are never packaged: the asset is reported missing instead. Two assets at
 * one path with one digest are one file; with two digests, the package holds the first (by asset
 * ID) and reports the second missing. Never throws: export is always available (FLR-REQ-151).
 */
export function packageEntries(document: Uint8Array | string, files: ReadonlyMap<string, Uint8Array> | ((sha256: string) => Uint8Array | undefined)): BuiltPackage {
  const bytes = typeof document === 'string' ? encoder.encode(document) : document;
  const lookup = typeof files === 'function' ? files : (sha: string) => files.get(sha);
  const byPath = new Map<string, { sha256: string; bytes: Uint8Array }>();
  const missing: PackagedAsset[] = [];
  const verified = new Map<string, boolean>();
  for (const a of packagedAssets(parseDocument(bytes))) {
    const there = byPath.get(a.path);
    if (there !== undefined) {
      // One file per path: a second asset there with another digest cannot be packaged, and a
      // package validator will say so (FS-INV-1006). An export never fails over it.
      if (there.sha256 !== a.sha256) missing.push(a);
      continue;
    }
    const file = lookup(a.sha256);
    let ok = file !== undefined && verified.get(a.sha256);
    if (file !== undefined && ok === undefined) {
      ok = toHex(sha256(file)) === a.sha256;
      verified.set(a.sha256, ok);
    }
    if (file === undefined || ok !== true) {
      missing.push(a);
      continue;
    }
    byPath.set(a.path, { sha256: a.sha256, bytes: file });
  }
  const assets = [...byPath.entries()].sort(([a], [b]) => comparePaths(a, b)).map(([name, f]) => ({ name, bytes: f.bytes }));
  return { entries: [{ name: DOCUMENT_NAME, bytes }, ...assets], missing };
}

/** The one-file form: the package's files as a deterministic ZIP. */
export function packageZip(built: Pick<BuiltPackage, 'entries'>): Uint8Array {
  return writeZip(built.entries);
}

export interface OpenedPackage {
  /** Where the document was found, from the archive's root. */
  readonly documentPath: string;
  /** The document's bytes, exactly as packaged. */
  readonly document: Uint8Array;
  /**
   * The files the document's assets name, by path relative to the document — what a package
   * validator is given (Core 18.4, `new Package(files)`).
   */
  readonly files: Map<string, Uint8Array>;
  /** Assets whose file the package does not hold (a package validator reports FS-INV-1005). */
  readonly missing: PackagedAsset[];
  /** Files nothing in the document names: not read further, and listed so a person can see. */
  readonly ignored: string[];
}

/** Junk an operating system adds when it zips a folder: never part of a package, never reported. */
const NOISE = /(^|\/)(__MACOSX|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/;

/**
 * Where the document is in a set of files: `model.json` at the root; failing that, the root's one
 * `*.floorspec.json` (Core 9.4's name for a document's file, which a person zipping the 18.4
 * directory form will have); failing both, the same inside a single top-level folder (what zipping
 * a folder, rather than its contents, makes). Anything else is not a package.
 */
function locateDocument(paths: readonly string[]): { documentPath: string; root: string } {
  const at = (root: string): string | null => {
    const inRoot = paths.filter((p) => p.startsWith(root) && !p.slice(root.length).includes('/')).map((p) => p.slice(root.length));
    if (inRoot.includes(DOCUMENT_NAME)) return DOCUMENT_NAME;
    const named = inRoot.filter((p) => p.endsWith('.floorspec.json'));
    return named.length === 1 ? (named[0] ?? null) : null;
  };
  const top = at('');
  if (top !== null) return { documentPath: top, root: '' };
  const firsts = new Set(paths.map((p) => (p.includes('/') ? `${p.split('/')[0] ?? ''}/` : '')));
  if (firsts.size === 1 && !firsts.has('')) {
    const [root = ''] = firsts;
    const inside = at(root);
    if (inside !== null) return { documentPath: root + inside, root };
  }
  throw new PackageError('no-document', `this package has no ${DOCUMENT_NAME}: a .floorspec package holds its document at ${DOCUMENT_NAME}, beside its assets/ folder`);
}

/**
 * A package from its files (a ZIP's entries, or a folder's files), by path from the package root:
 * the document, and the files its assets name. Every path must already be safe (readZip and the
 * CLI's folder reader both refuse unsafe ones).
 */
export function openEntries(entries: readonly ZipEntry[], limits: Pick<PackageLimits, 'maxDocumentBytes'> = DEFAULT_LIMITS): OpenedPackage {
  const all = entries.filter((e) => !NOISE.test(e.name));
  const { documentPath, root } = locateDocument(all.map((e) => e.name));
  const doc = all.find((e) => e.name === documentPath);
  if (doc === undefined) throw new PackageError('no-document', `this package has no ${DOCUMENT_NAME}`);
  if (doc.bytes.length > limits.maxDocumentBytes) throw new PackageError('too-large', `${documentPath} is larger than ${String(Math.floor(limits.maxDocumentBytes / MB))} MB`);
  const byPath = new Map<string, Uint8Array>();
  for (const e of all) if (e.name !== documentPath && e.name.startsWith(root)) byPath.set(e.name.slice(root.length), e.bytes);
  const files = new Map<string, Uint8Array>();
  const missing: PackagedAsset[] = [];
  for (const a of packagedAssets(parseDocument(doc.bytes))) {
    const bytes = byPath.get(a.path);
    if (bytes === undefined) missing.push(a);
    else files.set(a.path, bytes);
  }
  const ignored = all
    .map((e) => e.name)
    .filter((name) => name !== documentPath && !(name.startsWith(root) && files.has(name.slice(root.length))))
    .sort(comparePaths);
  return { documentPath, document: doc.bytes, files, missing, ignored };
}

/** Open a `.floorspec` archive: readZip's checks under `limits`, then openEntries. */
export function readPackage(zip: Uint8Array, limits: PackageLimits = DEFAULT_LIMITS): OpenedPackage {
  return openEntries(readZip(zip, limits).entries, limits);
}
