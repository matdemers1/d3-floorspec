import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_READER, Package, contentHash, validate } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { DOCUMENT_NAME, PackageError, documentToBatch, openEntries, packageEntries, packageZip, readPackage, readZip, writeZip, DEFAULT_LIMITS } from '../src/index.js';

const conformance = join(import.meta.dirname, '..', '..', 'engine', 'standard', 'conformance', 'core');
const backsplash = join(conformance, '0.3', 'materials', '008-tile-photo-on-the-backsplash');
const enc = new TextEncoder();
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The conformance case's document and its tile, as the asset store holds them: by digest. */
function fixture(): { document: Uint8Array; files: Map<string, Uint8Array>; tilePath: string; tile: Uint8Array } {
  const document = new Uint8Array(readFileSync(join(backsplash, 'input.json')));
  const tilePath = 'assets/tile-12in.png';
  const tile = new Uint8Array(readFileSync(join(backsplash, 'package', tilePath)));
  return { document, files: new Map([[sha(tile), tile]]), tilePath, tile };
}

/** Write a package's entries as a folder, and read every file under it back. */
function writeFolder(dir: string, entries: readonly { name: string; bytes: Uint8Array }[]): void {
  for (const e of entries) {
    mkdirSync(dirname(join(dir, e.name)), { recursive: true });
    writeFileSync(join(dir, e.name), e.bytes);
  }
}
function readFolder(dir: string, prefix = ''): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = `${prefix}${name}`;
    if (statSync(join(dir, rel)).isDirectory()) for (const [k, v] of readFolder(dir, `${rel}/`)) out.set(k, v);
    else out.set(rel, new Uint8Array(readFileSync(join(dir, rel))));
  }
  return out;
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

describe('packageEntries', () => {
  it('puts model.json first and each asset at its path, with the document bytes untouched', () => {
    const { document, files, tilePath, tile } = fixture();
    const built = packageEntries(document, files);
    expect(built.missing).toEqual([]);
    expect(built.entries.map((e) => e.name)).toEqual([DOCUMENT_NAME, tilePath]);
    expect(Buffer.from(built.entries[0]!.bytes).equals(Buffer.from(document))).toBe(true);
    expect(Buffer.from(built.entries[1]!.bytes).equals(Buffer.from(tile))).toBe(true);
  });

  it('reports an asset whose bytes it was not given, or was given the wrong bytes for, and never packages them', () => {
    const { document, tile } = fixture();
    expect(packageEntries(document, new Map()).missing.map((m) => m.asset)).toEqual(['TILE-PHOTO']);
    const lying = new Map([[sha(tile), enc.encode('not the tile')]]);
    const built = packageEntries(document, lying);
    expect(built.missing.map((m) => m.asset)).toEqual(['TILE-PHOTO']);
    expect(built.entries.map((e) => e.name)).toEqual([DOCUMENT_NAME]);
  });

  it('leaves out assets by uri and paths that are not safe', () => {
    const doc = { floorspec: '0.3', project: { name: 'x' }, assets: { A: { uri: 'https://example.com/a.png', sha256: 'a'.repeat(64), mediaType: 'image/png' }, B: { path: '../b.png', sha256: 'b'.repeat(64), mediaType: 'image/png' } } };
    const built = packageEntries(JSON.stringify(doc), new Map());
    expect(built.entries.map((e) => e.name)).toEqual([DOCUMENT_NAME]);
    expect(built.missing).toEqual([]);
  });

  it('holds one file per path: a second asset there with another file is reported, never thrown', () => {
    const a = enc.encode('a');
    const b = enc.encode('b');
    const doc = { floorspec: '0.3', project: { name: 'x' }, assets: { A: { path: 'assets/x.png', sha256: sha(a), mediaType: 'image/png' }, B: { path: 'assets/x.png', sha256: sha(b), mediaType: 'image/png' } } };
    const built = packageEntries(JSON.stringify(doc), new Map([[sha(a), a], [sha(b), b]]));
    expect(built.entries.map((e) => [e.name, new TextDecoder().decode(e.bytes)]).slice(1)).toEqual([['assets/x.png', 'a']]);
    expect(built.missing.map((m) => m.asset)).toEqual(['B']);
  });
});

