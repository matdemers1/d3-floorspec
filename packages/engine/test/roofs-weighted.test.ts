/**
 * Core 0.4 roofs (16.4.3 to 16.4.6) by hand and at random: a saltbox and an L-shaped hip at mixed
 * pitches, a stepped eave's break, a pyramid of events at one point, the roofs 0.4 leaves underived
 * with their reasons, the weighted skeleton reproducing Core 0.3's equal-pitch roofs value for value
 * on random rectilinear outlines, and independence from where the footprint starts.
 */
import { describe, expect, it } from 'vitest';
import type { FloorspecDocument, Roof } from '../src/model/document.js';
import { deriveRoofs, surfaceNotDerivedReason, type DerivedRoof } from '../src/roofs/roofs.js';

const SIX = { rise: 6, run: 12 };
type Edges = NonNullable<Roof['edges']>;
const roof = (footprint: [number, number][], m: Partial<Roof> = {}): Roof => ({ level: 'L1', footprint, ...m }) as Roof;
const doc = (r: Roof): FloorspecDocument => ({ floorspec: '0.4', levels: { L1: { building: 'B1', elevation: 0, height: 0 } }, roofs: { R: r } }) as unknown as FloorspecDocument;
const derive = (r: Roof, core04 = true): DerivedRoof => deriveRoofs(doc(r), core04).R!;
const pitch = (rise: number, run = 12) => ({ pitch: { rise, run } });

describe('saltbox and mixed pitches (16.4.3)', () => {
  it('a saltbox: the steep front and the shallow back meet in a level ridge a third of the way across', () => {
    const s = derive(roof([[0, 0], [32, 0], [32, 24], [0, 24]], { pitch: SIX, edges: { '0': pitch(12), '1': { gable: true }, '3': { gable: true } } })).surface!;
    expect(s.lines).toEqual([{ kind: 'ridge', from: [0, 8, 8], to: [32, 8, 8] }]);
    expect(s.faces.map((f) => f.edge)).toEqual([0, 2]);
    expect(s.gables.map((g) => g.polygon)).toEqual([
      [[32, 0, 0], [32, 24, 0], [32, 8, 8]],
      [[0, 24, 0], [0, 0, 0], [0, 8, 8]],
    ]);
  });
  it('an L-shaped hip with its wings at two pitches: two ridges at two heights joined by a hip', () => {
    const L: [number, number][] = [[0, 0], [40, 0], [40, 24], [24, 24], [24, 48], [0, 48]];
    const s = derive(roof(L, { pitch: SIX, edges: { '3': pitch(9), '4': pitch(9), '5': pitch(9) } })).surface!;
    const ridges = s.lines.filter((l) => l.kind === 'ridge');
    expect(ridges).toEqual([
      { kind: 'ridge', from: [12, 18, 9], to: [12, 36, 9] },
      { kind: 'ridge', from: [16, 12, 6], to: [28, 12, 6] },
    ]);
    expect(s.lines.filter((l) => l.kind === 'valley')).toEqual([{ kind: 'valley', from: [16, 12, 6], to: [24, 24, 0] }]);
    expect(s.high).toBe(9);
  });
  it('a stepped eave: the faster edge overtakes the slower, which ends in a level break (16.4.4)', () => {
    const s = derive(roof([[0, 0], [30, 0], [30, 3], [90, 3], [90, 60], [0, 60]], { pitch: { rise: 12, run: 12 }, edges: { '0': pitch(3) } })).surface!;
    expect(s.lines).toContainEqual({ kind: 'break', from: [29, 4, 1], to: [89, 4, 1] });
  });
  it('four planes that reach one point at once: four hips and no ridge', () => {
    const s = derive(roof([[0, 0], [24, 0], [24, 12], [0, 12]], { pitch: SIX, edges: { '0': pitch(12), '2': pitch(12) } })).surface!;
    expect(s.lines.map((l) => l.kind)).toEqual(['hip', 'hip', 'hip', 'hip']);
    expect(s.high).toBe(6);
  });
});

describe('roofs whose surface is not derived (16.4.6)', () => {
  it('names the condition each meets', () => {
    expect(surfaceNotDerivedReason(roof([[0, 0], [26, 0], [30, 4], [30, 20], [0, 20]], { pitch: SIX }), true)).toBe('a sloped edge whose length is irrational');
    const U: [number, number][] = [[0, 0], [36, 0], [36, 30], [24, 30], [24, 12], [12, 12], [12, 30], [0, 30]];
    expect(surfaceNotDerivedReason(roof(U, { pitch: SIX, edges: { '5': { gable: true } } }), true)).toBe('a gable whose wavefront edge would grow');
    const mixed = roof([[0, 0], [40, 0], [40, 30], [0, 30]], { pitch: SIX, edges: { '0': pitch(12) } });
    expect(surfaceNotDerivedReason(mixed, true)).toBeUndefined();
    expect(surfaceNotDerivedReason(mixed, false)).toMatch(/pitches differ/);
  });
});

