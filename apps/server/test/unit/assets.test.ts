import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAssetStore, FsAssetStore, MemoryAssetStore } from '../../src/assets/store.js';
import { MAX_DIMENSION, MediaError, prepareImage, sniff } from '../../src/assets/media.js';
import { cleanName, packagePath } from '../../src/routes/assets.js';
import { jpegWithExif, ktx2, tilePng, webpWithExif } from '../support/images.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const has = (haystack: Uint8Array, needle: string) => Buffer.from(haystack).includes(Buffer.from(needle));

describe('the filesystem asset store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flr-assets-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps a file under ab/cd/<sha256> of its bytes, and reads it back', async () => {
    const store = new FsAssetStore(dir);
    const bytes = tilePng(8, 8);
    const put = await store.put(bytes);
    expect(put).toEqual({ sha256: sha(bytes), byteLength: bytes.length, created: true });
    const path = join(dir, put.sha256.slice(0, 2), put.sha256.slice(2, 4), put.sha256);
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    expect(await store.get(put.sha256)).toEqual(bytes);
    expect(await store.has(put.sha256)).toBe(true);
  });

  it('stores the same bytes once, however often they arrive', async () => {
    const store = new FsAssetStore(dir);
    const bytes = tilePng(8, 8);
    const [a, b] = await Promise.all([store.put(bytes), store.put(bytes)]);
    expect(a.sha256).toBe(b.sha256);
    expect((await store.put(bytes)).created).toBe(false);
    const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
    // One file, and no temporary file left behind by either racing writer.
    expect(files.map((f) => f.name)).toEqual([a.sha256]);
  });

  it('answers null and false for a digest it does not have', async () => {
    const store = new FsAssetStore(dir);
    expect(await store.get('0'.repeat(64))).toBeNull();
    expect(await store.has('0'.repeat(64))).toBe(false);
    expect(await store.delete('0'.repeat(64))).toBe(false);
  });

  it('takes nothing but a lowercase hex digest as a key, so no key names a path', async () => {
    const store = new FsAssetStore(dir);
    for (const key of ['../../etc/passwd', 'A'.repeat(64), `${'a'.repeat(63)}/`, '', `..${'a'.repeat(62)}`]) {
      await expect(store.get(key)).rejects.toThrow(RangeError);
      expect(() => store.pathOf(key)).toThrow(RangeError);
    }
  });

  it('deletes a file', async () => {
    const store = new FsAssetStore(dir);
    const { sha256 } = await store.put(tilePng(4, 4));
    expect(await store.delete(sha256)).toBe(true);
    expect(await store.has(sha256)).toBe(false);
  });

  it('writes files the service user can read and others cannot', async () => {
    const store = new FsAssetStore(dir);
    const { sha256 } = await store.put(tilePng(4, 4));
    expect((await stat(store.pathOf(sha256))).mode & 0o007).toBe(0);
  });
});

describe('the default store', () => {
  it('is the filesystem when ASSET_DIR is set', () => {
    expect(defaultAssetStore({ ASSET_DIR: '/tmp/x', NODE_ENV: 'production' })).toBeInstanceOf(FsAssetStore);
  });
  it('is memory in development and tests, and none in production, when it is not', () => {
    expect(defaultAssetStore({ NODE_ENV: 'development' })).toBeInstanceOf(MemoryAssetStore);
    expect(defaultAssetStore({ NODE_ENV: 'test' })).toBeInstanceOf(MemoryAssetStore);
    expect(defaultAssetStore({ NODE_ENV: 'production' })).toBeNull();
  });
  it('dedupes in memory too', async () => {
    const store = new MemoryAssetStore();
    const bytes = tilePng(4, 4);
    await store.put(bytes);
    expect((await store.put(bytes)).created).toBe(false);
    expect(store.size).toBe(1);
  });
});

