import { describe, expect, it } from 'vitest';
import { area2, clip, extent, iarea2, Rat, remainder, rpoint, type IPoint } from '../src/exact.js';

const sq: IPoint[] = [[0n, 0n], [10n, 0n], [10n, 10n], [0n, 10n]];

describe('exact plan arithmetic', () => {
  it('reduces and compares rationals', () => {
    expect(new Rat(6n, -4n).reduce()).toEqual(new Rat(-3n, 2n));
    expect(new Rat(1n, 3n).add(new Rat(1n, 6n)).cmp(new Rat(1n, 2n))).toBe(0);
    expect(new Rat(7n, 2n).toNumber()).toBe(3.5);
    expect(new Rat(-7n, 2n).toNumber()).toBe(-3.5);
    expect(() => new Rat(1n, 0n)).toThrow(RangeError);
  });
  it('clips a polygon to a half-plane with a rational crossing', () => {
    // x + 2y ≥ 5 keeps the part of the square above the line through (5, 0) and (0, 2.5).
    const kept = clip(sq.map(rpoint), { a: [1n, 2n], c: 5n, s: 1 });
    expect(area2(kept).toNumber()).toBe(200 - 12.5);
    const below = clip(sq.map(rpoint), { a: [1n, 2n], c: 5n, s: -1 });
    expect(area2(below).toNumber()).toBe(12.5);
    expect(extent(below)!.max.map((r) => r.toNumber())).toEqual([5, 2.5]);
  });
  it('clips to a strip, and to nothing', () => {
    const strip = clip(clip(sq.map(rpoint), { a: [1n, 0n], c: 3n, s: 1 }), { a: [1n, 0n], c: 4n, s: -1 });
    expect(area2(strip).toNumber()).toBe(20);
    expect(clip(sq.map(rpoint), { a: [1n, 0n], c: 11n, s: 1 })).toEqual([]);
    expect(iarea2(sq)).toBe(200n);
  });
  it('leaves the regularized remainder of an interval', () => {
    expect(remainder(0n, 10n, [])).toEqual([[0n, 10n]]);
    expect(remainder(0n, 10n, [[2n, 4n], [3n, 6n]])).toEqual([[0n, 2n], [6n, 10n]]);
    // Touching cuts leave nothing between them: a single elevation is not a solid.
    expect(remainder(0n, 10n, [[0n, 4n], [4n, 10n]])).toEqual([]);
    expect(remainder(0n, 10n, [[-5n, 20n]])).toEqual([]);
  });
});
