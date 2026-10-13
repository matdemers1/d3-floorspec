import * as THREE from 'three';

/**
 * The tone curves the 3D view draws through, on the CPU (FLR-T-13.7). Draft tone-maps in every
 * material's shader, and a material can opt out (`toneMapped: false`: a selection's outline, a lit
 * lens). Presentation draws the scene in linear light into a float buffer and tone-maps the whole
 * picture once at the end, so a colour that must reach the screen as it is — the theme's accent, the
 * backdrop — is given here what the curve turns back into it: its inverse.
 */

/** Narkowicz's fit of ACES (SkyScene's `CustomToneMapping`): the renderers' filmic curve, per channel. */
export function narkowicz(x: number, exposure: number): number {
  const c = (x * exposure) / 0.6;
  return Math.min(1, Math.max(0, (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14)));
}

const rrt = (v: number): number => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);

/** three.js's `ACESFilmicToneMapping` (the studio's): the RRT and ODT fit between its colour matrices. */
export function acesFilmic(rgb: readonly [number, number, number], exposure: number): [number, number, number] {
  const k = exposure / 0.6;
  const [r, g, b] = [rgb[0] * k, rgb[1] * k, rgb[2] * k];
  // Column-major as in the shader: ACESInputMat * color.
  const i0 = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const i1 = 0.076 * r + 0.90834 * g + 0.01566 * b;
  const i2 = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  const [a, m, c] = [rrt(i0), rrt(i1), rrt(i2)];
  const o0 = 1.60475 * a - 0.53108 * m - 0.07367 * c;
  const o1 = -0.10208 * a + 1.10813 * m - 0.00605 * c;
  const o2 = -0.00327 * a - 0.07276 * m + 1.07602 * c;
  const sat = (x: number) => Math.min(1, Math.max(0, x));
  return [sat(o0), sat(o1), sat(o2)];
}

/** What a tone mapping makes of a linear colour at an exposure (three.js's `toneMappingExposure`). */
export function toneMap(rgb: readonly [number, number, number], mapping: THREE.ToneMapping, exposure: number): [number, number, number] {
  if (mapping === THREE.CustomToneMapping) return [narkowicz(rgb[0], exposure), narkowicz(rgb[1], exposure), narkowicz(rgb[2], exposure)];
  if (mapping === THREE.ACESFilmicToneMapping) return acesFilmic(rgb, exposure);
  if (mapping === THREE.NoToneMapping) return [rgb[0], rgb[1], rgb[2]];
  // The view uses no other; linear is the nearest honest answer.
  return [rgb[0] * exposure, rgb[1] * exposure, rgb[2] * exposure];
}

/**
 * The linear colour the curve maps onto `display` (linear, before the screen's sRGB encoding): what to
 * draw so that, tone-mapped, it reads as `display`. A display value of 1 has no finite preimage, so
 * channels are held just under it. Solved by multiplicative correction, which converges for these
 * monotone, nearly diagonal curves.
 */
export function untoneMap(display: readonly [number, number, number], mapping: THREE.ToneMapping, exposure: number): [number, number, number] {
  const target = display.map((v) => Math.min(0.985, Math.max(0, v))) as [number, number, number];
  let x: [number, number, number] = [target[0] / Math.max(exposure, 1e-9), target[1] / Math.max(exposure, 1e-9), target[2] / Math.max(exposure, 1e-9)];
  for (let i = 0; i < 60; i++) {
    const y = toneMap(x, mapping, exposure);
    x = x.map((v, k) => {
      const t = target[k] ?? 0;
      const got = y[k] ?? 0;
      if (t <= 1e-6) return 0;
      if (got <= 1e-9) return Math.max(v * 4, 1e-6);
      return v * Math.min(4, Math.max(0.25, t / got));
    }) as [number, number, number];
  }
  return x;
}
