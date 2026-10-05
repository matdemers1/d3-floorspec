/**
 * Texture space on meshed parts (Core 0.3, 18.3; FLR-T-8.2): every vertex of a wall's face, of a
 * region of it, of a floor and of a ceiling carries the surface coordinates the engine's exact
 * `surfaceST` defines — on an oblique wall, on both faces, region-anchored — the groups partition
 * the part, a region is cut where an opening is, and tile coordinates follow size, offset and
 * rotation. Runs in Node and in Chromium.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, surfaceST, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { loadMesher, surfaceGroups, tileCoordinates, type HouseMesh, type MeshPart, type Mesher, type SurfaceGroup } from '../src/index.js';

const IN = 32_512;

/**
 * A four-walled kitchen whose east wall W2 runs obliquely (J2 → J3), counter-clockwise, so the room
 * is on each wall's left. W2 has a backsplash region on each face and a window through the right
 * one; the room's walls are painted, its floor oak, its ceiling plaster.
 */
const HOUSE = {
  floorspec: '0.3',
  project: { name: 'Oblique kitchen' },
  buildings: { B1: {} },
  levels: { L1: { building: 'B1', elevation: 0, height: 3_456_000 } },
  types: {
    WT: { kind: 'wallType', layers: [{ thickness: 128_000, function: 'core' }] },
    W36: { kind: 'windowType', width: 36 * IN, height: 36 * IN, sill: 42 * IN },
  },
  junctions: {
    J1: { level: 'L1', position: [0, 0] },
    J2: { level: 'L1', position: [3_840_000, 0] },
    J3: { level: 'L1', position: [4_480_000, 3_200_000] },
    J4: { level: 'L1', position: [0, 3_200_000] },
  },
  walls: {
    W1: { level: 'L1', start: 'J1', end: 'J2', type: 'WT' },
    W2: {
      level: 'L1',
      start: 'J2',
      end: 'J3',
      type: 'WT',
      finishes: {
        left: { regions: [{ from: 500_000, to: 3_000_000, bottom: 36 * IN, top: 54 * IN, material: 'TILE' }] },
        right: { material: 'SIDING', regions: [{ from: 300_000, to: 2_500_000, bottom: 1_000_000, top: 2_000_000, material: 'BRICK' }] },
      },
    },
    W3: { level: 'L1', start: 'J3', end: 'J4', type: 'WT' },
    W4: { level: 'L1', start: 'J4', end: 'J1', type: 'WT' },
  },
  openings: { KW: { wall: 'W2', offset: 1_600_000, fill: 'W36' } },
  rooms: { KIT: { level: 'L1', anchor: [1_920_000, 1_600_000], name: 'Kitchen', function: 'kitchen', wallFinish: 'PAINT', floorFinish: 'OAK', ceilingFinish: 'PLASTER' } },
  materials: {
    PAINT: { color: '#e9e6df' },
    OAK: { color: '#c8b391', texture: { asset: 'OAK-PHOTO', size: [7 * IN, 48 * IN] } },
    PLASTER: { color: '#f2f0ea' },
    TILE: { color: '#5ea6a0', texture: { asset: 'TILE-PHOTO', size: [12 * IN, 12 * IN] } },
    BRICK: { color: '#a0523c' },
    SIDING: { color: '#8a9a88' },
  },
  assets: {
    'TILE-PHOTO': { path: 'assets/tile.png', sha256: 'a'.repeat(64), mediaType: 'image/png' },
    'OAK-PHOTO': { path: 'assets/oak.png', sha256: 'b'.repeat(64), mediaType: 'image/png' },
  },
};

let mesher: Mesher;
let doc: FloorspecDocument;
let derived: Derived;
let mesh: HouseMesh;
const ORIGIN: [number, number, number] = [2_240_000, 1_600_000, 0];

beforeAll(async () => {
  mesher = await loadMesher();
  const ev = evaluate(HOUSE);
  expect(ev.valid, JSON.stringify(ev.diagnostics)).toBe(true);
  doc = ev.document!;
  derived = deriveEvaluation(ev);
  mesh = mesher.meshDerived(doc, derived, { origin: ORIGIN });
});

const partOf = (key: string): MeshPart => mesh.parts.find((p) => p.key === key)!;
const groupsOf = (key: string): SurfaceGroup[] => surfaceGroups(doc, derived, partOf(key), mesh.origin, mesh.unitsPerMetre);

/** The document-frame point, in base units, of vertex i of a group. */
function at(g: SurfaceGroup, i: number): [number, number, number] {
  const k = mesh.unitsPerMetre;
  return [g.positions[3 * i]! * k + ORIGIN[0], g.positions[3 * i + 1]! * k + ORIGIN[1], g.positions[3 * i + 2]! * k + ORIGIN[2]];
}

/** Area in square metres of a group's triangles in 3D. */
function area3(positions: Float32Array, indices?: Uint32Array): number {
  let a = 0;
  const n = indices ? indices.length : positions.length / 3;
  const v = (j: number) => {
    const i = indices ? indices[j]! : j;
    return [positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!];
  };
  for (let j = 0; j < n; j += 3) {
    const [p, q, r] = [v(j), v(j + 1), v(j + 2)];
    const u = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!];
    const w = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!];
    a += Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!) / 2;
  }
  return a;
}

