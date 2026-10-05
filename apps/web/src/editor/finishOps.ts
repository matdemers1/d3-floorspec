/** A wall's `finishes` (Core 0.3, 18.5) as the editor changes them: pure, tested on their own. */
import { setProperty, unsetProperty, type Batch } from './ops';

export type Side = 'left' | 'right';
export interface Region {
  from: number;
  to: number;
  bottom: number;
  top: number;
  material: string;
}
export interface Face {
  material?: string;
  regions?: Region[];
}
export type Finishes = Partial<Record<Side, Face>>;

/** The wall's finishes with one face changed, emptied faces and regions dropped (their constant defaults, Core 18.5). */
export function withFace(finishes: Finishes | undefined, side: Side, face: Face): Finishes {
  const clean: Face = {};
  if (face.material !== undefined) clean.material = face.material;
  if (face.regions !== undefined && face.regions.length > 0) clean.regions = face.regions;
  const other: Side = side === 'left' ? 'right' : 'left';
  const out: Finishes = {};
  const keep = finishes?.[other];
  if (keep !== undefined) out[other] = keep;
  if (Object.keys(clean).length > 0) out[side] = clean;
  return out;
}

/** setProperty of `/finishes`, or unsetProperty when nothing is left. */
export function setFinishes(wall: string, finishes: Finishes): Batch {
  return Object.keys(finishes).length === 0 ? unsetProperty(wall, '/finishes') : setProperty(wall, '/finishes', finishes);
}

