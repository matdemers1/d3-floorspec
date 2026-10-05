import type { RoomView } from './model';

/**
 * Floors and ceilings, the editor's pure part (Core 0.3, chapter 15): a starting ceiling of each
 * kind, for the inspector to set when the kind changes.
 */

type Json = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export type CeilingKind = 'flat' | 'tray' | 'vaulted';

/** A starting ceiling of each kind, from the room's polygon — values to edit, not derived ones. */
export function startingCeiling(kind: CeilingKind, current: Json | undefined, room: RoomView | undefined, base: number): Json {
  const height = num(current?.['height']);
  if (kind === 'flat') return { kind, ...(height === undefined ? {} : { height }) };
  if (kind === 'tray') return { kind, ...(height === undefined ? {} : { height }), border: 390_144, depth: 195_072 };
  // A vault: its ridge along the room's longer side, through its middle, high enough that it meets
  // the walls at the height the ceiling had (pitch 4:12).
  const xs = (room?.outer ?? [[0, 0]]).map((p) => p[0]);
  const ys = (room?.outer ?? [[0, 0]]).map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const wide = x1 - x0 >= y1 - y0;
  const ridge = wide
    ? [[x0, Math.round((y0 + y1) / 2)], [x1, Math.round((y0 + y1) / 2)]]
    : [[Math.round((x0 + x1) / 2), y0], [Math.round((x0 + x1) / 2), y1]];
  const half = (wide ? y1 - y0 : x1 - x0) / 2;
  return { kind, height: (height ?? base) + Math.ceil((half * 4) / 12), ridge, pitch: { rise: 4, run: 12 } };
}

