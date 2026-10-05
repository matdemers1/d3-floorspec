import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as nodeCrc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, PackageError, comparePaths, crc32, isZip, pathProblem, readZip, writeZip, type ZipEntry } from '../src/index.js';

const enc = new TextEncoder();
const LIMITS = DEFAULT_LIMITS;

/** A tiny hand-rolled ZIP writer for hostile archives: whatever the test says, however wrong. */
interface Raw {
  name: string;
  data?: Uint8Array;
  method?: number;
  /** The bytes as stored (default: data, or its raw deflate for method 8). */
  stored?: Uint8Array;
  size?: number;
  crc?: number;
  flags?: number;
  madeBy?: number;
  external?: number;
  localName?: string;
  /** Point the central entry at this offset instead of its own local header. */
  offsetAt?: number;
}

function rawZip(entries: Raw[], comment = ''): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? new Uint8Array());
    const stored = Buffer.from(e.stored ?? (e.method === 8 ? deflateRawSync(data) : data));
    const name = Buffer.from(e.name, 'utf8');
    const localName = Buffer.from(e.localName ?? e.name, 'utf8');
    const crc = e.crc ?? nodeCrc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0x0800, 6);
    local.writeUInt16LE(e.method ?? 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(e.size ?? data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0x0800, 8);
    central.writeUInt16LE(e.method ?? 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(e.size ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.external ?? 0, 38);
    central.writeUInt32LE(e.offsetAt ?? offset, 42);
    centrals.push(Buffer.concat([central, name]));
    const block = Buffer.concat([local, localName, stored]);
    locals.push(block);
    offset += block.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return new Uint8Array(Buffer.concat([...locals, directory, end, Buffer.from(comment)]));
}

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PackageError) return e.code;
    throw e;
  }
  return 'accepted';
};

