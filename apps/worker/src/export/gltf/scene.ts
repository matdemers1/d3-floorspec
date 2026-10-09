/**
 * The 3D scene every 3D output is made from (FLR-T-9.2, FLR-T-8.5): the glTF and USDZ exports
 * write it, and the headless render draws it. One version, one design, one scene.
 *
 * It is built from what the engine derives (`ev.view` — the design's view — and its derived
 * values) and what @floorspec/mesh makes of them, converted once to glTF's frame: Floorspec
 * (x, y, z) in base units becomes (x, z, −y) in metres (Core 2.3), so +Y is up. Every element is a
 * node — a wall, a junction's fill, an opening, a room (its floor and ceiling), a slab, a roof, a
 * stair, an extension element — under a node for its level, and every node keeps its Floorspec ID.
 *
 * Materials are the document's own (Core 8.5, 18.1): a wall's faces take their resolved finishes
 * (18.6) — the face's material, the room's wallFinish, or the outermost layer — with each finish
 * region (18.5) cut out of its face and given its own material; a room's floor and ceiling take its
 * finishes; a roof and a slab their material. What the model names no material for takes the
 * defaults @floorspec/mesh's appearance gives it (FLR-T-12.23) — a room's floor, ceiling and wall
 * paint by what the room is for — which the editor's 3D view draws too; a material with a map but
 * no colour is drawn in its map's average colour where the asset store has the map. An arc wall's
 * faces are its faces, segment by segment (Core 21.6), each drawn as one curved surface. Surfaces whose material has a texture carry texture
 * coordinates exactly as 18.3 defines them, `u = s′ / w` and `v = −t′ / h`; the surfaces 18.3 does
 * not define (a wall's top and ends, a slab, a roof, a stair) are given a box projection, which is
 * this exporter's choice and not the standard's.
 */
import { deriveEvaluation, evaluate, extElements, facingVector, InvalidDocumentError, OFFICIAL_READER, type Derived, type Evaluation, type FloorspecDocument, type ValidateOptions } from '@floorspec/engine';
import { appearanceOf, DEFAULT_COLOURS, lightsOf, loadMesher, ROLE_LOOKS, surfaceGroups, swatch, UNITS_PER_METRE, type MeshPart, type Mesher, type ModelRole, type PartKind, type Swatch } from '@floorspec/mesh';
import { decodeTexture } from '../../pathtrace/textures.js';
import type { ImageSource } from './glb.js';

export type Vec3 = [number, number, number];
export type Rgba = [number, number, number, number];

/** The roles a texture's maps play (Core 18.2), by the member that names each. */
export const MAP_ROLES = ['asset', 'normal', 'metallicRoughness', 'occlusion'] as const;
export type MapRole = (typeof MAP_ROLES)[number];

export interface SceneTexture {
  /** The real-world size of one tile, in base units. */
  readonly size: readonly [number, number];
  readonly offset: readonly [number, number];
  /** Microdegrees, counter-clockwise seen facing the surface. */
  readonly rotation: number;
  /** The asset each map names. */
  readonly maps: Partial<Record<MapRole, string>>;
}

export interface SceneMaterial {
  /** `M:<material ID>` for the document's, `default:<what>` for the exporter's, `role:<role>` for a model's piece (FLR-T-12.21). */
  readonly key: string;
  readonly name: string;
  /** The document's material ID, for one of its own. */
  readonly floorspec?: string;
  /** Linear RGB and alpha: the material's `color`, or where it has none, a neutral grey. */
  readonly baseColor: Rgba;
  /** The declared `color`, `#rrggbb` sRGB, when there is one. */
  readonly color?: string;
  /** 0–1: `metallic` / 1000, and the defaults of 18.1 (0 and 1) when absent. */
  readonly metallic: number;
  readonly roughness: number;
  /** The raw thousandths, when declared: with a map, an absent factor lets the map through. */
  readonly declared: { readonly metallic?: number; readonly roughness?: number };
  /** Glass: drawn see-through. */
  readonly blend: boolean;
  /** Linear RGB it is drawn as giving off: a luminaire's lens (FLR-T-12.21) — a look, not a light. */
  readonly emissive?: readonly [number, number, number];
  readonly texture?: SceneTexture;
}

export interface ScenePrimitive {
  /** Index into `Scene.materials`. */
  readonly material: number;
  /** The part of the element it was made from: what a view filters by (ceilings, roofs). */
  readonly part: PartKind;
  /** Metres, +Y up; indexed. */
  readonly positions: Float32Array;
  /** Unit, one per vertex: faces are flat, so a vertex is shared only within one plane. */
  readonly normals: Float32Array;
  /** glTF's convention (v runs down the image), present when the material has a texture. */
  readonly uvs: Float32Array | null;
  readonly indices: Uint32Array;
  /** A model's round pieces (FLR-T-12.21): one curved surface, drawn without ink between its facets. */
  readonly smooth?: true;
}

