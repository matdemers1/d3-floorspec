/**
 * Arc edges (Core 0.4, chapter 21): the polyline by iterated snap rounding, its stations, and the level
 * graph's face paths. Runs in Node and in the browser; the conformance suite's group `arcs` checks every
 * derived value against the oracle.
 */
import { describe, expect, it } from 'vitest';
import { arcFits, arcMidpoint, arcPolyline, arcRadius, pointAt, polylineLength, roundSqrt, segmentAt, TAU } from '../src/geometry/arcs.js';
import { Q } from '../src/exact/rational.js';
import { isqrt } from '../src/exact/bigint.js';
import { orient, type IPoint } from '../src/geometry/predicates.js';
import { check } from '../src/index.js';
import { box, doc } from './doc.js';

const MM = 1280n;

describe('the polyline (21.2)', () => {
  it('is its chord when the sagitta is at most 1 mm', () => {
    expect(arcPolyline([0n, 0n], [5000n, 0n], TAU)).toEqual([
      [0n, 0n],
      [5000n, 0n],
    ]);
  });

  it('halves once at the arc midpoint', () => {
    expect(arcPolyline([0n, 0n], [3000n * MM, 0n], 1281n)).toEqual([
      [0n, 0n],
      [1500n * MM, 1281n],
      [3000n * MM, 0n],
    ]);
  });

  it('is the bay of the conformance suite: 64 segments, turning one way, every vertex on the circle within 2', () => {
    const S: IPoint = [0n, 4000n * MM];
    const E: IPoint = [5000n * MM, 4000n * MM];
    const p = arcPolyline(S, E, 1000n * MM);
    expect(p.length).toBe(65);
    expect(arcRadius(S, E, 1000n * MM).eq(Q.of(3625n * MM))).toBe(true);
    for (let i = 1; i < p.length - 1; i++) expect(orient(p[i - 1]!, p[i]!, p[i + 1]!)).toBe(-1);
    const C: [bigint, bigint] = [2500n * MM, 4000n * MM + 1000n * MM - 3625n * MM];
    for (const [x, y] of p) {
      const r = isqrt((x - C[0]) ** 2n + (y - C[1]) ** 2n);
      expect(r >= 3625n * MM - 3n && r <= 3625n * MM + 2n).toBe(true);
    }
  });

  it('is reversed with its edge', () => {
    const S: IPoint = [123457n, -98765n];
    const E: IPoint = [4567891n, 2345679n];
    const p = arcPolyline(S, E, 777777n);
    expect(arcPolyline(E, S, -777777n)).toEqual([...p].reverse());
  });

  it('rounds an irrational midpoint exactly', () => {
    // (1500 mm, 500 mm) + 500 (-1, 3) / sqrt 10 mm
    const m = arcMidpoint([0n, 0n], [3000n * MM, 1000n * MM], 500n * MM);
    expect(m).toEqual([1717614n, 1247157n]); // the oracle's value (tools/oracle/arcs.py)
  });

  it('fits at most a semicircle', () => {
    expect(arcFits([0n, 0n], [5000n, 0n], 2500n)).toBe(true);
    expect(arcFits([0n, 0n], [5000n, 0n], 2501n)).toBe(false);
  });
});

describe('lengths and stations (21.6)', () => {
  it('rounds a segment length once', () => {
    for (let m = 0n; m < 3000n; m++) expect(roundSqrt(m)).toBe((isqrt(4n * m) + 1n) / 2n);
  });

  it('places points along the polyline, half-open', () => {
    const p: IPoint[] = [
      [0n, 0n],
      [3000n, 4000n],
      [3000n, 10000n],
    ];
    expect(polylineLength(p)).toBe(11000n);
    expect(segmentAt(p, Q.of(5000n))).toEqual({ k: 1, s: 5000n, l: 6000n });
    expect(segmentAt(p, Q.of(11000n))?.k).toBe(1);
    expect(segmentAt(p, Q.of(11001n))).toBeUndefined();
    expect(pointAt(p, Q.of(2500n)).map((q) => q.toString())).toEqual(['1500', '2000']);
  });
});

describe('arc walls in a document', () => {
  const bay = (_h: number) =>
    doc({
      ...box(6400000, 5120000, 128000, { rooms: { R1: [3200000, 2560000] } }),
      extra: { floorspec: '0.4' },
    });

  it('derives a curved room whose area grows with an outward bulge', () => {
    const flat = check(bay(0));
    const d = bay(0) as { walls: Record<string, Record<string, unknown>> };
    d.walls.W2!.arc = { sagitta: 1280000 };
    const bent = check(d);
    expect(bent.valid).toBe(true);
    const a0 = BigInt(flat.derived!.rooms.R1!.area);
    const a1 = BigInt(bent.derived!.rooms.R1!.area);
    expect(a1 > a0).toBe(true);
    expect(bent.derived!.walls.W2!.polyline!.length).toBe(65);
  });

  it('cuts the face vertices a sharp join passes (21.4)', () => {
    const d = bay(0) as { walls: Record<string, Record<string, unknown>> };
    d.walls.W2!.arc = { sagitta: -1280000 };
    const r = check(d);
    expect(r.valid).toBe(true);
    const w = r.derived!.walls.W2!;
    expect(w.right!.length).toBeLessThan(w.left!.length);
  });

  it('reports an arc of more than a semicircle (FS-INV-113)', () => {
    const d = bay(0) as { walls: Record<string, Record<string, unknown>> };
    d.walls.W2!.arc = { sagitta: 3200001 };
    expect(check(d).diagnostics.map((x) => x.code)).toEqual(['FS-INV-113']);
  });
});
