import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { packageEntries, packageZip, writeZip } from '@floorspec/package';
import { readImportBytes } from '../src/projects/importPackage';

/** The import dialog's reading of a file (FLR-T-9.1). */

const conformance = new URL('../../../packages/engine/standard/conformance/core/0.3/materials/008-tile-photo-on-the-backsplash/', import.meta.url);
const document = new Uint8Array(readFileSync(new URL('input.json', conformance)));
const tile = new Uint8Array(readFileSync(new URL('package/assets/tile-12in.png', conformance)));
const enc = new TextEncoder();

describe('reading an import', () => {
  it('reads a .floorspec package as a package validator: valid, with its texture', () => {
    const zip = writeZip([{ name: 'model.json', bytes: document }, { name: 'assets/tile-12in.png', bytes: tile }, { name: 'notes.txt', bytes: enc.encode('hi') }]);
    const outcome = readImportBytes('kitchen.floorspec', zip);
    expect(outcome.status).toBe('read');
    if (outcome.status !== 'read') return;
    expect(outcome.read).toMatchObject({ kind: 'package', files: 1, missing: [], ignored: ['notes.txt'] });
    expect(outcome.read.summary.valid).toBe(true);
    expect(outcome.read.bytes).toBe(zip);
  });

  it('says a package with the wrong file is not valid (FS-INV-1006), and one with no model.json is not a package', () => {
    const wrong = readImportBytes('x.floorspec', writeZip([{ name: 'model.json', bytes: document }, { name: 'assets/tile-12in.png', bytes: enc.encode('no') }]));
    expect(wrong.status === 'read' && wrong.read.summary.valid).toBe(false);
    expect(wrong.status === 'read' ? wrong.read.summary.diagnostics.map((d) => d.code) : []).toContain('FS-INV-1006');
    const empty = readImportBytes('x.floorspec', writeZip([{ name: 'assets/tile-12in.png', bytes: tile }]));
    expect(empty).toMatchObject({ status: 'unreadable' });
    expect(readImportBytes('x.floorspec', enc.encode('not a zip'))).toMatchObject({ status: 'unreadable' });
  });

  it('reads a document as a document — no package validator, so no file is asked for', () => {
    const outcome = readImportBytes('house.floorspec.json', document);
    expect(outcome.status === 'read' && outcome.read.kind).toBe('document');
    expect(outcome.status === 'read' && outcome.read.summary.valid).toBe(true);
    expect(readImportBytes('x.json', new Uint8Array([0xff, 0xfe, 0x00]))).toMatchObject({ status: 'unreadable' });
  });

  it('reads what the server exports', () => {
    const zip = packageZip(packageEntries(document, new Map([['cf77abf784e1b49ffad62638d0117883502d08e4f0b8b1e7beb10fe1f70eab6c', tile]])));
    const outcome = readImportBytes('download', zip);
    expect(outcome.status === 'read' && outcome.read.summary.valid).toBe(true);
  });
});
