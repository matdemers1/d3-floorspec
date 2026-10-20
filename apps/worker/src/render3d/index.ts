/**
 * Headless 3D render-back (FLR-T-8.5, FLR-REQ-122): a PNG of a version's 3D model from a named view
 * — `sw`, `se`, `ne`, `nw` (isometric corners) or `top` — or from inside a room, drawn by the worker
 * from the same scene the glTF and USDZ exports write (export/gltf/scene.ts), by a software
 * rasterizer (raster.ts). An agent asks for it through MCP `floorspec_render` with `view: "3d"`; the
 * api queues it on the job queue and waits for the worker. A level cuts the house away above it;
 * `"all"` (or none) draws the whole house, every level's ceilings and every roof (FLR-T-12.23).
 */
import { buildScene, readGlb, type Scene, type SceneOptions, type Vec3 } from '../export/gltf/index.js';
import { linear } from '../export/gltf/scene.js';
import { findRoom, PRESETS, presetCamera, roomCamera, type Camera, type Preset } from './camera.js';
import { encodePng } from './png.js';
import { sideBySideComposite } from './composite.js';
import { rasterize, type DrawList, type RasterLamp, type RasterSky } from './raster.js';
import type { ImageSource } from '../export/gltf/glb.js';
import { skyBounce, skyExposure, skyHarmonics, type LookRequest, type SkyPreset } from '@floorspec/mesh/sky';
import { lookOption } from '../pathtrace/index.js';
import { lawnTinted, resolveSky, skySummary, type ResolvedSky, type SkySummary } from '../pathtrace/sky.js';
import { texturesOf } from '../pathtrace/index.js';
import { mipChain, type Texture } from '../pathtrace/textures.js';
import { withLibrary } from '../export/gltf/library.js';

export { PRESETS, presetCamera, roomCamera, findRoom, centroid, type Camera, type Preset } from './camera.js';
export { LIGHTS, rasterize, shoulder, tone, type DrawList, type RasterLamp, type RasterOptions, type RasterSky } from './raster.js';
export { encodePng } from './png.js';

export const DEFAULT_WIDTH = 1024;
export const MAX_WIDTH = 2048;

export interface Render3dOptions extends Omit<SceneOptions, 'levels'> {
  /** A named view. Default `sw` — unless `room` is given. */
  readonly camera?: Preset;
  /** Stand in this room (its ID or name) instead. */
  readonly room?: string;
  /** Cut away above this level: its ceilings and roof are left off, and every level above it. `"all"`: the whole house. */
  readonly level?: string;
  /** Element IDs drawn in the accent colour. */
  readonly highlight?: readonly string[];
  /** Pixels; the height is three quarters of it. Default 1024. */
  readonly width?: number;
  /**
   * Seen under a sky (FLR-T-13.4) — and with `at`, a date and time at the site, under its sun
   * (FLR-T-13.9) — instead of the studio drawing: the sun's shadows, the sky's light, the lawn.
   */
  readonly sky?: SkyPreset;
  readonly at?: string;
  /** FLR-T-15.4: the season and the weather it is seen in — under a sky (a clear one, when none is named). */
  readonly look?: LookRequest;
}

export interface Render3dResult {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** What the camera was, in words. */
  readonly camera: string;
  readonly design: Record<string, string> | null;
  /** Under a sky: which, where the sun was, and the site. */
  readonly sky?: SkySummary;
  /** With `rgb`: the picture, eight bits a channel, rows top to bottom. */
  readonly rgb?: Uint8Array;
}

/** The accent a highlighted element is drawn in (linear RGB). */
const ACCENT = linear('#3d63dd');
/** The ground: a muted lawn, so a house's own colours read against it. */
const GROUND = linear('#b4bf9c');

/** The level that means the whole house: no cutaway, every ceiling and every roof. */
export const ALL_LEVELS = 'all';

/**
 * Where a view cuts the house away: the place of `level` among the scene's levels (lowest first), or
 * undefined for none — no level, or `"all"`, unless the model has a level whose ID is "all", which
 * is then the one meant. Throws for a level the scene does not draw.
 */
