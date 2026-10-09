/**
 * What a house looks like where its document names no material (FLR-T-12.23): one palette for the
 * editor's 3D view, the headless render, the path tracer and the glTF and USDZ exports, so the house
 * is the same colours on screen, in a picture and in a file.
 *
 * A document's own materials always win (Core 8.5, 18.1, 18.6): a face's material, its room's
 * `wallFinish`, its assembly's outer layer, a room's `floorFinish` and `ceilingFinish`, a roof's or a
 * slab's `material`. Only where none of them names a material — or the one named has no colour and
 * no map this view can read — is a surface drawn in a default, and that default follows what the room
 * is for (4.1): oak under living rooms and bedrooms, tile in a bath, a kitchen or a laundry, epoxy on a
 * garage's concrete, decking outdoors; warm-white paint on the walls, each function a tint of its
 * own. These are a view's choices, not the standard's (a mesh is not normative, Core 0.5).
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { get } from './own.js';

/** `#rrggbb`, sRGB. */
export type Hex = string;

/**
 * The colours of what the model names no material for, where nothing more particular applies — a
 * house's own surfaces, not interface colour, so the same in either theme.
 */
export const DEFAULT_COLOURS = {
  /** A wall's left (outside) face that faces no room, and a roof's gable end. */
  exterior: '#d6c9b2',
  /** A wall's right (inside) face that faces no room. */
  interior: '#efe9df',
  /** A wall's top, its ends and its openings' reveals, where its core layer names no material. */
  wallEdge: '#d5cab8',
  /** A floor of a room with no function this palette knows. */
  floor: '#b98a5c',
  ceiling: '#f4f1ea',
  slab: '#b3b0a8',
  roof: '#525965',
  gable: '#d6c9b2',
  stair: '#a97d54',
  fill: '#ddd5c7',
  extension: '#9aa0ae',
  glass: '#a9c7d6',
} as const satisfies Record<string, Hex>;
export type DefaultColour = keyof typeof DEFAULT_COLOURS;

/** What a room's unfinished surfaces are drawn as, by its function. */
export interface RoomPalette {
  /** The floor's colour, and what it stands for ("oak", "tile"). */
  readonly floor: Hex;
  readonly floorIs: string;
  /** The walls' paint, on the faces that face the room. */
  readonly wall: Hex;
  readonly ceiling: Hex;
}

const OAK = '#b98a5c';
const LIGHT_OAK = '#c29a6c';

/** Each Core room function's palette (4.1). An extension term, or no function, is `unspecified`. */
export const ROOM_PALETTE = {
  unspecified: { floor: OAK, floorIs: 'oak', wall: '#efe9df', ceiling: '#f4f1ea' },
  living: { floor: OAK, floorIs: 'oak', wall: '#f0e6d6', ceiling: '#f4f1ea' },
  dining: { floor: OAK, floorIs: 'oak', wall: '#eddccb', ceiling: '#f4f1ea' },
  sleeping: { floor: LIGHT_OAK, floorIs: 'oak', wall: '#dfe6ec', ceiling: '#f4f1ea' },
  office: { floor: OAK, floorIs: 'oak', wall: '#e2e8dc', ceiling: '#f4f1ea' },
  circulation: { floor: OAK, floorIs: 'oak', wall: '#efe9df', ceiling: '#f4f1ea' },
  storage: { floor: LIGHT_OAK, floorIs: 'oak', wall: '#ece7de', ceiling: '#f4f1ea' },
  kitchen: { floor: '#d8d0c2', floorIs: 'tile', wall: '#f4ecd9', ceiling: '#f4f1ea' },
  bath: { floor: '#cdd5d6', floorIs: 'tile', wall: '#dcecea', ceiling: '#f4f1ea' },
  laundry: { floor: '#cfd2cf', floorIs: 'tile', wall: '#e1e9ef', ceiling: '#f4f1ea' },
  utility: { floor: '#b9b4aa', floorIs: 'sealed concrete', wall: '#e8e4dc', ceiling: '#f1eee8' },
  mechanical: { floor: '#a8a59f', floorIs: 'sealed concrete', wall: '#e3e1dc', ceiling: '#ebe9e4' },
  garage: { floor: '#8f9598', floorIs: 'epoxy', wall: '#dcdad4', ceiling: '#e6e4df' },
  exterior: { floor: '#8d6a4b', floorIs: 'decking', wall: DEFAULT_COLOURS.exterior, ceiling: '#cdb08a' },
} as const satisfies Record<string, RoomPalette>;
export type PaletteFunction = keyof typeof ROOM_PALETTE;

/** The palette function of a room function: a Core term (4.1), else `unspecified`. */
export function paletteFunction(fn: string | undefined): PaletteFunction {
  return fn !== undefined && Object.hasOwn(ROOM_PALETTE, fn) ? (fn as PaletteFunction) : 'unspecified';
}

