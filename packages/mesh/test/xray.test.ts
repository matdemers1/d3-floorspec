/**
 * FLR-T-14.5: X-ray's derivation — studs at the spacing, an opening framed, the layer stack as thick
 * as the wall, plumbing to its stack, a circuit from its panel along the walls to its devices, ducts,
 * and the same bytes every time.
 */
import { describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, type Derived, type FloorspecDocument } from '@floorspec/engine';
import courtyard from './fixtures/courtyard-kitchen-mudroom.floorspec.json' with { type: 'json' };
import { DEFAULT_STUD_SPACING, RUN_HEIGHT, studLayout, xrayMeshes, xrayPlan, type XrayMesh } from '../src/index.js';
import { xrayHouse } from './houses.js';
import { xrayDigest } from './digest.js';

const IN = 32_512;

function derive(doc: object): { doc: FloorspecDocument; derived: Derived } {
  const ev = evaluate(JSON.stringify(doc), {});
  expect(ev.valid, JSON.stringify(ev.diagnostics.filter((d) => d.severity === 'error'))).toBe(true);
  return { doc: (ev.view ?? ev.document)!, derived: deriveEvaluation(ev) };
}

/** Six times the signed volume a closed triangle list holds: positive when its faces point out. */
function volume6(positions: Float32Array): number {
  let v = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from(positions.subarray(i, i + 9)) as [number, number, number, number, number, number, number, number, number];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v;
}

describe('studs (FLR-T-14.5)', () => {
  // A 12′ wall, 8′ tall, 2x studs 16″ on centre, a 3′ window from 4′ along it, its sill at 3′ and head at 7′.
  const window = { id: 'O', t0: 48 * IN, t1: 84 * IN, sill: 36 * IN, head: 84 * IN, header: (37 * IN) / 4 };
  const members = studLayout(0, 144 * IN, 0, 96 * IN, (3 * IN) / 2, DEFAULT_STUD_SPACING, [window]);
  const of = (part: string) => members.filter((m) => m.part === part);

  it('stands a stud at each end and one every 16″ on centre, but where the window is', () => {
    const studs = of('stud').map((m) => (m.t0 + m.t1) / 2 / IN).sort((a, b) => a - b);
    // The layout 16, 32 … 128; 48, 64 and 80 fall in the window's king-to-king zone (45″ to 87″).
    expect(studs).toEqual([0.75, 16, 32, 96, 112, 128, 143.25]);
    expect(DEFAULT_STUD_SPACING).toBe(16 * IN);
    for (const m of of('stud')) expect([m.z0, m.z1]).toEqual([1.5 * IN, 93 * IN]);
  });

  it('frames the window: kings and jacks each side, a header, a rough sill and cripples under it', () => {
    expect(of('king').map((m) => [m.t0 / IN, m.t1 / IN])).toEqual([[45, 46.5], [85.5, 87]]);
    expect(of('jack').map((m) => [m.t0 / IN, m.t1 / IN, m.z1 / IN])).toEqual([[46.5, 48, 84], [84, 85.5, 84]]);
    // Two plies of 2x10 over the head, up to the top plates (9¼″ would reach past them).
    expect(of('header').map((m) => [m.t0 / IN, m.t1 / IN, m.z0 / IN, m.z1 / IN])).toEqual([[46.5, 85.5, 84, 93]]);
    expect(of('sill').map((m) => [m.t0 / IN, m.t1 / IN, m.z0 / IN, m.z1 / IN])).toEqual([[48, 84, 34.5, 36]]);
    // Where the layout falls inside the opening (64 and 80″): cripples under the sill, none over a header that meets the plates.
    expect(of('cripple').map((m) => [(m.t0 + m.t1) / 2 / IN, m.z0 / IN, m.z1 / IN])).toEqual([[64, 1.5, 34.5], [80, 1.5, 34.5]]);
  });

  it('lays one bottom plate and a double top plate, the bottom cut out under a door', () => {
    expect(of('plate').map((m) => [m.t0 / IN, m.t1 / IN, m.z0 / IN, m.z1 / IN])).toEqual([[0, 144, 0, 1.5], [0, 144, 93, 96]]);
    const door = studLayout(0, 144 * IN, 0, 96 * IN, (3 * IN) / 2, DEFAULT_STUD_SPACING, [{ id: 'D', t0: 24 * IN, t1: 60 * IN, sill: 0, head: 80 * IN, header: (37 * IN) / 4 }]);
    expect(door.filter((m) => m.part === 'plate' && m.z0 === 0).map((m) => [m.t0 / IN, m.t1 / IN])).toEqual([[0, 24], [60, 144]]);
    expect(door.some((m) => m.part === 'sill')).toBe(false);
    // Over a door's header: cripples where the layout falls (32 and 48″), up to the top plates.
    expect(door.filter((m) => m.part === 'cripple').map((m) => [(m.t0 + m.t1) / 2 / IN, m.z0 / IN, m.z1 / IN])).toEqual([[32, 89.25, 93], [48, 89.25, 93]]);
  });
});