export function cutOf(scene: Pick<Scene, 'levels'>, level: string | undefined): number | undefined {
  if (level === undefined) return undefined;
  const at = scene.levels.findIndex((l) => l.id === level);
  if (at >= 0) return at;
  if (level === ALL_LEVELS) return undefined;
  throw new RangeError(`the model has no level ${level} with anything to draw; "all" draws the whole house`);
}
/** The first outline key of a round piece: far past the planes' keys, which count up from 0. */
const SMOOTH_KEYS = 1 << 24;

interface Tri {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly rgb: readonly [number, number, number];
  readonly alpha: number;
  readonly twoSided: boolean;
  readonly key?: number;
  readonly bias?: number;
  readonly unlit?: boolean;
  /** FLR-T-13.6: its base colour map (an index into the draw list's maps) and its corners' coordinates (glTF's). */
  readonly map?: number;
  /** Its normal map and its occlusion map, indices into the draw list's maps. */
  readonly relief?: number;
  readonly occlusion?: number;
  readonly uv?: readonly [number, number, number, number, number, number];
}

/** A material's maps as the rasterizer draws them: indices into the draw list's mip chains. */
export interface RasterMaps {
  readonly albedo?: number;
  readonly relief?: number;
  readonly occlusion?: number;
}

/** Triangles into a draw list, each keyed by its plane, so coplanar neighbours draw no line. */
function drawList(tris: readonly Tri[], maps: readonly (readonly Texture[])[] = []): DrawList {
  const n = tris.length;
  const list = {
    map: new Int32Array(n).fill(-1),
    relief: new Int32Array(n).fill(-1),
    occlusion: new Int32Array(n).fill(-1),
    uvs: new Float32Array(6 * n),
    maps,
    positions: new Float32Array(9 * n),
    normals: new Float32Array(3 * n),
    colors: new Float32Array(3 * n),
    alpha: new Float32Array(n),
    keys: new Int32Array(n),
    twoSided: new Uint8Array(n),
    bias: new Uint8Array(n),
    unlit: new Uint8Array(n),
    count: n,
  };
  const planes = new Map<string, number>();
  let kept = 0;
  for (const t of tris) {
    const u = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]];
    const v = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
    const nx = u[1]! * v[2]! - u[2]! * v[1]!;
    const ny = u[2]! * v[0]! - u[0]! * v[2]!;
    const nz = u[0]! * v[1]! - u[1]! * v[0]!;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    const nrm: Vec3 = [nx / l, ny / l, nz / l];
    const d = nrm[0] * t.a[0] + nrm[1] * t.a[1] + nrm[2] * t.a[2];
    const plane = `${String(Math.round(nrm[0] * 50))},${String(Math.round(nrm[1] * 50))},${String(Math.round(nrm[2] * 50))},${String(Math.round(d * 200))}`;
    let key = t.key;
    if (key === undefined) {
      key = planes.get(plane);
      if (key === undefined) {
        key = planes.size;
        planes.set(plane, key);
      }
    }
    list.positions.set([...t.a, ...t.b, ...t.c], 9 * kept);
    list.normals.set(nrm, 3 * kept);
    list.colors.set(t.rgb, 3 * kept);
    list.alpha[kept] = t.alpha;
    list.keys[kept] = key;
    list.twoSided[kept] = t.twoSided ? 1 : 0;
    list.bias[kept] = t.bias ?? 0;
    list.unlit[kept] = t.unlit === true ? 1 : 0;
    if (t.uv !== undefined) {
      list.map[kept] = t.map ?? -1;
      list.relief[kept] = t.relief ?? -1;
      list.occlusion[kept] = t.occlusion ?? -1;
      list.uvs.set(t.uv, 6 * kept);
    }
    kept++;
  }
  return { ...list, count: kept };
}

const mix = (c: readonly [number, number, number], d: readonly [number, number, number], k: number): [number, number, number] => [
  c[0] + (d[0] - c[0]) * k,
  c[1] + (d[1] - c[1]) * k,
  c[2] + (d[2] - c[2]) * k,
];

