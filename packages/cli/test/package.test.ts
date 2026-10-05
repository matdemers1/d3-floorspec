/**
 * `floorspec package` and `floorspec unpack` (FLR-T-9.1), run as the built binary: a package
 * written from a document and its assets folder, unpacked again into a folder byte-identical in
 * content to the archive, and every refusal leaving nothing behind.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, readZip, writeZip } from '@floorspec/package';

const bin = join(import.meta.dirname, '..', 'dist', 'bin.js');
const backsplash = join(import.meta.dirname, '..', '..', 'engine', 'standard', 'conformance', 'core', '0.3', 'materials', '008-tile-photo-on-the-backsplash');
const floorspec = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function filesUnder(dir: string, prefix = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = `${prefix}${name}`;
    if (statSync(join(dir, rel)).isDirectory()) for (const [k, v] of filesUnder(dir, `${rel}/`)) out.set(k, v);
    else out.set(rel, readFileSync(join(dir, rel)));
  }
  return out;
}

describe('floorspec package and unpack', () => {
  let work: string;
  let house: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'fs-cli-pkg-'));
    // The Core 18.4 directory form: the document beside its assets/ folder.
    house = join(work, 'kitchen');
    mkdirSync(house);
    cpSync(join(backsplash, 'input.json'), join(house, 'house.floorspec.json'));
    cpSync(join(backsplash, 'package', 'assets'), join(house, 'assets'), { recursive: true });
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('writes a package, unpacks it to a folder byte-identical in content, and validates both', () => {
    const out = join(work, 'kitchen.floorspec');
    const packed = floorspec('package', join(house, 'house.floorspec.json'), '-o', out);
    expect(packed.status, packed.stderr).toBe(0);
    expect(packed.stdout).toContain('model.json and 1 asset file');
    const zip = new Uint8Array(readFileSync(out));
    const entries = readZip(zip, DEFAULT_LIMITS).entries;
    expect(entries.map((e) => e.name)).toEqual(['model.json', 'assets/tile-12in.png']);
    expect(Buffer.from(entries[0]!.bytes).equals(readFileSync(join(house, 'house.floorspec.json')))).toBe(true);

    // Packing again gives the same archive.
    const again = join(work, 'again.floorspec');
    expect(floorspec('package', join(house, 'house.floorspec.json'), '--assets', house, '--out', again).status).toBe(0);
    expect(sha(readFileSync(again))).toBe(sha(zip));

    const dir = join(work, 'unpacked');
    const unpacked = floorspec('unpack', out, '-o', dir);
    expect(unpacked.status, unpacked.stderr).toBe(0);
    const folder = filesUnder(dir);
    expect([...folder.keys()].sort()).toEqual(entries.map((e) => e.name).sort());
    for (const e of entries) expect(folder.get(e.name)!.equals(Buffer.from(e.bytes)), e.name).toBe(true);

    // The archive validates as a package; so does the folder, given as the package directory.
    expect(floorspec('validate', out).status).toBe(0);
    expect(floorspec('validate', join(dir, 'model.json'), '--package', dir).status).toBe(0);
    expect(floorspec('hash', out).stdout.trim()).toBe(floorspec('hash', join(dir, 'model.json')).stdout.trim());
  });

  it('refuses to write a package whose files are not the ones the document names, and writes nothing', () => {
    writeFileSync(join(house, 'assets', 'tile-12in.png'), 'not the tile');
    const out = join(work, 'bad.floorspec');
    const res = floorspec('package', join(house, 'house.floorspec.json'), '-o', out);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('FS-INV-1006');
    expect(existsSync(out)).toBe(false);
    rmSync(join(house, 'assets'), { recursive: true });
    const missing = floorspec('package', join(house, 'house.floorspec.json'), '-o', out);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('FS-INV-1005');
  });

  it('does not follow a symbolic link out of the assets folder', () => {
    rmSync(join(house, 'assets', 'tile-12in.png'));
    symlinkSync(join(backsplash, 'package', 'assets', 'tile-12in.png'), join(house, 'assets', 'tile-12in.png'));
    const res = floorspec('package', join(house, 'house.floorspec.json'), '-o', join(work, 'x.floorspec'));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('FS-INV-1005');
    expect(floorspec('validate', join(house, 'house.floorspec.json'), '--package', house).status).toBe(2);
  });

  it('unpacks only into a new or empty folder, and never outside it', () => {
    const out = join(work, 'kitchen.floorspec');
    expect(floorspec('package', join(house, 'house.floorspec.json'), '-o', out).status).toBe(0);
    const full = join(work, 'full');
    mkdirSync(full);
    writeFileSync(join(full, 'keep.txt'), 'mine');
    expect(floorspec('unpack', out, '-o', full).status).toBe(2);
    expect(readdirSync(full)).toEqual(['keep.txt']);

    // An archive with a climbing name (patched in: the writer will not make one) writes nothing.
    const evil = Buffer.from(writeZip([{ name: 'model.json', bytes: readFileSync(join(house, 'house.floorspec.json')) }, { name: 'assets/tile-12in.png', bytes: new Uint8Array([1]) }]));
    for (let at = evil.indexOf('assets/tile-12in.png'); at >= 0; at = evil.indexOf('assets/tile-12in.png', at + 1)) evil.write('../../../../tmp/pwnd', at, 'latin1');
    writeFileSync(join(work, 'evil.floorspec'), evil);
    const res = floorspec('unpack', join(work, 'evil.floorspec'), '-o', join(work, 'evil'));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('is not a package that can be read');
    expect(existsSync(join(work, 'evil'))).toBe(false);
  });

  it('needs -o for package and unpack, and takes it for nothing else', () => {
    expect(floorspec('package', join(house, 'house.floorspec.json')).status).toBe(2);
    expect(floorspec('unpack', 'x.floorspec').status).toBe(2);
    expect(floorspec('validate', join(house, 'house.floorspec.json'), '-o', 'x').status).toBe(2);
    expect(floorspec('validate', join(house, 'house.floorspec.json'), '--assets', house).status).toBe(2);
  });
});
