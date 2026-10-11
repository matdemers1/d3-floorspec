/**
 * Upper floors drawn down to the ceiling below (FLR-T-12.32): a floor that declares no thickness on
 * a level with a level below is a solid from its top to 1/16 in over the ceiling under it — the
 * level below's ceiling line, or a lower room's higher ceiling, never a double-height room's — with
 * its underside the ceiling of the room it covers most and its edges the structure's; a surface
 * facing both ways where that leaves no depth; a declared thickness wins; and a doorway's threshold
 * goes down with its room's floor. Every property of the meshed house holds (props.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { loadKernel, type Kernel } from '../src/kernel.js';
import { appearanceOf, DEFAULT_COLOURS, loadMesher, ROOM_PALETTE, surfaceGroups, type HouseMesh, type MeshPart, type Mesher } from '../src/index.js';
import { PLENUM_GAP } from '../src/rooms.js';
import { checkHouse } from './props.js';

const M = 1_280_000;
const m = (x: number): number => Math.round(x * M);

/**
 * Two levels, 8 m by 6 m. Below: a double-height great room (x 0–4 m, its ceiling 5.4 m up), a
 * kitchen (x 4–8, y 0–3) under the level's 2.7 m ceiling line and a den (y 3–6) with a 2.85 m
 * ceiling. Above, 3 m up and with no floor thickness: a bridge along the great room's west side
 * (x 0–1.5), open to the great room past its guard wall, and two bedrooms over the kitchen and the
 * den, a door between them.
 */
function house(): FloorspecDocument & Record<string, unknown> {
  const j = (level: string, x: number, y: number) => ({ level, position: [m(x), m(y)] });
  const w = (level: string, start: string, end: string) => ({ level, start, end, type: 'WT' });
  return {
    floorspec: '0.3',
    project: { name: 'Bridge over a great room' },
    buildings: { H: {} },
    levels: {
      L1: { building: 'H', elevation: 0, height: m(3), ceilingHeight: m(2.7) },
      L2: { building: 'H', elevation: m(3), height: m(2.7) },
    },
    types: {
      WT: { kind: 'wallType', layers: [{ thickness: 128_000, function: 'core' }] },
      DT: { kind: 'doorType', width: m(0.9), height: m(2.1) },
    },
    junctions: {
      J1: j('L1', 0, 0), J2: j('L1', 4, 0), J3: j('L1', 8, 0), J4: j('L1', 8, 3), J5: j('L1', 8, 6), J6: j('L1', 4, 6), J7: j('L1', 0, 6), J8: j('L1', 4, 3),
      K1: j('L2', 0, 0), K2: j('L2', 1.5, 0), K3: j('L2', 4, 0), K4: j('L2', 8, 0), K5: j('L2', 8, 3), K6: j('L2', 8, 6), K7: j('L2', 4, 6), K8: j('L2', 1.5, 6), K9: j('L2', 0, 6), K10: j('L2', 4, 3),
    },
    walls: {
      A1: w('L1', 'J1', 'J2'), A2: w('L1', 'J2', 'J3'), A3: w('L1', 'J3', 'J4'), A4: w('L1', 'J4', 'J5'), A5: w('L1', 'J5', 'J6'), A6: w('L1', 'J6', 'J7'), A7: w('L1', 'J7', 'J1'),
      A8: w('L1', 'J2', 'J8'), A9: w('L1', 'J8', 'J6'), A10: w('L1', 'J8', 'J4'),
      B1: w('L2', 'K1', 'K2'), B2: w('L2', 'K2', 'K3'), B3: w('L2', 'K3', 'K4'), B4: w('L2', 'K4', 'K5'), B5: w('L2', 'K5', 'K6'), B6: w('L2', 'K6', 'K7'), B7: w('L2', 'K7', 'K8'), B8: w('L2', 'K8', 'K9'), B9: w('L2', 'K9', 'K1'),
      B10: w('L2', 'K2', 'K8'), B11: w('L2', 'K3', 'K10'), B12: w('L2', 'K10', 'K7'), B13: w('L2', 'K10', 'K5'),
    },
    openings: { DR: { wall: 'B13', offset: m(1.5), fill: 'DT' } },
    rooms: {
      GREAT: { level: 'L1', anchor: [m(2), m(3)], function: 'living', ceiling: { kind: 'flat', height: m(5.4) }, ceilingFinish: 'CEDAR' },
      KIT: { level: 'L1', anchor: [m(6), m(1.5)], function: 'kitchen' },
      DEN: { level: 'L1', anchor: [m(6), m(4.5)], function: 'office', ceiling: { kind: 'flat', height: m(2.85) } },
      BR: { level: 'L2', anchor: [m(0.75), m(3)], function: 'circulation', floorFinish: 'OAK' },
      U1: { level: 'L2', anchor: [m(6), m(1.5)], function: 'sleeping' },
      U2: { level: 'L2', anchor: [m(6), m(4.5)], function: 'sleeping' },
    },
    materials: { CEDAR: { color: '#b07a4f' }, OAK: { color: '#c8b391' } },
  } as unknown as FloorspecDocument & Record<string, unknown>;
}

let kernel: Kernel;
let mesher: Mesher;
beforeAll(async () => {
  kernel = await loadKernel();
  mesher = await loadMesher();
});

function meshed(doc: object): { doc: FloorspecDocument; derived: Derived; mesh: HouseMesh; part: (key: string) => MeshPart } {
  const ev = evaluate(doc);
  expect(ev.valid, JSON.stringify(ev.diagnostics.filter((d) => d.severity === 'error'))).toBe(true);
  const derived = deriveEvaluation(ev);
  const d = (ev.view ?? ev.document)!;
  const mesh = mesher.meshDerived(d, derived, { stats: true });
  checkHouse(kernel, d, derived, mesh, 'bridge house');
  return {
    doc: d,
    derived,
    mesh,
    part: (key) => {
      const p = mesh.parts.find((q) => q.key === key);
      expect(p, key).toBeDefined();
      return p!;
    },
  };
}

