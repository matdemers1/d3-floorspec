/**
 * Seasons and weather on a meshed house (FLR-T-15.4): what a look does to the parts every view
 * draws — the editor's 3D view, the headless render, both path tracers and the glTF export the GPU
 * still reads — so a winter, an autumn or a light snow looks the same in each. A look, never a change
 * to the model: the document is read, never written, and the mesh it starts from is left as it is.
 *
 * - **Foliage follows each plant's FS_landscape `foliage` (2.2).** A `deciduous` plant's canopy is
 *   fresh green in spring (a flowering tree's sunlit lobes in blossom), as it is in summer, gold,
 *   orange or red in autumn — by its name where it says what it is (a maple turns red, a hornbeam
 *   gold), else by a hash of its ID — with leaves dropped on the bed or the lawn beneath it, and bare
 *   in winter: its trunk carried up into a crown of limbs, branches and twigs. An `evergreen` plant,
 *   and one whose foliage is not stated, keeps its leaves all year.
 * - **A lawn and a meadow (2.5) follow the season** (sky/weather.ts LAWN_TINT): greener in spring,
 *   yellowing in autumn, dormant in winter — as the ground the sky stands the house on does.
 * - **Light snow** lies on what faces up outside: a roof's slopes up to about 60°, a lawn, a bed, an
 *   evergreen's crown. Each such part's upward faces become a piece of its own in the `snow` role;
 *   the walks and drives (FS_landscape hardscape) are left cleared. How steep a slope still holds it
 *   varies a little from part to part, by a hash of its key.
 * - **Rain** wets the same outside surfaces (`wetPart`): each view darkens them and makes them glossy
 *   (sky/weather.ts `wetten`) in its own materials.
 *
 * Deterministic: every variation is a hash of an element's ID or a part's key, so the same document
 * and look always give the same parts.
 */
import type { FloorspecDocument } from '@floorspec/engine';
import type { ModelRole } from './roles.js';
import { DEFAULT_SEASON, type Look, type LookRequest, type LookSeason } from './sky/weather.js';
import { UNITS_PER_METRE, type Box3, type HouseMesh, type MeshPart, type Vec3 } from './types.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a plant keeps its leaves: as FS_landscape records it, or `unstated`. */
export type Foliage = 'deciduous' | 'evergreen' | 'unstated';

/** FS_landscape's records of one collection (2.2–2.6), when the document has any. */
export function landscapeCollection(doc: FloorspecDocument | object, collection: 'plants' | 'beds' | 'lawns' | 'hardscape'): Record<string, Json> {
  const data = ((doc as { extensions?: unknown }).extensions as Json | undefined)?.['FS_landscape'];
  const collections = isObject(data) ? data['collections'] : undefined;
  const records = isObject(collections) ? collections[collection] : undefined;
  return isObject(records) ? (records as Record<string, Json>) : {};
}

/** A plant's foliage (FS_landscape 2.2). */
export function foliageOf(plant: Json | undefined): Foliage {
  const f = plant?.['foliage'];
  return f === 'deciduous' || f === 'evergreen' ? f : 'unstated';
}

// ─── Hashes ──────────────────────────────────────────────────────────────────────────────────

