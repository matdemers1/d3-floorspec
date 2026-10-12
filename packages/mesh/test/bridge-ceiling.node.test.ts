/**
 * A double-height room's ceiling stops where a bridge stands in it (FLR-T-12.37). The Courtyard
 * House's great room has its ceiling at the upper level's ceiling line — the bridge's ceiling's
 * elevation — so over the bridge the two ceilings were drawn in one plane, a cedar one and a
 * painted one, and fought for depth in stripes. A ceiling is now not drawn inside a room of a
 * higher level whose floor it is above: there the room below sees that floor drawn down to it
 * (FLR-T-12.32). Where it is not above that floor — a vault's low sides, a tray's border, every
 * ordinary storey — it is drawn as before. Every property of the meshed house holds (props.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, type FloorspecDocument } from '@floorspec/engine';
import { loadKernel, type Kernel } from '../src/kernel.js';
import { loadMesher, type HouseMesh, type MeshPart, type Mesher } from '../src/index.js';
import { checkHouse, hits } from './props.js';

const M = 1_280_000;
const m = (x: number): number => Math.round(x * M);

/**
 * Two levels, 8 m by 6 m. Below, 3 m high with a 2.7 m ceiling line: a double-height great room
 * (x 0–4 m) whose ceiling is `ceiling`, and a kitchen (x 4–8). Above, 3 m up and 2.7 m to its
 * ceiling — 5.7 m, the great room's ceiling by default: a bridge along the great room's west side
 * (x 0–1.5) behind a guard wall, the void past it, and a bedroom over the kitchen.
 */
function house(ceiling: object = { kind: 'flat', height: m(5.7) }, below: { ceilingHeight?: number } = { ceilingHeight: m(2.7) }): FloorspecDocument {
  const j = (level: string, x: number, y: number) => ({ level, position: [m(x), m(y)] });
  const w = (level: string, start: string, end: string) => ({ level, start, end, type: 'WT' });
  return {
    floorspec: '0.3',
    project: { name: 'Bridge in the plane of the great room’s ceiling' },
    buildings: { H: {} },
    levels: {
      L1: { building: 'H', elevation: 0, height: m(3), ...below },
      L2: { building: 'H', elevation: m(3), height: m(2.7) },
    },
    types: { WT: { kind: 'wallType', layers: [{ thickness: 128_000, function: 'core' }] } },
    junctions: {
      J1: j('L1', 0, 0), J2: j('L1', 4, 0), J3: j('L1', 8, 0), J4: j('L1', 8, 6), J5: j('L1', 4, 6), J6: j('L1', 0, 6),
      K1: j('L2', 0, 0), K2: j('L2', 1.5, 0), K3: j('L2', 4, 0), K4: j('L2', 8, 0), K5: j('L2', 8, 6), K6: j('L2', 4, 6), K7: j('L2', 1.5, 6), K8: j('L2', 0, 6),
    },
    walls: {
      A1: w('L1', 'J1', 'J2'), A2: w('L1', 'J2', 'J3'), A3: w('L1', 'J3', 'J4'), A4: w('L1', 'J4', 'J5'), A5: w('L1', 'J5', 'J6'), A6: w('L1', 'J6', 'J1'), A7: w('L1', 'J2', 'J5'),
      B1: w('L2', 'K1', 'K2'), B2: w('L2', 'K2', 'K3'), B3: w('L2', 'K3', 'K4'), B4: w('L2', 'K4', 'K5'), B5: w('L2', 'K5', 'K6'), B6: w('L2', 'K6', 'K7'), B7: w('L2', 'K7', 'K8'), B8: w('L2', 'K8', 'K1'),
      B9: w('L2', 'K2', 'K7'), B10: w('L2', 'K3', 'K6'),
    },
    rooms: {
      GREAT: { level: 'L1', anchor: [m(2), m(3)], function: 'living', ceiling, ceilingFinish: 'CEDAR' },
      KIT: { level: 'L1', anchor: [m(6), m(3)], function: 'kitchen' },
      BR: { level: 'L2', anchor: [m(0.75), m(3)], function: 'circulation' },
      BED: { level: 'L2', anchor: [m(6), m(3)], function: 'sleeping' },
    },
    materials: { CEDAR: { color: '#b07a4f' } },
  } as unknown as FloorspecDocument;
}

let kernel: Kernel;
let mesher: Mesher;
beforeAll(async () => {
  kernel = await loadKernel();
  mesher = await loadMesher();
});

function meshed(doc: FloorspecDocument): { mesh: HouseMesh; part: (key: string) => MeshPart } {
  const ev = evaluate(doc);
  expect(ev.valid, JSON.stringify(ev.diagnostics.filter((d) => d.severity === 'error'))).toBe(true);
  const derived = deriveEvaluation(ev);
  const d = (ev.view ?? ev.document)!;
  const mesh = mesher.meshDerived(d, derived, { stats: true });
  checkHouse(kernel, d, derived, mesh, 'bridge ceiling house');
  return {
    mesh,
    part: (key) => {
      const p = mesh.parts.find((q) => q.key === key);
      expect(p, key).toBeDefined();
      return p!;
    },
  };
}

