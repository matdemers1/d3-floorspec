/** Degrees as the site's fields show and read them: Core 2.4 angles, stored in microdegrees (FLR-T-8.6). */

import { MICRO } from './study';

export type Axis = 'latitude' | 'longitude' | 'north';

const LIMIT: Record<Axis, number> = { latitude: 90, longitude: 180, north: 180 };
const HEMI: Record<Exclude<Axis, 'north'>, [string, string]> = { latitude: ['N', 'S'], longitude: ['E', 'W'] };

/** Decimal degrees to at most six places, without trailing zeros. */
function decimal(v: number): string {
  return String(Number(v.toFixed(6)));
}

/** `42.3601° N`, `71.0589° W`; true north as a signed angle, `-12.5°`. */
export function formatDegrees(v: number, axis: Axis): string {
  if (axis === 'north') return `${decimal(v)}°`;
  const [pos, neg] = HEMI[axis];
  return `${decimal(Math.abs(v))}° ${v < 0 ? neg : pos}`;
}

/**
 * Degrees as a person types them — `42.3601`, `-71.0589`, `71.0589 W`, `42.36° N`, `−12.5` — to
 * whole microdegrees (Core 2.4), or an error to show. Ranges are Core's: latitude in [−90, 90],
 * longitude and true north in (−180, 180].
 */
export function parseDegrees(text: string, axis: Axis): { value: number } | { error: string } {
  const m = /^\s*([+\-−]?)\s*(\d+(?:\.\d+)?|\.\d+)\s*°?\s*([NSEWnsew])?\s*$/.exec(text);
  if (m === null) return { error: axis === 'north' ? 'Degrees, such as -12.5' : axis === 'latitude' ? 'Degrees, such as 42.36 N' : 'Degrees, such as 71.06 W' };
  let v = Number(m[2]);
  if (m[1] === '-' || m[1] === '−') v = -v;
  const letter = m[3]?.toUpperCase();
  if (letter !== undefined) {
    if (axis === 'north') return { error: 'An angle, without a compass letter' };
    const [pos, neg] = HEMI[axis];
    if (letter !== pos && letter !== neg) return { error: `${pos} or ${neg}` };
    if (letter === neg) v = -Math.abs(v);
    else v = Math.abs(v);
  }
  const micro = Math.round(v * MICRO);
  const max = LIMIT[axis] * MICRO;
  if (axis === 'latitude' ? Math.abs(micro) > max : micro <= -max || micro > max) {
    return { error: axis === 'latitude' ? 'From 90 S to 90 N' : axis === 'longitude' ? 'From 180 W to 180 E' : 'Greater than −180 and at most 180' };
  }
  return { value: micro };
}