/** Area of a group's triangles in its own (s, t), square base units. */
function areaSt(g: SurfaceGroup): number {
  let a = 0;
  for (let j = 0; j < g.st.length; j += 6) {
    const [s0, t0, s1, t1, s2, t2] = [g.st[j]!, g.st[j + 1]!, g.st[j + 2]!, g.st[j + 3]!, g.st[j + 4]!, g.st[j + 5]!];
    a += Math.abs((s1 - s0) * (t2 - t0) - (s2 - s0) * (t1 - t0)) / 2;
  }
  return a;
}

const range = (g: SurfaceGroup, axis: 0 | 1) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = axis; j < g.st.length; j += 2) {
    lo = Math.min(lo, g.st[j]!);
    hi = Math.max(hi, g.st[j]!);
  }
  return [lo, hi] as const;
};

/** Float32 metres a few metres from the origin, and a point rounded to whole base units for surfaceST: a few base units. */
const TOL = 3;

describe('surface coordinates on a wall (18.3)', () => {
  it('match the engine’s exact surfaceST at every vertex of both faces of an oblique wall, and of their regions', () => {
    const groups = groupsOf('wall:W2');
    const kinds = groups.map((g) => (g.surface === null ? 'rest' : 'side' in g.surface ? `${g.surface.kind}:${g.surface.side}` : g.surface.kind)).sort();
    expect(kinds).toEqual(['face:left', 'face:right', 'region:left', 'region:right', 'rest']);
    let checked = 0;
    for (const g of groups) {
      if (g.surface === null || g.surface.kind === 'floor' || g.surface.kind === 'ceiling') continue;
      const { side } = g.surface;
      const region = g.surface.kind === 'region' ? HOUSE.walls.W2.finishes[side].regions[g.surface.index] : undefined;
      for (let i = 0; i < g.st.length / 2; i++) {
        const [x, y, z] = at(g, i);
        const exact = surfaceST(doc, 'W2', side, [Math.round(x), Math.round(y)], Math.round(z), region);
        expect(Math.abs(g.st[2 * i]! - exact.s.approx()), `s of ${g.surface.kind} ${side} vertex ${String(i)}`).toBeLessThan(TOL);
        expect(Math.abs(g.st[2 * i + 1]! - Number(exact.t)), `t of ${g.surface.kind} ${side} vertex ${String(i)}`).toBeLessThan(TOL);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('anchors a region at its lower corner on the left of a person facing it: (from, bottom) on a right face, (to, bottom) on a left one', () => {
    const groups = groupsOf('wall:W2');
    for (const side of ['left', 'right'] as const) {
      const g = groups.find((x) => x.surface?.kind === 'region' && x.surface.side === side)!;
      const r = HOUSE.walls.W2.finishes[side].regions[0]!;
      const [s0, s1] = range(g, 0);
      const [t0, t1] = range(g, 1);
      expect(Math.abs(s0)).toBeLessThan(TOL);
      expect(Math.abs(s1 - (r.to - r.from))).toBeLessThan(TOL);
      expect(Math.abs(t0)).toBeLessThan(TOL);
      expect(Math.abs(t1 - (r.top - r.bottom))).toBeLessThan(TOL);
      // The region's corner at s = 0 is (from, bottom) along the wall on the right face and (to, bottom) on the left.
      const corner = [...Array(g.st.length / 2).keys()].find((i) => Math.abs(g.st[2 * i]!) < TOL && Math.abs(g.st[2 * i + 1]!) < TOL)!;
      const [x, y] = at(g, corner);
      const along = ((x - 3_840_000) * 640_000 + y * 3_200_000) / Math.hypot(640_000, 3_200_000);
      expect(Math.abs(along - (side === 'right' ? r.from : r.to))).toBeLessThan(TOL);
    }
  });

  it('resolves each group’s material as 18.6 does: the region’s, the face’s own, the room’s', () => {
    const groups = groupsOf('wall:W2');
    const material = (kind: string, side: string) => groups.find((g) => g.surface?.kind === kind && 'side' in g.surface && g.surface.side === side)?.material;
    expect(material('region', 'left')).toBe('TILE');
    expect(material('region', 'right')).toBe('BRICK');
    expect(material('face', 'right')).toBe('SIDING');
    expect(material('face', 'left')).toBe('PAINT');
    expect(groups.find((g) => g.surface === null)?.material).toBeNull();
    expect(groupsOf('wall:W1').find((g) => g.surface?.kind === 'face' && g.surface.side === 'left')?.material).toBe('PAINT');
    expect(groupsOf('wall:W1').find((g) => g.surface?.kind === 'face' && g.surface.side === 'right')?.material).toBeNull();
  });

  it('partitions the part: the groups cover exactly its triangles, wound the same way', () => {
    for (const key of ['wall:W1', 'wall:W2', 'floor:KIT', 'ceiling:KIT']) {
      const part = partOf(key);
      const groups = groupsOf(key);
      const total = groups.reduce((a, g) => a + area3(g.positions), 0);
      expect(total, key).toBeCloseTo(area3(part.mesh.positions, part.mesh.indices), 6);
      for (const g of groups)
        for (let j = 0; j < g.positions.length; j += 9) {
          const p = g.positions;
          const u = [p[j + 3]! - p[j]!, p[j + 4]! - p[j + 1]!, p[j + 5]! - p[j + 2]!];
          const w = [p[j + 6]! - p[j]!, p[j + 7]! - p[j + 1]!, p[j + 8]! - p[j + 2]!];
          const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
          const len = Math.hypot(...n);
          if (len < 1e-9) continue;
          const dot = (n[0]! * g.normals[j]! + n[1]! * g.normals[j + 1]! + n[2]! * g.normals[j + 2]!) / len;
          expect(dot, key).toBeGreaterThan(0.99);
        }
    }
  });

  it('cuts the window out of the region it passes through, as it is cut out of the face', () => {
    const groups = groupsOf('wall:W2');
    const region = groups.find((g) => g.surface?.kind === 'region' && g.surface.side === 'right')!;
    const r = HOUSE.walls.W2.finishes.right.regions[0]!;
    const o = derived.openings['KW']!;
    const e = [640_000 / Math.hypot(640_000, 3_200_000), 3_200_000 / Math.hypot(640_000, 3_200_000)];
    const along = (p: readonly [number, number]) => (p[0] - 3_840_000) * e[0]! + p[1] * e[1]!;
    const [a0, a1] = [along(o.start), along(o.end)].sort((x, y) => x - y) as [number, number];
    const ds = Math.max(0, Math.min(r.to, a1) - Math.max(r.from, a0));
    const dt = Math.max(0, Math.min(r.top, o.headElevation) - Math.max(r.bottom, o.sillElevation));
    expect(ds * dt).toBeGreaterThan(0);
    const expected = (r.to - r.from) * (r.top - r.bottom) - ds * dt;
    expect(Math.abs(areaSt(region) - expected) / expected).toBeLessThan(1e-5);
    // The left region is above the window's sill … and below its head: cut too.
    const left = groups.find((g) => g.surface?.kind === 'region' && g.surface.side === 'left')!;
    const l = HOUSE.walls.W2.finishes.left.regions[0]!;
    expect(areaSt(left)).toBeLessThan((l.to - l.from) * (l.top - l.bottom));
  });
});

describe('surface coordinates on floors and ceilings (18.3)', () => {
  it('lays a floor in plan coordinates and a ceiling in plan coordinates seen from below', () => {
    const floor = groupsOf('floor:KIT').find((g) => g.surface?.kind === 'floor')!;
    expect(floor.material).toBe('OAK');
    for (let i = 0; i < floor.st.length / 2; i++) {
      const [x, y] = at(floor, i);
      expect(Math.abs(floor.st[2 * i]! - x)).toBeLessThan(TOL);
      expect(Math.abs(floor.st[2 * i + 1]! - y)).toBeLessThan(TOL);
    }
    const ceiling = groupsOf('ceiling:KIT').find((g) => g.surface?.kind === 'ceiling')!;
    expect(ceiling.material).toBe('PLASTER');
    for (let i = 0; i < ceiling.st.length / 2; i++) {
      const [x, y] = at(ceiling, i);
      expect(Math.abs(ceiling.st[2 * i]! + x)).toBeLessThan(TOL);
      expect(Math.abs(ceiling.st[2 * i + 1]! - y)).toBeLessThan(TOL);
    }
  });

  it('gives a part with no finished surface one group with its own material', () => {
    const fill = mesh.parts.find((p) => p.kind === 'junctionFill');
    if (fill === undefined) return;
    const groups = surfaceGroups(doc, derived, fill, mesh.origin);
    expect(groups.map((g) => [g.surface, g.st.length])).toEqual([[null, 0]]);
  });
});

describe('tile coordinates (18.3)', () => {
  const W = 12 * IN;
  it('are surface coordinates over the tile size', () => {
    expect(tileCoordinates(W, 2 * W, { size: [W, W] })).toEqual([1, 2]);
    expect(tileCoordinates(W / 2, W / 4, { size: [W, 2 * W] })).toEqual([0.5, 0.125]);
  });
  it('start a tile’s corner at the offset', () => {
    expect(tileCoordinates(W + 1000, 1000, { size: [W, W], offset: [1000, 1000] })).toEqual([1, 0]);
  });
  it('turn the tiles counter-clockwise by the rotation, exactly at a quarter turn', () => {
    // A quarter turn: F = (0, 1), so s' = t and t' = −s.
    const [u, v] = tileCoordinates(W, 2 * W, { size: [W, W], rotation: 90_000_000 });
    expect(u).toBeCloseTo(2, 12);
    expect(v).toBeCloseTo(-1, 12);
    const [u2, v2] = tileCoordinates(W, 0, { size: [W, W], rotation: 45_000_000 });
    expect(u2).toBeCloseTo(Math.SQRT1_2, 9);
    expect(v2).toBeCloseTo(-Math.SQRT1_2, 9);
  });
});
