/**
 * Seeded randomness for the path tracer: every pixel of every pass draws from its own stream, keyed
 * by the seed, the pass and the pixel — so a still does not depend on the order pixels are traced
 * in, or on how many threads trace them, and the same options make the same PNG.
 */

/** A 32-bit integer hash (lowbias32, Chris Wellons). */
export function hash32(x: number): number {
  let a = x >>> 0;
  a ^= a >>> 16;
  a = Math.imul(a, 0x7feb352d);
  a ^= a >>> 15;
  a = Math.imul(a, 0x846ca68b);
  a ^= a >>> 16;
  return a >>> 0;
}

/** mulberry32: small, fast, and good enough to sample light paths with. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Re-key the stream for one pixel of one pass. */
  reseed(seed: number, pass: number, pixel: number): void {
    this.s = hash32(hash32(seed ^ Math.imul(pass + 1, 0x9e3779b9)) ^ hash32(pixel + 0x632be5ab));
  }
}
