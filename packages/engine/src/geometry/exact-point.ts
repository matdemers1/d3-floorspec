/**
 * Exact points and the face lines of 5.5. A face line is `A·x + B·y = C` with integer A, B and
 * C = p + q·√(dx² + dy²); its intersections and feet are points whose coordinates are Surds, which
 * are rounded once, at output (2.2).
 */
import { Surd } from '../exact/surd.js';
import { toSafeNumber } from '../exact/bigint.js';
import type { IPoint } from './predicates.js';

export interface XPoint {
  readonly x: Surd;
  readonly y: Surd;
}

export interface Line {
  readonly A: bigint;
  readonly B: bigint;
  readonly C: Surd;
}

export const xpoint = (p: IPoint): XPoint => ({ x: Surd.of(p[0]), y: Surd.of(p[1]) });

export const xeq = (p: XPoint, q: XPoint): boolean => p.x.equals(q.x) && p.y.equals(q.y);

/** round() each coordinate, ties to even (2.2). */
export const roundPoint = (p: XPoint): IPoint => [p.x.round(), p.y.round()];

export const toNumbers = (p: IPoint): [number, number] => [toSafeNumber(p[0]), toSafeNumber(p[1])];

/**
 * The face line at junction J of an edge with outgoing direction d (5.5): `n · (P − J) = s · |d|`
 * with n = (−dy, dx) and s = offset2 / 2 — λ for the left face line, −ρ for the right. Offsets are
 * passed doubled, so a centre-justified wall of odd thickness stays in integers.
 */
export function faceLine(J: IPoint, d: IPoint, offset2: bigint): Line {
  const A = -d[1];
  const B = d[0];
  const m = d[0] * d[0] + d[1] * d[1];
  const nJ = A * J[0] + B * J[1];
  const C = Surd.of(nJ).add(Surd.sqrt(m).mulInt(offset2).divInt(2n));
  return { A, B, C };
}

/** The intersection of two non-parallel lines, by Cramer's rule. */
export function intersect(l1: Line, l2: Line): XPoint {
  const D = l1.A * l2.B - l2.A * l1.B;
  if (D === 0n) throw new Error('intersect: parallel lines');
  const x = l1.C.mulInt(l2.B).sub(l2.C.mulInt(l1.B)).divInt(D);
  const y = l2.C.mulInt(l1.A).sub(l1.C.mulInt(l2.A)).divInt(D);
  return { x, y };
}

/** The foot of J on its face line at signed offset s = offset2 / 2: J + s · n / |d| (5.5). */
export function foot(J: IPoint, d: IPoint, offset2: bigint): XPoint {
  const m = d[0] * d[0] + d[1] * d[1];
  // s·n/|d| = s·n·√m / m
  const k = Surd.sqrt(m).mulInt(offset2).divInt(2n * m);
  return { x: k.mulInt(-d[1]).addInt(J[0]), y: k.mulInt(d[0]).addInt(J[1]) };
}