/** A big ground plate under the house, out to the horizon. */
function ground(bounds: { min: Vec3; max: Vec3 }): Tri[] {
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const r = 40 * Math.max(5, Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]));
  const y = bounds.min[1] - 0.003;
  const p: Vec3[] = [
    [cx - r, y, cz + r],
    [cx + r, y, cz + r],
    [cx + r, y, cz - r],
    [cx - r, y, cz - r],
  ];
  return [
    { a: p[0]!, b: p[1]!, c: p[2]!, rgb: GROUND, alpha: 1, twoSided: false, key: -2 },
    { a: p[0]!, b: p[2]!, c: p[3]!, rgb: GROUND, alpha: 1, twoSided: false, key: -2 },
  ];
}

/** The scene's triangles as drawn: cut away above `level`, highlighted, with a ground under them. */
export function sceneTriangles(scene: Scene, options: { level?: string; only?: boolean; highlight?: readonly string[]; ground?: boolean; maps?: ReadonlyMap<number, RasterMaps> } = {}): Tri[] {
  const order = new Map(scene.levels.map((l, i) => [l.id, i]));
  const cut = cutOf(scene, options.level);
  // One level alone (FLR-T-13.2): none below the cut either.
  const alone = options.only === true && cut !== undefined;
  const lit = new Set(options.highlight ?? []);
  const tris: Tri[] = [];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  // A round piece's facets share one outline key, past every plane's (drawList), so ink is drawn only round it.
  let round = SMOOTH_KEYS;
  for (const level of scene.levels) {
    const at = order.get(level.id)!;
    if (cut !== undefined && at > cut) continue;
    if (alone && at < cut) continue;
    for (const node of level.nodes) {
      // An appliance lights for the elements it stands for too (FLR-T-12.34): they have no node of their own.
      const on = lit.has(node.id) || (node.standsFor ?? []).some((id) => lit.has(id));
      for (const p of node.primitives) {
        if (cut === at && (p.part === 'ceiling' || p.part === 'roof' || p.part === 'roofGable')) continue;
        const m = scene.materials[p.material]!;
        // A mapped surface is white under its map, whose texel is its colour (Core 18.1).
        const map = p.uvs === null ? undefined : options.maps?.get(p.material);
        const base = map?.albedo === undefined ? (m.baseColor.slice(0, 3) as Vec3) : ([1, 1, 1] as Vec3);
        const rgb = on ? mix(base, ACCENT, 0.6) : base;
        const UV = p.uvs;
        const bias = p.part === 'ceiling' ? 2 : p.part === 'floor' || p.part === 'threshold' ? 1 : 0;
        const key = p.smooth === true ? round++ : undefined;
        const P = p.positions;
        const at3 = (i: number): Vec3 => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!];
        for (let k = 0; k < p.indices.length; k += 3) {
          const a = at3(p.indices[k]!);
          const b = at3(p.indices[k + 1]!);
          const c = at3(p.indices[k + 2]!);
          for (const q of [a, b, c])
            for (let j = 0; j < 3; j++) {
              min[j] = Math.min(min[j]!, q[j]!);
              max[j] = Math.max(max[j]!, q[j]!);
            }
          const uv = map === undefined || UV === null ? undefined : ([0, 1, 2].flatMap((j) => [UV[2 * p.indices[k + j]!]!, UV[2 * p.indices[k + j]! + 1]!]) as unknown as Tri['uv']);
          tris.push({ a, b, c, rgb, alpha: m.baseColor[3], twoSided: m.blend, bias, ...(key === undefined ? {} : { key }), ...(m.emissive === undefined ? {} : { unlit: true }), ...(map === undefined || uv === undefined ? {} : { uv, ...(map.albedo === undefined ? {} : { map: map.albedo }), ...(map.relief === undefined ? {} : { relief: map.relief }), ...(map.occlusion === undefined ? {} : { occlusion: map.occlusion }) }) });
        }
      }
    }
  }
  if (options.ground !== false && Number.isFinite(min[0])) tris.push(...ground({ min, max }));
  return tris;
}

