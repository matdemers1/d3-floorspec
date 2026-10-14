/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import { readModel, type EditorModel, type LevelView, type Point } from '../src/editor/model';
import type { Batch, BatchBuilder } from '../src/editor/ops';
import { entriesFor, entryByKey, footprintText, matches, search, type Entry } from '../src/placing/catalog';
import { compassOf, ghostOf, type GhostOptions } from '../src/placing/ghost';
import { batchFor } from '../src/placing/place';
import type { StoredFile } from '../src/furniture/ops';

/**
 * Adding things (FLR-T-18.7): the one library, the ghost's snapping on the Courtyard House — a sofa
 * backed onto the Den's south wall, centred and into a corner, a chair flush to a face, a window in
 * a wall and not over another, a tree free on the level — and every kind of placement as one batch
 * through the real applier, as the server runs it.
 */

const TEXT = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const MODEL: EditorModel = readModel('h', TEXT);
const L1 = MODEL.levels.find((l) => l.id === 'L1')!;
/** The same level with nothing placed on it: what the faces alone snap to. */
const BARE: LevelView = { ...L1, devices: [] };
const MM = 1_280;
const opts = (o: Partial<GhostOptions> = {}): GhostOptions => ({ tol: 150 * MM, grid: 16_256, rotation: 0, turned: false, roomName: (id) => L1.rooms.find((r) => r.id === id)?.name ?? id, ...o });
const entry = (key: string): Entry => entryByKey(MODEL.document, key)!;

