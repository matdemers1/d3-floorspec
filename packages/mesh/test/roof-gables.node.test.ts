/**
 * FLR-T-12.35: a thick roof's gable ends stop at the roof's underside. The roof is its surface
 * thickened straight down, so on a gable edge its band stands in the gable end's own plane: a gable
 * end drawn up to the surface lay under the band for the roof's whole thickness, and the two fought
 * for depth — the dark, streaked band an owner saw along the top of the Courtyard House's guest wing.
 *
 * The fixture is that wing as the owner drew it: a shed roof rising south over an arc wall, whose
 * west end is a three-segment approximation of the arc, every edge but the north one a gable.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMesher, type MeshPart, type Mesher } from '../src/index.js';
import { belowSolid } from '../src/roofs.js';

const FT = 390_144;
const GUEST_WING = readFileSync(new URL('./fixtures/courtyard-guest-wing.floorspec.json', import.meta.url), 'utf8');
const T = 325_120;

let mesher: Mesher;
beforeAll(async () => {
  mesher = await loadMesher();
});

type V = [number, number, number];
type V2 = [number, number];
interface Tri {
  part: MeshPart;
  p: V[];
  n: V;
}

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const area = (p: readonly V2[]): number => p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * a[1], 0) / 2;

/** The part of convex polygon `s` inside convex counter-clockwise polygon `c`. */
function clip(s: V2[], c: readonly V2[]): V2[] {
  let out = s;
  for (let i = 0; i < c.length && out.length; i++) {
    const a = c[i]!;
    const b = c[(i + 1) % c.length]!;
    const side = (p: V2): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j]!;
      const q = inp[(j + 1) % inp.length]!;
      const [sp, sq] = [side(p), side(q)];
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) {
        const k = sp / (sp - sq);
        out.push([p[0] + k * (q[0] - p[0]), p[1] + k * (q[1] - p[1])]);
      }
    }
  }
  return out;
}

function triangles(parts: readonly MeshPart[]): Tri[] {
  const out: Tri[] = [];
  for (const part of parts) {
    const { positions: P, indices: I } = part.mesh;
    for (let t = 0; t < I.length; t += 3) {
      const p = [0, 1, 2].map((k): V => [P[3 * I[t + k]!]!, P[3 * I[t + k]! + 1]!, P[3 * I[t + k]! + 2]!]);
      const n = cross(sub(p[1]!, p[0]!), sub(p[2]!, p[0]!));
      const l = Math.hypot(...n);
      if (l > 1e-12) out.push({ part, p, n: [n[0] / l, n[1] / l, n[2] / l] });
    }
  }
  return out;
}

/**
 * Every pair of faces of different parts that lie in one plane and overlap, which a renderer cannot
 * order: facing the same way, or either an open surface (seen from both sides). Two closed solids
 * that abut share a plane facing opposite ways, and neither face is ever seen.
 */
function coplanarOverlaps(parts: readonly MeshPart[]): string[] {
  const tris = triangles(parts);
  const found = new Set<string>();
  for (let i = 0; i < tris.length; i++)
    for (let j = i + 1; j < tris.length; j++) {
      const [A, B] = [tris[i]!, tris[j]!];
      if (A.part === B.part) continue;
      const c = dot(A.n, B.n);
      if (Math.abs(c) < 1 - 1e-6) continue;
      if (c < 0 && A.part.closed && B.part.closed) continue;
      const d = dot(A.n, A.p[0]!);
      // Float32 metres: a micrometre is far inside any depth buffer's reach and far outside rounding.
      if (B.p.some((q) => Math.abs(dot(A.n, q) - d) > 1e-6)) continue;
      const [u, v] = Math.abs(A.n[0]) > 0.5 ? [1, 2] : Math.abs(A.n[1]) > 0.5 ? [2, 0] : [0, 1];
      const flat = (t: Tri): V2[] => {
        const r = t.p.map((q): V2 => [q[u]!, q[v]!]);
        return area(r) < 0 ? r.reverse() : r;
      };
      // A square centimetre: shared edges and corners overlap in nothing.
      if (area(clip(flat(B), flat(A))) > 1e-4) found.add([A.part.key, B.part.key].sort().join(' over '));
    }
  return [...found].sort();
}