/** How many triangles of a part a vertical segment at plan (x, y), metres, meets between z0 and z1. */
const up = (p: MeshPart, x: number, y: number, z0: number, z1: number): number => hits(p.mesh, [x, y, z0], [x, y, z1]);

describe('a double-height room’s ceiling, where a bridge stands in it', () => {
  it('is not drawn in the plane of the bridge’s ceiling: the bridge has one ceiling over it', () => {
    const { part } = meshed(house());
    const [great, bridge] = [part('ceiling:GREAT'), part('ceiling:BR')];
    // Looking up from the bridge, at eye height: its own ceiling, and nothing of the great room's.
    expect(up(bridge, 0.75, 3, 4.6, 7), 'the bridge’s ceiling').toBe(1);
    expect(up(great, 0.75, 3, 4.6, 7), 'the great room’s ceiling, over the bridge').toBe(0);
    expect(up(great, 1.2, 0.4, 4.6, 7), 'the great room’s ceiling, over the bridge’s corner').toBe(0);
    // Past the guard wall, over the void, the great room's ceiling is all there.
    expect(up(great, 2.75, 3, 4.6, 7), 'the great room’s ceiling, over the void').toBe(1);
    expect(up(great, 3.9, 5.9, 4.6, 7), 'the great room’s ceiling, in its far corner').toBe(1);
    expect(great.bbox.min[0], 'it starts at the bridge’s guard wall').toBe(m(1.5) - 64_000);
    expect(great.bbox.max).toEqual([m(4) - 64_000, m(6) - 64_000, m(5.7)]);
  });

  it('is not drawn over the bridge’s ceiling either, where it is higher', () => {
    const { part } = meshed(house({ kind: 'flat', height: m(6.3) }));
    expect(up(part('ceiling:GREAT'), 0.75, 3, 4.6, 8), 'the great room’s ceiling, over the bridge').toBe(0);
    expect(up(part('ceiling:GREAT'), 2.75, 3, 4.6, 8), 'the great room’s ceiling, over the void').toBe(1);
  });

  it('is drawn where it is below the bridge’s floor: a vault’s low side', () => {
    // A vault along x = 3 m at 5.7 m, falling 1 in 1: 3 m (the bridge's floor) at 2.7 m from the
    // ridge, x = 0.3 m — over the bridge, above its floor east of that and below it west of it.
    const { part } = meshed(house({ kind: 'vaulted', height: m(5.7), ridge: [[m(3), 0], [m(3), m(6)]], pitch: { rise: 12, run: 12 } }));
    const great = part('ceiling:GREAT');
    expect(up(great, 1, 3, 3.05, 8), 'the vault over the bridge, above its floor').toBe(0);
    expect(up(great, 0.15, 3, 1, 3), 'the vault’s low side, under the bridge’s floor').toBe(1);
    expect(up(great, 2.75, 3, 1, 8), 'the vault over the void').toBe(1);
    // Its low side is all there: from the west wall's face, 2.95 m from the ridge, 2.75 m up.
    expect(great.bbox.min[0]).toBe(64_000);
    expect(great.bbox.min[2]).toBe(m(5.7) - (m(3) - 64_000));
  });

  it('keeps a tray’s border where only its centre is above the bridge’s floor, and its step where its centre is', () => {
    // A border 2.9 m up, under the bridge's floor; the centre 2 m deeper, 0.6 m in from the walls.
    const { part } = meshed(house({ kind: 'tray', height: m(2.9), border: m(0.6), depth: m(2) }));
    const great = part('ceiling:GREAT');
    expect(up(great, 0.3, 3, 1, 8), 'the border under the bridge').toBe(1);
    expect(up(great, 1, 3, 1, 8), 'the centre, over the bridge').toBe(0);
    expect(up(great, 2.75, 3, 1, 8), 'the centre, over the void').toBe(1);
    // The step stands on the centre's own edges only: none where the bridge's guard wall cuts it, at x = 1.5 m.
    const P = great.mesh.positions;
    const xs = new Set<number>();
    for (let i = 0; i < P.length; i += 3) xs.add(Math.round(P[i]! * M));
    expect([...xs].filter((x) => x > m(0.7) && x < m(1.7)), 'no point of it over the bridge but its edge').toEqual([m(1.5) - 64_000]);
  });

  it('leaves an ordinary storey’s ceiling whole, at the floor over it or below it', () => {
    // With no ceiling line of its own, the level below's ceilings are at the upper floor's top.
    for (const doc of [house(), house(undefined, {})]) {
      const kit = meshed(doc).part('ceiling:KIT');
      expect(up(kit, 6, 3, 1, 4), 'the kitchen’s ceiling, under the bedroom').toBe(1);
      expect(kit.bbox.min.slice(0, 2)).toEqual([m(4) + 64_000, 64_000]);
    }
  });
});