describe('the ZIP and the folder', () => {
  it('are byte-identical in content: the document and every asset, file for file (FLR-T-9.1 doneWhen)', () => {
    const { document, files } = fixture();
    const built = packageEntries(document, files);
    const zip = packageZip(built);
    const dir = mkdtempSync(join(tmpdir(), 'fs-pkg-'));
    try {
      writeFolder(dir, built.entries);
      const folder = readFolder(dir);
      const zipped = new Map(readZip(zip, DEFAULT_LIMITS).entries.map((e) => [e.name, e.bytes]));
      expect([...zipped.keys()].sort()).toEqual([...folder.keys()].sort());
      for (const [name, bytes] of folder) expect(Buffer.from(zipped.get(name)!).equals(Buffer.from(bytes)), name).toBe(true);
      // Opened either way, the package is the same document and the same files.
      const fromZip = readPackage(zip);
      const fromFolder = openEntries([...folder].map(([name, bytes]) => ({ name, bytes })));
      expect(Buffer.from(fromZip.document).equals(Buffer.from(fromFolder.document))).toBe(true);
      expect([...fromZip.files.keys()]).toEqual([...fromFolder.files.keys()]);
      for (const [p, b] of fromZip.files) expect(Buffer.from(b).equals(Buffer.from(fromFolder.files.get(p)!))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is deterministic: the same document and files make the same archive', () => {
    const { document, files } = fixture();
    const a = packageZip(packageEntries(document, files));
    const b = packageZip(packageEntries(new Uint8Array(document), new Map(files)));
    expect(sha(a)).toBe(sha(b));
  });

  it('is a valid package to the engine’s package validator, as the folder is', () => {
    const { document, files } = fixture();
    const opened = readPackage(packageZip(packageEntries(document, files)));
    const result = validate(opened.document, { package: new Package(opened.files) });
    expect(result.valid, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.diagnostics.filter((d) => /^FS-INV-100[5-7]$/.test(d.code))).toEqual([]);
  });
});

describe('openEntries', () => {
  const { document, tilePath, tile } = fixture();

  it('finds model.json, the files its assets name, and lists what else is there', () => {
    const opened = openEntries([
      { name: 'model.json', bytes: document },
      { name: tilePath, bytes: tile },
      { name: 'notes.txt', bytes: enc.encode('hi') },
      { name: '__MACOSX/._model.json', bytes: enc.encode('junk') },
      { name: '.DS_Store', bytes: enc.encode('junk') },
    ]);
    expect(opened.documentPath).toBe('model.json');
    expect([...opened.files.keys()]).toEqual([tilePath]);
    expect(opened.missing).toEqual([]);
    expect(opened.ignored).toEqual(['notes.txt']);
  });

  it('reads the Core 18.4 directory form zipped by a person: house.floorspec.json, inside one folder', () => {
    const opened = openEntries([
      { name: 'kitchen/house.floorspec.json', bytes: document },
      { name: `kitchen/${tilePath}`, bytes: tile },
    ]);
    expect(opened.documentPath).toBe('kitchen/house.floorspec.json');
    expect([...opened.files.keys()]).toEqual([tilePath]);
  });

  it('reports a file the document names and the package lacks, for the package validator to report too', () => {
    const opened = openEntries([{ name: 'model.json', bytes: document }]);
    expect(opened.missing.map((m) => m.path)).toEqual([tilePath]);
    const result = validate(opened.document, { package: new Package(opened.files) });
    expect(result.diagnostics.map((d) => d.code)).toContain('FS-INV-1005');
  });

  it('refuses a package with no document, or a document past the limit', () => {
    expect(refusal(() => openEntries([{ name: tilePath, bytes: tile }]))).toBe('no-document');
    expect(refusal(() => openEntries([{ name: 'a.floorspec.json', bytes: document }, { name: 'b.floorspec.json', bytes: document }]))).toBe('no-document');
    expect(refusal(() => openEntries([{ name: 'model.json', bytes: document }], { maxDocumentBytes: 10 }))).toBe('too-large');
  });

  it('keeps a document that is not JSON, for the validator to say why', () => {
    const opened = readPackage(writeZip([{ name: 'model.json', bytes: enc.encode('{not json') }]));
    expect(new TextDecoder().decode(opened.document)).toBe('{not json');
    expect(validate(opened.document).valid).toBe(false);
  });
});

// ── documentToBatch: every valid conformance document, rebuilt from the empty one by Ops ──────────

function cases(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...cases(p));
    else if (e === 'expected.json') out.push(dir);
  }
  return out;
}

const valid = ['0.1', '0.2', '0.3'].flatMap((v) =>
  cases(join(conformance, v)).filter((dir) => {
    if (existsSync(join(dir, 'registry.json')) || !existsSync(join(dir, 'input.json'))) return false;
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as { valid?: boolean; diagnostics?: { code: string }[] };
    // A package validator's failures are about files, not the document.
    return expected.valid === true || (expected.diagnostics ?? []).every((d) => /^FS-INV-100[5-7]$/.test(d.code) || !d.code.startsWith('FS-'));
  }),
);

describe('documentToBatch', () => {
  it('finds documents to rebuild', () => {
    expect(valid.length).toBeGreaterThan(50);
  });

  it.each(valid.map((dir) => [dir.slice(conformance.length + 1), dir]))('%s: the batch rebuilds the document from the empty one', (_name, dir) => {
    const document = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8')) as Record<string, unknown>;
    if (!validate(document, OFFICIAL_READER).valid) return; // valid only as a package, or with a design
    const name = (document['project'] as { name: string }).name;
    const empty = { floorspec: '0.3', project: { name } };
    const batch = documentToBatch(document, name, { from: '0.3' });
    // The empty document needs no op (what an import of it does: the project as created).
    if (batch.length === 0) {
      expect(contentHash(empty)).toBe(contentHash(document));
      return;
    }
    const result = apply(empty, { batch }, { ops: '0.3', ...OFFICIAL_READER });
    expect(result.status, JSON.stringify(result.status === 'rejected' ? result.diagnostics : [])).toBe('committed');
    if (result.status !== 'committed') return;
    const after = typeof result.document === 'string' ? (JSON.parse(result.document) as unknown) : result.document;
    expect(contentHash(after as object)).toBe(contentHash(document));
  });
});