function bounds(level: LevelView, room: string): { minX: number; maxX: number; minY: number; maxY: number } {
  const ring = level.rooms.find((r) => r.id === room)!.outer;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function commit(batch: Batch | BatchBuilder): { status: string; document: string; diagnostics: { code: string; message: string }[] } {
  const sent = typeof batch === 'function' ? batch(0) : batch;
  const r = apply(TEXT, { batch: sent }, OFFICIAL_READER);
  return r.status === 'committed' ? { status: r.status, document: r.document, diagnostics: [] } : { status: r.status, document: '', diagnostics: r.diagnostics };
}

describe('the library (FLR-T-18.7)', () => {
  const all = entriesFor(MODEL.document);
  it('holds the furniture, the devices, the document’s door and window types and the garden', () => {
    const kinds = new Set(all.map((e) => e.source.kind));
    expect([...kinds].sort()).toEqual(['device', 'furniture', 'landscape', 'opening']);
    expect(new Set(all.map((e) => e.key)).size).toBe(all.length);
    expect(all.filter((e) => e.groups.includes('outdoor')).length).toBeGreaterThanOrEqual(16);
    expect(all.some((e) => e.key === 'window:window-casement-30x48')).toBe(true);
    expect(all.some((e) => e.key === 'door:door-interior-swing-32x80')).toBe(true);
  });

  it('places by kind: a sofa backs onto a wall, a table stands free, a receptacle is a device, a tree is free on the level', () => {
    expect(entry('furniture:sofa-2100').placement).toBe('backed');
    expect(entry('furniture:dining-table-1500').placement).toBe('floor');
    expect(entry('furniture:wall-cabinet-600').placement).toBe('wall');
    expect(entry('device:receptacle').placement).toBe('device');
    expect(entry('landscape:tree-small').placement).toBe('level');
    expect(entry('window:window-casement-30x48').placement).toBe('opening');
  });

  it('searches every word, names that start with the query first, recent items first among equals', () => {
    expect(matches(entry('furniture:sofa-2100'), 'three sofa')).toBe(true);
    expect(matches(entry('furniture:sofa-2100'), 'sofa window')).toBe(false);
    const found = search(all, 'window');
    expect(found[0]!.name.toLowerCase().startsWith('window') || found[0]!.groups.includes('windows')).toBe(true);
    const recent = search(all, 'casement', ['window:window-casement-30x60']);
    expect(recent[0]!.key).toBe('window:window-casement-30x60');
    expect(search(all, 'small tree')[0]!.key).toBe('landscape:tree-small');
  });

  it('says a card’s size as the board does: width × depth', () => {
    expect(footprintText(entry('furniture:sofa-2100'), 'imperial')).toBe('83 × 35″');
    expect(footprintText(entry('furniture:sofa-2100'), 'metric')).toBe('2100 × 900 mm');
  });
});

describe('the ghost (FLR-T-18.7)', () => {
  const den = bounds(L1, 'R6');
  const sofa = entry('furniture:sofa-2100');
  const half = (sofa.box.max[1] - sofa.box.min[1]) / 2;

  it('backs a sofa onto the Den’s south wall, facing into the room, centred when near the middle', () => {
    const p: Point = [(den.minX + den.maxX) / 2 + 40 * MM, den.minY + 700 * MM];
    const g = ghostOf(L1, sofa, p, opts())!;
    expect(g.host).toMatchObject({ mode: 'surface', room: 'R6', surface: 'floor', rotation: 90_000_000 });
    expect(g.label).toBe('Against the south wall · centred on the Den');
    // Centred: the clear distances either side are equal.
    expect(g.gaps).toHaveLength(2);
    expect(Math.abs(g.gaps[0]!.length - g.gaps[1]!.length)).toBeLessThan(2);
    // Its back 10 mm off the face.
    expect(Math.min(...g.footprint.map((q) => q[1]))).toBeCloseTo(den.minY + 12_800, -1);
  });

  it('goes into the corner when its side comes near one', () => {
    const p: Point = [den.minX + half + 60 * MM, den.minY + 600 * MM];
    const g = ghostOf(BARE, sofa, p, opts())!;
    expect(g.label).toContain('in the corner of the Den');
    expect(Math.min(...g.footprint.map((q) => q[0]))).toBeCloseTo(den.minX, -1);
    expect(g.gaps).toHaveLength(1);
  });

  it('else lands its gap from the corner on the grid; turned by hand away from the wall, it stands free', () => {
    const p: Point = [den.minX + half + 900 * MM, den.minY + 600 * MM];
    const g = ghostOf(L1, sofa, p, opts({ tol: 10 * MM }))!;
    const gap = Math.min(...g.footprint.map((q) => q[0])) - den.minX;
    expect(Math.abs(gap / 16_256 - Math.round(gap / 16_256))).toBeLessThan(0.01);
    const turned = ghostOf(L1, sofa, p, opts({ tol: 10 * MM, rotation: 0, turned: true }))!;
    expect(turned.host).toMatchObject({ mode: 'surface', room: 'R6' });
    expect((turned.host as { rotation?: number }).rotation).toBe(0);
  });

  it('puts a free-standing item flush to a face it comes near, each axis by itself', () => {
    const chair = entry('furniture:dining-chair-450');
    const dx = (chair.box.max[0] - chair.box.min[0]) / 2;
    const p: Point = [den.minX + dx + 50 * MM, (den.minY + den.maxY) / 2];
    const g = ghostOf(BARE, chair, p, opts())!;
    // 10 mm off the face, as a backed item's back is.
    expect(Math.min(...g.footprint.map((q) => q[0]))).toBeCloseTo(den.minX + 12_800, -1);
    expect(g.guides.length).toBeGreaterThan(0);
    expect(g.host?.mode).toBe('surface');
  });

  it('puts a window in the wall under the pointer, and says when it would overlap another', () => {
    const win = entry('window:window-casement-30x48');
    const clear = ghostOf(L1, win, [den.maxX + 70 * MM, den.minY + 1_000 * MM], opts())!;
    expect(clear.opening).not.toBeNull();
    expect(clear.problem).toBeUndefined();
    const wall = L1.walls.find((w) => w.id === clear.opening!.wall)!;
    const other = L1.openings.find((o) => o.wall === wall.id)!;
    expect(other).toBeDefined();
    const mid: Point = [(other.start[0] + other.end[0]) / 2, (other.start[1] + other.end[1]) / 2];
    const over = ghostOf(L1, win, mid, opts())!;
    expect(over.problem).toMatch(/overlap/);
    expect(over.blocked).toBe(true);
  });

  it('turns a door round its four hinges and swings with R', () => {
    const door = entry('door:door-interior-swing-32x80');
    const at: Point = [den.maxX + 70 * MM, den.minY + 1_000 * MM];
    const seen = [0, 90, 180, 270].map((r) => ghostOf(L1, door, at, opts({ rotation: r, turned: true }))!.opening!);
    expect(new Set(seen.map((s) => `${s.nearer}/${s.side}`)).size).toBe(4);
  });

  it('keeps to the snap menu: everything off, a sofa near a wall does not back onto it; walls off, neither', () => {
    const p: Point = [(den.minX + den.maxX) / 2, den.minY + 700 * MM];
    const all = { on: true, walls: true, items: true, guides: true, grid: true };
    expect(ghostOf(L1, sofa, p, opts({ snaps: all }))!.label).toContain('south wall');
    expect((ghostOf(L1, sofa, p, opts({ snaps: { ...all, on: false } }))!.host as { rotation?: number }).rotation).toBe(0);
    expect(ghostOf(L1, sofa, p, opts({ snaps: { ...all, walls: false } }))!.label).not.toContain('wall');
  });

  it('puts a tree free on the level, wherever it is', () => {
    const g = ghostOf(L1, entry('landscape:tree-small'), [den.maxX + 3_000 * MM, den.minY], opts())!;
    expect(g.host).toMatchObject({ mode: 'free', level: 'L1' });
    expect(g.label).toBe('Free on the level');
  });

  it('names a wall by the way it is from the room', () => {
    expect(compassOf([0, -1])).toBe('south');
    expect(compassOf([1, 0])).toBe('east');
    expect(compassOf([0.6, 0.8])).toBe('north-east');
    expect(compassOf([0.94, 0.34])).toBeNull();
  });
});

describe('a placement is one batch (FLR-T-18.7)', () => {
  const den = bounds(L1, 'R6');
  const p: Point = [(den.minX + den.maxX) / 2, den.minY + 700 * MM];
  const fileOf = (f: { sha256: string; mediaType: string; byteLength: number; path: string }): StoredFile => ({ sha256: f.sha256, mediaType: f.mediaType, byteLength: f.byteLength, path: `assets/${f.sha256}`, name: null });

  it('places a library sofa: its assets and its element, the applier taking it', () => {
    const sofa = entry('furniture:sofa-2100');
    const item = sofa.source.kind === 'furniture' ? sofa.source.item : null;
    const g = ghostOf(L1, sofa, p, opts())!;
    const batch = batchFor(MODEL, sofa, g, { files: { model: fileOf(item!.model), symbol: fileOf(item!.symbol) } })!;
    const r = commit(batch);
    expect(r.diagnostics).toEqual([]);
    const after = JSON.parse(r.document) as { extensions: { FS_furniture: { collections: { pieces: Record<string, { catalogue?: string; host: { room?: string } }> } } } };
    expect(Object.values(after.extensions.FS_furniture.collections.pieces).filter((x) => x.catalogue === 'sofa-2100' && x.host.room === 'R6').length).toBeGreaterThan(0);
  });

  it('places a window, a receptacle, a tree and a bed', () => {
    const win = entry('window:window-casement-30x48');
    const w = commit(batchFor(MODEL, win, ghostOf(L1, win, [den.maxX + 70 * MM, den.minY + 1_000 * MM], opts())!)!);
    expect(w.diagnostics).toEqual([]);
    expect(Object.keys((JSON.parse(w.document) as { openings: object }).openings).length).toBe(Object.keys(MODEL.document.openings ?? {}).length + 1);
    const plug = entry('device:receptacle');
    expect(commit(batchFor(MODEL, plug, ghostOf(L1, plug, [den.minX + 1_200 * MM, den.minY + 100 * MM], opts())!)!).diagnostics).toEqual([]);
    for (const key of ['landscape:tree-small', 'landscape:bed-1200x2400']) {
      const e = entry(key);
      const r = commit(batchFor(MODEL, e, ghostOf(L1, e, [den.maxX + 4_000 * MM, den.minY - 2_000 * MM], opts({ rotation: 90, turned: true }))!)!);
      expect(r.diagnostics, key).toEqual([]);
    }
  });
});
