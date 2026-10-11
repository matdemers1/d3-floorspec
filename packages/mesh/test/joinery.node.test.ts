/**
 * Openings' joinery (FLR-T-13.8): every door and window operation drawn as what it is, on a house
 * with one of each — closed, open and both — with every property of every part holding, the moving
 * pieces where a closed or an open door puts them, and the rules for glass, mullions and muntins.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { loadKernel, type Kernel } from '../src/kernel.js';
import { loadMesher, PART_KINDS, ROLE_LOOKS, UNITS_PER_METRE as BU, type HouseMesh, type MeshPart, type Mesher } from '../src/index.js';
import { joinery } from './houses.js';
import { checkHouse, openingAxes, type OpeningAxes } from './props.js';

let kernel: Kernel;
let mesher: Mesher;
let doc: FloorspecDocument;
let derived: Derived;
const meshes: Partial<Record<'closed' | 'open' | 'both', HouseMesh>> = {};
beforeAll(async () => {
  kernel = await loadKernel();
  mesher = await loadMesher();
  const ev = evaluate(joinery());
  derived = deriveEvaluation(ev);
  doc = (ev.view ?? ev.document)!;
  for (const doors of ['closed', 'open', 'both'] as const) meshes[doors] = mesher.meshDerived(doc, derived, { stats: true, doors });
});

const MM = 1_280;
const of = (m: HouseMesh, id: string): MeshPart[] => m.parts.filter((p) => p.kind === 'joinery' && p.id === id);
const named = (ps: readonly MeshPart[], name: string): MeshPart[] => ps.filter((p) => p.key.split(':')[2]!.replace(/\d+$/, '') === name);

/** A part's box in the opening's frame: along, across (left positive), up from the sill. */
type V3 = [number, number, number];
function local(m: HouseMesh, p: MeshPart, f: OpeningAxes): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  const P = p.mesh.positions;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i]! * BU + m.origin[0] - f.start[0];
    const y = P[i + 1]! * BU + m.origin[1] - f.start[1];
    const q = [x * f.u[0] + y * f.u[1], x * f.n[0] + y * f.n[1], P[i + 2]! * BU + m.origin[2] - f.sill];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, q[k]!);
      max[k] = Math.max(max[k]!, q[k]!);
    }
  }
  return { min, max };
}

