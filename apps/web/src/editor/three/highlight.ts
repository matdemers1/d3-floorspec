import type * as THREE from 'three';

/**
 * A selection's glow in the 3D view: the emissive accent a selected part is drawn with. Emissive
 * light goes through the tone curve like any other, so under a sky exposed for 100 000 lux of sun
 * (FLR-T-13.4) a glow of 0.55 would be lost; it is given back what the view's exposure takes.
 */
const GLOW = 0.55;
const glowing = new Set<THREE.Material & { emissiveIntensity: number }>();
let exposure = 1;

/** A material that glows when selected; its glow follows the view's exposure. */
export function glow<M extends THREE.Material & { emissiveIntensity: number }>(m: M): M {
  glowing.add(m);
  m.emissiveIntensity = GLOW / exposure;
  m.addEventListener('dispose', () => { glowing.delete(m); });
  return m;
}

/** The view's tone-mapping exposure, as three.js has it. */
export function setHighlightExposure(toneExposure: number): void {
  exposure = Math.max(1e-9, toneExposure);
  for (const m of glowing) m.emissiveIntensity = GLOW / exposure;
}
