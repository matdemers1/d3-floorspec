import { directionOf, wrapYaw, type YawPitch } from '@floorspec/mesh';

/**
 * Where the tour viewer looks (FLR-T-14.2): a yaw (degrees clockwise from project north), a pitch
 * and a vertical field of view — and where a direction lands on the screen, which places a doorway's
 * hotspot over the panorama. The same frame the worker renders panoramas in (@floorspec/mesh tour.ts).
 */

export interface Look {
  readonly yaw: number;
  readonly pitch: number;
  /** Vertical field of view, degrees. */
  readonly fov: number;
}

export const FOV_MIN = 30;
export const FOV_MAX = 100;
export const FOV_DEFAULT = 75;
/** A little below the horizon: the floor and the doorways' thresholds in view, as a person looks into a room. */
export const PITCH_DEFAULT = -15;
/** How far up or down the view may tip: not quite straight up, where the yaw stops meaning anything. */
export const PITCH_MAX = 85;

export function clampLook(look: Look): Look {
  return { yaw: wrapYaw(look.yaw), pitch: Math.max(-PITCH_MAX, Math.min(PITCH_MAX, look.pitch)), fov: Math.max(FOV_MIN, Math.min(FOV_MAX, look.fov)) };
}

type V3 = readonly [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The camera's basis in the project frame: forward, right and up. */
export function basisOf(look: Pick<Look, 'yaw' | 'pitch'>): { forward: V3; right: V3; up: V3 } {
  const forward = directionOf(look);
  const right = directionOf({ yaw: look.yaw + 90, pitch: 0 });
  // up = right × forward
  const up: V3 = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  return { forward, right, up };
}

/** Where a direction is on a screen `width` × `height` (CSS pixels, from the top left); null behind or beside the camera. */
export function onScreen(look: Look, d: YawPitch, width: number, height: number): { x: number; y: number } | null {
  const v = directionOf(d);
  const b = basisOf(look);
  const z = dot(v, b.forward);
  if (z < 0.05) return null;
  const tanY = Math.tan((look.fov * Math.PI) / 360);
  const tanX = tanY * (width / height);
  const x = dot(v, b.right) / z / tanX;
  const y = dot(v, b.up) / z / tanY;
  if (Math.abs(x) > 1.3 || Math.abs(y) > 1.3) return null;
  return { x: ((x + 1) / 2) * width, y: ((1 - y) / 2) * height };
}

/** A drag of `dx`, `dy` CSS pixels on a screen `height` tall: the panorama follows the finger. */
export function dragged(look: Look, dx: number, dy: number, height: number): Look {
  const perPixel = look.fov / Math.max(1, height);
  return clampLook({ ...look, yaw: look.yaw - dx * perPixel, pitch: look.pitch + dy * perPixel });
}

/** The look of a phone held up (deviceorientation's alpha, beta, gamma, degrees) relative to where it was when turned on. */
export function fromOrientation(alpha: number, beta: number, start: { alpha: number; yaw: number }, fov: number): Look {
  // Held upright in portrait, beta 90° looks at the horizon; alpha turns anticlockwise.
  return clampLook({ yaw: start.yaw - (alpha - start.alpha), pitch: beta - 90, fov });
}
