import { appearanceOf, DEFAULT_COLOURS, ROLE_LOOKS, type Appearance, type MeshPart, type PartKind } from '@floorspec/mesh';
import type { EditorModel, WallView } from '../model';
import type { LevelsShown } from './mode';

/**
 * What the 3D view does with each meshed part (FLR-T-7.5), without three.js: which element a part
 * selects, which parts show for a level and a cutaway, and what colour each face is drawn in —
 * from the document's own materials (Core 8.5), the walls' layers (8.3) and the rooms' finishes
 * (6.5), with @floorspec/mesh's appearance where the model names none (FLR-T-12.23): the same
 * palette — by what each room is for — the worker's render and exports draw.
 */

/**
 * The element a part selects: the part's own `id` — a wall for a wall, the opening for its cut
 * (its pick target) and its joinery (a door's slab, a window's frame and glass, the casings,
 * FLR-T-13.8), the room for its floor and ceiling, the stair for each
 * of its flights and landings, the roof for its gable ends, an appliance for its model (which a
 * fixture or gas appliance paired with it has none of its own besides, FLR-T-12.34).
 */
export const elementOfPart = (part: Pick<MeshPart, 'id'>): string => part.id;

/**
 * Whether a part lights up when an element is selected: its own, or — for an FS_furniture
 * appliance's — one of the elements it stands for (FLR-T-12.34), the plumbing fixture or gas
 * appliance in its box that @floorspec/mesh draws nothing of. Selected in the plan or a list, such
 * an element shows as the appliance in 3D.
 */
export const partSelected = (part: Pick<MeshPart, 'id' | 'standsFor'>, id: string | null): boolean => id !== null && (part.id === id || (part.standsFor?.includes(id) ?? false));

/** The parts that belong to an element: what lights up in 3D when it is selected anywhere. */
export function partsOfElement<T extends Pick<MeshPart, 'id' | 'standsFor'>>(parts: readonly T[], id: string | null): T[] {
  return parts.filter((p) => partSelected(p, id));
}

export type Look = 'solid' | 'floor' | 'ceiling' | 'glass' | 'pick' | 'lens';

/**
 * How a part is drawn: opaque; a floor or a ceiling — opaque, and drawn in front of what shares
 * its plane (a wall running floor to floor ends at the top of the floor above; a ceiling at the
 * level's floor-to-floor height meets that floor's underside), a doorway's threshold as the floor
 * it continues; as glass (a window's or a glazed door's, a shower's screen); as a lit lens (a
 * luminaire's, FLR-T-12.21); or not at all but still clickable (an opening's cut, which its joinery
 * fills, FLR-T-13.8).
 */
export function lookOf(part: Pick<MeshPart, 'kind' | 'opening' | 'model'>): Look {
  if (part.model !== undefined) return ROLE_LOOKS[part.model.role].opacity !== undefined ? 'glass' : ROLE_LOOKS[part.model.role].emissive === true ? 'lens' : 'solid';
  if (part.kind === 'ceiling') return 'ceiling';
  if (part.kind === 'floor' || part.kind === 'slab' || part.kind === 'threshold') return 'floor';
  return part.kind === 'opening' ? 'pick' : 'solid';
}

const ROOFS: ReadonlySet<PartKind> = new Set(['roof', 'roofGable']);

export interface Visibility {
  walking: boolean;
  /** Which levels show about the current one (FLR-T-13.2): the whole house, a cutaway, or it alone. */
  levels: LevelsShown;
  /** In the whole house, the roofs on or off. */
  roof: boolean;
  /** The current level. */
  level: string | null;
  /** Each level's place, lowest first. */
  order: ReadonlyMap<string, number>;
}

/**
 * What shows. Walking shows the whole house, ceilings and roofs included, with its doors open
 * (FLR-T-13.8) — swung back, slid into their pockets, raised — so a person walks through every
 * doorway as the walls let them (the walk's collision is the walls and their cuts, walk.ts, never a
 * door); the orbit views show them closed. Otherwise the whole house
 * shows every level, every ceiling and every roof (the roofs unless they are turned off) — what
 * floorspec_render draws for `level: "all"`. The cutaway shows the levels up to the current one and
 * leaves off the current level's ceilings and the roof it carries, so its rooms are seen from above;
 * a roof of a level below shows, since nothing above it is cut. Only the current level shows that
 * level alone, cut the same way.
 */
export function isVisible(part: Pick<MeshPart, 'kind' | 'level' | 'state'>, v: Visibility): boolean {
  if (part.state !== undefined && part.state !== (v.walking ? 'open' : 'closed')) return false;
  if (v.walking) return true;
  if (v.levels === 'house' || v.level === null) return v.roof || !ROOFS.has(part.kind);
  const at = v.order.get(part.level);
  const current = v.order.get(v.level);
  if (at === undefined || current === undefined) return true;
  if (at > current) return false;
  if (at < current) return v.levels === 'cutaway';
  // A roof belongs to the level whose walls carry it: it sits on top of that level, so cutting at that level leaves it off.
  return part.kind !== 'ceiling' && !ROOFS.has(part.kind);
}

/** A choice of the 3D view's levels control: a select value, its label and a line under it. */
export interface LevelChoice {
  value: string;
  label: string;
  description: string;
}