const LINE = m(2.7);
const TOP = m(3);

describe('an upper floor with no thickness, drawn down to the ceiling below', () => {
  it('goes down to just over the level below’s ceiling line, or a lower room’s higher ceiling', () => {
    const { part } = meshed(house());
    // Over the double-height great room (its ceiling above the floor): as deep as the line; its underside the great room's ceiling.
    expect(part('floor:BR').plenum).toEqual({ bottom: LINE + PLENUM_GAP, room: 'GREAT' });
    expect(part('floor:U1').plenum).toEqual({ bottom: LINE + PLENUM_GAP, room: 'KIT' });
    // Over the den, whose ceiling is higher than its level's line: never into the den.
    expect(part('floor:U2').plenum).toEqual({ bottom: m(2.85) + PLENUM_GAP, room: 'DEN' });
    for (const key of ['floor:BR', 'floor:U1', 'floor:U2']) {
      const p = part(key);
      expect([p.closed, p.facing, p.bbox.min[2], p.bbox.max[2]], key).toEqual([true, undefined, p.plenum!.bottom, TOP]);
    }
    // The lowest level's floors are as they were: surfaces facing up.
    for (const key of ['floor:GREAT', 'floor:KIT', 'floor:DEN']) expect([part(key).closed, part(key).facing, part(key).plenum], key).toEqual([false, 'up', undefined]);
  });

  it('takes its doorways’ thresholds down with it', () => {
    const { mesh, part } = meshed(house());
    const ts = mesh.parts.filter((p) => p.kind === 'threshold' && p.id === 'DR');
    expect(ts.map((t) => t.threshold!.room).sort()).toEqual(['U1', 'U2']);
    for (const t of ts) expect(t.plenum, t.key).toEqual(part(`floor:${t.threshold!.room}`).plenum);
  });

  it('is a surface facing both ways where there is no depth to fill', () => {
    const doc = house();
    delete (doc.levels as Record<string, { ceilingHeight?: number }>)['L1']!.ceilingHeight;
    const { part } = meshed(doc);
    // The level below's ceiling line is its height: the upper floor's own top. The bottom is never
    // under that line — not even over the den, whose own ceiling is lower.
    for (const key of ['floor:BR', 'floor:U1', 'floor:U2']) {
      const p = part(key);
      expect([p.closed, p.facing, p.plenum?.bottom], key).toEqual([false, 'both', TOP]);
      // Its triangles face up and down, half and half.
      const P = p.mesh.positions;
      const I = p.mesh.indices;
      let up = 0;
      let down = 0;
      for (let t = 0; t < I.length; t += 3) {
        const [a, b, c] = [I[t]!, I[t + 1]!, I[t + 2]!];
        const nz = (P[3 * b]! - P[3 * a]!) * (P[3 * c + 1]! - P[3 * a + 1]!) - (P[3 * b + 1]! - P[3 * a + 1]!) * (P[3 * c]! - P[3 * a]!);
        if (nz > 0) up++;
        else if (nz < 0) down++;
      }
      expect([up, down], key).toEqual([I.length / 6, I.length / 6]);
    }
    expect(part('floor:U2').plenum).toEqual({ bottom: TOP, room: 'DEN' });
  });

  it('keeps a declared thickness', () => {
    const doc = house();
    (doc.rooms as unknown as Record<string, Record<string, unknown>>)['U2']!['floor'] = { thickness: m(0.3) };
    const { derived, part } = meshed(doc);
    const p = part('floor:U2');
    expect([p.closed, p.plenum, p.bbox.min[2]]).toEqual([true, undefined, derived.floors!['U2']!.bottom]);
  });

  it('is laid out as its floor, the ceiling of the room below and the structure’s edges', () => {
    const { doc, derived, mesh, part } = meshed(house());
    const groups = surfaceGroups(doc, derived, part('floor:BR'), mesh.origin);
    const by = (pred: (g: (typeof groups)[number]) => boolean) => groups.filter(pred);
    const [top] = by((g) => g.surface?.kind === 'floor');
    const [under] = by((g) => g.plenum === 'underside');
    const [edge] = by((g) => g.plenum === 'edge');
    expect([top?.surface, top?.material]).toEqual([{ kind: 'floor', room: 'BR' }, 'OAK']);
    // The underside is the great room's ceiling, its finish and its coordinates (18.3: −x, y).
    expect([under?.surface, under?.material]).toEqual([{ kind: 'ceiling', room: 'GREAT' }, 'CEDAR']);
    for (let i = 0; i < under!.st.length / 2; i++) expect(under!.st[2 * i]).toBeCloseTo(-(under!.positions[3 * i]! * M + mesh.origin[0]), -1);
    for (let k = 2; k < under!.normals.length; k += 3) expect(under!.normals[k]).toBeLessThan(-0.98);
    expect([edge?.surface, edge?.material]).toEqual([null, null]);
    expect(groups).toHaveLength(3);
    // Where nothing names a material: the room below's ceiling, else a plain ceiling; the edges the structure's band.
    const look = appearanceOf(doc, derived);
    expect(look.plenum('underside', 'KIT').color).toBe(ROOM_PALETTE.kitchen.ceiling);
    expect(look.plenum('underside', undefined).color).toBe(DEFAULT_COLOURS.ceiling);
    expect(look.plenum('edge', 'KIT')).toMatchObject({ key: 'floorEdge', color: DEFAULT_COLOURS.floorEdge });
  });
});
