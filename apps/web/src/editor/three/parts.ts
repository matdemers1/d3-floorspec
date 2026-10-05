import type { MeshPart, PartKind } from '@floorspec/mesh';
import type { EditorModel, WallView } from '../model';

/**
 * What the 3D view does with each meshed part (FLR-T-7.5), without three.js: which element a part
 * selects, which parts show for a level and a cutaway, and what colour each face is drawn in —
 * from the document's own materials (Core 8.5), the walls' layers (8.3) and the rooms' finishes
 * (6.5), with quiet defaults where the model names none.
 */

/**
 * The element a part selects: the part's own `id` — a wall for a wall, the opening for its cut
 * (a window's glass, a door's pick target), the room for its floor and ceiling, the stair for each
 * of its flights and landings, the roof for its gable ends.
 */
export const elementOfPart = (part: Pick<MeshPart, 'id'>): string => part.id;

/** The parts that belong to an element: what lights up in 3D when it is selected anywhere. */
export function partsOfElement<T extends Pick<MeshPart, 'id'>>(parts: readonly T[], id: string | null): T[] {
  return id === null ? [] : parts.filter((p) => p.id === id);
}

export type Look = 'solid' | 'floor' | 'ceiling' | 'glass' | 'pick';

/**
 * How a part is drawn: opaque; a floor or a ceiling — opaque, and drawn in front of what shares
 * its plane (a wall running floor to floor ends at the top of the floor above; a ceiling at the
 * level's floor-to-floor height meets that floor's underside); as glass (a window); or not at all
 * but still clickable (a door's or an empty opening's cut).
 */
export function lookOf(part: Pick<MeshPart, 'kind' | 'opening'>): Look {
  if (part.kind === 'ceiling') return 'ceiling';
  if (part.kind === 'floor' || part.kind === 'slab') return 'floor';
  if (part.kind !== 'opening') return 'solid';
  return part.opening?.category === 'window' ? 'glass' : 'pick';
}

const ROOFS: ReadonlySet<PartKind> = new Set(['roof', 'roofGable']);

export interface Visibility {
  walking: boolean;
  cutaway: boolean;
  roof: boolean;
  /** The current level. */
  level: string | null;
  /** Each level's place, lowest first. */
  order: ReadonlyMap<string, number>;
}

/**
 * What shows. Walking shows the whole house. Otherwise the cutaway shows the levels up to the
 * current one and leaves off the current level's ceilings, so the rooms are seen from above; without
 * it every level shows. The roof shows when it is on and its level shows.
 */
export function isVisible(part: Pick<MeshPart, 'kind' | 'level'>, v: Visibility): boolean {
  if (v.walking) return true;
  if (ROOFS.has(part.kind) && !v.roof) return false;
  if (!v.cutaway || v.level === null) return true;
  const at = v.order.get(part.level);
  const current = v.order.get(v.level);
  if (at === undefined || current === undefined) return true;
  if (at > current) return false;
  if (at === current && part.kind === 'ceiling') return false;
  // A roof belongs to the level whose walls carry it: it sits on top of that level, so a cutaway at that level leaves it off.
  if (at === current && ROOFS.has(part.kind)) return false;
  return true;
}

export const levelOrder = (model: EditorModel): Map<string, number> => new Map([...model.levels].sort((a, b) => a.elevation - b.elevation || (a.id < b.id ? -1 : 1)).map((l, i) => [l.id, i]));

// ─── Colour ──────────────────────────────────────────────────────────────────────────────────

/**
 * The colours of what the model names no material for — a house's own surfaces drawn in 3D, not
 * interface colour, so not tokens: the same plaster and oak in either theme.
 */
export const DEFAULTS = {
  exterior: '#d8d2c6', // d3-allow: a default material colour of the 3D model, not chrome
  interior: '#ebe8e1', // d3-allow: a default material colour of the 3D model, not chrome
  wallEdge: '#cfc9bd', // d3-allow: a default material colour of the 3D model, not chrome
  floor: '#c8b391', // d3-allow: a default material colour of the 3D model, not chrome
  ceiling: '#f2f0ea', // d3-allow: a default material colour of the 3D model, not chrome
  slab: '#b9b6ae', // d3-allow: a default material colour of the 3D model, not chrome
  roof: '#5b616d', // d3-allow: a default material colour of the 3D model, not chrome
  gable: '#d8d2c6', // d3-allow: a default material colour of the 3D model, not chrome
  stair: '#b58b5f', // d3-allow: a default material colour of the 3D model, not chrome
  fill: '#ddd8ce', // d3-allow: a default material colour of the 3D model, not chrome
  extension: '#9aa0ae', // d3-allow: a default material colour of the 3D model, not chrome
} as const;

type Json = Record<string, unknown>;