describe('what an upload is', () => {
  it('reads the four texture formats from their bytes, with their pixel size', () => {
    expect(prepareImage(tilePng(64, 32))).toMatchObject({ mediaType: 'image/png', width: 64, height: 32 });
    expect(prepareImage(jpegWithExif(2048, 1024))).toMatchObject({ mediaType: 'image/jpeg', width: 2048, height: 1024 });
    expect(prepareImage(webpWithExif(300, 200))).toMatchObject({ mediaType: 'image/webp', width: 300, height: 200 });
    expect(prepareImage(ktx2(512, 256))).toMatchObject({ mediaType: 'image/ktx2', width: 512, height: 256 });
  });

  it('refuses anything else, whatever it is called', () => {
    for (const bytes of [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), new TextEncoder().encode('GIF89a......'), new Uint8Array([0x25, 0x50, 0x44, 0x46])]) {
      expect(sniff(bytes)).toBeNull();
      expect(() => prepareImage(bytes)).toThrow(MediaError);
    }
  });

  it('refuses a damaged file', () => {
    const png = tilePng(16, 16);
    expect(() => prepareImage(png.subarray(0, 40))).toThrow(/cut short/);
    expect(() => prepareImage(jpegWithExif(10, 10).subarray(0, 30))).toThrow(/cut short/);
  });

  it('refuses an image larger than a GPU texture', () => {
    expect(() => prepareImage(ktx2(MAX_DIMENSION + 1, 8))).toThrow(/at most/);
  });

  it('strips camera and location metadata from a JPEG and keeps everything else byte for byte', () => {
    const original = jpegWithExif(40, 30);
    const out = prepareImage(original);
    expect(out.stripped).toEqual(['APP1', 'APP1', 'COM']);
    expect(has(out.bytes, 'GPSLatitude')).toBe(false);
    expect(has(out.bytes, 'xmpmeta')).toBe(false);
    expect(has(out.bytes, 'taken at the house')).toBe(false);
    // The colour profile, the frame and the scan are untouched.
    expect(has(out.bytes, 'ICC_PROFILE')).toBe(true);
    expect(has(out.bytes, 'JFIF')).toBe(true);
    const scan = original.subarray(original.length - 13);
    expect(Buffer.from(out.bytes.subarray(out.bytes.length - 13)).equals(Buffer.from(scan))).toBe(true);
    expect(prepareImage(out.bytes)).toMatchObject({ width: 40, height: 30, stripped: [] });
  });

  it('strips text and EXIF chunks from a PNG, which still decodes to the same pixels', () => {
    const plain = tilePng(16, 8);
    const tagged = tilePng(16, 8, { meta: true });
    const out = prepareImage(tagged);
    expect(out.stripped).toEqual(['tEXt', 'eXIf']);
    expect(has(out.bytes, 'Example Lane')).toBe(false);
    expect(has(out.bytes, 'GPSLatitude')).toBe(false);
    expect(out.bytes).toEqual(plain);
    const idat = (b: Uint8Array) => {
      const at = Buffer.from(b).indexOf('IDAT');
      const len = new DataView(b.buffer, b.byteOffset).getUint32(at - 4);
      return inflateSync(b.subarray(at + 4, at + 4 + len));
    };
    expect(idat(out.bytes).equals(idat(tagged))).toBe(true);
  });

  it('strips EXIF and XMP chunks from a WebP and clears their flags', () => {
    const out = prepareImage(webpWithExif(64, 48));
    expect(out.stripped).toEqual(['EXIF', 'XMP']);
    expect(has(out.bytes, 'GPS')).toBe(false);
    const view = new DataView(out.bytes.buffer, out.bytes.byteOffset);
    expect(view.getUint32(4, true)).toBe(out.bytes.length - 8);
    expect((out.bytes[20] ?? 0) & 0x0c).toBe(0);
    expect(prepareImage(out.bytes)).toMatchObject({ mediaType: 'image/webp', width: 64, height: 48, stripped: [] });
  });

  it('stores a file without metadata exactly as it came', () => {
    const plain = tilePng(16, 16);
    expect(prepareImage(plain).bytes).toBe(plain);
  });
});

describe('names and paths', () => {
  it('keeps a person’s file name and drops any path and control characters', () => {
    expect(cleanName(encodeURIComponent('Zellige — seafoam.jpg'))).toBe('Zellige — seafoam.jpg');
    expect(cleanName('..%2F..%2Fetc%2Fpasswd')).toBe('passwd');
    expect(cleanName('C:\\Users\\me\\tile.png')).toBe('tile.png');
    expect(cleanName('a%00b.png')).toBe('ab.png');
    expect(cleanName('')).toBeNull();
    expect(cleanName(undefined)).toBeNull();
    expect(cleanName('%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('puts a file at assets/<sha256>.<ext> in the package (Core 18.4)', () => {
    const d = 'a'.repeat(64);
    expect(packagePath(d, 'image/jpeg')).toBe(`assets/${d}.jpg`);
    expect(packagePath(d, 'image/png')).toBe(`assets/${d}.png`);
    expect(packagePath(d, 'image/webp')).toBe(`assets/${d}.webp`);
    expect(packagePath(d, 'image/ktx2')).toBe(`assets/${d}.ktx2`);
  });
});