/** What a node's element is: the Floorspec collection it is in, singular. */
export type ElementKind = 'wall' | 'junction' | 'opening' | 'room' | 'slab' | 'roof' | 'stair' | 'extension';

export interface SceneNode {
  readonly id: string;
  readonly kind: ElementKind;
  readonly level: string;
  readonly name?: string;
  /** For an opening: door, window or empty. */
  readonly category?: string;
  /** For an extension element: its extension and collection. */
  readonly extension?: { readonly name: string; readonly collection: string };
  /** The kinds of the mesh parts it is made of. */
  readonly parts: PartKind[];
  readonly primitives: ScenePrimitive[];
  /**
   * An extension element whose fallback has a model (Core 12.6): where the model's origin goes, in
   * the scene (metres, +Y up), and its turn about +Y — the element's facing alone; and the asset's
   * digest and media type as the document records them, for an exporter that merges the model.
   */
  readonly model?: { readonly asset: string; readonly sha256?: string; readonly mediaType?: string; readonly translation: Vec3; readonly rotation: [number, number, number, number] };
}

export interface SceneLevel {
  readonly id: string;
  readonly name?: string;
  /** Metres. */
  readonly elevation: number;
  readonly nodes: SceneNode[];
}

/** A room, for a camera that stands in it (FLR-T-8.5). Plan in metres, z-up. */
export interface SceneRoom {
  readonly id: string;
  readonly name?: string;
  readonly level: string;
  readonly outer: [number, number][];
  /** The floor's top and the ceiling's lowest point, metres. */
  readonly floor: number;
  readonly ceiling: number;
}

/** A luminaire's light (FLR-T-12.22, @floorspec/mesh `lightsOf`), in the scene's frame: metres, +Y up. */
export interface SceneLight {
  readonly id: string;
  readonly level: string;
  readonly fixture: string;
  readonly position: Vec3;
  /** Metres: the size of what shines. */
  readonly radius: number;
  /** A spot's direction (straight down) and its cone's cosines; absent for a light that shines every way. */
  readonly spot?: { readonly dir: Vec3; readonly inner: number; readonly outer: number };
  readonly lumens: number;
  /** Linear RGB, luminance 1. */
  readonly color: readonly [number, number, number];
  readonly room: string | null;
}

/** A door, for a camera that stands in its doorway. Plan in metres, z-up. */
export interface SceneDoor {
  readonly id: string;
  readonly level: string;
  readonly mid: [number, number];
  /** The host wall's left normal, unit. */
  readonly normal: [number, number];
  readonly halfThickness: number;
  readonly sill: number;
}

/**
 * An extension element's fallback box (Core 12.6) — a piece of furniture, a fixture, an appliance —
 * for a camera that keeps out of it (FLR-T-12.29). Plan in metres, z-up.
 */
export interface SceneObstacle {
  readonly id: string;
  readonly level: string;
  readonly extension: string;
  readonly collection: string;
  /** Its footprint: four corners, counter-clockwise. */
  readonly footprint: [number, number][];
  /** The box's bottom and top, metres. */
  readonly bottom: number;
  readonly top: number;
}

export interface Scene {
  readonly project: string;
  /** Every option set's chosen option, for a document with design options; else null. */
  readonly design: Record<string, string> | null;
  readonly materials: SceneMaterial[];
  readonly levels: SceneLevel[];
  /** Of every primitive, metres, +Y up; null when there is nothing. */
  readonly bounds: { min: Vec3; max: Vec3 } | null;
  readonly rooms: SceneRoom[];
  readonly doors: SceneDoor[];
  /** Every extension element's fallback box, by ID: what a camera standing in a room keeps out of. */
  readonly obstacles: SceneObstacle[];
  /** What FS_electrical's luminaires shine (FLR-T-12.22), for a view that turns them on. */
  readonly lights: SceneLight[];
  /** The assets a material's maps name: what an exporter asks the store for. */
  readonly assets: Record<string, { readonly sha256: string; readonly mediaType: string; readonly path?: string; readonly uri?: string }>;
}

export interface SceneOptions {
  /** Only these levels. Default every level. */
  readonly levels?: readonly string[];
  /** The design to build (Core 19.6): option set → option. Default the primary design. */
  readonly design?: Readonly<Record<string, string>>;
  /**
   * The reader the document is validated with (Core 1.6.4, 12.2). Default `OFFICIAL_READER`, the
   * reader the api and the editor run (FLR-T-12.10), so a model that requires an official extension
   * is built and one the editor calls invalid is refused.
   */
  readonly reader?: Omit<ValidateOptions, 'design'>;
  /**
   * The bytes of the assets a material's maps name, where the caller can have them: a material with
   * a base colour map and no `color` is drawn in the map's average colour rather than a default.
   */
  readonly images?: ImageSource;
}