export function materialColour(model: EditorModel, id: string | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const colour = (model.document.materials?.[id] as Json | undefined)?.['color'];
  return typeof colour === 'string' && /^#[0-9a-f]{6}$/i.test(colour) ? colour : null;
}

const channel = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** "#rrggbb" (sRGB) as linear RGB, which is what three.js's vertex colours hold. */
export function linear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [channel(((n >> 16) & 255) / 255), channel(((n >> 8) & 255) / 255), channel((n & 255) / 255)];
}

/**
 * Each face's colour, for a flat-shaded part (one normal per vertex, three per triangle). A wall's
 * left face (Core 5.4, its exterior when drawn clockwise around a room) takes its first layer's
 * material, its right face its last layer's, and its top, ends and the reveals of its openings its
 * core's; everything else is one colour.
 */
export function faceColours(model: EditorModel, part: MeshPart, normals: Float32Array, walls: ReadonlyMap<string, WallView>): Float32Array {
  const out = new Float32Array(normals.length);
  const one = (hex: string) => {
    const [r, g, b] = linear(hex);
    for (let i = 0; i < out.length; i += 3) {
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
    }
    return out;
  };
  const rooms = model.document.rooms as Record<string, Json | undefined> | undefined;
  switch (part.kind) {
    case 'wall': {
      const wall = walls.get(part.id);
      const layers = part.layers ?? [];
      const left = linear(materialColour(model, layers[0]) ?? DEFAULTS.exterior);
      const right = linear(materialColour(model, layers[layers.length - 1]) ?? DEFAULTS.interior);
      const coreIndex = layers.length === 0 ? -1 : Math.floor(layers.length / 2);
      const edge = linear(materialColour(model, layers[coreIndex]) ?? DEFAULTS.wallEdge);
      if (wall === undefined) return one(DEFAULTS.interior);
      const dx = wall.b[0] - wall.a[0];
      const dy = wall.b[1] - wall.a[1];
      const len = Math.hypot(dx, dy) || 1;
      const lx = -dy / len;
      const ly = dx / len;
      for (let i = 0; i < out.length; i += 3) {
        const d = (normals[i] ?? 0) * lx + (normals[i + 1] ?? 0) * ly;
        const c = d > 0.7 ? left : d < -0.7 ? right : edge;
        out[i] = c[0];
        out[i + 1] = c[1];
        out[i + 2] = c[2];
      }
      return out;
    }
    case 'floor':
      return one(materialColour(model, rooms?.[part.id]?.['floorFinish'] as string | undefined) ?? DEFAULTS.floor);
    case 'ceiling':
      return one(materialColour(model, rooms?.[part.id]?.['ceilingFinish'] as string | undefined) ?? DEFAULTS.ceiling);
    case 'slab':
      return one(materialColour(model, part.material) ?? DEFAULTS.slab);
    case 'roof':
      return one(materialColour(model, part.material) ?? DEFAULTS.roof);
    case 'roofGable':
      return one(DEFAULTS.gable);
    case 'stairFlight':
    case 'stairLanding':
    case 'stairColumn':
    case 'stairBlock':
      return one(DEFAULTS.stair);
    case 'junctionFill':
      return one(DEFAULTS.fill);
    case 'extension':
      return one(DEFAULTS.extension);
    case 'opening':
      return one(DEFAULTS.interior);
  }
}

// ─── Words ───────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * What the 3D view shows, in words — the canvas's text alternative (WCAG 1.1.1): which levels,
 * how many of each kind of element, and the roof.
 */
export function describeScene(model: EditorModel, parts: readonly MeshPart[]): string {
  const ids = (kinds: readonly PartKind[], test: (p: MeshPart) => boolean = () => true) => new Set(parts.filter((p) => kinds.includes(p.kind) && test(p)).map((p) => p.id)).size;
  const levels = new Set(parts.map((p) => p.level));
  const names = model.levels.filter((l) => levels.has(l.id)).map((l) => l.name);
  const bits = [
    plural(ids(['wall']), 'wall'),
    plural(ids(['opening'], (p) => p.opening?.category === 'door'), 'door'),
    plural(ids(['opening'], (p) => p.opening?.category === 'window'), 'window'),
    plural(ids(['floor']), 'room'),
  ];
  const stairs = ids(['stairFlight', 'stairLanding', 'stairColumn', 'stairBlock']);
  if (stairs > 0) bits.push(plural(stairs, 'stair'));
  const slabs = ids(['slab']);
  if (slabs > 0) bits.push(plural(slabs, 'slab'));
  const roofs = ids(['roof', 'roofGable']);
  bits.push(roofs > 0 ? plural(roofs, 'roof') : 'no roof showing');
  const where = names.length === 0 ? 'Nothing is showing' : names.join(', ');
  return `${where}: ${bits.join(', ')}.`;
}