function boundsOf(tris: readonly Tri[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    if (t.key === -2) continue;
    for (const q of [t.a, t.b, t.c])
      for (let j = 0; j < 3; j++) {
        min[j] = Math.min(min[j]!, q[j]!);
        max[j] = Math.max(max[j]!, q[j]!);
      }
  }
  return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

function sizeOf(width: number | undefined): { width: number; height: number } {
  const w = width ?? DEFAULT_WIDTH;
  if (!Number.isInteger(w) || w < 64 || w > MAX_WIDTH) throw new RangeError(`width is an integer from 64 to ${String(MAX_WIDTH)}`);
  return { width: w, height: Math.round((w * 3) / 4) };
}

/** A resolved sky as the rasterizer draws with it: its light in this frame, its harmonics and its exposure. */
export function rasterSky(sky: ResolvedSky, groundY: number): RasterSky {
  const d = sky.light.direct;
  return {
    field: sky.field,
    sh: skyHarmonics(sky.field),
    exposure: skyExposure(sky.light, sky.field.maps),
    sun: d === null ? null : { dir: [d.dir[0], d.dir[2], -d.dir[1]], lux: d.lux, color: d.color },
    groundY,
    ...(sky.light.ground.grass ? (lawnTinted(sky.light) ? { lawnTint: sky.light.ground.tint } : {}) : { floor: sky.light.ground.albedo }),
    bounce: (() => {
      const b = skyBounce(sky.light);
      return [b.lux * b.color[0], b.lux * b.color[1], b.lux * b.color[2]] as Vec3;
    })(),
  };
}

/** Each material's maps as the rasterizer draws them, decoded once: mip chains, and which a material uses. */
function rasterMaps(scene: Scene, images: ImageSource | undefined): { chains: Texture[][]; maps: Map<number, RasterMaps> } {
  // FLR-T-13.6: each material's base colour map, the store's or the library's, as a mip chain.
  const decoded = texturesOf(scene, withLibrary(images));
  const chains: Texture[][] = [];
  const maps = new Map<number, RasterMaps>();
  const seen = new Map<Texture, number>();
  const chainOf = (t: Texture | undefined): number | undefined => {
    if (t === undefined) return undefined;
    let at = seen.get(t);
    if (at === undefined) {
      at = chains.push(mipChain(t)) - 1;
      seen.set(t, at);
    }
    return at;
  };
  for (const [material, m] of decoded.textures) {
    const albedo = chainOf(m.albedo);
    const relief = chainOf(m.normal);
    const occlusion = chainOf(m.orm);
    maps.set(material, { ...(albedo === undefined ? {} : { albedo }), ...(relief === undefined ? {} : { relief }), ...(occlusion === undefined ? {} : { occlusion }) });
  }
  return { chains, maps };
}

/**
 * A scene made ready to be drawn many times (FLR-T-14.1, a film's drafts): its maps decoded once, a
 * draw list for each cutaway asked for, kept, and the lamps of the levels each one draws — each with
 * the room it lights.
 */
export interface RasterStage {
  /** The draw list of a cutaway (`level` and those below it, or it alone): the same object every time it is asked for. */
  list(level?: string, only?: boolean): DrawList;
  /** The lamps on the levels that cutaway draws, at full. */
  lamps(level?: string, only?: boolean): RasterLamp[];
  /** The ground's height under the house, metres (+Y). */
  readonly groundY: number;
}

export function rasterStage(scene: Scene, images?: ImageSource): RasterStage {
  const { chains, maps } = rasterMaps(scene, images);
  const lists = new Map<string, DrawList>();
  const order = new Map(scene.levels.map((l, i) => [l.id, i]));
  const all = boundsOf(sceneTriangles(scene, { ground: false }));
  const rooms = new Map(scene.rooms.map((r) => [r.id, r]));
  return {
    groundY: all.min[1] - 0.003,
    list(level, only) {
      const key = `${level ?? ''}|${only === true ? 'only' : ''}`;
      let list = lists.get(key);
      if (list === undefined) {
        list = drawList(sceneTriangles(scene, { ...(level === undefined ? {} : { level, ...(only === true ? { only: true } : {}) }), ground: false, maps }), chains);
        lists.set(key, list);
      }
      return list;
    },
    lamps(level, only) {
      const cut = cutOf(scene, level);
      return scene.lights.flatMap((l): RasterLamp[] => {
        const at = order.get(l.level) ?? Infinity;
        if (cut !== undefined && (at > cut || (only === true && at !== cut))) return [];
        const room = l.room === null ? undefined : rooms.get(l.room);
        if (room === undefined) return [];
        const sr = l.spot === undefined ? 4 * Math.PI : 2 * Math.PI * (1 - (l.spot.inner + l.spot.outer) / 2);
        const cd = l.lumens / sr;
        return [{ position: l.position, intensity: [l.color[0] * cd, l.color[1] * cd, l.color[2] * cd], ...(l.spot === undefined ? {} : { spot: l.spot }), room: { outer: room.outer, floor: room.floor, ceiling: room.ceiling } }];
      });
    },
  };
}

/** Render a scene: from a named view, or from inside a room. */
export function renderScene(
  scene: Scene,
  options: Omit<Render3dOptions, 'design' | 'sky' | 'at'> & {
    readonly skyLight?: ResolvedSky;
    /** A camera given whole (FLR-T-13.10, a saved view's), in place of `camera` and `room`; and the picture's size. */
    readonly shot?: { readonly camera: Camera; readonly width: number; readonly height: number };
    /** `level` alone, without the levels below it. */
    readonly only?: boolean;
    /** Exposure compensation: a factor on the exposure. */
    readonly exposureScale?: number;
    /** Also give back the picture as eight-bit RGB (a comparison's composite, FLR-T-14.4). */
    readonly rgb?: boolean;
  } = {},
): Render3dResult {
  const { width, height } = options.shot === undefined ? sizeOf(options.width) : { width: options.shot.width, height: options.shot.height };
  cutOf(scene, options.level);
  const { chains, maps } = rasterMaps(scene, options.images);
  let camera: Camera;
  let tris: Tri[];
  if (options.shot !== undefined) {
    camera = options.shot.camera;
    tris = sceneTriangles(scene, { ...(options.level === undefined ? {} : { level: options.level, ...(options.only === true ? { only: true } : {}) }), ...(options.highlight === undefined ? {} : { highlight: options.highlight }), ground: options.skyLight === undefined, maps });
  } else if (options.room !== undefined) {
    const room = findRoom(scene.rooms, options.room);
    if (room === undefined) {
      const known = scene.rooms.map((r) => (r.name === undefined ? r.id : `${r.id} (${r.name})`));
      throw new RangeError(`the model has no room ${options.room}${known.length === 0 ? '' : `; its rooms are ${known.slice(0, 20).join(', ')}`}`);
    }
    camera = roomCamera(room, scene.doors, scene.obstacles);
    tris = sceneTriangles(scene, { ...(options.highlight === undefined ? {} : { highlight: options.highlight }), ground: options.skyLight === undefined, maps });
  } else {
    tris = sceneTriangles(scene, {
      ...(options.level === undefined ? {} : { level: options.level }),
      ...(options.highlight === undefined ? {} : { highlight: options.highlight }),
      // Under a sky the ground is the rasterizer's own plane, out to the horizon.
      ground: options.skyLight === undefined,
      maps,
    });
    camera = presetCamera(options.camera ?? 'sw', boundsOf(tris), width / height);
  }
  const all = boundsOf(sceneTriangles(scene, { ground: false }));
  const lighting = options.skyLight === undefined ? undefined : rasterSky(options.skyLight, all.min[1] - 0.003);
  const rgb = rasterize(drawList(tris, chains), camera, { width, height, supersample: 2, ...(lighting === undefined ? {} : { lighting }), ...(options.exposureScale === undefined ? {} : { exposureScale: options.exposureScale }) });
  return { png: encodePng(rgb, width, height), width, height, camera: camera.label, design: scene.design, ...(options.skyLight === undefined || lighting === undefined ? {} : { sky: skySummary(options.skyLight, Number(lighting.exposure.toPrecision(3))) }), ...(options.rgb === true ? { rgb } : {}) };
}

/** A side of a rasterized comparison (FLR-T-14.4): its document, its design, what is lit in it. */
export interface ComparedSide {
  readonly document: object;
  readonly design?: Record<string, string>;
  /** Element IDs drawn in the accent colour: what B changes. */
  readonly highlight?: readonly string[];
}

export interface CompareResult {
  /** A and B side by side, a gap between. */
  readonly png: Uint8Array;
  /** Each side's picture. */
  readonly width: number;
  readonly height: number;
  readonly camera: string;
  readonly design: { readonly a: Record<string, string> | null; readonly b: Record<string, string> | null };
}

/**
 * A comparison an agent asks for (FLR-T-14.4, `floorspec_render` with `compare`): A and B rasterized
 * through one camera — a named view framed on both houses together, or a room of A's — and set side
 * by side, B's changes lit in the accent colour. `width` is each side's.
 */
export async function render3dCompare(a: ComparedSide, b: ComparedSide, options: Omit<Render3dOptions, 'design' | 'highlight'> = {}): Promise<CompareResult> {
  if (options.camera !== undefined && !PRESETS.includes(options.camera)) throw new RangeError(`camera is one of ${PRESETS.join(', ')}`);
  const build = (s: ComparedSide) =>
    buildScene(s.document, {
      ...(s.design === undefined ? {} : { design: s.design }),
      ...(options.reader === undefined ? {} : { reader: options.reader }),
      ...(options.images === undefined ? {} : { images: options.images }),
      ...(options.doors === undefined ? {} : { doors: options.doors }),
      ...(options.lighting === undefined ? {} : { lighting: options.lighting }),
      ...lookOption(options.look),
    });
  const [sa, sb] = await Promise.all([build(a), build(b)]);
  const { width, height } = sizeOf(options.width);
  cutOf(sa, options.level);
  let camera: Camera;
  if (options.room !== undefined) {
    const room = findRoom(sa.rooms, options.room);
    if (room === undefined) {
      const known = sa.rooms.map((r) => (r.name === undefined ? r.id : `${r.id} (${r.name})`));
      throw new RangeError(`the model has no room ${options.room}${known.length === 0 ? '' : `; its rooms are ${known.slice(0, 20).join(', ')}`}`);
    }
    camera = roomCamera(room, sa.doors, sa.obstacles);
  } else {
    const cut = options.level === undefined ? {} : { level: options.level };
    const ba = boundsOf(sceneTriangles(sa, { ...cut, ground: false }));
    const bb = boundsOf(sceneTriangles(sb, { ...cut, ground: false }));
    camera = presetCamera(options.camera ?? 'sw', { min: [Math.min(ba.min[0], bb.min[0]), Math.min(ba.min[1], bb.min[1]), Math.min(ba.min[2], bb.min[2])], max: [Math.max(ba.max[0], bb.max[0]), Math.max(ba.max[1], bb.max[1]), Math.max(ba.max[2], bb.max[2])] }, width / height);
  }
  const { sky, at } = options;
  const look = lookOption(options.look).look;
  const skyLight = sky === undefined && at === undefined && look === undefined ? undefined : resolveSky(a.document, { ...(sky === undefined ? {} : { sky }), ...(at === undefined ? {} : { at }), ...look });
  const draw = (scene: Scene, side: ComparedSide) =>
    renderScene(scene, {
      shot: { camera, width, height },
      ...(options.level === undefined ? {} : { level: options.level }),
      ...(side.highlight === undefined ? {} : { highlight: side.highlight }),
      ...(options.images === undefined ? {} : { images: options.images }),
      ...(skyLight === undefined ? {} : { skyLight }),
      rgb: true,
    });
  const ra = draw(sa, a);
  const rb = draw(sb, b);
  if (ra.rgb === undefined || rb.rgb === undefined) throw new Error('the comparison was not drawn');
  const both = sideBySideComposite(ra.rgb, rb.rgb, width, height);
  return { png: encodePng(both.rgb, both.width, both.height), width, height, camera: camera.label, design: { a: sa.design, b: sb.design } };
}

export interface ViewOptions {
  readonly camera?: Preset;
  /** Cut away above this level (as `renderScene`). */
  readonly level?: string;
  /** Pixels, any aspect: a drawing sheet's 3D panel is the panel's shape. */
  readonly width: number;
  readonly height: number;
  /** Linear RGB behind the model. Default white: a drawing's paper. */
  readonly background?: Vec3;
  /** A ground plate under the house. Default false. */
  readonly ground?: boolean;
}

/**
 * A named view of a scene at any size, for a drawing (FLR-T-9.7): the model alone on the paper's
 * colour, framed on what is drawn. Null when nothing is drawn (an empty model, or a cut below it).
 */
export function renderView(scene: Scene, options: ViewOptions): { png: Uint8Array; width: number; height: number; camera: string } | null {
  const { width, height } = options;
  for (const v of [width, height]) if (!Number.isInteger(v) || v < 16 || v > MAX_WIDTH) throw new RangeError(`a view is 16 to ${String(MAX_WIDTH)} pixels each way`);
  const tris = sceneTriangles(scene, { ...(options.level === undefined ? {} : { level: options.level }), ground: options.ground ?? false });
  if (tris.every((t) => t.key === -2)) return null;
  const camera = presetCamera(options.camera ?? 'sw', boundsOf(tris), width / height);
  const bg = options.background ?? [1, 1, 1];
  const rgb = rasterize(drawList(tris), camera, { width, height, supersample: 2, sky: [bg, bg] });
  return { png: encodePng(rgb, width, height), width, height, camera: camera.label };
}

/** Render a version's 3D model (FLR-T-8.5). Throws for an invalid model, an unknown room or level. */
export async function render3dPng(document: object, options: Render3dOptions = {}): Promise<Render3dResult> {
  if (options.camera !== undefined && !PRESETS.includes(options.camera)) throw new RangeError(`camera is one of ${PRESETS.join(', ')}`);
  // One evaluation, with the reader asked for (default OFFICIAL_READER, the editor's: FLR-T-12.10).
  const scene = await buildScene(document, {
    ...(options.design === undefined ? {} : { design: options.design }),
    ...(options.reader === undefined ? {} : { reader: options.reader }),
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(options.doors === undefined ? {} : { doors: options.doors }),
    ...(options.lighting === undefined ? {} : { lighting: options.lighting }),
    ...lookOption(options.look),
  });
  const { sky, at, look: asked, ...rest } = options;
  const look = lookOption(asked).look;
  const skyLight = sky === undefined && at === undefined && look === undefined ? undefined : resolveSky(document, { ...(sky === undefined ? {} : { sky }), ...(at === undefined ? {} : { at }), ...look });
  return renderScene(scene, { ...rest, ...(skyLight === undefined ? {} : { skyLight }) });
}

// ─── An exported .glb, drawn back ────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
}
function trs(node: Json): Mat4 {
  if (Array.isArray(node['matrix'])) return node['matrix'] as Mat4;
  const [tx, ty, tz] = (node['translation'] as number[] | undefined) ?? [0, 0, 0];
  const [x, y, z, w] = (node['rotation'] as number[] | undefined) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = (node['scale'] as number[] | undefined) ?? [1, 1, 1];
  const r = [1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! + z! * w!), 2 * (x! * z! - y! * w!), 2 * (x! * y! - z! * w!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! + x! * w!), 2 * (x! * z! + y! * w!), 2 * (y! * z! - x! * w!), 1 - 2 * (x! * x! + y! * y!)];
  return [r[0]! * sx!, r[1]! * sx!, r[2]! * sx!, 0, r[3]! * sy!, r[4]! * sy!, r[5]! * sy!, 0, r[6]! * sz!, r[7]! * sz!, r[8]! * sz!, 0, tx!, ty!, tz!, 1];
}

