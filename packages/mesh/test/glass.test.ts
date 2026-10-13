import { describe, expect, it } from 'vitest';
import { DEFAULT_COLOURS, GLASS_F0, GLASS_GLSL, GLASS_IOR, glassAt, glassFresnel, paneTransmission, ROLE_LOOKS } from '../src/index.js';

/** `#rrggbb` to linear RGB. */
const linear = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

/**
 * FLR-T-13.17: how every view sees a pane of glass. Clear glazing barely tints what is behind it —
 * about 90% through face on, the faintest green — and reflects more, and tints a little more, at a
 * slant; drawn before as a pale blue surface at 35%, a window turned the lawn behind it teal.
 */
describe('glass', () => {
  it('lets about 90% through face on, clear glazing a faint green and nothing like blue', () => {
    for (const colour of [ROLE_LOOKS.glass.color, DEFAULT_COLOURS.glass]) {
      const t = paneTransmission(linear(colour));
      for (const c of t) {
        expect(c).toBeGreaterThan(0.86);
        expect(c).toBeLessThanOrEqual(0.9216 + 1e-9);
      }
      // The green its iron gives it, a few percent at most: green highest, blue not above it.
      expect(t[1]).toBeGreaterThanOrEqual(t[0]);
      expect(t[1]).toBeGreaterThanOrEqual(t[2]);
      expect(t[1] - Math.min(...t)).toBeLessThan(0.04);
    }
    // A tinted glass is its tint: bronze lets less blue through than red.
    const bronze = paneTransmission(linear('#8b7a64'));
    expect(bronze[2]).toBeLessThan(bronze[0] * 0.85);
  });

  it('reflects 4% face on and more at a slant, letting less through and a little greener', () => {
    const pane = paneTransmission(linear(ROLE_LOOKS.glass.color));
    const face = new Float64Array(3);
    const slant = new Float64Array(3);
    expect(glassAt(pane, 1, face)).toBeCloseTo(GLASS_F0, 9);
    for (let c = 0; c < 3; c++) expect(face[c]).toBeCloseTo(pane[c]!, 9);
    const f = glassAt(pane, 0.15, slant);
    expect(f).toBeGreaterThan(0.3);
    expect(glassFresnel(0)).toBeCloseTo(1, 9);
    for (let c = 0; c < 3; c++) expect(slant[c]).toBeLessThan(face[c]!);
    expect(slant[1]! / slant[0]!).toBeGreaterThan(face[1]! / face[0]!);
    // Never more through than in: energy kept at every angle.
    for (let cos = 0; cos <= 1; cos += 0.05) {
      const t = new Float64Array(3);
      const r = glassAt(pane, cos, t);
      for (let c = 0; c < 3; c++) expect(t[c]! + r).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('is the same rule in GLSL (FLR-T-13.7): the constants, and both functions', () => {
    const define = (name: string): number => Number(new RegExp(`#define ${name} ([0-9.]+)`).exec(GLASS_GLSL)?.[1]);
    expect(define('GLASS_F0')).toBeCloseTo(GLASS_F0, 6);
    expect(define('GLASS_IOR')).toBeCloseTo(GLASS_IOR, 6);
    expect(define('GLASS_FACES')).toBeCloseTo((1 - GLASS_F0) ** 2, 6);
    expect(GLASS_GLSL).toContain('float glassFresnel( float cosine )');
    expect(GLASS_GLSL).toContain('vec3 glassTransmission( vec3 pane, float cosine )');
    // The GLSL, read as arithmetic, gives glassAt's numbers.
    const pane = paneTransmission(linear(DEFAULT_COLOURS.glass));
    for (const cos of [1, 0.7, 0.3, 0.05]) {
      const f = GLASS_F0 + (1 - GLASS_F0) * (1 - cos) ** 5;
      const inside = Math.sqrt(1 - (1 - cos * cos) / (GLASS_IOR * GLASS_IOR));
      const glsl = pane.map((p) => (1 - f) ** 2 * Math.min(1, p / define('GLASS_FACES')) ** (1 / inside));
      const out: [number, number, number] = [0, 0, 0];
      expect(glassAt(pane, cos, out)).toBeCloseTo(f, 9);
      for (let k = 0; k < 3; k++) expect(glsl[k]).toBeCloseTo(out[k] ?? Number.NaN, 5);
    }
  });
});

