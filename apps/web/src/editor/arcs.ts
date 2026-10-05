/**
 * Arc edges in the editor (Core 0.4, chapter 21): distances to a polyline, stations along it, and the
 * sagitta of a bulge. Display and pointer arithmetic only: every normative value — the polyline, an
 * arc wall's length, where its openings stand — comes from the engine.
 */
import type { Point } from './model';

const hyp = (x: number, y: number): number => Math.hypot(x, y);

/** The least distance from p to a polyline. */
export function distanceToLine(p: Point, line: readonly Point[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = (line[i - 1] as Point);
    const b = (line[i] as Point);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    best = Math.min(best, hyp(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
}

/** Each segment's length, rounded as Core 21.6 rounds it. */
export function segmentLengths(line: readonly Point[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < line.length; i++) out.push(Math.round(hyp((line[i] as Point)[0] - (line[i - 1] as Point)[0], (line[i] as Point)[1] - (line[i - 1] as Point)[1])));
  return out;
}

/**
 * A pointer seen from a polyline: `along`, the station of its nearest point (21.6), `across`, its signed
 * distance to the left of the polyline there, and the polyline's length L.
 */
export function stationOf(line: readonly Point[], p: Point): { along: number; across: number; L: number } {
  const ls = segmentLengths(line);
  let s = 0;
  let best = { d: Infinity, along: 0, across: 0 };
  for (let i = 1; i < line.length; i++) {
    const a = (line[i - 1] as Point);
    const b = (line[i] as Point);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = hyp(dx, dy) || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (l * l)));
    const q: Point = [a[0] + t * dx, a[1] + t * dy];
    const d = hyp(p[0] - q[0], p[1] - q[1]);
    if (d < best.d) best = { d, along: s + t * (ls[i - 1] as number), across: (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / l };
    s += (ls[i - 1] as number);
  }
  return { along: best.along, across: best.across, L: s };
}

/** The point at station t along a polyline (21.6). */
export function pointAtStation(line: readonly Point[], t: number): Point {
  const ls = segmentLengths(line);
  let s = 0;
  for (let i = 1; i < line.length; i++) {
    const l = (ls[i - 1] as number);
    if (t <= s + l || i === line.length - 1) {
      const f = l === 0 ? 0 : (t - s) / l;
      const a = (line[i - 1] as Point);
      const b = (line[i] as Point);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    s += l;
  }
  return (line[line.length - 1] as Point);
}

/** The signed sagitta of the arc from a to b through the side of the chord p is on: its distance to the left of the chord, at most half the chord (21.1.2). */
export function sagittaToward(a: Point, b: Point, p: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const c = hyp(dx, dy) || 1;
  const m: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const h = (dx * (p[1] - m[1]) - dy * (p[0] - m[0])) / c;
  return Math.round(Math.max(-c / 2, Math.min(c / 2, h)));
}

/** The sagitta of an arc of radius R on a chord c (R ≥ c/2), signed. */
export function sagittaFromRadius(c: number, R: number, sign: 1 | -1): number {
  const r = Math.max(R, c / 2);
  return sign * Math.round(r - Math.sqrt(r * r - (c * c) / 4));
}

/** A smooth curve through an arc from a to b with sagitta h, for drawing a draft: n + 1 points. */
export function arcPoints(a: Point, b: Point, h: number, n = 48): Point[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const c = hyp(dx, dy);
  if (c === 0 || h === 0) return [a, b];
  const R = (c * c + 4 * h * h) / (8 * Math.abs(h));
  const nx = -dy / c;
  const ny = dx / c;
  const m: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const k = h - Math.sign(h) * R; // from the chord's midpoint to the centre, along the left normal
  const C: Point = [m[0] + nx * k, m[1] + ny * k];
  const t0 = Math.atan2(a[1] - C[1], a[0] - C[0]);
  let t1 = Math.atan2(b[1] - C[1], b[0] - C[0]);
  // A positive sagitta bulges left: walking from a to b the arc turns clockwise.
  if (h > 0) while (t1 > t0) t1 -= 2 * Math.PI;
  else while (t1 < t0) t1 += 2 * Math.PI;
  return Array.from({ length: n + 1 }, (_, i): Point => {
    const t = t0 + ((t1 - t0) * i) / n;
    return [C[0] + R * Math.cos(t), C[1] + R * Math.sin(t)];
  });
}