const SAMPLE: ZipEntry[] = [
  { name: 'model.json', bytes: enc.encode(`${JSON.stringify({ floorspec: '0.3', project: { name: 'x' } }, null, 2)}\n`.repeat(20)) },
  { name: 'assets/a.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  { name: 'assets/é/ü.bin', bytes: new Uint8Array(0) },
];

describe('crc32', () => {
  it('agrees with zlib', () => {
    for (const s of ['', 'a', 'The quick brown fox jumps over the lazy dog', '\u00ff'.repeat(1000)]) expect(crc32(enc.encode(s))).toBe(nodeCrc32(enc.encode(s)) >>> 0);
  });
});

describe('writeZip', () => {
  it('is deterministic: the same entries give the same bytes', () => {
    const a = writeZip(SAMPLE);
    const b = writeZip(SAMPLE.map((e) => ({ name: e.name, bytes: new Uint8Array(e.bytes) })));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(isZip(a)).toBe(true);
  });

  it('reads back exactly what it wrote, deflating text and storing what does not shrink', () => {
    const zip = writeZip(SAMPLE);
    const { entries, directories } = readZip(zip, LIMITS);
    expect(directories).toEqual([]);
    expect(entries.map((e) => e.name)).toEqual(SAMPLE.map((e) => e.name));
    for (const [i, e] of entries.entries()) expect(Buffer.from(e.bytes).equals(Buffer.from(SAMPLE[i]!.bytes))).toBe(true);
    // The repeated document shrinks a lot; the archive is smaller than its text.
    expect(zip.length).toBeLessThan(SAMPLE[0]!.bytes.length);
  });

  it('stamps every entry 1980-01-01 00:00 and mode 0644, made by Unix', () => {
    const zip = Buffer.from(writeZip(SAMPLE));
    const end = zip.length - 22;
    let at = zip.readUInt32LE(end + 16);
    for (let i = 0; i < SAMPLE.length; i++) {
      expect(zip.readUInt16LE(at + 4)).toBe((3 << 8) | 20);
      expect(zip.readUInt16LE(at + 12)).toBe(0);
      expect(zip.readUInt16LE(at + 14)).toBe(0x21);
      expect(zip.readUInt32LE(at + 38) >>> 16).toBe(0o100644);
      at += 46 + zip.readUInt16LE(at + 28);
    }
  });

  it('is read by the system unzip, file for file', () => {
    const which = spawnSync('unzip', ['-v']);
    if (which.status !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), 'fs-zip-'));
    try {
      writeFileSync(join(dir, 'x.floorspec'), writeZip(SAMPLE));
      execFileSync('unzip', ['-q', 'x.floorspec', '-d', 'out'], { cwd: dir });
      for (const e of SAMPLE) expect(Buffer.from(readFileSync(join(dir, 'out', e.name))).equals(Buffer.from(e.bytes))).toBe(true);
      execFileSync('unzip', ['-tq', 'x.floorspec'], { cwd: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses names that are not safe paths, and two files at one path', () => {
    expect(refusal(() => writeZip([{ name: '../x', bytes: new Uint8Array() }]))).toBe('unsafe-path');
    expect(refusal(() => writeZip([{ name: 'a', bytes: new Uint8Array() }, { name: 'a', bytes: new Uint8Array() }]))).toBe('duplicate-path');
  });
});

describe('pathProblem', () => {
  it('orders by code point, not UTF-16 unit', () => {
    expect(['b', '\u{1F600}', '\uFFFF', 'a', 'ab'].sort(comparePaths)).toEqual(['a', 'ab', 'b', '\uFFFF', '\u{1F600}']);
  });
  it('accepts what Core 8.6.2 accepts', () => {
    for (const p of ['model.json', 'assets/tile-12in.jpg', 'assets/é.png', 'a/b/c/d.ktx2', 'a b/c']) expect(pathProblem(p)).toBeNull();
  });
  it('refuses climbing, absolute, drive-letter, backslash, empty and control-character paths', () => {
    for (const p of ['', '/etc/passwd', '../x', 'a/../../x', './a', 'a//b', 'a/', 'C:/x', 'c:x', 'a\\..\\x', 'a\u0000b', 'a\nb', 'x'.repeat(256), `${'a/'.repeat(600)}b`]) expect(pathProblem(p), p).not.toBeNull();
  });
});

describe('readZip refuses what a package never is', () => {
  const file = (name: string, data: Uint8Array = enc.encode('hello'), extra: Partial<Raw> = {}): Raw => ({ name, data, ...extra });

  it('a hand-made archive that is fine reads', () => {
    const zip = rawZip([file('model.json'), file('assets/x.png', enc.encode('x'.repeat(5000)), { method: 8 }), file('assets/', new Uint8Array())], 'a comment');
    const { entries, directories } = readZip(zip, LIMITS);
    expect(entries.map((e) => e.name)).toEqual(['model.json', 'assets/x.png']);
    expect(directories).toEqual(['assets']);
    expect(new TextDecoder().decode(entries[1]!.bytes)).toBe('x'.repeat(5000));
  });

  it('not a ZIP, or one cut short', () => {
    expect(refusal(() => readZip(enc.encode('{"floorspec":"0.3"}'), LIMITS))).toBe('not-a-zip');
    const zip = writeZip(SAMPLE);
    expect(refusal(() => readZip(zip.subarray(0, zip.length - 5), LIMITS))).toBe('not-a-zip');
    expect(refusal(() => readZip(zip.subarray(40), LIMITS))).not.toBe('accepted');
  });

  it('zip-slip: a name that climbs out, is absolute, or uses backslashes', () => {
    for (const name of ['../evil.sh', 'assets/../../evil', '/etc/cron.d/x', 'assets\\..\\..\\evil', 'C:/evil', 'a//b']) {
      expect(refusal(() => readZip(rawZip([file('model.json'), file(name)]), LIMITS)), name).toBe('unsafe-path');
    }
  });

  it('a symbolic link, or a device', () => {
    const link = (0o120777 << 16) >>> 0;
    expect(refusal(() => readZip(rawZip([file('model.json'), file('assets/x.png', enc.encode('/etc/passwd'), { madeBy: (3 << 8) | 20, external: link })]), LIMITS))).toBe('symlink');
    const fifo = (0o010644 << 16) >>> 0;
    expect(refusal(() => readZip(rawZip([file('model.json'), file('assets/x', enc.encode(''), { madeBy: (3 << 8) | 20, external: fifo })]), LIMITS))).toBe('special-file');
  });

  it('the same path twice', () => {
    expect(refusal(() => readZip(rawZip([file('model.json'), file('model.json')]), LIMITS))).toBe('duplicate-path');
  });

  it('encryption, other methods', () => {
    expect(refusal(() => readZip(rawZip([file('model.json', enc.encode('x'), { flags: 0x0801 })]), LIMITS))).toBe('encrypted');
    expect(refusal(() => readZip(rawZip([file('model.json', enc.encode('x'), { method: 12 })]), LIMITS))).toBe('unsupported-method');
  });

  it('a damaged entry: wrong checksum, a local header that names another file, overlapping entries', () => {
    expect(refusal(() => readZip(rawZip([file('model.json', enc.encode('x'), { crc: 1 })]), LIMITS))).toBe('corrupt');
    expect(refusal(() => readZip(rawZip([file('model.json', enc.encode('x'), { localName: 'other.json' })]), LIMITS))).toBe('corrupt');
    // The overlapping-entry bomb: assets/x's local header and data lie inside model.json's data.
    const inner = rawZip([file('assets/x')]).subarray(0, 30 + 'assets/x'.length + 5);
    const overlapping = rawZip([file('model.json', inner), file('assets/x', enc.encode('hello'), { offsetAt: 30 + 'model.json'.length })]);
    expect(refusal(() => readZip(overlapping, LIMITS))).toBe('corrupt');
  });

  it('a deflated entry that says it is smaller than it is never grows past its declared size', () => {
    const big = new Uint8Array(1_000_000).fill(65);
    const zip = rawZip([file('model.json', big, { method: 8, size: 10, crc: nodeCrc32(big) })]);
    expect(refusal(() => readZip(zip, LIMITS))).toBe('corrupt');
  });

  it('limits: archive size, entry count, an entry, the total', () => {
    const zip = writeZip(SAMPLE);
    expect(refusal(() => readZip(zip, { ...LIMITS, maxArchiveBytes: zip.length - 1 }))).toBe('too-large');
    expect(refusal(() => readZip(zip, { ...LIMITS, maxEntries: 2 }))).toBe('too-many-entries');
    expect(refusal(() => readZip(zip, { ...LIMITS, maxEntryBytes: 100 }))).toBe('too-large');
    expect(refusal(() => readZip(zip, { ...LIMITS, maxTotalBytes: SAMPLE[0]!.bytes.length }))).toBe('too-large');
    // A bomb: 64 MB of zeros deflates to ~64 KB; the declared size is refused before inflating.
    const bomb = rawZip([file('model.json', new Uint8Array(64 * 1024 * 1024), { method: 8 })]);
    expect(bomb.length).toBeLessThan(200_000);
    expect(refusal(() => readZip(bomb, { ...LIMITS, maxEntryBytes: 1024 * 1024 }))).toBe('too-large');
  });
});