describe('a thick roof and its gable ends (FLR-T-12.35)', () => {
  it('the Courtyard House guest wing: no two faces of its roof, gable ends and walls lie over each other', () => {
    const house = mesher.meshDocument(GUEST_WING, { include: ['wall', 'junctionFill', 'roof', 'roofGable'] });
    const kinds = new Set(house.parts.map((p) => p.key));
    for (const k of ['roof:RF2', 'roofGable:RF2:gable0', 'roofGable:RF2:gable4', 'wall:WGW']) expect(kinds).toContain(k);
    expect(coplanarOverlaps(house.parts)).toEqual([]);
  });

  it('each gable end rises from the eave to the roof’s underside, the surface less the thickness', () => {
    const parts = mesher.meshDocument(GUEST_WING, { include: ['roof', 'roofGable'] }).parts;
    const top = (key: string): number => parts.find((p) => p.key === key)!.bbox.max[2];
    const eave = 10 * FT;
    // The high edge is 16 ft from the low one, overhangs included, at 3 in 12: 4 ft above the 10 ft eave.
    expect(top('roof:RF2')).toBe(14 * FT);
    // The south wall is a foot inside it (FLR-T-12.36): the surface over it is 3 in lower.
    expect(top('roofGable:RF2:gable0')).toBe(14 * FT - FT / 4 - T);
    expect(top('roofGable:RF2:gable1')).toBe(14 * FT - FT / 4 - T);
    for (const p of parts.filter((q) => q.kind === 'roofGable')) expect(p.bbox.min[2], p.key).toBe(eave);
    // Nothing of a gable end is above the underside of the roof over it: Float32 metres, within rounding.
    const roof = triangles(parts.filter((p) => p.key === 'roof:RF2'));
    for (const g of triangles(parts.filter((p) => p.kind === 'roofGable')))
      for (const q of g.p) {
        const under = roof.filter((t) => t.n[2] < -0.5);
        const at = under.map((t) => {
          // The underside's elevation above (x, y), where its triangle covers it.
          const [a, b, c] = t.p as [V, V, V];
          const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
          const s = ((q[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (q[1] - a[1])) / det;
          const r = ((b[0] - a[0]) * (q[1] - a[1]) - (q[0] - a[0]) * (b[1] - a[1])) / det;
          return s >= -1e-6 && r >= -1e-6 && s + r <= 1 + 1e-6 ? a[2] + s * (b[2] - a[2]) + r * (c[2] - a[2]) : undefined;
        });
        const z = at.find((x) => x !== undefined);
        expect(z, `${g.part.key}: no underside over (${q[0]}, ${q[1]})`).toBeDefined();
        expect(q[2]).toBeLessThanOrEqual(z! + 1e-5);
      }
  });

  it('each gable end stands on its wall, and the roof rakes past it (FLR-T-12.36)', () => {
    const doc = JSON.parse(GUEST_WING) as { roofs: { RF2: { footprint: V2[] } } };
    const fp = doc.roofs.RF2.footprint;
    const result = mesher.meshDocument(GUEST_WING, { include: ['roof', 'roofGable'] });
    const parts = result.parts;
    const gables = parts.filter((p) => p.kind === 'roofGable');
    expect(gables.map((p) => p.key).sort()).toEqual([0, 1, 3, 4, 5, 6].map((i) => `roofGable:RF2:gable${i}`).sort());
    for (const g of gables) {
      // Every point of gable end i lies on footprint edge i, the wall's face — within Float32 metres.
      const i = Number(g.key.slice('roofGable:RF2:gable'.length));
      const o = result.origin;
      const [a, b] = [fp[i]!, fp[(i + 1) % fp.length]!].map((p): V2 => [(p[0] - o[0]) / 1_280_000, (p[1] - o[1]) / 1_280_000]) as [V2, V2];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const P = g.mesh.positions;
      for (let k = 0; k < P.length; k += 3) {
        const off = ((b[0] - a[0]) * (P[k + 1]! - a[1]) - (b[1] - a[1]) * (P[k]! - a[0])) / len;
        expect(Math.abs(off), `${g.key}: a point off its wall`).toBeLessThan(1e-5);
      }
    }
    // The roof reaches a foot past the south wall: its underside shows over the rake.
    const roof = parts.find((p) => p.key === 'roof:RF2')!;
    expect(roof.bbox.min[1]).toBe(-FT);
  });

  it('a gable end lower than the roof’s thickness everywhere is not drawn', () => {
    const doc = JSON.parse(GUEST_WING) as { roofs: { RF2: { thickness: number } } };
    // 4 ft 6 in: more than the 4 ft the roof rises from its eave to its high edge.
    doc.roofs.RF2.thickness = 4.5 * FT;
    const parts = mesher.meshDocument(doc, { include: ['roof', 'roofGable'] }).parts;
    expect(parts.map((p) => p.key)).toEqual(['roof:RF2']);
  });

  it('belowSolid: the top lowered by the thickness and cut at the eave, a point where it crosses the eave rounded once', () => {
    const e = 1000;
    // A gable of a gable roof: A and B at the eave, the ridge between, 10 up.
    const ridge = belowSolid(
      [
        [0, 0, e],
        [20, 0, e],
        [10, 0, e + 10],
      ],
      e,
      4,
    );
    expect(ridge).toEqual([
      [
        [4, 0, e],
        [16, 0, e],
        [10, 0, e + 6],
      ],
    ]);
    // A shed's rake end whose surface meets the eave at A: the point where its top dropped from the polygon comes back.
    expect(
      belowSolid(
        [
          [0, 0, e],
          [9, 0, e],
          [9, 0, e + 3],
        ],
        e,
        1,
      ),
    ).toEqual([
      [
        [3, 0, e],
        [9, 0, e],
        [9, 0, e + 2],
      ],
    ]);
    // An M: two pieces, one each side of the dip.
    expect(
      belowSolid(
        [
          [0, 0, e],
          [40, 0, e],
          [40, 0, e + 10],
          [20, 0, e + 2],
          [0, 0, e + 10],
        ],
        e,
        4,
      ),
    ).toEqual([
      [
        [25, 0, e],
        [40, 0, e],
        [40, 0, e + 6],
      ],
      [
        [0, 0, e],
        [15, 0, e],
        [0, 0, e + 6],
      ],
    ]);
  });
});
