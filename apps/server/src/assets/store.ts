import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * The asset store (FLR-T-8.2, FLR-REQ-124): uploaded files kept by the SHA-256 of their bytes behind
 * an adapter. Content addressing is the whole design: a file's name is what it is, so two uploads of
 * one texture are one file, a file never changes once written, and the nightly backup mirrors the
 * directory by copying only names it has not seen (FLR-T-12.1).
 *
 * Nothing here knows about projects or access: which project may read which file is the routes'
 * business (src/routes/assets.ts), decided from the database before the store is asked.
 */

/** 64 lowercase hex digits: the only key the store accepts, so no key can name a path. */
export const SHA256 = /^[0-9a-f]{64}$/;

export interface PutResult {
  readonly sha256: string;
  readonly byteLength: number;
  /** False when the store already had these bytes: nothing was written. */
  readonly created: boolean;
}

export interface AssetStore {
  /** Store bytes; their SHA-256 is computed here, never taken from the caller. */
  put(bytes: Uint8Array): Promise<PutResult>;
  /** The bytes stored under a digest, or null. */
  get(sha256: string): Promise<Uint8Array | null>;
  has(sha256: string): Promise<boolean>;
  /** Remove a file. True when there was one. Nothing calls this yet: a store is append-only until it has a collector. */
  delete(sha256: string): Promise<boolean>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkKey(sha256: string): void {
  if (!SHA256.test(sha256)) throw new RangeError('an asset key is a lowercase hex SHA-256');
}

/**
 * Files under a root directory as `ab/cd/<sha256>`: two levels of fan-out keep any one directory
 * small at any size a house's textures reach. A write goes to a temporary name in the same
 * directory and is renamed into place, so a reader never sees half a file and a crash leaves at
 * worst a `.tmp-` file, never a wrong one.
 */
export class FsAssetStore implements AssetStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Where a digest's file is. The key is checked first, so the path is always inside the root. */
  pathOf(sha256: string): string {
    checkKey(sha256);
    const path = join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
    if (!path.startsWith(this.root + sep)) throw new RangeError('an asset path left the store');
    return path;
  }

  async put(bytes: Uint8Array): Promise<PutResult> {
    const sha256 = sha256Hex(bytes);
    const path = this.pathOf(sha256);
    if (await this.has(sha256)) return { sha256, byteLength: bytes.length, created: false };
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(tmp, bytes, { flag: 'wx', mode: 0o640 });
      // rename(2) is atomic within a file system, and replaces a file a racing upload put there
      // first — with the same bytes, because the name is their digest.
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    return { sha256, byteLength: bytes.length, created: true };
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathOf(sha256)));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async has(sha256: string): Promise<boolean> {
    try {
      return (await stat(this.pathOf(sha256))).isFile();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async delete(sha256: string): Promise<boolean> {
    const had = await this.has(sha256);
    await rm(this.pathOf(sha256), { force: true });
    return had;
  }
}

/** In memory: for unit tests, and for an instance with no ASSET_DIR that must still boot. */
export class MemoryAssetStore implements AssetStore {
  private readonly files = new Map<string, Uint8Array>();

  put(bytes: Uint8Array): Promise<PutResult> {
    const sha256 = sha256Hex(bytes);
    const created = !this.files.has(sha256);
    if (created) this.files.set(sha256, new Uint8Array(bytes));
    return Promise.resolve({ sha256, byteLength: bytes.length, created });
  }
  get(sha256: string): Promise<Uint8Array | null> {
    checkKey(sha256);
    return Promise.resolve(this.files.get(sha256) ?? null);
  }
  has(sha256: string): Promise<boolean> {
    checkKey(sha256);
    return Promise.resolve(this.files.has(sha256));
  }
  delete(sha256: string): Promise<boolean> {
    checkKey(sha256);
    return Promise.resolve(this.files.delete(sha256));
  }
  get size(): number {
    return this.files.size;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The store an app runs with: the filesystem under ASSET_DIR. Without one, development and tests
 * keep uploads in memory (gone on restart, and the boot log says so); production has none, and an
 * upload is refused rather than accepted into memory and lost.
 */
export function defaultAssetStore(config: { readonly ASSET_DIR?: string | undefined; readonly NODE_ENV: string }): AssetStore | null {
  if (config.ASSET_DIR !== undefined && config.ASSET_DIR !== '') return new FsAssetStore(config.ASSET_DIR);
  return config.NODE_ENV === 'production' ? null : new MemoryAssetStore();
}