/** A default's colour, with the key a view caches its material by and a name for it. */
export interface Swatch {
  /** Unique per colour and use: `floor:bath`, `face:exterior`, `roof`. */
  readonly key: string;
  readonly color: Hex;
  /** In words: "bath floor (tile)". */
  readonly name: string;
}

/** A plain default as a swatch. */
export const swatch = (what: DefaultColour): Swatch => ({ key: what, color: DEFAULT_COLOURS[what], name: what });

export type FaceSide = 'left' | 'right';

/** How the surfaces of one document are drawn where it names no material. */
export interface Appearance {
  /** The room a wall's side faces (18.6 when it says, else the room just past the face), or undefined. */
  roomOf(wall: string, side: FaceSide): string | undefined;
  floor(room: string): Swatch;
  ceiling(room: string): Swatch;
  /** A wall face: its room's paint; outside, or facing an outdoor room, the exterior colour. */
  face(wall: string, side: FaceSide): Swatch;
}

/** How far past a face its room is looked for: 10 mm, in base units. */
const PAST_FACE = 12_800;

function inside(rings: readonly (readonly (readonly [number, number])[])[], x: number, y: number): boolean {
  let hit = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  return hit;
}

/** The room a face of a wall looks into, found just past the middle of the face (its middle segment, for an arc wall). */
function roomPast(doc: FloorspecDocument, derived: Derived, wall: string, side: FaceSide): string | undefined {
  const w = get(doc.walls, wall);
  const dw = derived.walls[wall];
  if (w === undefined || dw === undefined) return undefined;
  const S = get(doc.junctions, w.start)?.position;
  const E = get(doc.junctions, w.end)?.position;
  if (S === undefined || E === undefined) return undefined;
  const line = dw.polyline !== undefined && dw.polyline.length > 2 ? dw.polyline : [S, E];
  const k = Math.floor((line.length - 2) / 2);
  const a = line[k]!;
  const b = line[k + 1]!;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return undefined;
  // The face is the location line moved along its left normal; the room is a little further on.
  const l = [-dy / len, dx / len] as const;
  const f0 = side === 'left' ? dw.startLeft : dw.startRight;
  const l0x = line[1]![0] - line[0]![0];
  const l0y = line[1]![1] - line[0]![1];
  const at = ((f0[0] - line[0]![0]) * -l0y + (f0[1] - line[0]![1]) * l0x) / (Math.hypot(l0x, l0y) || 1);
  const d = at + (side === 'left' ? PAST_FACE : -PAST_FACE);
  const x = (a[0] + b[0]) / 2 + d * l[0];
  const y = (a[1] + b[1]) / 2 + d * l[1];
  for (const id of Object.keys(derived.rooms).sort()) {
    const room = get(doc.rooms, id);
    if (room === undefined || room.level !== w.level) continue;
    const poly = derived.rooms[id]!;
    if (inside([poly.outer, ...poly.holes], x, y)) return id;
  }
  return undefined;
}

/** The appearance of a document's unfinished surfaces, from what the engine derived of it. */
export function appearanceOf(doc: FloorspecDocument, derived: Derived | null): Appearance {
  const fnOf = (room: string | undefined): PaletteFunction => paletteFunction(room === undefined ? undefined : get(doc.rooms, room)?.function);
  const rooms = new Map<string, string | undefined>();
  const roomOf = (wall: string, side: FaceSide): string | undefined => {
    const key = `${wall}/${side}`;
    if (!rooms.has(key)) rooms.set(key, derived === null ? undefined : (derived.finishes?.walls[wall]?.[side]?.room ?? roomPast(doc, derived, wall, side)));
    return rooms.get(key);
  };
  return {
    roomOf,
    floor: (room) => {
      const fn = fnOf(room);
      const p = ROOM_PALETTE[fn];
      return { key: `floor:${fn}`, color: p.floor, name: `${fn} floor (${p.floorIs})` };
    },
    ceiling: (room) => {
      const fn = fnOf(room);
      return { key: `ceiling:${fn}`, color: ROOM_PALETTE[fn].ceiling, name: `${fn} ceiling` };
    },
    face: (wall, side) => {
      const room = roomOf(wall, side);
      if (room === undefined) return side === 'left' ? { key: 'face:exterior', color: DEFAULT_COLOURS.exterior, name: 'exterior wall' } : { key: 'face:interior', color: DEFAULT_COLOURS.interior, name: 'interior wall' };
      const fn = fnOf(room);
      if (fn === 'exterior') return { key: 'face:exterior', color: DEFAULT_COLOURS.exterior, name: 'exterior wall' };
      return { key: `wall:${fn}`, color: ROOM_PALETTE[fn].wall, name: `${fn} wall paint` };
    },
  };
}