const M = UNITS_PER_METRE;

let mesher: Promise<Mesher> | null = null;
/** manifold-3d's WASM, loaded once per process. */
export const getMesher = (): Promise<Mesher> => (mesher ??= loadMesher());

// ─── Colour ──────────────────────────────────────────────────────────────────────────────────

/** The colours of what the model names no material for: @floorspec/mesh's, which the editor's 3D view draws too. */
export const DEFAULTS = DEFAULT_COLOURS;

const channel = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** `#rrggbb` (sRGB) as linear RGB. */
export function linear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [channel(((n >> 16) & 255) / 255), channel(((n >> 8) & 255) / 255), channel((n & 255) / 255)];
}

const HEX = /^#[0-9a-f]{6}$/i;
type Json = Record<string, unknown>;

/** Linear RGB of a material's base colour map, averaged over its texels; undefined when it cannot be read. */
export type MapAverage = (material: string) => [number, number, number] | undefined;

/** The average colour of each material's base colour map that `images` can supply and decode. */
export function mapAverages(doc: FloorspecDocument, images: ImageSource | undefined): MapAverage | undefined {
  if (images === undefined) return undefined;
  return (material) => {
    const tex = ((doc.materials as Record<string, Json> | undefined)?.[material]?.['texture'] as Json | undefined) ?? {};
    const id = tex['asset'];
    const a = typeof id === 'string' ? (doc.assets as Record<string, Json> | undefined)?.[id] : undefined;
    if (typeof id !== 'string' || a === undefined || typeof a['sha256'] !== 'string' || typeof a['mediaType'] !== 'string') return undefined;
    const bytes = images({ id, sha256: a['sha256'], mediaType: a['mediaType'] });
    const t = bytes === undefined ? undefined : decodeTexture(bytes, a['mediaType']);
    if (t === undefined) return undefined;
    const sum = [0, 0, 0];
    const n = t.width * t.height;
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) sum[k]! += t.data[3 * i + k]!;
    return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
  };
}

class Materials {
  readonly list: SceneMaterial[] = [];
  private readonly index = new Map<string, number>();
  constructor(
    private readonly doc: FloorspecDocument,
    private readonly average?: MapAverage,
  ) {}

  /**
   * The document's material `id`, or `fallback` when it names none (or none that exists). A material
   * of the document's with no colour is drawn in its map's average colour, else in `fallback`'s.
   */
  of(id: string | null | undefined, fallback: Swatch): number {
    if (id !== null && id !== undefined && Object.hasOwn(this.doc.materials ?? {}, id)) return this.own(id, fallback);
    return this.palette(fallback);
  }

  default(what: keyof typeof DEFAULT_COLOURS): number {
    return this.palette(swatch(what));
  }

  /** A default's material (FLR-T-12.23): `default:<key>`. */
  palette(s: Swatch): number {
    const key = `default:${s.key}`;
    const at = this.index.get(key);
    if (at !== undefined) return at;
    const [r, g, b] = linear(s.color);
    const glass = s.key === 'glass';
    return this.add({
      key,
      name: `Default ${s.name}`,
      baseColor: [r, g, b, glass ? 0.35 : 1],
      color: s.color,
      metallic: 0,
      roughness: glass ? 0.05 : 1,
      declared: {},
      blend: glass,
    });
  }

  /** What a piece of an extension element's model is made of (FLR-T-12.21): the look the editor draws it with too. */
  role(role: ModelRole): number {
    const key = `role:${role}`;
    const at = this.index.get(key);
    if (at !== undefined) return at;
    const look = ROLE_LOOKS[role];
    const [r, g, b] = linear(look.color);
    const opacity = look.opacity ?? 1;
    return this.add({
      key,
      name: `Model ${role}`,
      baseColor: [r, g, b, opacity],
      color: look.color,
      metallic: look.metallic,
      roughness: look.roughness,
      declared: {},
      blend: opacity < 1,
      ...(look.emissive === true ? { emissive: [r, g, b] as const } : {}),
    });
  }

