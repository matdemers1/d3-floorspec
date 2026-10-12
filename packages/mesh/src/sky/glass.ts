/**
 * How a pane of glass is seen in every view (FLR-T-13.17): what it lets through and what it reflects,
 * by the angle it is seen at — one rule the editor, the headless render, the path tracer and the
 * glTF (whose KHR_materials_transmission the GPU still traces) all follow, so clear glazing barely
 * tints the garden seen through it in any of them.
 *
 * A pane of clear float glass lets about 90% of the light through at normal incidence: each of its
 * two faces reflects 4% (Fresnel at n = 1.5), and its iron a little more of the red and blue than the
 * green — the green its edge shows. Seen at a slant, its faces reflect more (Schlick's approximation)
 * and the light's path through it is longer, so a pane seen edge-on is a mirror with a green cast.
 * Drawn before as a pale blue surface 35% opaque, a window turned the lawn behind it into teal sea.
 *
 * Isomorphic: square roots only, no trigonometry.
 */

export type Rgb = [number, number, number];

/** A face's reflectance at normal incidence: glass, n = 1.5. */
export const GLASS_F0 = 0.04;
/** The pane's index of refraction. */
export const GLASS_IOR = 1.5;
/** What both faces let through at normal incidence: (1 − F0)². */
const FACES = (1 - GLASS_F0) ** 2;
/** How strongly a glass's colour tints what is seen through it: the colour's chroma to this power. */
const TINT = 0.35;

/**
 * What a pane lets through at normal incidence, linear RGB, from the colour a document or a look gives
 * its glass (linear RGB): its faces' 92%, times its colour's chroma softened — clear glass's faint
 * green-grey is about (0.89, 0.92, 0.90); a bronze glass is browner.
 */
export function paneTransmission(color: readonly [number, number, number]): Rgb {
  const m = Math.max(color[0], color[1], color[2], 1e-6);
  return [FACES * (color[0] / m) ** TINT, FACES * (color[1] / m) ** TINT, FACES * (color[2] / m) ** TINT];
}

/** Schlick's Fresnel reflectance of a glass face seen at `cos` (|n · v|). */
export function glassFresnel(cos: number): number {
  const c = Math.min(1, Math.max(0, cos));
  const k = 1 - c;
  return GLASS_F0 + (1 - GLASS_F0) * k * k * k * k * k;
}

/**
 * A pane of normal-incidence transmission `pane` (paneTransmission's) seen at `cos`: what it lets
 * through, into `out` (linear RGB), and what its face reflects — returned. The light's path in the
 * glass lengthens as 1 / cos of its angle inside (Snell, n = 1.5), its absorption with it.
 */
export function glassAt(pane: readonly [number, number, number], cos: number, out: Rgb | Float64Array): number {
  const c = Math.min(1, Math.max(0, cos));
  const f = glassFresnel(c);
  const inside = Math.sqrt(1 - (1 - c * c) / (GLASS_IOR * GLASS_IOR));
  const faces = (1 - f) * (1 - f);
  for (let k = 0; k < 3; k++) out[k] = faces * Math.min(1, (pane[k]! / FACES)) ** (1 / inside);
  return f;
}