/**
 * The 3D view's levels control (FLR-T-13.2), top level first: the whole house, then each level as a
 * cutaway ("Level 2 and below") and alone ("Only Level 2"). The lowest level is offered as a cutaway
 * only: with nothing below it, it alone is the same view.
 */
export function levelChoices(levels: readonly { id: string; name: string }[], order: ReadonlyMap<string, number>): LevelChoice[] {
  const sorted = [...levels].sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
  const choices: LevelChoice[] = [{ value: 'house', label: 'Whole house', description: 'Every level and every roof' }];
  sorted.forEach((l, i) => {
    choices.push({ value: `cutaway:${l.id}`, label: `${l.name} and below`, description: i === 0 ? 'Its ceilings and roof off' : 'The levels above cut away' });
    if (i < sorted.length - 1) choices.push({ value: `only:${l.id}`, label: `Only ${l.name}`, description: 'This level alone' });
  });
  return choices;
}

/** The control's value for what the view shows: the lowest level alone is its cutaway. */
export function levelChoiceOf(levels: LevelsShown, level: string | null, order: ReadonlyMap<string, number>): string {
  if (levels === 'house' || level === null) return 'house';
  const lowest = levels === 'only' && order.get(level) === 0;
  return `${lowest ? 'cutaway' : levels}:${level}`;
}

/** A choice back into what the view shows and at which level (null for the whole house). */
export function parseLevelChoice(value: string): { levels: LevelsShown; level: string | null } {
  if (value.startsWith('cutaway:')) return { levels: 'cutaway', level: value.slice('cutaway:'.length) };
  if (value.startsWith('only:')) return { levels: 'only', level: value.slice('only:'.length) };
  return { levels: 'house', level: null };
}

/** What the levels control says the view shows, in words: its chip and the inspector's "Showing". */
export function levelsLabel(levels: LevelsShown, levelName: string | null, lowest = false): string {
  if (levels === 'house' || levelName === null) return 'Whole house';
  return levels === 'cutaway' || lowest ? `${levelName} and below` : `Only ${levelName}`;
}

export const levelOrder = (model: EditorModel): Map<string, number> => new Map([...model.levels].sort((a, b) => a.elevation - b.elevation || (a.id < b.id ? -1 : 1)).map((l, i) => [l.id, i]));

// ─── Colour ──────────────────────────────────────────────────────────────────────────────────

/**
 * The colours of what the model names no material for — a house's own surfaces drawn in 3D, not
 * interface colour, so not tokens: @floorspec/mesh's, shared with the worker's render and exports.
 */
export const DEFAULTS = DEFAULT_COLOURS;

const looks = new WeakMap<EditorModel, Appearance>();
/** The appearance of a model's unfinished surfaces (FLR-T-12.23), one per model shown. */
export function appearance(model: EditorModel): Appearance {
  let a = looks.get(model);
  if (a === undefined) looks.set(model, (a = appearanceOf(model.view, model.derived)));
  return a;
}

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
 * Each face's colour, for a flat-shaded part (one normal per vertex, three per triangle) — what the
 * view draws when the model has no derived values to lay finished surfaces out by (surfaces.ts). A
 * wall's left face (Core 5.4, its exterior when drawn clockwise around a room) takes its first
 * layer's material, its right face its last layer's, and its top, ends and the reveals of its
 * openings its core's; everything else is one colour.
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
      const left = linear(materialColour(model, layers[0]) ?? appearance(model).face(part.id, 'left').color);
      const right = linear(materialColour(model, layers[layers.length - 1]) ?? appearance(model).face(part.id, 'right').color);
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
    case 'floor': {
      const top = materialColour(model, rooms?.[part.id]?.['floorFinish'] as string | undefined) ?? appearance(model).floor(part.id).color;
      if (part.plenum === undefined) return one(top);
      // Drawn down to the ceiling below (FLR-T-12.32): its top the floor, its underside the ceiling
      // of the room under it, its edges the structure's band.
      const under = part.plenum.room;
      const colours = {
        top: linear(top),
        under: linear((under === undefined ? null : materialColour(model, rooms?.[under]?.['ceilingFinish'] as string | undefined)) ?? appearance(model).plenum('underside', under).color),
        edge: linear(appearance(model).plenum('edge', under).color),
      };
      for (let i = 0; i < out.length; i += 3) {
        const nz = normals[i + 2] ?? 0;
        out.set(nz > 0.98 ? colours.top : nz < -0.98 ? colours.under : colours.edge, i);
      }
      return out;
    }
    case 'ceiling':
      return one(materialColour(model, rooms?.[part.id]?.['ceilingFinish'] as string | undefined) ?? appearance(model).ceiling(part.id).color);
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
    case 'threshold':
      return one(materialColour(model, rooms?.[part.threshold?.room ?? '']?.['floorFinish'] as string | undefined) ?? (part.threshold === undefined ? DEFAULTS.floor : appearance(model).floor(part.threshold.room).color));
    case 'extension':
    case 'joinery':
      // A model's piece, or an opening's joinery, in its role's colour (FLR-T-12.21, FLR-T-13.8), the worker's render and export alike.
      return one(part.model === undefined ? DEFAULTS.extension : ROLE_LOOKS[part.model.role].color);
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