  private own(id: string, fallback: Swatch): number {
    const key = `M:${id}`;
    const at = this.index.get(key);
    if (at !== undefined) return at;
    const m = (this.doc.materials as Record<string, Json>)[id]!;
    const colour = typeof m['color'] === 'string' && HEX.test(m['color']) ? m['color'] : undefined;
    // 18.1: no declared base colour — its map's average where it can be read, else the surface's default.
    const [r, g, b] = colour === undefined ? (this.average?.(id) ?? linear(fallback.color)) : linear(colour);
    const metallic = typeof m['metallic'] === 'number' ? m['metallic'] : undefined;
    const roughness = typeof m['roughness'] === 'number' ? m['roughness'] : undefined;
    const tex = m['texture'] as Json | undefined;
    let texture: SceneTexture | undefined;
    if (tex !== undefined && Array.isArray(tex['size'])) {
      const maps: Partial<Record<MapRole, string>> = {};
      for (const role of MAP_ROLES) if (typeof tex[role] === 'string') maps[role] = tex[role];
      const size = tex['size'] as [number, number];
      const offset = Array.isArray(tex['offset']) ? (tex['offset'] as [number, number]) : ([0, 0] as const);
      texture = { size: [size[0], size[1]], offset: [offset[0], offset[1]], rotation: typeof tex['rotation'] === 'number' ? tex['rotation'] : 0, maps };
    }
    const name = typeof m['name'] === 'string' ? `${id} ${m['name']}` : id;
    return this.add({
      key,
      name,
      floorspec: id,
      baseColor: [r, g, b, 1],
      ...(colour === undefined ? {} : { color: colour }),
      metallic: (metallic ?? 0) / 1000,
      roughness: (roughness ?? 1000) / 1000,
      declared: { ...(metallic === undefined ? {} : { metallic }), ...(roughness === undefined ? {} : { roughness }) },
      blend: false,
      ...(texture === undefined ? {} : { texture }),
    });
  }

  private add(m: SceneMaterial): number {
    this.list.push(m);
    this.index.set(m.key, this.list.length - 1);
    return this.list.length - 1;
  }
}

// ─── Texture space (18.3) ────────────────────────────────────────────────────────────────────

/** A surface's coordinates (s, t) of a point (z-up metres), in base units. */
export type SurfaceST = (p: Vec3) => [number, number];

/** The facing vector of a rotation (13.1), as unit floats. */
function facingOf(rotation: number): [number, number] {
  if (rotation === 0) return [1, 0];
  const [fx, fy] = facingVector(rotation);
  const x = Number(fx);
  const y = Number(fy);
  const l = Math.hypot(x, y);
  return [x / l, y / l];
}

/** 18.3: tile coordinates, then glTF's `u = s′ / w`, `v = −t′ / h`. */
export function tileUV(texture: SceneTexture, s: number, t: number): [number, number] {
  const [fx, fy] = facingOf(texture.rotation);
  const ds = s - texture.offset[0];
  const dt = t - texture.offset[1];
  const s1 = ds * fx + dt * fy;
  const t1 = dt * fx - ds * fy;
  return [s1 / texture.size[0], -t1 / texture.size[1]];
}

/** Where 18.3 defines nothing: a box projection, the face's dominant axis seen from outside. */
const boxST: SurfaceST = (p) => [p[0] * M, p[1] * M];
function boxProjection(n: Vec3): SurfaceST {
  const [ax, ay, az] = n.map(Math.abs) as Vec3;
  if (az >= ax && az >= ay) return n[2] >= 0 ? boxST : (p) => [-p[0] * M, p[1] * M];
  if (ax >= ay) return n[0] >= 0 ? (p) => [p[1] * M, p[2] * M] : (p) => [-p[1] * M, p[2] * M];
  return n[1] >= 0 ? (p) => [-p[0] * M, p[2] * M] : (p) => [p[0] * M, p[2] * M];
}

// ─── Building primitives ─────────────────────────────────────────────────────────────────────

interface Group {
  readonly material: number;
  readonly part: PartKind;
  readonly smooth: boolean;
  /** z-up metres, nine per triangle. */
  readonly tris: number[];
  /** Base-unit surface coordinates, six per triangle, or null for an untextured material. */
  readonly st: number[] | null;
  readonly normals: number[];
}

class NodeBuilder {
  readonly groups = new Map<string, Group>();
  readonly parts: PartKind[] = [];
  constructor(private readonly materials: Materials) {}

  /** Add a convex polygon (z-up metres) with the normal of the triangle it came from. */
  add(part: PartKind, material: number, poly: readonly Vec3[], n: Vec3, st: SurfaceST, smooth = false): void {
    const key = `${part}|${String(material)}${smooth ? '|smooth' : ''}`;
    let g = this.groups.get(key);
    const textured = this.materials.list[material]!.texture !== undefined;
    if (g === undefined) {
      g = { material, part, smooth, tris: [], st: textured ? [] : null, normals: [] };
      this.groups.set(key, g);
    }
    for (let i = 1; i + 1 < poly.length; i++) {
      const tri = [poly[0]!, poly[i]!, poly[i + 1]!];
      if (area(tri[0]!, tri[1]!, tri[2]!) < 1e-12) continue;
      for (const p of tri) {
        g.tris.push(p[0], p[1], p[2]);
        if (g.st !== null) g.st.push(...st(p));
      }
      g.normals.push(n[0], n[1], n[2]);
    }
  }