describe('the X-ray house (FLR-T-14.5)', () => {
  const { doc, derived } = derive(xrayHouse());
  const plan = xrayPlan(doc, derived);

  it('frames each wall from its layers: as thick as the wall, studs at 16″ by default, batts in an insulated core', () => {
    for (const [id, w] of Object.entries(plan.walls)) {
      const d = derived.walls[id]!;
      // The faces' separation, square to the wall.
      const wall = doc.walls![id]!;
      const [a, b] = [doc.junctions![wall.start]!.position, doc.junctions![wall.end]!.position];
      const len = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
      const across = Math.abs(((b[0] - a[0]) * (d.startLeft[1] - d.startRight[1]) - (b[1] - a[1]) * (d.startLeft[0] - d.startRight[0])) / len);
      expect(w.thickness, id).toBe(w.layers.reduce((s, l) => s + l.thickness, 0));
      expect(Math.abs(w.thickness - across), id).toBeLessThan(2);
      expect(w.framing).toMatchObject({ system: 'studs', spacing: 16 * IN, source: 'default', member: { width: 1.5 * IN, depth: 5.5 * IN } });
      expect(w.insulated, id).toBe(true);
      expect(w.batts, id).toBeGreaterThan(0);
    }
    // The south wall's window and the west wall's door, each framed.
    expect(plan.walls['WS']).toMatchObject({ openings: ['O1'], kings: 2, jacks: 2, headers: 1 });
    expect(plan.walls['WW']).toMatchObject({ openings: ['O2'], kings: 2, jacks: 2, headers: 1 });
    expect(plan.walls['WN']).toMatchObject({ openings: [], kings: 0, jacks: 0, headers: 0, cripples: 0 });
    // Sheathing on the substrate layer, batts in the core's cavities.
    expect(plan.pieces.filter((p) => p.part === 'sheathing' && p.owner === 'WN')).toHaveLength(1);
    expect(plan.counts.studs).toBe(Object.values(plan.walls).reduce((s, w) => s + w.studs + w.kings + w.jacks + w.cripples, 0));
  });

  it('takes the spacing and the member from FS_structural when a wall records its framing', () => {
    const house = xrayHouse() as { walls: Record<string, Record<string, unknown>>; extensionsUsed: Record<string, string> };
    house.walls['WN']!['extensions'] = { FS_structural: { framing: { material: 'wood', system: 'studs', member: { designation: '2x6', width: 48768, depth: 178816 }, spacing: 24 * IN } } };
    house.extensionsUsed['FS_structural'] = '0.1.0';
    const { doc: d2, derived: v2 } = derive(house);
    const wn = xrayPlan(d2, v2).walls['WN']!;
    expect(wn.framing).toMatchObject({ system: 'studs', spacing: 24 * IN, source: 'FS_structural', member: { designation: '2x6' } });
    expect(wn.studs).toBeLessThan(plan.walls['WN']!.studs);
  });

  it('runs a circuit from its panel along the walls at 7′6″, with a drop to each device', () => {
    const c = plan.runs.find((r) => r.id === 'C1')!;
    expect(c).toMatchObject({ system: 'electrical', kind: 'circuit', amps: 20, walls: ['WE', 'WN', 'WW'] });
    const pts = c.points;
    // From the panel (5′ up the west wall) to the last receptacle (16″ up the east wall).
    expect(pts[0]![2]).toBe(60 * IN);
    expect(Math.abs(pts[0]![0])).toBeLessThan(IN);
    expect(pts[pts.length - 1]![2]).toBe(16 * IN);
    expect(Math.abs(pts[pts.length - 1]![0] - 192 * IN)).toBeLessThan(IN);
    expect(RUN_HEIGHT).toBe(90 * IN);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [p, q] = [pts[i]!, pts[i + 1]!];
      const vertical = p[0] === q[0] && p[1] === q[1];
      // Square: up and down, or level — at the run's height, or across the ceiling to the light.
      if (!vertical) {
        expect(p[2], `segment ${String(i)}`).toBe(q[2]);
        expect([90 * IN, 96 * IN]).toContain(p[2]);
      }
      // At the run's height, inside a wall: within its half thickness of a location line.
      if (!vertical && p[2] === 90 * IN) {
        const inWall = [p, q].every((r) => Math.min(Math.abs(r[0]), Math.abs(r[0] - 192 * IN), Math.abs(r[1]), Math.abs(r[1] - 144 * IN)) < 3.3 * IN);
        expect(inWall, `segment ${String(i)}`).toBe(true);
      }
    }
    // A box behind each receptacle on the east wall.
    expect(plan.walls['WE']!.devices).toEqual(['RA', 'RB']);
    expect(plan.pieces.filter((p) => p.system === 'electrical' && p.part === 'box')).toHaveLength(2);
    expect(plan.counts.circuits).toBe(1);
  });

  it('pipes each fixture: cold and hot up its wall from under the floor, its drain to the stack, its vent up the wall', () => {
    const lav = (kind: string) => plan.runs.find((r) => r.id === `LAV:${kind}`)!;
    for (const kind of ['cold', 'hot']) {
      const r = lav(kind);
      expect(r.system).toBe('supply');
      expect(r.walls).toContain('WS');
      // Ends at the lavatory's stub-out, 21″ up the south wall.
      expect(r.points[r.points.length - 1]![2]).toBe(21 * IN);
      expect(Math.abs(r.points[r.points.length - 1]![1])).toBeLessThan(IN);
      // Under the floor between.
      expect(r.points.some((p) => p[2] === -3 * IN)).toBe(true);
    }
    expect(plan.runs.find((r) => r.id === 'WC:cold')).toBeDefined();
    expect(plan.runs.find((r) => r.id === 'WC:hot')).toBeUndefined();
    const stack = plan.runs.find((r) => r.id === 'K1')!;
    expect(stack.kind).toBe('stack');
    const drain = lav('drain');
    // From 18″ up the wall to the stack, under the floor.
    expect(drain.points[0]![2]).toBe(18 * IN);
    const end = drain.points[drain.points.length - 1]!;
    expect([end[0], end[1]]).toEqual([stack.points[0]![0], stack.points[0]![1]]);
    expect(lav('vent').points[lav('vent').points.length - 1]![2]).toBe(96 * IN);
    expect(plan.walls['WS']).toMatchObject({ drain: ['K1', 'LAV:drain', 'WC:drain'], vent: ['LAV:vent', 'WC:vent'] });
    expect(plan.counts).toMatchObject({ supply: 3, drain: 2, vents: 2, stacks: 1 });
  });

  it('ducts each terminal from its furnace: a supply over the ceiling, a return under the floor', () => {
    const s = plan.runs.find((r) => r.id === 'S1:duct')!;
    const t = plan.runs.find((r) => r.id === 'T1:duct')!;
    expect(s.kind).toBe('supply');
    expect(s.points.some((p) => p[2] === 96 * IN + 4 * IN)).toBe(true);
    expect(s.points[s.points.length - 1]![2]).toBe(96 * IN);
    expect(t.kind).toBe('return');
    expect(t.points.some((p) => p[2] === -5 * IN)).toBe(true);
    expect(plan.counts.ducts).toBe(2);
  });

  it('meshes every system as closed, outward-facing solids in metres about the origin', () => {
    const meshes = xrayMeshes(plan, [96 * IN, 72 * IN, 0]);
    expect([...new Set(meshes.map((m) => m.system))]).toEqual(['framing', 'insulation', 'supply', 'drain', 'electrical', 'ducts']);
    for (const m of meshes) {
      expect(m.positions.length % 9).toBe(0);
      expect(m.normals.length).toBe(m.positions.length);
      expect(m.positions.every(Number.isFinite)).toBe(true);
      // Within the house, about its middle: metres, not base units.
      expect(m.positions.every((v) => Math.abs(v) < 10)).toBe(true);
      expect(volume6(m.positions), `${m.system} ${m.style}`).toBeGreaterThan(0);
    }
    expect(meshes.find((m) => m.system === 'drain' && m.style === 'dash')).toBeDefined();
    expect(meshes.find((m) => m.system === 'insulation')?.style).toBe('sheet');
  });
});

describe('determinism (FLR-T-14.5)', () => {
  it('derives the same plan and the same bytes from the same document, every time', () => {
    for (const source of [xrayHouse(), courtyard]) {
      const a = derive(source);
      const b = derive(JSON.parse(JSON.stringify(source)) as object);
      const pa = xrayPlan(a.doc, a.derived);
      const pb = xrayPlan(b.doc, b.derived);
      expect(JSON.stringify(pa)).toBe(JSON.stringify(pb));
      const ma: XrayMesh[] = xrayMeshes(pa, [1_000, 2_000, 0]);
      expect(xrayDigest(ma)).toBe(xrayDigest(xrayMeshes(pb, [1_000, 2_000, 0])));
      expect(ma.length).toBeGreaterThan(0);
    }
  });
});