/**
 * The triangles of a .glb this exporter wrote (float positions, 16- or 32-bit indices, no strides),
 * in its base colours: what a viewer that opens the file shows, drawn by the same rasterizer.
 */
export function glbTriangles(bytes: Uint8Array, options: { highlight?: readonly string[] } = {}): Tri[] {
  const { json, bin } = readGlb(bytes);
  if (bin === null) return [];
  const accessors = (json['accessors'] ?? []) as Json[];
  const views = (json['bufferViews'] ?? []) as Json[];
  const meshes = (json['meshes'] ?? []) as Json[];
  const materials = (json['materials'] ?? []) as Json[];
  const nodes = (json['nodes'] ?? []) as Json[];
  const lit = new Set(options.highlight ?? []);
  const read = (index: number): Float32Array | Uint16Array | Uint32Array => {
    const a = accessors[index]!;
    const view = views[a['bufferView'] as number]!;
    const offset = bin.byteOffset + Number(view['byteOffset'] ?? 0) + Number(a['byteOffset'] ?? 0);
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a['type'] as string] ?? 1;
    const count = Number(a['count']) * width;
    const copy = bin.buffer.slice(offset, offset + count * (a['componentType'] === 5123 ? 2 : 4));
    return a['componentType'] === 5126 ? new Float32Array(copy) : a['componentType'] === 5123 ? new Uint16Array(copy) : new Uint32Array(copy);
  };
  const tris: Tri[] = [];
  const walk = (index: number, parent: Mat4, on: boolean): void => {
    const node = nodes[index]!;
    const m = mul(parent, trs(node));
    const extras = (node['extras'] as Json | undefined)?.['floorspec'] as Json | undefined;
    const own = extras?.['id'];
    // An appliance lights for the elements it stands for too (FLR-T-12.34).
    const stands = extras?.['standsFor'];
    const lights = typeof own === 'string' ? lit.has(own) || (Array.isArray(stands) && stands.some((x) => typeof x === 'string' && lit.has(x))) : on;
    if (typeof node['mesh'] === 'number')
      for (const p of (meshes[node['mesh']]!['primitives'] as Json[] | undefined) ?? []) {
        const attrs = p['attributes'] as Record<string, number>;
        const pos = read(attrs['POSITION']!);
        const idx = typeof p['indices'] === 'number' ? read(p['indices']) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
        const mat = typeof p['material'] === 'number' ? materials[p['material']] : undefined;
        const pbr = (mat?.['pbrMetallicRoughness'] ?? {}) as Json;
        const factor = (pbr['baseColorFactor'] as number[] | undefined) ?? [1, 1, 1, 1];
        const base: [number, number, number] = [factor[0]!, factor[1]!, factor[2]!];
        const rgb = lights ? mix(base, ACCENT, 0.6) : base;
        const blend = mat?.['alphaMode'] === 'BLEND';
        const at = (i: number): Vec3 => {
          const x = pos[3 * i]!;
          const y = pos[3 * i + 1]!;
          const z = pos[3 * i + 2]!;
          return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
        };
        for (let k = 0; k + 2 < idx.length; k += 3)
          tris.push({ a: at(idx[k]!), b: at(idx[k + 1]!), c: at(idx[k + 2]!), rgb, alpha: blend ? factor[3]! : 1, twoSided: mat?.['doubleSided'] === true });
      }
    for (const child of (node['children'] as number[] | undefined) ?? []) walk(child, m, lights);
  };
  const scene = ((json['scenes'] as Json[] | undefined) ?? [])[Number(json['scene'] ?? 0)];
  for (const root of (scene?.['nodes'] as number[] | undefined) ?? []) walk(root, IDENTITY, false);
  return tris;
}

/** Draw an exported .glb from a named view, with a ground under it. */
export function renderGlb(bytes: Uint8Array, options: { camera?: Preset; width?: number; highlight?: readonly string[] } = {}): Render3dResult {
  const { width, height } = sizeOf(options.width);
  const tris = glbTriangles(bytes, options.highlight === undefined ? {} : { highlight: options.highlight });
  const box = boundsOf(tris);
  tris.push(...ground(box));
  const camera = presetCamera(options.camera ?? 'sw', box, width / height);
  const rgb = rasterize(drawList(tris), camera, { width, height, supersample: 2 });
  return { png: encodePng(rgb, width, height), width, height, camera: camera.label, design: null };
}