  /** Each group welded into an indexed primitive in glTF's frame, in the order they were begun. */
  build(): ScenePrimitive[] {
    const out: ScenePrimitive[] = [];
    for (const g of this.groups.values()) {
      if (g.tris.length === 0) continue;
      const tex = this.materials.list[g.material]!.texture;
      const keyOf = new Map<string, number>();
      const pos: number[] = [];
      const nor: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      const f32 = new Float32Array(8);
      const u32 = new Uint32Array(f32.buffer);
      for (let t = 0; t < g.tris.length / 9; t++) {
        const nx = g.normals[3 * t]!;
        const ny = g.normals[3 * t + 1]!;
        const nz = g.normals[3 * t + 2]!;
        for (let k = 0; k < 3; k++) {
          const o = 9 * t + 3 * k;
          // glTF's frame: (x, z, −y).
          f32[0] = g.tris[o]!;
          f32[1] = g.tris[o + 2]!;
          f32[2] = -g.tris[o + 1]!;
          f32[3] = nx;
          f32[4] = nz;
          f32[5] = -ny;
          if (tex !== undefined) {
            const [u, v] = tileUV(tex, g.st![6 * t + 2 * k]!, g.st![6 * t + 2 * k + 1]!);
            f32[6] = u;
            f32[7] = v;
          } else {
            f32[6] = 0;
            f32[7] = 0;
          }
          const key = Array.from(u32, (x) => x.toString(36)).join(',');
          let at = keyOf.get(key);
          if (at === undefined) {
            at = pos.length / 3;
            keyOf.set(key, at);
            pos.push(f32[0], f32[1], f32[2]);
            nor.push(f32[3], f32[4], f32[5]);
            if (tex !== undefined) uv.push(f32[6], f32[7]);
          }
          idx.push(at);
        }
      }
      out.push({
        material: g.material,
        part: g.part,
        positions: Float32Array.from(pos),
        normals: Float32Array.from(nor),
        uvs: tex === undefined ? null : Float32Array.from(uv),
        indices: Uint32Array.from(idx),
        ...(g.smooth ? { smooth: true as const } : {}),
      });
    }
    return out;
  }
}

function area(a: Vec3, b: Vec3, c: Vec3): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

function normalOf(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(...n);
  return l < 2e-12 ? null : [n[0] / l, n[1] / l, n[2] / l];
}

/** A part's triangles as z-up metre points with their unit normals; degenerate ones dropped. */
function* triangles(part: MeshPart): Generator<{ tri: [Vec3, Vec3, Vec3]; n: Vec3 }> {
  const P = part.mesh.positions;
  const I = part.mesh.indices;
  const at = (i: number): Vec3 => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!];
  for (let t = 0; t < I.length; t += 3) {
    const tri: [Vec3, Vec3, Vec3] = [at(I[t]!), at(I[t + 1]!), at(I[t + 2]!)];
    const n = normalOf(...tri);
    if (n !== null) yield { tri, n };
  }
}

// ─── The scene ───────────────────────────────────────────────────────────────────────────────

const ELEMENT_KIND: Record<PartKind, ElementKind> = {
  wall: 'wall',
  junctionFill: 'junction',
  opening: 'opening',
  floor: 'room',
  ceiling: 'room',
  slab: 'slab',
  roof: 'roof',
  roofGable: 'roof',
  stairFlight: 'stair',
  stairLanding: 'stair',
  stairColumn: 'stair',
  stairBlock: 'stair',
  extension: 'extension',
  threshold: 'opening',
};

const COLLECTION: Record<Exclude<ElementKind, 'extension'>, keyof FloorspecDocument> = {
  wall: 'walls',
  junction: 'junctions',
  opening: 'openings',
  room: 'rooms',
  slab: 'slabs',
  roof: 'roofs',
  stair: 'stairs',
};

interface WallFrame {
  /** Start junction, metres. */
  readonly S: [number, number];
  /** Unit direction. */
  readonly e: [number, number];
  /** Left normal, unit. */
  readonly L: [number, number];
  /** Base elevation, metres. */
  readonly b: number;
  /** A point on each face's plane, metres. */
  readonly leftAt: [number, number];
  readonly rightAt: [number, number];
}

