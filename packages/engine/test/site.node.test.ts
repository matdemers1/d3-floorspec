/**
 * FS_site 0.1.0 (FLR-T-15.1): the surface's triangulation is deterministic and is the one its spec
 * defines, cut and fill are exact on a case checked by hand, setbacks are measured to an edge and not
 * its line — and the drawing helpers (contours, cut and fill regions, setback line, bearings) agree with
 * what is derived.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bearingOf, check, contoursOf, cutFillOf, gradeAt, OFFICIAL_EXTENSIONS, setbackPolygon, site, siteDrawing, type FloorspecDocument } from '../src/index.js';

const suite = join(import.meta.dirname, '..', 'standard', 'conformance', 'ext', 'FS_site', '0.1.0');
const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const garden = (): FloorspecDocument => structuredClone(read(join(suite, 'examples', '001-p15-garden-on-a-slope', 'input.json'))) as FloorspecDocument;
const reader = { extensions: ['FS_site'], knownExtensions: OFFICIAL_EXTENSIONS };
const FT = 390144;
const FT3 = BigInt(FT) ** 3n;
type Data = { spots: Record<string, { at: [number, number]; elevation: number }>; contours: Record<string, unknown>; pads: Record<string, unknown> };
const data = (d: FloorspecDocument) => (d.extensions as Record<string, Data>)['FS_site']!;
const derivedSite = (d: FloorspecDocument) => {
  const r = check(d, reader);
  expect(r.valid, JSON.stringify(r.diagnostics)).toBe(true);
  return r.derived!.extensions!.FS_site!;
};
const P = (x: number, y: number): [bigint, bigint] => [BigInt(x), BigInt(y)];

/** A brute force of spec 3.2: every empty circle through three positions gives the face of all positions on it. */
function brute(pts: [bigint, bigint][]): [number, number, number][] {
  const faces = new Set<string>();
  const n = pts.length;
  const orient = (a: number, b: number, c: number) => {
    const v = (pts[b]![0] - pts[a]![0]) * (pts[c]![1] - pts[a]![1]) - (pts[b]![1] - pts[a]![1]) * (pts[c]![0] - pts[a]![0]);
    return v > 0n ? 1 : v < 0n ? -1 : 0;
  };
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++) {
        const o = orient(a, b, c);
        if (o === 0) continue;
        const [x, y] = o > 0 ? [b, c] : [c, b];
        const ins = pts.map((_, d) => site.incircle(pts[a]!, pts[x]!, pts[y]!, pts[d]!));
        if (ins.some((v) => v > 0)) continue;
        faces.add(JSON.stringify(ins.flatMap((v, d) => (v === 0 ? [d] : []))));
      }
  const out: [number, number, number][] = [];
  for (const f of faces) {
    const vs = JSON.parse(f) as number[];
    const v0 = vs[0]!; // pts are sorted, so the least index is the least vertex
    const rest = vs.slice(1).sort((i, j) => -orient(v0, i, j));
    for (let i = 0; i + 1 < rest.length; i++) out.push([v0, rest[i]!, rest[i + 1]!]);
  }
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
}

describe('FS_site: the surface (3.2)', () => {
  it('is the unique Delaunay triangulation the spec defines, on grids full of cocircular points', () => {
    let seed = 15;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % (n + 1);
    };
    let checked = 0;
    for (let trial = 0; trial < 150; trial++) {
      const R = [3, 5, 8, 1000][trial % 4]!;
      const set = new Map<string, [bigint, bigint]>();
      for (let i = 0; i < 4 + (trial % 12); i++) {
        const p = P(rnd(R), rnd(R));
        set.set(`${p[0]},${p[1]}`, p);
      }
      const pts = [...set.values()].sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));
      const t = site.triangulate(pts);
      if (!t) continue;
      expect(t, JSON.stringify(pts.map(String))).toEqual(brute(pts));
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('divides four cocircular points from the least, and makes nothing of points on one line', () => {
    expect(site.triangulate([P(0, 0), P(0, 10), P(10, 0), P(10, 10)])).toEqual([[0, 2, 3], [0, 3, 1]]);
    expect(site.triangulate([P(0, 0), P(1, 1), P(5, 5)])).toBeUndefined();
  });

  it('is the same whatever order the survey is written in', () => {
    const d = garden();
    const a = derivedSite(d);
    const s = data(d);
    s.spots = Object.fromEntries(Object.entries(s.spots).reverse());
    s.contours = Object.fromEntries(Object.entries(s.contours).reverse());
    const b = derivedSite(d);
    expect(b.surface).toEqual(a.surface);
    expect(b.grading).toEqual(a.grading);
  });
});