/** A 32-bit hash of a string (FNV-1a). */
export function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A number in [0, 1) from a seed and an index (lowbias32): the same pair, the same number. */
export function rand(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ─── Foliage through the year ────────────────────────────────────────────────────────────────

/** Autumn's three colours a deciduous canopy turns. */
export type AutumnHue = 'gold' | 'orange' | 'red';

/** Plants whose autumn colour is red, and gold, by a name or a genus in their `commonName` or `species`. */
const RED = /maple|acer\b|sumac|rhus|dogwood|cornus|sweetgum|liquidambar|\boak\b|quercus|burning bush|euonymus|blueberry|tupelo|nyssa|sourwood|oxydendrum|smoke ?(tree|bush)|cotinus/i;
const GOLD = /birch|betula|ginkgo|aspen|poplar|populus|hornbeam|carpinus|beech|fagus|linden|tilia|redbud|cercis|willow|salix|\bash\b|fraxinus|\belm\b|ulmus|katsura|cercidiphyllum|honey ?locust|gleditsia|larch|larix|witch ?hazel|hamamelis|serviceberry|amelanchier|tulip ?tree|liriodendron/i;
/** Trees and shrubs that flower in spring before or with their leaves. */
const FLOWERING = /cherry|prunus|plum|apple|malus|crab|magnolia|dogwood|cornus|redbud|cercis|\bpear\b|pyrus|serviceberry|amelanchier|hawthorn|crataegus|lilac|syringa|forsythia|azalea|rhododendron|almond|peach/i;

const nameOf = (plant: Json | undefined): string => [plant?.['commonName'], plant?.['species']].filter((v): v is string => typeof v === 'string').join(' ');

/** The colour a deciduous plant turns in autumn: by its name where it says, else by a hash of its ID. */
export function autumnHue(id: string, plant?: Json): AutumnHue {
  const name = nameOf(plant);
  if (RED.test(name)) return 'red';
  if (GOLD.test(name)) return 'gold';
  return (['gold', 'orange', 'red'] as const)[Math.floor(rand(seedOf(id), 7) * 3)]!;
}

/** Whether a deciduous plant blossoms in spring: by its name where it has one, else about one in three, by a hash of its ID. */
export function blossoms(id: string, plant?: Json): boolean {
  const name = nameOf(plant);
  if (name !== '') return FLOWERING.test(name);
  return rand(seedOf(id), 11) < 0.34;
}

const FOLIAGE_ROLES: ReadonlySet<ModelRole> = new Set(['foliage', 'foliageLight', 'foliageDark']);

/** Autumn's roles for a hue: the main mass, the sunlit lobes, the shaded ones. */
const AUTUMN: Readonly<Record<AutumnHue, Readonly<Record<'foliage' | 'foliageLight' | 'foliageDark', ModelRole>>>> = {
  gold: { foliage: 'autumnGold', foliageLight: 'autumnGold', foliageDark: 'autumnOrange' },
  orange: { foliage: 'autumnOrange', foliageLight: 'autumnGold', foliageDark: 'autumnBrown' },
  red: { foliage: 'autumnRed', foliageLight: 'autumnOrange', foliageDark: 'autumnBrown' },
};

/**
 * The season → foliage mapping: the role a piece of a plant's canopy is drawn in, in a season, by
 * the plant's foliage — or null when the piece is not drawn at all (a deciduous plant's leaves in
 * winter). Only the canopy's roles change; a trunk, a grass's blades and plumes, anything else keep theirs.
 */
export function seasonRole(role: ModelRole, season: LookSeason, foliage: Foliage, plant: { hue: AutumnHue; blossom: boolean } = { hue: 'gold', blossom: false }): ModelRole | null {
  if (foliage !== 'deciduous' || !FOLIAGE_ROLES.has(role) || season === 'summer') return role;
  const r = role as 'foliage' | 'foliageLight' | 'foliageDark';
  switch (season) {
    case 'winter':
      return null;
    case 'autumn':
      return AUTUMN[plant.hue][r];
    case 'spring':
      return r === 'foliage' ? 'leafSpring' : r === 'foliageLight' ? (plant.blossom ? 'blossom' : 'leafSpringLight') : 'foliage';
  }
}

/** A lawn's or a meadow's role in a season (FS_landscape 2.5): summer's is its own. */
export function lawnRole(role: ModelRole, season: LookSeason): ModelRole {
  if (season === 'summer' || (role !== 'lawn' && role !== 'meadow')) return role;
  const s = season === 'spring' ? 'Spring' : season === 'autumn' ? 'Autumn' : 'Winter';
  return `${role}${s}` as ModelRole;
}

// ─── Geometry ────────────────────────────────────────────────────────────────────────────────

/** Triangles being gathered into a part: metres about the mesh's origin. */
class Builder {
  readonly positions: number[] = [];
  readonly indices: number[] = [];

  vertex(p: Vec3): number {
    this.positions.push(p[0], p[1], p[2]);
    return this.positions.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /**
   * A tapering square prism from `p0` (radius r0) to `p1` (radius r1): a limb or a twig — closed, its
   * faces counter-clockwise seen from outside.
   */
  limb(p0: Vec3, p1: Vec3, r0: number, r1: number, turn: number): void {
    const d = sub(p1, p0);
    const len = Math.hypot(...d);
    if (len < 1e-4) return;
    const w: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
    // u ⟂ w, v = w × u: (u, v, w) right-handed, so going u → v is counter-clockwise about w.
    const helper: Vec3 = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = norm(cross(helper, w));
    const v = cross(w, u);
    const ring = (p: Vec3, r: number) =>
      [0, 1, 2, 3].map((k) => {
        const a = turn + (k * Math.PI) / 2;
        const c = Math.cos(a) * r;
        const s = Math.sin(a) * r;
        return this.vertex([p[0] + u[0] * c + v[0] * s, p[1] + u[1] * c + v[1] * s, p[2] + u[2] * c + v[2] * s]);
      });
    const a = ring(p0, r0);
    const b = ring(p1, r1);
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      this.tri(a[k]!, a[k1]!, b[k1]!);
      this.tri(a[k]!, b[k1]!, b[k]!);
    }
    this.tri(a[0]!, a[2]!, a[1]!);
    this.tri(a[0]!, a[3]!, a[2]!);
    this.tri(b[0]!, b[1]!, b[2]!);
    this.tri(b[0]!, b[2]!, b[3]!);
  }

  /** A flat leaf lying on the ground at `c`, `size` across, turned by `turn`: facing up. */
  leaf(c: Vec3, size: number, turn: number): void {
    const h = size / 2;
    const ca = Math.cos(turn);
    const sa = Math.sin(turn);
    const at = (x: number, y: number) => this.vertex([c[0] + x * ca - y * sa, c[1] + x * sa + y * ca, c[2]]);
    const p = [at(-h, 0), at(0, -h * 0.55), at(h, 0), at(0, h * 0.55)];
    this.tri(p[0]!, p[1]!, p[2]!);
    this.tri(p[0]!, p[2]!, p[3]!);
  }

  get empty(): boolean {
    return this.indices.length === 0;
  }
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A box in base units (absolute) from metre points about `origin` (base units): what a part's `bbox` holds. */
function boxOf(positions: ArrayLike<number>, indices: ArrayLike<number>, origin: Vec3): Box3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < indices.length; t++) {
    const i = indices[t]!;
    for (let k = 0; k < 3; k++) {
      const v = positions[3 * i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  const u = (v: number, k: number) => Math.round(v * UNITS_PER_METRE + origin[k]!);
  return { min: [u(min[0], 0), u(min[1], 1), u(min[2], 2)], max: [u(max[0], 0), u(max[1], 1), u(max[2], 2)] };
}

/** A part's box in metres about the mesh's origin. */
function metres(box: Box3, origin: Vec3): { min: Vec3; max: Vec3 } {
  const m = (v: number, k: number) => (v - origin[k]!) / UNITS_PER_METRE;
  return { min: [m(box.min[0], 0), m(box.min[1], 1), m(box.min[2], 2)], max: [m(box.max[0], 0), m(box.max[1], 1), m(box.max[2], 2)] };
}

function union(a: Box3 | undefined, b: Box3): Box3 {
  if (a === undefined) return { min: [...b.min], max: [...b.max] };
  return { min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])], max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] };
}

