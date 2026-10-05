/**
 * The orbit camera's arithmetic (FLR-T-7.5), kept out of three.js so it can be tested: a target, an
 * azimuth and an elevation around it, and a distance. Everything is in the document's own frame —
 * x east, y north, z up — in metres relative to the mesh's origin; the scene's camera sets
 * `up = +z` and looks at the target, so nothing is re-oriented.
 */

export type Vec3 = [number, number, number];

export interface Orbit {
  target: Vec3;
  /** Where the camera stands around the target, radians anticlockwise from east. */
  azimuth: number;
  /** Above the target's horizon, radians. */
  elevation: number;
  distance: number;
}

export type PresetId = 'sw' | 'se' | 'ne' | 'nw' | 'top';

/** An isometric elevation: the camera on a cube's diagonal. */
const ISO = Math.atan(1 / Math.SQRT2);
const DEG = Math.PI / 180;
const MAX_ELEVATION = 89.5 * DEG;
const MIN_ELEVATION = -10 * DEG;

export const PRESETS: Record<PresetId, { label: string; azimuth: number; elevation: number }> = {
  sw: { label: 'SW iso', azimuth: -135 * DEG, elevation: ISO },
  se: { label: 'SE iso', azimuth: -45 * DEG, elevation: ISO },
  ne: { label: 'NE iso', azimuth: 45 * DEG, elevation: ISO },
  nw: { label: 'NW iso', azimuth: 135 * DEG, elevation: ISO },
  top: { label: 'Top', azimuth: -90 * DEG, elevation: MAX_ELEVATION },
};

/** The order the view cube steps through. */
export const PRESET_ORDER: readonly PresetId[] = ['sw', 'se', 'ne', 'nw', 'top'];

export const MIN_DISTANCE = 0.5;
export const MAX_DISTANCE = 800;

export const clampElevation = (e: number): number => Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, e));
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** The camera's position. */
export function eyeOf(o: Orbit): Vec3 {
  const c = Math.cos(o.elevation);
  return [o.target[0] + o.distance * c * Math.cos(o.azimuth), o.target[1] + o.distance * c * Math.sin(o.azimuth), o.target[2] + o.distance * Math.sin(o.elevation)];
}

/** A box framed from a preset: the distance at which its bounding sphere fills the narrower field of view. */
export function fitOrbit(box: { min: Vec3; max: Vec3 }, preset: PresetId, fovDeg: number, aspect: number): Orbit {
  const target: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const radius = Math.max(0.5, Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2);
  const vertical = (fovDeg * DEG) / 2;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(aspect, 0.1));
  const half = Math.min(vertical, horizontal);
  const p = PRESETS[preset];
  return { target, azimuth: p.azimuth, elevation: p.elevation, distance: Math.min(MAX_DISTANCE, (radius / Math.sin(half)) * 1.04) };
}

export function orbitBy(o: Orbit, dAzimuth: number, dElevation: number): Orbit {
  return { ...o, azimuth: wrap(o.azimuth + dAzimuth), elevation: clampElevation(o.elevation + dElevation) };
}

/** Closer (factor < 1) or further (> 1). */
export function zoomBy(o: Orbit, factor: number): Orbit {
  return { ...o, distance: Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, o.distance * factor)) };
}

/** The camera's right and up directions, unit vectors. */
export function basisOf(o: Orbit): { right: Vec3; up: Vec3; forward: Vec3 } {
  const c = Math.cos(o.elevation);
  const forward: Vec3 = [-c * Math.cos(o.azimuth), -c * Math.sin(o.azimuth), -Math.sin(o.elevation)];
  // right = forward × z, normalised: (fy, −fx, 0) / |…|; it is (−sin az, cos az, 0) for any elevation.
  const right: Vec3 = [-Math.sin(o.azimuth), Math.cos(o.azimuth), 0];
  const up: Vec3 = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  return { right, up, forward };
}

/**
 * Drag the scene by a number of pixels: the point under the cursor follows it (at the target's
 * depth). `heightPx` is the viewport's height, `fovDeg` the vertical field of view.
 */
export function panBy(o: Orbit, dxPx: number, dyPx: number, heightPx: number, fovDeg: number): Orbit {
  const perPx = (2 * o.distance * Math.tan((fovDeg * DEG) / 2)) / Math.max(1, heightPx);
  const { right, up } = basisOf(o);
  return {
    ...o,
    target: [
      o.target[0] - right[0] * dxPx * perPx + up[0] * dyPx * perPx,
      o.target[1] - right[1] * dxPx * perPx + up[1] * dyPx * perPx,
      o.target[2] - right[2] * dxPx * perPx + up[2] * dyPx * perPx,
    ],
  };
}

/** The preset the camera is at, if it is at one. */
export function presetOf(o: Orbit): PresetId | null {
  for (const id of PRESET_ORDER) {
    const p = PRESETS[id];
    if (Math.abs(wrap(o.azimuth - p.azimuth)) < 1e-3 && Math.abs(o.elevation - p.elevation) < 1e-3) return id;
  }
  return null;
}

/** The compass direction a horizontal heading points, for people: "north-east". */
export function compass(yaw: number): string {
  const names = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  const i = Math.round(wrap(yaw) / (Math.PI / 4));
  return names[((i % 8) + 8) % 8] ?? 'east';
}