function wallFrame(doc: FloorspecDocument, derived: Derived, id: string): WallFrame | undefined {
  const w = doc.walls?.[id];
  const d = derived.walls[id];
  if (w === undefined || d === undefined) return undefined;
  const s = doc.junctions?.[w.start]?.position;
  const e = doc.junctions?.[w.end]?.position;
  if (s === undefined || e === undefined) return undefined;
  const dx = e[0] - s[0];
  const dy = e[1] - s[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return undefined;
  return {
    S: [s[0] / M, s[1] / M],
    e: [dx / len, dy / len],
    L: [-dy / len, dx / len],
    b: d.baseElevation / M,
    leftAt: [d.startLeft[0] / M, d.startLeft[1] / M],
    rightAt: [d.startRight[0] / M, d.startRight[1] / M],
  };
}

/**
 * Build the scene of a document: evaluated once (with `options.reader`, default `OFFICIAL_READER`,
 * in the design asked for, else the primary), derived and meshed. Throws the engine's
 * InvalidDocumentError for a document that is not valid.
 */
export async function buildScene(document: object, options: SceneOptions = {}): Promise<Scene> {
  const reader = options.reader ?? OFFICIAL_READER;
  return buildSceneFrom(evaluate(document, options.design === undefined ? reader : { ...reader, design: options.design }), options);
}

/**
 * The scene of a document the caller has already evaluated (with its own reader, in the design it
 * chose), without validating it again: the drawings' 3D views use the evaluation their plans were
 * drawn from. `options.design` and `options.reader` are the evaluation's and are not read.
 */
export async function buildSceneFrom(ev: Evaluation, options: Pick<SceneOptions, 'levels' | 'images'> = {}): Promise<Scene> {
  if (!ev.valid || ev.document === undefined) throw new InvalidDocumentError(ev.diagnostics);
  const derived = deriveEvaluation(ev);
  const doc = ev.view ?? ev.document;
  const mesher = await getMesher();
  const levelIds = Object.keys(doc.levels ?? {});
  for (const l of options.levels ?? []) if (!levelIds.includes(l)) throw new RangeError(`the model has no level ${l}`);
  const house = mesher.meshDerived(doc, derived, options.levels === undefined ? {} : { levels: options.levels });
  return sceneOf(doc, derived, house.parts, ev.design ?? null, mapAverages(doc, options.images));
}

/** The scene of meshed parts: exported for tests that mesh once and build several ways. */
export function sceneOf(doc: FloorspecDocument, derived: Derived, parts: readonly MeshPart[], design: Readonly<Record<string, string>> | null, average?: MapAverage): Scene {
  const materials = new Materials(doc, average);
  const look = appearanceOf(doc, derived);
  const builders = new Map<string, { node: Omit<SceneNode, 'primitives' | 'parts'>; b: NodeBuilder }>();
  const frames = new Map<string, WallFrame | undefined>();
  const frameOf = (id: string): WallFrame | undefined => {
    if (!frames.has(id)) frames.set(id, wallFrame(doc, derived, id));
    return frames.get(id);
  };
  const finishes = derived.finishes;
  const docLevels = (doc.levels ?? {}) as unknown as Record<string, Json>;

  const ext = new Map(extElements(doc).map((e) => [e.id, e]));
  const nameOf = (kind: ElementKind, id: string): string | undefined => {
    const el = kind === 'extension' ? (ext.get(id)?.element as Json | undefined) : ((doc[COLLECTION[kind]] as Record<string, Json> | undefined)?.[id]);
    const n = el?.['name'];
    return typeof n === 'string' ? n : undefined;
  };

  for (const part of parts) {
    const kind = ELEMENT_KIND[part.kind];
    let entry = builders.get(part.id);
    if (entry === undefined) {
      const name = nameOf(kind, part.id);
      entry = {
        node: {
          id: part.id,
          kind,
          level: part.level,
          ...(name === undefined ? {} : { name }),
          ...(part.opening === undefined ? {} : { category: part.opening.category }),
          ...(part.extension === undefined ? {} : { extension: { name: part.extension.name, collection: part.extension.collection } }),
          ...modelOf(doc, derived, ext.get(part.id)),
        },
        b: new NodeBuilder(materials),
      };
      builders.set(part.id, entry);
    }
    const b = entry.b;
    if (!b.parts.includes(part.kind)) b.parts.push(part.kind);

    switch (part.kind) {
      case 'wall':
      case 'junctionFill':
      case 'threshold': {
        // @floorspec/mesh groups each by finished surface (18.3, 18.6): a wall's faces and their
        // regions — an arc wall's segment by segment (21.6) — and the rest of it (its top, its ends,
        // its openings' reveals) in its core's material; a fill's (or a closure's) faces in its walls'
        // planes are those faces, the rest its walls' core; a threshold is the floor of the room on its
        // side. The editor's 3D view groups them the same way.
        const layers = part.layers ?? [];
        const arc = part.kind === 'wall' && (derived.walls[part.id]?.polyline?.length ?? 0) > 2;
        const room = part.threshold?.room;
        for (const g of surfaceGroups(doc, derived, part)) {
          const s = g.surface;
          let material: number;
          if (s === null) {
            if (part.kind === 'wall') material = materials.of(layers[Math.floor(layers.length / 2)], swatch('wallEdge'));
            else if (part.kind === 'threshold' && room !== undefined) material = materials.of(g.material, look.floor(room));
            else material = materials.of(g.material, swatch('fill'));
          } else if (s.kind === 'floor') material = materials.of(g.material, look.floor(s.room));
          else if (s.kind === 'ceiling') material = materials.of(g.material, look.ceiling(s.room));
          else material = materials.of(g.material ?? (part.kind === 'wall' && s.kind === 'face' ? (s.side === 'left' ? layers[0] : layers[layers.length - 1]) : null), look.face(s.wall, s.side));
          const P = g.positions;
          for (let t = 0; t < P.length / 9; t++) {
            const tri: Vec3[] = [0, 1, 2].map((k): Vec3 => [P[9 * t + 3 * k]!, P[9 * t + 3 * k + 1]!, P[9 * t + 3 * k + 2]!]);
            const n: Vec3 = [g.normals[9 * t]!, g.normals[9 * t + 1]!, g.normals[9 * t + 2]!];
            let st: SurfaceST = boxProjection(n);
            if (s !== null) {
              const at = new Map(tri.map((p, k): [Vec3, [number, number]] => [p, [g.st[6 * t + 2 * k]!, g.st[6 * t + 2 * k + 1]!]]));
              st = (p) => at.get(p) ?? [0, 0];
            }
            // An arc wall's face is one curved surface: no ink between its segments.
            b.add(part.kind, material, tri, n, st, arc && s !== null);
          }
        }
        break;
      }
      case 'opening': {
        // A window's glass; a door's or an empty opening's cut is a hole, so it has no geometry.
        if (part.opening?.category !== 'window') break;
        const glass = materials.default('glass');
        for (const { tri, n } of triangles(part)) b.add('opening', glass, tri, n, boxProjection(n));
        break;
      }
      case 'floor':
      case 'ceiling': {
        const fin = finishes?.rooms[part.id];
        const material = part.kind === 'floor' ? materials.of(fin?.floor, look.floor(part.id)) : materials.of(fin?.ceiling, look.ceiling(part.id));
        // 18.3: a floor's (s, t) is the plan's (x, y); a ceiling's (−x, y), seen from below.
        const st: SurfaceST = part.kind === 'floor' ? (p) => [p[0] * M, p[1] * M] : (p) => [-p[0] * M, p[1] * M];
        for (const { tri, n } of triangles(part)) b.add(part.kind, material, tri, n, st);
        break;
      }
      default: {
        const fallback = swatch(part.kind === 'slab' ? 'slab' : part.kind === 'roof' ? 'roof' : part.kind === 'roofGable' ? 'gable' : part.kind === 'extension' ? 'extension' : 'stair');
        // A piece of a model takes its role's look; a fallback box the quiet default.
        const material = part.model !== undefined ? materials.role(part.model.role) : materials.of(part.kind === 'roofGable' ? undefined : part.material, fallback);
        const smooth = part.model?.smooth === true;
        for (const { tri, n } of triangles(part)) b.add(part.kind, material, tri, n, boxProjection(n), smooth);
      }
    }
  }

  // Levels by elevation, then ID; their nodes in the mesher's order (kind, then key).
  const levels: SceneLevel[] = Object.keys(docLevels)
    .sort((a, b) => Number(docLevels[a]!['elevation']) - Number(docLevels[b]!['elevation']) || (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => {
      const name = docLevels[id]!['name'];
      return { id, ...(typeof name === 'string' ? { name } : {}), elevation: Number(docLevels[id]!['elevation']) / M, nodes: [] as SceneNode[] };
    });
  const byId = new Map(levels.map((l) => [l.id, l]));
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const { node, b } of builders.values()) {
    const primitives = b.build();
    for (const p of primitives)
      for (let i = 0; i < p.positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
          const v = p.positions[i + k]!;
          if (v < min[k]!) min[k] = v;
          if (v > max[k]!) max[k] = v;
        }
    byId.get(node.level)?.nodes.push({ ...node, parts: b.parts, primitives });
  }
  if (!Number.isFinite(min[0])) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }

  const assets: Scene['assets'] = {};
  for (const m of materials.list)
    for (const aid of Object.values(m.texture?.maps ?? {})) {
      const a = (doc.assets as Record<string, Json> | undefined)?.[aid];
      if (a === undefined) continue;
      assets[aid] = {
        sha256: String(a['sha256']),
        mediaType: String(a['mediaType']),
        ...(typeof a['path'] === 'string' ? { path: a['path'] } : {}),
        ...(typeof a['uri'] === 'string' ? { uri: a['uri'] } : {}),
      };
    }

  return {
    project: typeof doc.project.name === 'string' ? doc.project.name : 'Floorspec model',
    design: design === null ? null : { ...design },
    materials: materials.list,
    levels: levels.filter((l) => l.nodes.length > 0),
    bounds: builders.size === 0 ? null : { min, max },
    rooms: roomsOf(doc, derived),
    doors: doorsOf(derived, parts, frameOf),
    obstacles: obstaclesOf(derived),
    lights: lightsOf(doc, derived).map((l) => ({
      id: l.id,
      level: l.level,
      fixture: l.fixture,
      position: [l.position[0] / M, l.position[2] / M, -l.position[1] / M],
      radius: l.radius / M,
      ...(l.cone === undefined ? {} : { spot: { dir: [0, -1, 0] as Vec3, inner: l.cone.inner, outer: l.cone.outer } }),
      lumens: l.lumens,
      color: l.color,
      room: l.room,
    })),
    assets,
  };
}