describe('FS_site: cut and fill (4.2)', () => {
  /** The lot's corners on the plane z = y / 10, and one pad. */
  function plane(boundary: [number, number][], elevation = 0): FloorspecDocument {
    const d = garden();
    const lot = d.site!.boundary!;
    const s = data(d);
    s.spots = Object.fromEntries(lot.map((p, i) => [`SP${i + 1}`, { at: [p[0], p[1]], elevation: p[1] / 10 }]));
    s.contours = {};
    s.pads = { GP1: { boundary, elevation } };
    delete (d.slabs!.S1 as { purpose?: string }).purpose;
    return d;
  }

  it('measures a pad across the zero line by hand: 100 cubic feet cut, 100 filled', () => {
    const x = derivedSite(plane([[0, -10 * FT], [20 * FT, -10 * FT], [20 * FT, 10 * FT], [0, 10 * FT]]));
    expect(x.grading.GP1).toEqual({ kind: 'pad', elevation: 0, low: -FT, high: FT, cut: `${100n * FT3}`, fill: `${100n * FT3}` });
  });

  it('measures an L-shaped pad, not convex, whichever way round it is written', () => {
    const L: [number, number][] = [[0, 0], [20 * FT, 0], [20 * FT, 10 * FT], [10 * FT, 10 * FT], [10 * FT, 20 * FT], [0, 20 * FT]];
    expect(derivedSite(plane(L)).grading.GP1!.cut).toBe(`${250n * FT3}`);
    expect(derivedSite(plane([...L].reverse())).grading.GP1!.cut).toBe(`${250n * FT3}`);
  });

  it('agrees with the drawn cut and fill regions', () => {
    const d = plane([[0, -10 * FT], [20 * FT, -10 * FT], [20 * FT, 10 * FT], [0, 10 * FT]]);
    const drawing = siteDrawing(d);
    const g = drawing.graded.find((x) => x.id === 'GP1')!;
    const r = cutFillOf(drawing.surface!, g.ring, g.elevation);
    const area = (polys: [number, number][][]) => polys.reduce((s, p) => s + Math.abs(p.reduce((a, q, i) => a + q[0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * q[1], 0)) / 2, 0);
    expect(area(r.cut) / (FT * FT)).toBeCloseTo(200, 6);
    expect(area(r.fill) / (FT * FT)).toBeCloseTo(200, 6);
    expect(r.cutDepth / FT).toBeCloseTo(1, 9);
    expect(gradeAt(drawing.surface!, 5 * FT, 5 * FT)! / FT).toBeCloseTo(0.5, 9);
  });

  it('gives the garden on its slope its cut under the house and its fill under the patio', () => {
    const x = derivedSite(garden());
    expect(BigInt(x.grading.GP1!.cut!)).toBeGreaterThan(0n);
    expect(x.grading.S1!.cut).toBe('0');
    expect(BigInt(x.fill!)).toBe(BigInt(x.grading.GP1!.fill!) + BigInt(x.grading.S1!.fill!));
  });
});

describe('FS_site: setbacks (2.2, 2.3)', () => {
  it('measures to the edge, not to its line', () => {
    const a = P(0, 0);
    const b = P(10, 0);
    expect(site.nearerThan(P(5, 3), a, b, 4n)).toBe(true);
    expect(site.nearerThan(P(5, 4), a, b, 4n)).toBe(false);
    expect(site.nearerThan(P(-10, 1), a, b, 4n)).toBe(false);
    expect(site.nearerThan(P(13, 2), a, b, 4n)).toBe(true);
  });

  it('names each edge front, side or rear from the street edges', () => {
    expect(site.edgeKinds(4, { street: [0] })).toEqual(['front', 'side', 'rear', 'side']);
    expect(site.edgeKinds(5, { street: [0] })).toEqual(['front', 'side', 'rear', 'rear', 'side']);
    expect(site.edgeKinds(4, { street: [0, 1] })).toEqual(['front', 'front', 'side', 'side']);
  });

  it('draws the setback line inside the lot and the bearings a surveyor writes', () => {
    const lot: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];
    expect(setbackPolygon(lot, [30, 10, 20, 10]).map((p) => p.map((v) => Math.round(v)))).toEqual([[10, 30], [90, 30], [90, 80], [10, 80]]);
    expect(bearingOf([0, 0], [100, 0])).toBe('N 90°00′ E');
    expect(bearingOf([0, 0], [-1, -100])).toBe('S 00°34′ W');
    expect(bearingOf([0, 0], [0, 100], 1_000_000)).toBe('N 01°00′ E');
  });
});

describe('FS_site: contours (5.1)', () => {
  it('draws a contour at every foot of the survey datum, majors every fifth, on the derived surface', () => {
    const d = garden();
    const drawing = siteDrawing(d);
    expect(drawing.surface!.triangles).toEqual(derivedSite(d).surface!.triangles);
    const cs = contoursOf(drawing.surface!, FT, drawing.benchmark);
    // the survey runs from 809' 6" to 817' at 814' 6" = project zero: 810' to 817'
    expect(cs.map((c) => Math.round(c.height / FT))).toEqual([810, 811, 812, 813, 814, 815, 816, 817]);
    expect(cs.filter((c) => c.major).map((c) => Math.round(c.height / FT))).toEqual([810, 815]);
    for (const c of cs) for (const line of c.lines) for (const p of line) expect(gradeAt(drawing.surface!, p[0], p[1])! - c.z).toBeCloseTo(0, 3);
  });

  it('reads a document with no site, or a site it cannot read, as nothing to draw', () => {
    const d = garden();
    delete d.site;
    delete (d.extensions as Record<string, unknown>).FS_site;
    const s = siteDrawing(d);
    // the patio is still a patio slab: graded, with nothing to measure it against
    expect([s.lot, s.surface, s.setbackLine, s.graded.map((g) => g.id)]).toEqual([null, null, null, ['S1']]);
    (d.extensions as Record<string, unknown>).FS_site = { spots: { A: { at: 'nowhere' } } };
    expect(siteDrawing(d).surface).toBeNull();
  });
});