/**
 * A deciduous plant's bare winter crown: its trunk carried up as a leader, and limbs from it — each
 * with branches, and twigs on those — reaching out to the crown its leaves filled; a shrub's stems from
 * the ground. Metres about the origin; seeded by the plant's ID.
 */
export function bareCrown(id: string, form: string, crown: { min: Vec3; max: Vec3 }, trunk: { min: Vec3; max: Vec3 } | null): { positions: Float32Array; indices: Uint32Array } {
  const b = new Builder();
  const seed = seedOf(id);
  let n = 0;
  const r = () => rand(seed, n++);
  const cx = trunk === null ? (crown.min[0] + crown.max[0]) / 2 : (trunk.min[0] + trunk.max[0]) / 2;
  const cy = trunk === null ? (crown.min[1] + crown.max[1]) / 2 : (trunk.min[1] + trunk.max[1]) / 2;
  const R = Math.max(0.05, Math.min(crown.max[0] - crown.min[0], crown.max[1] - crown.min[1]) / 2);
  const z0 = crown.min[2];
  const z1 = crown.max[2];
  const hc = Math.max(0.05, z1 - z0);
  // A limb's end on the crown's envelope, an ellipsoid about the crown's middle; and its branches and twigs.
  const grow = (from: Vec3, to: Vec3, radius: number, depth: number): void => {
    b.limb(from, to, radius, Math.max(0.004, radius * 0.4), r() * Math.PI);
    if (depth === 0) return;
    const d = sub(to, from);
    const len = Math.hypot(...d);
    for (let k = 0; k < 2; k++) {
      const t = 0.5 + 0.35 * r();
      const at: Vec3 = [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t];
      // Off the parent's line by 30–50°, a little upward.
      const side = norm(cross(norm(d), [0, 0, 1]));
      const sway = (k === 0 ? 1 : -1) * (0.55 + 0.4 * r());
      const dir = norm([d[0] / len + side[0] * sway, d[1] / len + side[1] * sway, d[2] / len + 0.35]);
      const l = len * (0.42 + 0.18 * r());
      let end: Vec3 = [at[0] + dir[0] * l, at[1] + dir[1] * l, at[2] + dir[2] * l];
      // Kept inside the crown's box: a bare tree is the shape its leaves were.
      end = [Math.min(crown.max[0], Math.max(crown.min[0], end[0])), Math.min(crown.max[1], Math.max(crown.min[1], end[1])), Math.min(z1, Math.max(z0, end[2]))];
      grow(at, end, Math.max(0.004, radius * 0.45), depth - 1);
    }
  };
  if (form === 'tree' && trunk !== null) {
    const rt = Math.max(0.02, (trunk.max[0] - trunk.min[0]) / 2 / 1.25);
    const top = trunk.max[2];
    // The leader: the trunk carried on up into the crown.
    grow([cx, cy, top - 0.05], [cx + (r() - 0.5) * R * 0.15, cy + (r() - 0.5) * R * 0.15, z0 + hc * 0.88], rt * 0.62, 2);
    const limbs = 6 + Math.floor(r() * 3);
    for (let i = 0; i < limbs; i++) {
      const a = ((i + 0.35 * r()) / limbs) * 2 * Math.PI;
      const zs = z0 + (top - z0) * (0.05 + 0.85 * r());
      const d = R * (0.5 + 0.35 * r());
      const ze = z0 + hc * (0.4 + 0.45 * r());
      grow([cx, cy, zs], [cx + Math.cos(a) * d, cy + Math.sin(a) * d, ze], rt * (0.42 + 0.12 * r()), 2);
    }
  } else {
    // A shrub's (or a tree with no trunk drawn) stems from the ground, fanning up and out.
    const stems = 7 + Math.floor(r() * 4);
    const rs = Math.max(0.008, Math.min(0.03, R * 0.04));
    for (let i = 0; i < stems; i++) {
      const a = ((i + 0.4 * r()) / stems) * 2 * Math.PI;
      const d = R * (0.35 + 0.5 * r());
      grow([cx + Math.cos(a) * R * 0.08, cy + Math.sin(a) * R * 0.08, z0], [cx + Math.cos(a) * d, cy + Math.sin(a) * d, z0 + hc * (0.6 + 0.35 * r())], rs, 1);
    }
  }
  return { positions: Float32Array.from(b.positions), indices: Uint32Array.from(b.indices) };
}