/** Core 12.6: where an extension element's fallback model goes, when it has one. */
function modelOf(doc: FloorspecDocument, derived: Derived, el: ReturnType<typeof extElements>[number] | undefined): Pick<SceneNode, 'model'> {
  const fallback = (el?.element as { fallback?: { asset?: string; level?: string } } | undefined)?.fallback;
  if (el === undefined || fallback?.asset === undefined) return {};
  const placed = derived.placements?.[el.id];
  const elevation = Number((doc.levels as Record<string, Json> | undefined)?.[fallback.level ?? '']?.['elevation'] ?? 0);
  // A hosted element is placed by its host's frame (13.4); an unhosted one by its level's.
  const [x, y, z] = placed?.point ?? [0, 0, elevation];
  const facing = placed?.facing ?? 0;
  const half = ((facing / 1e6) * Math.PI) / 360;
  const a = (doc.assets as Record<string, Json> | undefined)?.[fallback.asset];
  return {
    model: {
      asset: fallback.asset,
      ...(typeof a?.['sha256'] === 'string' ? { sha256: a['sha256'] } : {}),
      ...(typeof a?.['mediaType'] === 'string' ? { mediaType: a['mediaType'] } : {}),
      translation: [x / M, z / M, -y / M],
      rotation: [0, Math.sin(half), 0, Math.cos(half)],
    },
  };
}

