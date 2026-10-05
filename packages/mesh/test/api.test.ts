/**
 * The mesher's API, on the conformance suite's three-room house — in Node and, in the browser
 * project, in headless Chromium, where manifold-3d's WASM is fetched as an asset.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, InvalidDocumentError } from '@floorspec/engine';
import house from '../../engine/standard/conformance/core/0.3/examples/001-three-room-house/input.json' with { type: 'json' };
import lStair from '../../engine/standard/conformance/core/0.3/stairs/007-l-stair-with-landing/input.json' with { type: 'json' };
import { flatShaded, loadMesher, meshDocument, PART_KINDS, UNITS_PER_METRE, type HouseMesh, type Mesher } from '../src/index.js';
import { loadKernel, type Kernel } from '../src/kernel.js';
import { checkHouse, hits } from './props.js';

let mesher: Mesher;
let kernel: Kernel;
beforeAll(async () => {
  mesher = await loadMesher();
  kernel = await loadKernel();
});

const kinds = (m: HouseMesh): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const p of m.parts) out[p.kind] = (out[p.kind] ?? 0) + 1;
  return out;
};

describe('meshDocument', () => {
  it('meshes the three-room house into its walls, openings, fill, floors and ceilings', async () => {
    const m = await meshDocument(house);
    expect(m.unitsPerMetre).toBe(UNITS_PER_METRE);
    expect(kinds(m)).toEqual({ wall: 9, junctionFill: 1, opening: 6, floor: 3, ceiling: 3 });
    // Parts are in kind order, then by key; every key is unique.
    expect(m.parts.map((p) => PART_KINDS.indexOf(p.kind))).toEqual([...m.parts.map((p) => PART_KINDS.indexOf(p.kind))].sort((a, b) => a - b));
    expect(new Set(m.parts.map((p) => p.key)).size).toBe(m.parts.length);
    const fd = m.parts.find((p) => p.key === 'opening:FD')!;
    expect(fd.opening).toEqual({ category: 'door', fill: 'D36', wall: 'WS2' });
    expect(fd.closed).toBe(true);
    const ww = m.parts.find((p) => p.key === 'wall:WW')!;
    expect(ww.layers).toEqual(['SIDING', 'OSB', 'STUD', 'GWB']);
    // No floor thickness is declared: the floors are surfaces facing up, the ceilings face down.
    for (const p of m.parts.filter((q) => q.kind === 'floor')) expect([p.closed, p.facing]).toEqual([false, 'up']);
    for (const p of m.parts.filter((q) => q.kind === 'ceiling')) expect([p.closed, p.facing]).toEqual([false, 'down']);
    // The house's box: the walls' outlines, from the slab to the top of the walls.
    expect(m.bbox!.min[2]).toBe(0);
    expect(m.bbox!.max[2]).toBe(3_511_296);
  });

  it('holds every property, here too', () => {
    const ev = evaluate(lStair);
    const d = deriveEvaluation(ev);
    const sum = checkHouse(kernel, ev.document!, d, mesher.meshDerived(ev.document!, d, { stats: true }), 'l-stair');
    expect(sum.solids).toBeGreaterThan(10);
  });

  it('filters by level and by kind', () => {
    const all = mesher.meshDocument(lStair);
    const upper = mesher.meshDocument(lStair, { levels: ['L2'] });
    expect(upper.parts.length).toBeGreaterThan(0);
    expect(upper.parts.every((p) => p.level === 'L2')).toBe(true);
    expect(upper.parts.length).toBeLessThan(all.parts.length);
    const stair = mesher.meshDocument(lStair, { include: ['stairFlight', 'stairLanding'] });
    expect(stair.parts.map((p) => p.key)).toEqual(['stairFlight:ST1:flight1', 'stairFlight:ST1:flight2', 'stairLanding:ST1:landing1']);
    expect(new Set(stair.parts.map((p) => p.id))).toEqual(new Set(['ST1']));
  });

  it('subtracts the origin before converting to metres, and nothing else changes', () => {
    const a = mesher.meshDocument(house, { include: ['wall'] });
    const origin: [number, number, number] = [7_802_880, 4_681_728, 1_280_000];
    const b = mesher.meshDocument(house, { include: ['wall'], origin });
    expect(b.origin).toEqual(origin);
    expect(b.bbox).toEqual(a.bbox);
    const [p, q] = [a.parts[0]!.mesh.positions, b.parts[0]!.mesh.positions];
    expect(q.length).toBe(p.length);
    for (let i = 0; i < p.length; i++) expect(q[i]).toBeCloseTo(p[i]! - origin[i % 3]! / UNITS_PER_METRE, 5);
  });

  it('refuses an invalid document', () => {
    const bad = structuredClone(house) as { walls: Record<string, { start: string }> };
    bad.walls['WW']!.start = 'NOWHERE';
    expect(() => mesher.meshDocument(bad)).toThrow(InvalidDocumentError);
  });

  it('flat-shades a part for a view', () => {
    const p = mesher.meshDocument(house, { include: ['wall'] }).parts[0]!;
    const f = flatShaded(p.mesh);
    expect(f.positions.length).toBe(p.mesh.indices.length * 3);
    for (let i = 0; i < f.normals.length; i += 3) expect(Math.hypot(f.normals[i]!, f.normals[i + 1]!, f.normals[i + 2]!)).toBeCloseTo(1, 5);
  });
});

describe('the checks themselves', () => {
  const checked = (m: HouseMesh): (() => void) => {
    const ev = evaluate(house);
    return () => checkHouse(kernel, ev.document!, deriveEvaluation(ev), m, 'mutant');
  };

  it('pass on the house as meshed', () => {
    expect(checked(mesher.meshDocument(house, { stats: true }))).not.toThrow();
  });

  it('catch a missing triangle', () => {
    const m = mesher.meshDocument(house, { stats: true });
    const w = m.parts.find((p) => p.kind === 'wall')!;
    w.mesh.indices = w.mesh.indices.slice(3);
    expect(checked(m)).toThrow(/no twin|used/);
  });

  it('catch a wall whose openings were not cut', () => {
    const m = mesher.meshDocument(house, { stats: true });
    const uncut = structuredClone(house) as { openings?: unknown };
    delete uncut.openings;
    const plain = mesher.meshDocument(uncut, { include: ['wall'] });
    const w = m.parts.find((p) => p.key === 'wall:WW')!;
    w.mesh = plain.parts.find((p) => p.key === 'wall:WW')!.mesh;
    expect(checked(m)).toThrow(/genus|Float32 volume|meets its wall/);
  });

  it('catch a box that is off by one base unit', () => {
    const m = mesher.meshDocument(house, { stats: true });
    const f = m.parts.find((p) => p.kind === 'floor')!;
    f.bbox.max[0] += 1;
    expect(checked(m)).toThrow(/box/);
  });
});

describe('the ray test, on its own', () => {
  it('meets an uncut wall at the centre of every opening it should have', () => {
    const uncut = structuredClone(house) as { openings?: unknown };
    delete uncut.openings;
    const plain = mesher.meshDocument(uncut, { include: ['wall'] });
    const cut = mesher.meshDocument(house, { include: ['wall'] });
    const ev = evaluate(house);
    const d = deriveEvaluation(ev);
    for (const [oid, o] of Object.entries(d.openings)) {
      const wid = ev.document!.openings![oid]!.wall;
      const S = ev.document!.junctions![ev.document!.walls![wid]!.start]!.position;
      const E = ev.document!.junctions![ev.document!.walls![wid]!.end]!.position;
      const n = [S[1] - E[1], E[0] - S[0]];
      const len = Math.hypot(n[0]!, n[1]!);
      const c = [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2, (o.sillElevation + o.headElevation) / 2];
      const at = (s: number): number[] => [0, 1, 2].map((k) => (c[k]! + (k < 2 ? (s * n[k]!) / len : 0)) / UNITS_PER_METRE);
      const seg = [at(-100 * UNITS_PER_METRE), at(100 * UNITS_PER_METRE)] as const;
      expect(hits(plain.parts.find((p) => p.id === wid)!.mesh, ...seg), oid).toBeGreaterThanOrEqual(2);
      expect(hits(cut.parts.find((p) => p.id === wid)!.mesh, ...seg), oid).toBe(0);
    }
  });
});