/**
 * Autumn's fallen leaves under a tree: flat leaves scattered under its crown, each lying on the
 * highest bed or lawn under it no higher than a little over the plant's own bottom — none where there
 * is no bed or lawn to lie on. Metres about the origin; seeded by the plant's ID. Two sets: the tree's
 * own colour, and its sunlit lobes'.
 */
export function leafLitter(id: string, crown: { min: Vec3; max: Vec3 }, bottom: number, grounds: readonly { min: Vec3; max: Vec3 }[]): [{ positions: Float32Array; indices: Uint32Array }, { positions: Float32Array; indices: Uint32Array }] {
  const seed = seedOf(`${id}:litter`);
  const sets = [new Builder(), new Builder()] as const;
  const cx = (crown.min[0] + crown.max[0]) / 2;
  const cy = (crown.min[1] + crown.max[1]) / 2;
  const R = Math.min(crown.max[0] - crown.min[0], crown.max[1] - crown.min[1]) / 2;
  const count = Math.min(140, Math.max(24, Math.round(R * R * 6)));
  for (let i = 0; i < count; i++) {
    const a = rand(seed, 4 * i) * 2 * Math.PI;
    const d = R * 1.1 * Math.sqrt(rand(seed, 4 * i + 1));
    const x = cx + Math.cos(a) * d;
    const y = cy + Math.sin(a) * d;
    let z = -Infinity;
    for (const g of grounds) if (x >= g.min[0] && x <= g.max[0] && y >= g.min[1] && y <= g.max[1] && g.max[2] <= bottom + 0.15 && g.max[2] > z) z = g.max[2];
    if (!Number.isFinite(z)) continue;
    const size = 0.07 + 0.05 * rand(seed, 4 * i + 2);
    sets[rand(seed, 4 * i + 3) < 0.62 ? 0 : 1].leaf([x, y, z + 0.006], size, rand(seed, 4 * i + 3) * 2 * Math.PI);
  }
  return [sets[0], sets[1]].map((s) => ({ positions: Float32Array.from(s.positions), indices: Uint32Array.from(s.indices) })) as [{ positions: Float32Array; indices: Uint32Array }, { positions: Float32Array; indices: Uint32Array }];
}

