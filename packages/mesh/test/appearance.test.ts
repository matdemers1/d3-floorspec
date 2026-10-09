/**
 * FLR-T-12.23: what a house looks like where its document names no material — the room-function
 * palette, by the room each wall face looks into — an arc wall's faces as faces, segment by segment
 * (Core 21.6), and an outdoor room open to the sky drawn without a ceiling. Runs in Node and in
 * Chromium.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { appearanceOf, DEFAULT_COLOURS, loadMesher, paletteFunction, ROOM_PALETTE, surfaceGroups, type Mesher } from '../src/index.js';

const M = 1_280_000;

/**
 * Two levels of one 6 m × 4 m box, each wall drawn clockwise so its left is outside (5.4): the
 * lower level's south wall W4 an arc bowing out by `sagitta`, a room on each level with the
 * functions given, and optionally a hip roof over the upper level.
 */
function house(lower: string, upper: string, options: { sagitta?: number; roof?: boolean } = {}): object {
  const level = (id: string, elevation: number) => ({ building: 'HOUSE', elevation, height: 3 * M });
  const box = (l: string, s: string) => ({
    [`A${s}`]: { level: l, position: [0, 0] },
    [`B${s}`]: { level: l, position: [6 * M, 0] },
    [`C${s}`]: { level: l, position: [6 * M, 4 * M] },
    [`D${s}`]: { level: l, position: [0, 4 * M] },
  });
  const walls = (l: string, s: string) => ({
    [`W1${s}`]: { level: l, start: `A${s}`, end: `D${s}`, type: 'WT' },
    [`W2${s}`]: { level: l, start: `D${s}`, end: `C${s}`, type: 'WT' },
    [`W3${s}`]: { level: l, start: `C${s}`, end: `B${s}`, type: 'WT' },
    [`W4${s}`]: { level: l, start: `B${s}`, end: `A${s}`, type: 'WT' },
  });
  const doc: Record<string, unknown> = {
    floorspec: '0.4',
    project: { name: 'Appearance' },
    buildings: { HOUSE: {} },
    levels: { L1: level('L1', 0), L2: level('L2', 3 * M) },
    types: { WT: { kind: 'wallType', layers: [{ thickness: 150_000, function: 'core' }] } },
    junctions: { ...box('L1', ''), ...box('L2', 'U') },
    walls: { ...walls('L1', ''), ...walls('L2', 'U') },
    rooms: {
      R1: { level: 'L1', anchor: [3 * M, 2 * M], function: lower },
      R2: { level: 'L2', anchor: [3 * M, 2 * M], function: upper },
    },
  };
  if (options.sagitta !== undefined) (doc['walls'] as Record<string, Record<string, unknown>>)['W4']!['arc'] = { sagitta: options.sagitta };
  if (options.roof === true)
    doc['roofs'] = {
      RF: {
        level: 'L2',
        footprint: [
          [0, 0],
          [6 * M, 0],
          [6 * M, 4 * M],
          [0, 4 * M],
        ],
        pitch: { rise: 6, run: 12 },
        overhang: 300_000,
      },
    };
  return doc;
}

function derive(doc: object): { view: FloorspecDocument; derived: Derived } {
  const ev = evaluate(doc);
  expect(ev.valid, JSON.stringify(ev.diagnostics.filter((d) => d.severity === 'error'))).toBe(true);
  return { view: (ev.view ?? ev.document)!, derived: deriveEvaluation(ev) };
}

let mesher: Mesher;
beforeAll(async () => {
  mesher = await loadMesher();
});