function roomsOf(doc: FloorspecDocument, derived: Derived): SceneRoom[] {
  const out: SceneRoom[] = [];
  for (const [id, poly] of Object.entries(derived.rooms).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const room = doc.rooms?.[id];
    if (room === undefined) continue;
    const level = (doc.levels as Record<string, unknown> | undefined)?.[room.level] as Json | undefined;
    const elevation = Number(level?.['elevation'] ?? 0);
    const floor = (derived.floors?.[id]?.top ?? elevation) / M;
    const height = Number(level?.['height'] ?? 2_438_400 * 1.25);
    const ceiling = (derived.ceilings?.[id]?.low ?? elevation + height) / M;
    out.push({
      id,
      ...(typeof room.name === 'string' ? { name: room.name } : {}),
      level: room.level,
      outer: poly.outer.map(([x, y]) => [x / M, y / M] as [number, number]),
      floor,
      ceiling,
    });
  }
  return out;
}

function obstaclesOf(derived: Derived): SceneObstacle[] {
  return Object.entries(derived.fallbacks ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, f]) => ({
      id,
      level: f.level,
      extension: f.extension,
      collection: f.collection,
      footprint: f.footprint.map(([x, y]) => [x / M, y / M] as [number, number]),
      bottom: f.bottom / M,
      top: f.top / M,
    }));
}

function doorsOf(derived: Derived, parts: readonly MeshPart[], frameOf: (id: string) => WallFrame | undefined): SceneDoor[] {
  const out: SceneDoor[] = [];
  for (const part of parts) {
    if (part.kind !== 'opening' || part.opening?.category !== 'door') continue;
    const o = derived.openings[part.id];
    const f = frameOf(part.opening.wall);
    if (o === undefined || f === undefined) continue;
    const half = Math.abs((f.leftAt[0] - f.rightAt[0]) * f.L[0] + (f.leftAt[1] - f.rightAt[1]) * f.L[1]) / 2;
    out.push({
      id: part.id,
      level: part.level,
      mid: [(o.start[0] + o.end[0]) / 2 / M, (o.start[1] + o.end[1]) / 2 / M],
      normal: f.L,
      halfThickness: half,
      sill: o.sillElevation / M,
    });
  }
  return out;
}