// ─── Snow and rain ───────────────────────────────────────────────────────────────────────────

const isLandscape = (p: Pick<MeshPart, 'extension'>, collection?: string): boolean => p.extension?.name === 'FS_landscape' && (collection === undefined || p.extension.collection === collection);

/**
 * How steep a face of a part may be and still hold a light snow, as the least upward component of
 * its normal — or null for a part that holds none: a roof's slopes up to about 60° (55–65°, by a hash
 * of the part's key), a lawn's and a bed's tops, the caps of an evergreen's crown, a grass's tufts;
 * never a walk or a drive (FS_landscape hardscape, cleared), a trunk, a wall, or anything indoors; FS_outdoor's
 * outdoor rooms' tops — a pergola's slats, a porch's roof, a coping, a counter — but never water or embers.
 */
export function snowHold(part: Pick<MeshPart, 'kind' | 'key' | 'extension' | 'model'>): number | null {
  if (part.kind === 'roof') return Math.cos(((55 + 10 * rand(seedOf(part.key), 3)) * Math.PI) / 180);
  // FS_outdoor (FLR-T-15.2): a pergola's slats and a porch's roof, a coping, a counter, a fence's cap hold it; water and embers never
  if (part.extension?.name === 'FS_outdoor') return part.model === undefined || part.model.role === 'water' || part.model.role === 'ember' || part.model.role === 'snow' ? null : 0.5;
  if (!isLandscape(part) || part.extension?.collection === 'hardscape') return null;
  const role = part.model?.role;
  if (role === undefined || role === 'trunk' || role === 'snow') return null;
  if (part.extension?.collection === 'plants') return role === 'plume' ? 0.85 : 0.68;
  return 0.5;
}

/** Whether rain wets a part: what stands outside — a roof and its gable ends, and everything FS_landscape draws. */
export const wetPart = (part: Pick<MeshPart, 'kind' | 'extension'>): boolean => part.kind === 'roof' || part.kind === 'roofGable' || isLandscape(part) || part.extension?.name === 'FS_outdoor';

/** A part with its upward faces laid in snow: [what is left, the snow] — either may be absent. */
export function snowSplit(part: MeshPart, hold: number, origin: Vec3): MeshPart[] {
  const P = part.mesh.positions;
  const I = part.mesh.indices;
  const snow: number[] = [];
  const rest: number[] = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]!;
    const b = I[t + 1]!;
    const c = I[t + 2]!;
    const ux = P[3 * b]! - P[3 * a]!;
    const uy = P[3 * b + 1]! - P[3 * a + 1]!;
    const uz = P[3 * b + 2]! - P[3 * a + 2]!;
    const vx = P[3 * c]! - P[3 * a]!;
    const vy = P[3 * c + 1]! - P[3 * a + 1]!;
    const vz = P[3 * c + 2]! - P[3 * a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    (l > 0 && nz / l >= hold ? snow : rest).push(a, b, c);
  }
  if (snow.length === 0) return [part];
  const snowIdx = Uint32Array.from(snow);
  const covered: MeshPart = {
    ...part,
    key: `${part.key}:snow`,
    model: { kind: part.model?.kind ?? 'snow', role: 'snow', ...(part.model?.smooth === true ? { smooth: true as const } : {}) },
    mesh: { positions: P, indices: snowIdx },
    bbox: boxOf(P, snowIdx, origin),
  };
  delete covered.stats;
  if (rest.length === 0) return [covered];
  const restIdx = Uint32Array.from(rest);
  const left: MeshPart = { ...part, mesh: { positions: P, indices: restIdx }, bbox: boxOf(P, restIdx, origin) };
  delete left.stats;
  return [left, covered];
}

// ─── A look on a mesh ────────────────────────────────────────────────────────────────────────

/** A look with its defaults: summer, clear. */
export function fullLook(request: LookRequest | undefined): Look {
  return { season: request?.season ?? DEFAULT_SEASON, weather: request?.weather ?? 'clear' };
}

/** Whether a look changes any part: a season other than summer, or snow (rain changes materials, not parts). */
export const changesParts = (look: Look): boolean => look.season !== 'summer' || look.weather === 'snow';