describe('the room-function palette', () => {
  it('knows every Core room function, and draws an extension term or none as unspecified', () => {
    for (const fn of ['sleeping', 'bath', 'kitchen', 'living', 'dining', 'office', 'laundry', 'utility', 'storage', 'circulation', 'mechanical', 'garage', 'exterior', 'unspecified'])
      expect(paletteFunction(fn)).toBe(fn);
    expect(paletteFunction('EXT_wellness:sauna')).toBe('unspecified');
    expect(paletteFunction(undefined)).toBe('unspecified');
    // Oak under living rooms and bedrooms; tile in wet rooms; epoxy in a garage; decking outdoors.
    expect(ROOM_PALETTE.living.floorIs).toBe('oak');
    expect(ROOM_PALETTE.sleeping.floorIs).toBe('oak');
    for (const fn of ['bath', 'kitchen', 'laundry'] as const) expect(ROOM_PALETTE[fn].floorIs).toBe('tile');
    expect(ROOM_PALETTE.garage.floorIs).toBe('epoxy');
    expect(ROOM_PALETTE.exterior.floorIs).toBe('decking');
    // Each function's walls a tint of their own, but for those that share the plain warm white.
    const tints = new Set(Object.values(ROOM_PALETTE).map((p) => p.wall));
    expect(tints.size).toBeGreaterThanOrEqual(10);
  });

  it('gives a room with no finishes its function’s floor and ceiling', () => {
    const { view, derived } = derive(house('bath', 'garage'));
    const look = appearanceOf(view, derived);
    expect(look.floor('R1')).toMatchObject({ key: 'floor:bath', color: ROOM_PALETTE.bath.floor });
    expect(look.floor('R2')).toMatchObject({ key: 'floor:garage', color: ROOM_PALETTE.garage.floor });
    expect(look.ceiling('R2')).toMatchObject({ key: 'ceiling:garage', color: ROOM_PALETTE.garage.ceiling });
  });

  it('paints each wall face as the room it looks into: outside the exterior colour, an outdoor room’s walls too', () => {
    const { view, derived } = derive(house('bath', 'exterior', { sagitta: 600_000 }));
    const look = appearanceOf(view, derived);
    // The walls run clockwise round the room: it is on their right, the outside on their left.
    for (const w of ['W1', 'W2', 'W3', 'W4']) {
      expect(look.roomOf(w, 'right'), w).toBe('R1');
      expect(look.roomOf(w, 'left'), w).toBeUndefined();
      expect(look.face(w, 'right'), w).toMatchObject({ key: 'wall:bath', color: ROOM_PALETTE.bath.wall });
      expect(look.face(w, 'left'), w).toMatchObject({ key: 'face:exterior', color: DEFAULT_COLOURS.exterior });
    }
    expect(look.roomOf('W2U', 'right')).toBe('R2');
    expect(look.face('W2U', 'right').color).toBe(DEFAULT_COLOURS.exterior);
  });
});

describe('an arc wall’s faces (FLR-T-12.23, Core 21.6)', () => {
  it('are its faces round the whole curve, with s the distance along the wall; only its top, bottom and ends are the rest', () => {
    const { view, derived } = derive(house('living', 'living', { sagitta: 600_000 }));
    const dw = derived.walls['W4']!;
    expect(dw.polyline!.length).toBeGreaterThan(4);
    const L = dw.length!;
    const part = mesher.meshDerived(view, derived).parts.find((p) => p.kind === 'wall' && p.id === 'W4')!;
    const groups = surfaceGroups(view, derived, part);
    const S = [6 * M, 0];
    const E = [0, 0];
    for (const g of groups.filter((x) => x.surface === null))
      for (let t = 0; t < g.positions.length / 9; t++) {
        const nz = g.normals[9 * t + 2]!;
        const c = [0, 1].map((k) => ((g.positions[9 * t + k]! + g.positions[9 * t + 3 + k]! + g.positions[9 * t + 6 + k]!) / 3) * M);
        const atEnd = Math.min(Math.hypot(c[0]! - S[0]!, c[1]! - S[1]!), Math.hypot(c[0]! - E[0]!, c[1]! - E[1]!)) < 400_000;
        expect(Math.abs(nz) > 0.99 || atEnd, `a rest triangle at ${String(c)} facing ${String(nz)}`).toBe(true);
      }
    const right = groups.find((g) => g.surface?.kind === 'face' && g.surface.side === 'right')!;
    const left = groups.find((g) => g.surface?.kind === 'face' && g.surface.side === 'left')!;
    const sOf = (g: typeof right) => Array.from({ length: g.st.length / 2 }, (_, i) => g.st[2 * i]!);
    // Right face s = station + along: 0 at the start, the wall's length at its end (give or take the face's offset at the joints).
    expect(Math.min(...sOf(right))).toBeLessThan(0.02 * L);
    expect(Math.max(...sOf(right))).toBeGreaterThan(0.95 * L);
    expect(Math.max(...sOf(right))).toBeLessThan(1.05 * L);
    // Left face s runs the other way.
    expect(Math.max(...sOf(left))).toBeGreaterThan(-0.02 * L);
    expect(Math.min(...sOf(left))).toBeLessThan(-0.95 * L);
  });
});

describe('an outdoor room open to the sky (FLR-T-12.23)', () => {
  const ceilings = (doc: object): string[] => {
    const { view, derived } = derive(doc);
    return mesher
      .meshDerived(view, derived)
      .parts.filter((p) => p.kind === 'ceiling')
      .map((p) => p.id)
      .sort();
  };

  it('has no ceiling when nothing is over it', () => {
    expect(ceilings(house('living', 'exterior'))).toEqual(['R1']);
  });

  it('keeps its ceiling under a room above, or under a roof', () => {
    expect(ceilings(house('exterior', 'living'))).toEqual(['R1', 'R2']);
    expect(ceilings(house('living', 'exterior', { roof: true }))).toEqual(['R1', 'R2']);
  });

  it('is only an outdoor room’s rule: any other room keeps its ceiling with nothing over it', () => {
    expect(ceilings(house('living', 'sleeping'))).toEqual(['R1', 'R2']);
  });
});