describe('joinery', () => {
  it('is a kind of part of its own, after every other', () => {
    expect(PART_KINDS[PART_KINDS.length - 1]).toBe('joinery');
    const m = mesher.meshDerived(doc, derived, { include: ['joinery'] });
    expect(new Set(m.parts.map((p) => p.kind))).toEqual(new Set(['joinery']));
  });

  for (const doors of ['closed', 'open', 'both'] as const)
    it(`meshes the house with every opening's doors ${doors} with every property holding`, () => {
      const m = meshes[doors]!;
      const r = checkHouse(kernel, doc, derived, m, `joinery (${doors})`);
      expect(r.openings).toBe(22);
      // Every opening is filled.
      for (const oid of Object.keys(doc.openings ?? {})) expect(of(m, oid).length, oid).toBeGreaterThan(0);
    });

  it('draws each opening as its operation, every piece of a role with a look', () => {
    const m = meshes.closed!;
    for (const [oid, o] of Object.entries(doc.openings ?? {})) {
      const t = doc.types![o!.fill!]!;
      const op = t.kind === 'wallType' ? undefined : t.operation;
      for (const p of of(m, oid)) {
        expect(p.model?.kind, p.key).toBe(op);
        expect(ROLE_LOOKS[p.model!.role], p.key).toBeDefined();
        expect(p.opening, p.key).toEqual({ category: t.kind === 'doorType' ? 'door' : 'window', wall: o!.wall, fill: o!.fill });
      }
    }
  });

  it('glazes every window, and gives each operation its sashes', () => {
    const m = meshes.closed!;
    const glass = (oid: string): number => of(m, oid).filter((p) => p.model!.role === 'glass').length;
    // Fixed: glass in the frame; casement, awning, hopper, tilt-turn, pivot: one sash; hung and sliders: two.
    for (const oid of ['O1', 'O11']) expect([oid, glass(oid), named(of(m, oid), 'stile').length]).toEqual([oid, 1, 0]);
    for (const oid of ['O2', 'O3', 'O4', 'O8', 'O9']) expect([oid, glass(oid), named(of(m, oid), 'stile').length]).toEqual([oid, 1, 2]);
    for (const oid of ['O5', 'O6', 'O7', 'O16']) expect([oid, glass(oid), named(of(m, oid), 'stile').length]).toEqual([oid, 2, 4]);
    // Two sashes of a hung window, one above the other, in two planes.
    const f = openingAxes(doc, derived, 'O6');
    const [lo, hi] = named(of(m, 'O6'), 'glass').map((p) => local(m, p, f)).sort((a, b) => a.min[2] - b.min[2]);
    expect(hi!.min[2]).toBeGreaterThan(lo!.min[2]);
    expect(hi!.min[1] === lo!.min[1]).toBe(false);
    // A slider's two side by side.
    const s = openingAxes(doc, derived, 'O7');
    const [l, r] = named(of(m, 'O7'), 'glass').map((p) => local(m, p, s)).sort((a, b) => a.min[0] - b.min[0]);
    expect(r!.min[0]).toBeGreaterThan(l!.min[0]);
  });

  it('draws mullions and muntins only where the type asks for them', () => {
    const m = meshes.closed!;
    // "Twin casement window with grilles": two units between a mullion, each with its divided lites.
    const twin = of(m, 'O10');
    expect(named(twin, 'mullion')).toHaveLength(1);
    expect(twin.filter((p) => p.model!.role === 'glass')).toHaveLength(2);
    expect(named(twin, 'muntin').length).toBeGreaterThan(0);
    for (const [oid, o] of Object.entries(doc.openings ?? {})) {
      if (oid === 'O10' || doc.types![o!.fill!]!.kind !== 'windowType') continue;
      expect(named(of(m, oid), 'muntin'), oid).toHaveLength(0);
      expect(named(of(m, oid), 'mullion'), oid).toHaveLength(0);
    }
  });

  it('puts a stool and an apron inside a window off the floor, a sill outside, and neither at a glass wall', () => {
    const m = meshes.closed!;
    for (const oid of ['O1', 'O6', 'O10']) for (const n of ['stool', 'apron', 'sill']) expect(named(of(m, oid), n), `${oid} ${n}`).toHaveLength(1);
    for (const n of ['stool', 'apron', 'sill']) expect(named(of(m, 'O11'), n), n).toHaveLength(0);
    // The sill is outside — the west wall's left (A → D runs north, so its left is west) — the stool inside.
    const f = openingAxes(doc, derived, 'O1');
    expect(local(m, named(of(m, 'O1'), 'sill')[0]!, f).max[1]).toBeGreaterThan(f.a);
    expect(local(m, named(of(m, 'O1'), 'stool')[0]!, f).min[1]).toBeLessThan(-f.b);
  });

  it('glazes French and patio doors in an outside wall, and no other door but one its type says is glass', () => {
    const m = meshes.closed!;
    for (const oid of ['O12', 'O14']) expect(of(m, oid).some((p) => p.model!.role === 'glass'), oid).toBe(true);
    for (const oid of ['O15', 'O17', 'O18', 'O19', 'O20', 'O22']) expect(of(m, oid).some((p) => p.model!.role === 'glass'), oid).toBe(false);
  });

  it('closes each slab in its opening, and opens it as its operation does', () => {
    const closed = meshes.closed!;
    const open = meshes.open!;
    // A swing door hung at its end, swinging left: closed between its jambs and its faces, open to its left at 90°.
    const f = openingAxes(doc, derived, 'O22');
    const shut = local(closed, named(of(closed, 'O22'), 'slab')[0]!, f);
    expect(shut.min[0]).toBeGreaterThanOrEqual(0);
    expect(shut.max[0]).toBeLessThanOrEqual(f.len);
    expect(shut.min[1]).toBeGreaterThanOrEqual(-f.b - 1);
    expect(shut.max[1]).toBeLessThanOrEqual(f.a + 1);
    const swung = local(open, named(of(open, 'O22'), 'slabOpen')[0]!, f);
    expect(swung.min[1]).toBeGreaterThanOrEqual(f.a - 1);
    expect(swung.max[1] - f.a).toBeGreaterThan(f.len * 0.8);
    // At its end jamb: the hinge.
    expect(swung.min[0]).toBeGreaterThan(f.len * 0.9);
    // A pocket door: closed across its opening and a little into the wall beyond its end jamb, open in the wall.
    const p = openingAxes(doc, derived, 'O18');
    const pc = local(closed, named(of(closed, 'O18'), 'slab')[0]!, p);
    expect(pc.max[0]).toBeGreaterThan(p.len);
    expect(pc.min[0]).toBeLessThan(p.len * 0.1);
    const po = local(open, named(of(open, 'O18'), 'slabOpen')[0]!, p);
    expect(po.min[0]).toBeGreaterThan(p.len * 0.85);
    expect(po.min[1]).toBeGreaterThanOrEqual(-p.b);
    expect(po.max[1]).toBeLessThanOrEqual(p.a);
    // A garage door: its sections upright in the opening, closed; raised flat over the garage, open.
    const g = openingAxes(doc, derived, 'O13');
    const up = named(of(closed, 'O13'), 'section').map((s) => local(closed, s, g));
    expect(up).toHaveLength(4);
    for (const s of up) expect(s.max[1] - s.min[1]).toBeLessThan(60 * MM);
    const flat = named(of(open, 'O13'), 'sectionOpen').map((s) => local(open, s, g));
    for (const s of flat) {
      expect(s.min[2]).toBeGreaterThanOrEqual(g.H);
      expect(s.max[2] - s.min[2]).toBeLessThan(60 * MM);
      // Inside the garage, R2, south of the north wall: the wall runs east, so its right.
      expect(s.max[1]).toBeLessThanOrEqual(-g.b);
    }
    // A bypass slider: its back panel behind its front one, open.
    const b = openingAxes(doc, derived, 'O14');
    const front = named(of(open, 'O14'), 'stile').map((s) => local(open, s, b));
    const back = named(of(open, 'O14'), 'stileOpen').map((s) => local(open, s, b));
    expect(Math.min(...back.map((s) => s.min[0]))).toBeCloseTo(Math.min(...front.map((s) => s.min[0])), -2);
  });

  it('draws both states with `both`, each moving piece with its state, the rest once', () => {
    const keys = (m: HouseMesh): string[] => m.parts.filter((p) => p.kind === 'joinery').map((p) => p.key);
    const both = meshes.both!;
    const closed = new Set(keys(meshes.closed!));
    const open = new Set(keys(meshes.open!));
    expect(new Set(keys(both))).toEqual(new Set([...closed, ...open]));
    for (const p of both.parts.filter((q) => q.kind === 'joinery')) {
      if (p.state === undefined) {
        expect(closed.has(p.key) && open.has(p.key), p.key).toBe(true);
        continue;
      }
      expect((p.state === 'open' ? open : closed).has(p.key), p.key).toBe(true);
      expect(p.opening!.category, p.key).toBe('door');
    }
    // A cased opening and a window move nothing.
    expect(both.parts.filter((p) => (p.id === 'O21' || p.id === 'O6') && p.state !== undefined)).toHaveLength(0);
    // The same bytes for a piece drawn in both.
    const at = new Map(meshes.closed!.parts.map((p) => [p.key, p]));
    for (const p of both.parts) {
      const q = at.get(p.key);
      if (q !== undefined) expect(Buffer.from(p.mesh.positions.buffer).equals(Buffer.from(q.mesh.positions.buffer)), p.key).toBe(true);
    }
  });
});