/**
 * The parts of a meshed house in a season and a weather: foliage and lawns by the season, a deciduous
 * plant bare in winter (its bare crown a part of its own, `<key>:bare`), autumn's leaves under a tree
 * (`<key>:litter:<n>`), and light snow split off what faces up (`<key>:snow`). In summer without snow
 * it is the mesh it was given — the very object — so a view that names no look draws what it drew.
 */
export function lookMesh(house: HouseMesh, doc: FloorspecDocument | object, request?: LookRequest): HouseMesh {
  const look = fullLook(request);
  if (!changesParts(look)) return house;
  let parts = look.season === 'summer' ? house.parts : seasonParts(house, doc, look.season);
  if (look.weather === 'snow') parts = parts.flatMap((p) => {
    const hold = snowHold(p);
    return hold === null ? [p] : snowSplit(p, hold, house.origin);
  });
  return { ...house, parts };
}

function seasonParts(house: HouseMesh, doc: FloorspecDocument | object, season: LookSeason): MeshPart[] {
  const plants = landscapeCollection(doc, 'plants');
  const origin = house.origin;
  const looks = new Map<string, { hue: AutumnHue; blossom: boolean }>();
  const plantLook = (id: string) => {
    let l = looks.get(id);
    if (l === undefined) looks.set(id, (l = { hue: autumnHue(id, plants[id]), blossom: blossoms(id, plants[id]) }));
    return l;
  };
  // Each deciduous plant's crown (its leaves' box), trunk and first piece: what winter and autumn add parts from.
  const crowns = new Map<string, { crown?: Box3; trunk?: MeshPart; first: MeshPart; form: string }>();
  const out: MeshPart[] = [];
  for (const part of house.parts) {
    const role = part.model?.role;
    if (role !== undefined && isLandscape(part, 'lawns')) {
      const next = lawnRole(role, season);
      out.push(next === role ? part : { ...part, model: { ...part.model!, role: next } });
      continue;
    }
    if (role === undefined || !isLandscape(part, 'plants') || foliageOf(plants[part.id]) !== 'deciduous') {
      out.push(part);
      continue;
    }
    const plant = plants[part.id];
    const form = typeof plant?.['form'] === 'string' ? plant['form'] : (part.model?.kind ?? 'tree');
    let c = crowns.get(part.id);
    if (c === undefined) crowns.set(part.id, (c = { first: part, form }));
    if (role === 'trunk') c.trunk = part;
    if (FOLIAGE_ROLES.has(role)) c.crown = union(c.crown, part.bbox);
    const next = seasonRole(role, season, 'deciduous', plantLook(part.id));
    if (next === null) continue;
    out.push(next === role ? part : { ...part, model: { ...part.model!, role: next } });
  }
  if (season !== 'winter' && season !== 'autumn') return out;
  // The beds and lawns autumn's leaves fall on: their tops, in metres.
  const grounds = season === 'autumn' ? house.parts.filter((p) => isLandscape(p, 'lawns') || isLandscape(p, 'beds')).map((p) => metres(p.bbox, origin)) : [];
  for (const [id, c] of [...crowns].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (c.crown === undefined || (c.form !== 'tree' && c.form !== 'shrub')) continue;
    const base = c.trunk ?? c.first;
    const crown = metres(c.crown, origin);
    const make = (key: string, role: ModelRole, mesh: { positions: Float32Array; indices: Uint32Array }, closed: boolean): MeshPart => ({
      key,
      id,
      kind: base.kind,
      level: base.level,
      closed,
      ...(closed ? {} : { facing: 'up' as const }),
      ...(base.extension === undefined ? {} : { extension: base.extension }),
      model: { kind: base.model?.kind ?? c.form, role },
      mesh,
      bbox: boxOf(mesh.positions, mesh.indices, origin),
    });
    if (season === 'winter') {
      const mesh = bareCrown(id, c.form, crown, c.trunk === undefined ? null : metres(c.trunk.bbox, origin));
      if (mesh.indices.length > 0) out.push(make(`${base.key}:bare`, 'trunk', mesh, true));
    } else if (c.form === 'tree') {
      const hue = plantLook(id).hue;
      const bottom = metres((c.trunk ?? c.first).bbox, origin).min[2];
      const [own, light] = leafLitter(id, crown, bottom, grounds);
      const roles = AUTUMN[hue];
      if (own.indices.length > 0) out.push(make(`${base.key}:litter:0`, roles.foliage, own, false));
      if (light.indices.length > 0) out.push(make(`${base.key}:litter:1`, roles.foliageLight === roles.foliage ? roles.foliageDark : roles.foliageLight, light, false));
    }
  }
  return out;
}