/** A seeded generator, so the random roofs are the same on every run and in every runtime. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random rectilinear polygon with no hole and no pinch — the union of grid cells grown at random — or undefined. */
function blob(r: () => number): [number, number][] | undefined {
  const int = (n: number): number => Math.floor(r() * n);
  const nx = 2 + int(4);
  const ny = 2 + int(4);
  const pick = (n: number): number[] => {
    const s = new Set<number>();
    while (s.size < n) s.add(int(40));
    return [...s].sort((a, b) => a - b);
  };
  const xs = pick(nx + 1);
  const ys = pick(ny + 1);
  const cells = new Set([`${int(nx)},${int(ny)}`]);
  for (let k = 0, n = 1 + int(nx * ny); k < n; k++) {
    const c = [...cells][int(cells.size)]!.split(',').map(Number) as [number, number];
    const d = [[1, 0], [-1, 0], [0, 1], [0, -1]][int(4)]!;
    const m = [c[0] + d[0]!, c[1] + d[1]!];
    if (m[0]! >= 0 && m[0]! < nx && m[1]! >= 0 && m[1]! < ny) cells.add(`${m[0]},${m[1]}`);
  }
  const count = new Map<string, number>();
  for (const c of cells) {
    const [i, j] = c.split(',').map(Number) as [number, number];
    const q = [[xs[i]!, ys[j]!], [xs[i + 1]!, ys[j]!], [xs[i + 1]!, ys[j + 1]!], [xs[i]!, ys[j + 1]!]];
    for (let k = 0; k < 4; k++) {
      const key = `${q[k]!.join(',')}>${q[(k + 1) % 4]!.join(',')}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const nxt = new Map<string, string[]>();
  for (const key of count.keys()) {
    const [a, b] = key.split('>') as [string, string];
    if (!count.get(`${b}>${a}`)) nxt.set(a, [...(nxt.get(a) ?? []), b]);
  }
  if ([...nxt.values()].some((v) => v.length > 1)) return undefined;
  const start = nxt.keys().next().value!;
  const ring = [start];
  for (let cur = nxt.get(start)![0]!; cur !== start; cur = nxt.get(cur)![0]!) ring.push(cur);
  if (ring.length !== nxt.size) return undefined;
  const pts = ring.map((s) => s.split(',').map(Number) as [number, number]);
  return pts.filter((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length]!;
    const b = pts[(i + 1) % pts.length]!;
    return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
  });
}

describe('the weighted skeleton at random', () => {
  it('derives every roof Core 0.3 derives exactly as 0.3 does (16.4.3, the note)', () => {
    const r = rng(7);
    let n = 0;
    for (let guard = 0; n < 40 && guard < 5000; guard++) {
      const fp = blob(r);
      if (!fp) continue;
      const edges: Edges = {};
      fp.forEach((_, k) => {
        if (r() < 0.15) edges[String(k)] = { gable: true };
      });
      const rf = roof(fp, { pitch: SIX, edges });
      let a: DerivedRoof;
      try {
        a = derive(rf, false);
      } catch {
        continue; // an outline that does not fit, or fewer than two sloped edges
      }
      if (!a.surface || a.kind === 'shed') continue;
      a.surface.lines.sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to) || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0));
      expect(derive(rf)).toEqual(a);
      n++;
    }
    expect(n).toBe(40);
  });
  it('does not depend on where the footprint starts', () => {
    const r = rng(11);
    let n = 0;
    for (let guard = 0; n < 25 && guard < 5000; guard++) {
      const fp = blob(r);
      if (!fp) continue;
      const pitches = fp.map(() => [3, 6, 12][Math.floor(r() * 3)]!);
      const edges = (ps: number[]): Edges => Object.fromEntries(ps.map((p, i) => [String(i), pitch(p)]));
      const a = derive(roof(fp, { edges: edges(pitches) })).surface;
      if (!a) continue;
      const k = 1 + Math.floor(r() * (fp.length - 1));
      const rot = [...fp.slice(k), ...fp.slice(0, k)];
      const b = derive(roof(rot, { edges: edges([...pitches.slice(k), ...pitches.slice(0, k)]) })).surface!;
      const key = (s: typeof a) => s.faces.map((f) => JSON.stringify([f.polygon, f.area])).sort();
      expect(key(b)).toEqual(key(a));
      expect(b.lines).toEqual(a.lines);
      expect(b.high).toBe(a.high);
      n++;
    }
    expect(n).toBe(25);
  });
});

const cmp = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
};
