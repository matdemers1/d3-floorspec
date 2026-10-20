/**
 * Path-traced stills (FLR-T-12.6, FLR-REQ-154): on request, an offline render of a chosen view of a
 * version — one of the editor's named views, or standing in a room — from the same scene the glTF
 * export writes and the headless render draws (export/gltf/scene.ts, @floorspec/mesh's meshes), the
 * same cameras (render3d/camera.ts), and the materials' colours and base-colour maps where the asset
 * store has them. A job on the Postgres queue (`export.still`), like the exports: the api starts it,
 * the UI polls it, and its PNG is downloaded from the exports list.
 *
 * Bounded: three sizes and three qualities, and a combination over the work budget is refused
 * before a ray is cast; a still that runs past its time budget is stopped with a reason. Seeded: the
 * same version and options always give the same PNG.
 */
import { buildScene, type Scene, type SceneOptions, type Vec3 } from '../export/gltf/scene.js';
import type { ImageSource } from '../export/gltf/glb.js';
import { withLibrary } from '../export/gltf/library.js';
import { linear } from '../export/gltf/scene.js';
import { findRoom, PRESETS, presetCamera, roomCamera, type Camera, type Preset } from '../render3d/camera.js';
import { encodePng } from '../render3d/png.js';
import { denoise } from './denoise.js';
import { BUDGET_MS, DEFAULT_SUN, LIGHTS, MAX_WORK, QUALITIES, SIZES, TIMES, withinBudget, type Lights, type Quality, type Size, type SunInput, type TimeOfDay } from './presets.js';
import { decodeTexture, type Texture } from './textures.js';
import { EXPOSURE_PER_NIT, type Lighting } from '@floorspec/mesh';
import { exposureOf, toneMap, type ExposureBand, type PtLamp, type PtMaterial, type PtScene, type Sun } from './trace.js';
import { traceParallel } from './threads.js';
import { groundOf, resolveSky, skySummary, type ResolvedSky, type SkySummary } from './sky.js';
import { GLASS_IOR, skyExposure, type LookRequest, type SkyPreset } from '@floorspec/mesh/sky';

export { trace, toneMap, meter, exposureOf, skyRadiance, type ExposureBand, type PtLamp, type PtScene, type PtMaterial, type Sun, type TraceOptions } from './trace.js';
export { Bvh, type Hit } from './bvh.js';
export { Rng, hash32 } from './rng.js';
export * as brdf from './brdf.js';
export { decodeTexture, imageSize, sample, type Texture } from './textures.js';
export { denoise, type Features } from './denoise.js';
export { traceParallel, stillThreads, canThread } from './threads.js';
export { groundOf, lawnTinted, resolveSky, siteOf, loadSkyMap, skySummary, type ResolvedSky, type Site, type SkyRequest, type SkySummary } from './sky.js';
export * from './presets.js';

/** The seed every still is traced with: the picture depends on the version and the options alone. */
export const SEED = 0x5eed_f10c;

export interface StillOptions {
  readonly camera?: Preset;
  readonly room?: string;
  /** Cut away above this level (as the headless render). */
  readonly level?: string;
  readonly size?: Size;
  readonly quality?: Quality;
  readonly sun?: SunInput;
  readonly design?: Record<string, string>;
  /** The reader the model is validated with (Core 1.6.4, 12.2). Default `OFFICIAL_READER`, the editor's (FLR-T-12.10). */
  readonly reader?: SceneOptions['reader'];
  /** The asset store, for base-colour maps; only what the project claimed. */
  readonly images?: ImageSource;
  readonly onPass?: (done: number, total: number) => void | Promise<void>;
  /** Override the size (tests). */
  readonly pixels?: { readonly width: number; readonly height: number };
  /** Override the samples a pixel (tests). */
  readonly samples?: number;
  readonly budgetMs?: number;
  /** Smooth the noise with the edge-aware filter (denoise.ts). Default true. */
  readonly denoise?: boolean;
  /**
   * Also give back the picture before it is exposed: linear RGB, cd/m², rows top to bottom
   * (`StillResult.radiance`) — what a GPU still is compared with (FLR-T-13.14, FLR-ADR-040).
   */
  readonly radiance?: boolean;
  /**
   * The luminaires (FLR-T-12.22): `on`, each lamp lights its room and its lens glows; `off`, dark
   * lenses and no lamps. Either way the still is metered within its `time`'s band (`EXPOSURE`), so
   * a room with its lamps off at night stays dark beside the same room with them on. Absent: lenses
   * glow and light nothing, exposed to the picture (FLR-T-12.21).
   */
  readonly lights?: Lights;
  /** Default `night` with `lights`, else `day`. */
  readonly time?: TimeOfDay;
  /** The lighting scene the scene was built with (FLR-T-13.12), by name: reported with `lit`. */
  readonly scene?: string;
  /** The sky (FLR-T-13.4), from `renderStill`/`renderLit`: its preset, sun and maps. Without it, the old gradient sky over a plate. */
  readonly skyLight?: ResolvedSky;
  /** For `renderStill`: the sky preset (FLR-T-13.4) and a date and time at the site (FLR-T-13.9) that places the sun. */
  readonly sky?: SkyPreset;
  readonly at?: string;
  /** For `renderStill`: the season and the weather it is seen in (FLR-T-15.4). Default summer, and the sky's weather. */
  readonly look?: LookRequest;
  /**
   * A camera given whole (FLR-T-13.10, a saved view's: render3d/camera.ts `savedCamera`) in place of
   * `camera` and `room`: its lens shift and thin lens with it. `inside` says whether it stands in a
   * room — metered as a room is — or outside, exposed for the sky's light.
   */
  readonly shot?: { readonly camera: Camera; readonly inside: boolean };
  /** One level alone: `level` without those below it (FLR-T-13.2). */
  readonly only?: boolean;
  /** Exposure compensation (FLR-T-13.10): a factor on the exposure the still is metered to. Default 1. */
  readonly exposureScale?: number;
  /**
   * A film's frame (FLR-T-14.1): given the exposure the still would be metered to (the tracer's
   * units), the one to use — so a film's exposure follows its frames smoothly rather than jumping.
   */
  readonly adapt?: (metered: number) => number;
  /** How far up the lamps and their lenses are, 0–1 (a film's lights fading up at dusk). Default 1. */
  readonly lampScale?: number;
  /** Also give back the picture as eight-bit RGB, rows top to bottom (`StillResult.rgb`): a film's frame. */
  readonly rgb?: boolean;
}

export interface StillResult {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly camera: string;
  readonly sun: SunInput & { readonly source: 'yours' | 'default' };
  readonly design: Record<string, string> | null;
  readonly triangles: number;
  /** The threads it was traced on. */
  readonly threads: number;
  /** Base-colour maps drawn, and those the store did not have (their material's colour was used). */
  readonly maps: { readonly used: string[]; readonly missing: string[] };
  /**
   * With `lights`: how the still was lit, how many lamps were on, and the exposure it was metered
   * to, per cd/m² (FLR-T-13.1, @floorspec/mesh `EXPOSURE_PER_NIT`).
   */
  readonly lit?: { readonly lights: Lights; readonly scene?: string; readonly time: TimeOfDay; readonly lamps: number; readonly exposure?: number };
  /** The sky it was seen under (FLR-T-13.4, 13.9): the preset, the sun's place and why, and the site's place, assumed or the document's. */
  readonly sky?: SkySummary;
  /** With `radiance`: the picture before it was exposed, linear RGB in cd/m², three floats a pixel. */
  readonly radiance?: Float32Array;
  /** With `rgb`: the picture, eight bits a channel. */
  readonly rgb?: Uint8Array;
  readonly ms: number;
}


const GROUND = linear('#cfcabd');
/** How bright a luminaire's lens looks to the camera, over its colour: about a sunlit white wall's. */
const LENS = 2.5;
const DEG = Math.PI / 180;
/**
 * The tracer's irradiance unit in lux: the sun's 8 is about 100 000 lx. Its radiance unit is then
 * 12 500 cd/m² — a surface of reflectance ρ under E units shows ρE/π units.
 */
export const LUX_PER_UNIT = 12_500;

/** The sky by time of day, scaled per channel: dusk a deep blue, night all but black. */
const SKY: Readonly<Record<TimeOfDay, Vec3>> = { day: [1, 1, 1], dusk: [0.0006, 0.0008, 0.0014], night: [0.00008, 0.0001, 0.00018] };
/**
 * The exposure of a still with `lights`, by time of day (FLR-T-13.1): metered, and held within the
 * band @floorspec/mesh's `EXPOSURE_PER_NIT` calibrates, in the tracer's units. At dusk and at night,
 * no less than a room lit to 150–300 lux reads normally lit at, and no more than two stops above it
 * — so a bedroom at 50 lux under its one ceiling light reads lit too, and a room with its lamps off
 * stays dark. By day, from a sunlit house's outside to a daylit room's inside.
 */
export const EXPOSURE: Readonly<Record<TimeOfDay, ExposureBand>> = {
  day: { min: EXPOSURE_PER_NIT.day * LUX_PER_UNIT, max: EXPOSURE_PER_NIT.dayMax * LUX_PER_UNIT },
  dusk: { min: EXPOSURE_PER_NIT.night * LUX_PER_UNIT, max: EXPOSURE_PER_NIT.nightMax * LUX_PER_UNIT },
  night: { min: EXPOSURE_PER_NIT.night * LUX_PER_UNIT, max: EXPOSURE_PER_NIT.nightMax * LUX_PER_UNIT },
};
/** Diffuse bounces a still with `lights` traces: enough that a lamp-lit room's corners are not black. */
export const LIT_BOUNCES = 6;

/** A sky's direct light (the sun, the moon, the studio's key) in the tracer's frame and units; none at dusk. */
export function directOf(sky: ResolvedSky): Sun {
  const d = sky.light.direct;
  if (d === null) return { dir: [0, 1, 0], irradiance: 0, radius: 0.01, color: [1, 1, 1] };
  return { dir: [d.dir[0], d.dir[2], -d.dir[1]], irradiance: d.lux / LUX_PER_UNIT, radius: d.radius, color: [d.color[0], d.color[1], d.color[2]] };
}

/** A sun in the scene's frame (x east-ish, +Y up, −Z project north), turned by the site's true north. */
export function sunOf(input: SunInput, trueNorthDeg: number): Sun {
  // Plan bearing (clockwise from project north) = true bearing − true north (Core 1.8).
  const b = (input.azimuth - trueNorthDeg) * DEG;
  const alt = Math.max(1, Math.min(90, input.altitude)) * DEG;
  const dir: Vec3 = [Math.sin(b) * Math.cos(alt), Math.sin(alt), -Math.cos(b) * Math.cos(alt)];
  // Warmer and weaker near the horizon.
  const low = Math.max(0, Math.min(1, (25 - input.altitude) / 25));
  return { dir, irradiance: 8 * (1 - 0.35 * low), radius: 0.6 * DEG, color: [1, 0.96 - 0.12 * low, 0.9 - 0.25 * low] };
}

/**
 * The lamps of a scene's luminaires (FLR-T-12.22) on the levels drawn: each a small sphere with its
 * luminous flux spread over the sphere (every way) or over its cone (a spot), in the tracer's units
 * — candela over `LUX_PER_UNIT`, so it lights a surface d metres away to I cos θ / d² lux. Each is
 * owned by its luminaire: its place in `scene.lights`, which `ptScene` marks that fixture's
 * triangles with, so the fixture never shadows its own lamp (FLR-T-13.1).
 */
export function lampsOf(scene: Scene, drawn: (level: string) => boolean = () => true): PtLamp[] {
  return scene.lights
    .map((l, owner) => ({ l, owner }))
    .filter(({ l }) => drawn(l.level))
    .map(({ l, owner }) => {
      // Intensity (candela) = flux / solid angle: 4π sr, or a cap out to the middle of the cone's edge.
      const sr = l.spot === undefined ? 4 * Math.PI : 2 * Math.PI * (1 - (l.spot.inner + l.spot.outer) / 2);
      const k = l.lumens / sr / LUX_PER_UNIT;
      return {
        position: l.position,
        radius: Math.max(0.005, l.radius),
        intensity: [l.color[0] * k, l.color[1] * k, l.color[2] * k] as Vec3,
        ...(l.spot === undefined ? {} : { spot: { dir: l.spot.dir, inner: l.spot.inner, outer: l.spot.outer } }),
        owner,
      };
    });
}

/** The scene's triangles as the tracer reads them, cut away above `level`, on a ground plate — with its lamps, when they are on. */
export function ptScene(scene: Scene, options: { level?: string; only?: boolean; textures?: ReadonlyMap<number, Texture | MaterialMaps>; lights?: Lights; plate?: boolean; lampScale?: number } = {}): PtScene & { readonly floor: number; readonly plate: boolean } {
  const up = Math.min(1, Math.max(0, options.lampScale ?? 1));
  const order = new Map(scene.levels.map((l, i) => [l.id, i]));
  const cut = options.level === undefined ? undefined : order.get(options.level);
  // One level alone (FLR-T-13.2, a saved view's `levels: "only"`): none below the cut either.
  const alone = options.only === true && cut !== undefined;
  const pos: number[] = [];
  const mat: number[] = [];
  const uv: number[] = [];
  // Each triangle's luminaire, by its place in scene.lights: what never shadows that luminaire's lamp.
  const fixtures = new Map(scene.lights.map((l, i) => [l.id, i]));
  const own: number[] = [];
  const materials: PtMaterial[] = scene.materials.map((m, i) => {
    const got = options.textures?.get(i);
    const maps: MaterialMaps = got === undefined ? {} : 'data' in got ? { albedo: got } : got;
    const t = maps.albedo;
    return {
      // Under a base colour map the texel is the colour (Core 18.1), not the colour times it.
      rgb: t === undefined ? [m.baseColor[0], m.baseColor[1], m.baseColor[2]] : [1, 1, 1],
      glass: m.blend,
      // Glazing's index, as the glTF export writes it (KHR_materials_ior) and the GPU still traces it.
      ...(m.blend ? { ior: GLASS_IOR } : {}),
      ...(t === undefined ? {} : { texture: t }),
      // FLR-T-13.6: roughness and metalness (Core 18.1: a map's channel times a declared factor), and the surface's relief.
      ...(maps.orm === undefined ? { roughness: m.roughness, metallic: m.metallic } : { orm: maps.orm, roughness: (m.declared.roughness ?? 1000) / 1000, metallic: (m.declared.metallic ?? 1000) / 1000 }),
      ...(maps.normal === undefined ? {} : { normalMap: maps.normal }),
      ...(m.emissive === undefined ? {} : { lens: true }),
      ...(m.emissive === undefined || options.lights === 'off' || up <= 0 ? {} : { emission: [m.emissive[0] * LENS * up, m.emissive[1] * LENS * up, m.emissive[2] * LENS * up] as Vec3 }),
    };
  });
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const level of scene.levels) {
    const at = order.get(level.id)!;
    if (cut !== undefined && at > cut) continue;
    if (alone && at < cut) continue;
    for (const node of level.nodes) {
      const owner = fixtures.get(node.id) ?? -1;
      for (const p of node.primitives) {
        if (cut === at && (p.part === 'ceiling' || p.part === 'roof' || p.part === 'roofGable')) continue;
        const P = p.positions;
        const U = p.uvs;
        for (let k = 0; k < p.indices.length; k += 3) {
          for (let j = 0; j < 3; j++) {
            const i = p.indices[k + j]!;
            for (let c = 0; c < 3; c++) {
              const v = P[3 * i + c]!;
              pos.push(v);
              if (v < min[c]!) min[c] = v;
              if (v > max[c]!) max[c] = v;
            }
            if (U === null) uv.push(NaN, NaN);
            else uv.push(U[2 * i]!, U[2 * i + 1]!);
          }
          mat.push(p.material);
          own.push(owner);
        }
      }
    }
  }
  // The ground: a plate under the house out to the horizon, as the headless render's — unless the
  // tracer is given the ground as a plane of its own (FLR-T-13.4).
  const plate = options.plate !== false && Number.isFinite(min[0]);
  if (plate) {
    const groundMat = materials.length;
    materials.push({ rgb: GROUND, glass: false });
    const cx = (min[0] + max[0]) / 2;
    const cz = (min[2] + max[2]) / 2;
    const r = 40 * Math.max(5, Math.hypot(max[0] - min[0], max[2] - min[2]));
    const y = min[1] - 0.003;
    const q: Vec3[] = [
      [cx - r, y, cz + r],
      [cx + r, y, cz + r],
      [cx + r, y, cz - r],
      [cx - r, y, cz - r],
    ];
    for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]] as const) {
      pos.push(...q[a]!, ...q[b]!, ...q[c]!);
      uv.push(NaN, NaN, NaN, NaN, NaN, NaN);
      mat.push(groundMat);
      own.push(-1);
    }
  }
  const count = mat.length;
  const positions = Float64Array.from(pos);
  const normals = new Float64Array(3 * count);
  for (let t = 0; t < count; t++) {
    const o = 9 * t;
    const ux = positions[o + 3]! - positions[o]!, uy = positions[o + 4]! - positions[o + 1]!, uz = positions[o + 5]! - positions[o + 2]!;
    const vx = positions[o + 6]! - positions[o]!, vy = positions[o + 7]! - positions[o + 1]!, vz = positions[o + 8]! - positions[o + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    normals[3 * t] = nx / l;
    normals[3 * t + 1] = ny / l;
    normals[3 * t + 2] = nz / l;
  }
  const lamps = options.lights === 'on' && up > 0 ? lampsOf(scene, (l) => cut === undefined || ((order.get(l) ?? Infinity) <= cut && (!alone || order.get(l) === cut))).map((l) => (up === 1 ? l : { ...l, intensity: [l.intensity[0] * up, l.intensity[1] * up, l.intensity[2] * up] as Vec3 })) : [];
  return { count, positions, normals, material: Int32Array.from(mat), uvs: Float32Array.from(uv), materials, floor: Number.isFinite(min[1]) ? min[1] - 0.003 : 0, plate, ...(lamps.length === 0 ? {} : { lamps, owner: Int32Array.from(own) }) };
}

/** The camera a still looks from: a named view framed on what is drawn, or a room. */
function cameraFor(scene: Scene, pt: PtScene & { readonly plate: boolean }, options: StillOptions, aspect: number): Camera {
  if (options.room !== undefined) {
    const room = findRoom(scene.rooms, options.room);
    if (room === undefined) {
      const known = scene.rooms.map((r) => (r.name === undefined ? r.id : `${r.id} (${r.name})`));
      throw new RangeError(`the model has no room ${options.room}${known.length === 0 ? '' : `; its rooms are ${known.slice(0, 20).join(', ')}`}`);
    }
    return roomCamera(room, scene.doors, scene.obstacles);
  }
  // Framed on the house, not the ground plate (its last two triangles, when it has one).
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 9 * Math.max(0, pt.count - (pt.plate ? 2 : 0)); i += 3)
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, pt.positions[i + c]!);
      max[c] = Math.max(max[c]!, pt.positions[i + c]!);
    }
  const box = Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
  return presetCamera(options.camera ?? 'sw', box, aspect);
}

/** A material's maps as the tracer reads them (FLR-T-13.6): its base colour, its normals, and occlusion-roughness-metalness. */
export interface MaterialMaps {
  readonly albedo?: Texture;
  readonly normal?: Texture;
  /** Occlusion in red, roughness in green, metalness in blue — glTF's channels (Core 18.2). */
  readonly orm?: Texture;
}

/**
 * Decode every map the scene's materials name and the store (or the material library, FLR-T-13.6)
 * has: base colour, normal, and metallic-roughness with occlusion — each file once, however many
 * materials share it. `used` and `missing` list base colour maps, as they always have.
 */
export function texturesOf(scene: Scene, images: ImageSource | undefined): { textures: Map<number, MaterialMaps>; used: string[]; missing: string[] } {
  const textures = new Map<number, MaterialMaps>();
  const used = new Set<string>();
  const missing = new Set<string>();
  const decoded = new Map<string, Texture | undefined>();
  const read = (id: string | undefined, encoding: 'srgb' | 'linear'): Texture | undefined => {
    if (id === undefined) return undefined;
    const key = `${encoding}:${id}`;
    if (decoded.has(key)) return decoded.get(key);
    const asset = scene.assets[id];
    const bytes = asset === undefined || images === undefined ? undefined : images({ id, sha256: asset.sha256, mediaType: asset.mediaType });
    const t = bytes === undefined || asset === undefined ? undefined : decodeTexture(bytes, asset.mediaType, encoding);
    decoded.set(key, t);
    return t;
  };
  scene.materials.forEach((m, i) => {
    const maps = m.texture?.maps;
    if (maps === undefined) return;
    const albedo = read(maps.asset, 'srgb');
    if (maps.asset !== undefined) (albedo === undefined ? missing : used).add(maps.asset);
    const normal = read(maps.normal, 'linear');
    const orm = read(maps.metallicRoughness, 'linear');
    if (albedo !== undefined || normal !== undefined || orm !== undefined) textures.set(i, { ...(albedo === undefined ? {} : { albedo }), ...(normal === undefined ? {} : { normal }), ...(orm === undefined ? {} : { orm }) });
  });
  return { textures, used: [...used].sort(), missing: [...missing].sort() };
}

/** Path-trace a still of a scene. */
export async function renderSceneStill(scene: Scene, options: StillOptions & { trueNorth?: number } = {}): Promise<StillResult> {
  const started = Date.now();
  const size = options.size ?? 'medium';
  const quality = options.quality ?? 'standard';
  if (!Object.hasOwn(SIZES, size)) throw new RangeError(`size is one of ${Object.keys(SIZES).join(', ')}`);
  if (!Object.hasOwn(QUALITIES, quality)) throw new RangeError(`quality is one of ${Object.keys(QUALITIES).join(', ')}`);
  if (options.camera !== undefined && !PRESETS.includes(options.camera)) throw new RangeError(`camera is one of ${PRESETS.join(', ')}`);
  if (options.pixels === undefined && options.samples === undefined && !withinBudget(size, quality)) throw new RangeError(`a ${size} still at ${quality} quality is more work than a still may take: choose a smaller size or a lower quality`);
  // "all" is the whole house (FLR-T-12.23), unless the model has a level of that ID.
  if (options.level !== undefined && options.level !== 'all' && !scene.levels.some((l) => l.id === options.level)) throw new RangeError(`the model has no level ${options.level} with anything to draw`);
  if (options.lights !== undefined && !(LIGHTS as readonly string[]).includes(options.lights)) throw new RangeError('lights is on or off');
  if (options.time !== undefined && !TIMES.includes(options.time)) throw new RangeError(`time is one of ${TIMES.join(', ')}`);
  const [width, height] = options.pixels === undefined ? SIZES[size] : [options.pixels.width, options.pixels.height];
  const samples = options.samples ?? QUALITIES[quality];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || width * height * samples > MAX_WORK) throw new RangeError('the still is too big');
  const maps = texturesOf(scene, withLibrary(options.images));
  const sky = options.skyLight;
  const pt = ptScene(scene, { ...(options.room === undefined && options.level !== undefined ? { level: options.level, ...(options.only === true ? { only: true } : {}) } : {}), textures: maps.textures, ...(options.lights === undefined ? {} : { lights: options.lights }), ...(options.lampScale === undefined ? {} : { lampScale: options.lampScale }), plate: sky === undefined });
  const camera = options.shot?.camera ?? cameraFor(scene, pt, options, width / height);
  const inRoom = options.shot === undefined ? options.room !== undefined : options.shot.inside;
  const sunIn = options.sun ?? DEFAULT_SUN;
  // FLR-T-13.4: under a sky, its band is the time of day the still is exposed for.
  const time = sky !== undefined ? sky.light.band : (options.time ?? (options.lights === undefined ? 'day' : 'night'));
  const daylight = sunOf(sunIn, options.trueNorth ?? 0);
  // After sunset, no sun: the sky (dimmed) and the lamps. Under a sky, its direct light: the sun, the moon or the studio's key.
  const sun = sky !== undefined ? directOf(sky) : time === 'day' ? daylight : { ...daylight, irradiance: 0 };
  // Under a sky, an outside view is exposed as the editor's is — for the sky's own light (FLR-T-13.4),
  // so a lawn filling the frame does not open it up and burn the house out; a room is metered.
  const outside = sky !== undefined && !inRoom && (sky.light.band === 'day' || options.lights === undefined) ? skyExposure(sky.light, sky.field.maps) * LUX_PER_UNIT : undefined;
  const exposure = outside !== undefined ? outside : sky === undefined && options.lights === undefined && options.time === undefined ? undefined : EXPOSURE[time];
  const lit = options.lights !== undefined;
  const traced = await traceParallel(pt, {
    width,
    height,
    samples,
    camera,
    sun,
    seed: SEED,
    budgetMs: options.budgetMs ?? BUDGET_MS,
    ...(sky !== undefined ? { field: { sky: sky.field, unit: LUX_PER_UNIT }, ground: { y: pt.floor, ...groundOf(sky.light) } } : time === 'day' ? {} : { sky: SKY[time] }),
    // A firefly's cap, in what the picture shows: the same after the least exposure by day and by night.
    ...(exposure === undefined ? {} : { clamp: 12 * (EXPOSURE.day.min / (typeof exposure === 'number' ? exposure : exposure.min)) }),
    ...(lit ? { bounces: LIT_BOUNCES } : {}),
    ...(options.onPass === undefined ? {} : { onPass: options.onPass }),
  });
  const hdr = options.denoise === false ? traced.color : denoise(traced.color, traced.features, width, height);
  // Exposure compensation (FLR-T-13.10) on top of what the still is metered to.
  const scale = options.exposureScale ?? 1;
  // A film's frame (FLR-T-14.1) takes the exposure its film has come to, from what this one meters.
  const adapted = options.adapt === undefined ? undefined : options.adapt(exposureOf(hdr, width, height, exposure));
  const exposed = adapted !== undefined ? adapted * scale : exposure === undefined && scale === 1 ? undefined : exposureOf(hdr, width, height, exposure) * scale;
  const rgb = toneMap(hdr, width, height, exposed ?? exposure);
  const png = encodePng(rgb, width, height);
  return {
    png,
    width,
    height,
    samples,
    camera: camera.label,
    sun: sky !== undefined && sky.sun !== null ? { azimuth: sky.sun.azimuth, altitude: sky.sun.altitude, source: sky.sun.source === 'yours' ? 'yours' : 'default' } : { azimuth: sunIn.azimuth, altitude: sunIn.altitude, source: options.sun === undefined ? 'default' : 'yours' },
    design: scene.design,
    triangles: pt.count,
    threads: traced.threads,
    maps: { used: maps.used, missing: maps.missing },
    ...(options.lights === undefined ? {} : { lit: { lights: options.lights, ...(options.scene === undefined ? {} : { scene: options.scene }), time, lamps: pt.lamps?.length ?? 0, ...(exposed === undefined ? {} : { exposure: Number((exposed / LUX_PER_UNIT).toPrecision(3)) }) } }),
    ...(sky === undefined ? {} : { sky: skySummary(sky, exposed === undefined ? undefined : Number((exposed / LUX_PER_UNIT).toPrecision(3))) }),
    ...(options.radiance === true ? { radiance: hdr.map((v) => v * LUX_PER_UNIT) } : {}),
    ...(options.rgb === true ? { rgb } : {}),
    ms: Date.now() - started,
  };
}

/** Path-trace a still of a version (FLR-REQ-154). Throws for an invalid model, an unknown room or level, or work over the budget. */
export async function renderStill(document: object, options: StillOptions = {}): Promise<StillResult> {
  const scene = await buildScene(document, { ...(options.design === undefined ? {} : { design: options.design }), ...(options.reader === undefined ? {} : { reader: options.reader }), ...lookOption(options.look) });
  const site = (document as { site?: { trueNorth?: unknown } }).site;
  const trueNorth = typeof site?.trueNorth === 'number' ? site.trueNorth / 1e6 : 0;
  const skyLight = resolveSky(document, { ...(options.sky === undefined ? {} : { sky: options.sky }), ...(options.at === undefined ? {} : { at: options.at }), ...(options.sun === undefined ? {} : { sun: options.sun }), ...(options.time === undefined ? {} : { time: options.time }), ...options.look });
  return renderSceneStill(scene, { ...options, trueNorth, skyLight });
}

/** A scene's `look` option (FLR-T-15.4), when a request names a season or a weather. */
export function lookOption(look: LookRequest | undefined): { look?: LookRequest } {
  return look === undefined || (look.season === undefined && look.weather === undefined) ? {} : { look };
}

/** A lit render's samples a pixel (FLR-T-12.22): few, smoothed by the denoiser, so an agent's render returns while it waits. */
export const LIT_SAMPLES = 16;
/**
 * By day, twice as many (FLR-T-13.1): a daylit room is lit by what comes in through its windows,
 * found by paths that bounce, not by lamps sampled directly — noisier, and metered brighter.
 */
export const LIT_DAY_SAMPLES = 32;
/** A lit render's default and widest pictures, pixels: path-traced, so its pixels are the worker's time. */
export const LIT_WIDTH = 800;
export const LIT_MAX_WIDTH = 1280;
/** A lit render that runs past this is stopped: the api waits for it. */
export const LIT_BUDGET_MS = 150_000;

export interface LitOptions {
  readonly camera?: Preset;
  readonly room?: string;
  /** Cut away above this level. Default: the lowest level, so the rooms and their lamps are seen from above. */
  readonly level?: string;
  /** Pixels; the height is three quarters of it. Default 800. */
  readonly width?: number;
  readonly lights: Lights;
  /** Default night. */
  readonly time?: TimeOfDay;
  readonly design?: Record<string, string>;
  readonly reader?: SceneOptions['reader'];
  readonly images?: ImageSource;
  /** The doors closed (default) or open (FLR-T-13.8). */
  readonly doors?: SceneOptions['doors'];
  /**
   * With `lights` on, which are on, how bright and how warm (FLR-T-13.12): a lighting scene's. Default
   * every one at full. `scene` is its name, for the summary.
   */
  readonly lighting?: Lighting;
  readonly scene?: string;
  /** The sky (FLR-T-13.4) and a date and time at the site (FLR-T-13.9); `time` maps to a sky when no `sky` is given. */
  readonly sky?: SkyPreset;
  readonly at?: string;
  /** The season and the weather (FLR-T-15.4); a weather is a daytime sky's when no `time` is given. */
  readonly look?: LookRequest;
  readonly onPass?: (done: number, total: number) => void | Promise<void>;
}

/**
 * The 3D render with its lights on or off (FLR-T-12.22, `floorspec_render` with `lights`): the same
 * views as the headless render, path-traced — so a lamp's light pools on its room's floor and walls
 * and stops at them — metered within the time of day's band, so on and off can be compared.
 */
export async function renderLit(document: object, options: LitOptions): Promise<StillResult> {
  const w = options.width ?? LIT_WIDTH;
  if (!Number.isInteger(w) || w < 64 || w > LIT_MAX_WIDTH) throw new RangeError(`a render with lights is 64 to ${String(LIT_MAX_WIDTH)} pixels wide`);
  const scene = await buildScene(document, { ...(options.design === undefined ? {} : { design: options.design }), ...(options.reader === undefined ? {} : { reader: options.reader }), ...(options.doors === undefined ? {} : { doors: options.doors }), ...(options.lighting === undefined || options.lights !== 'on' ? {} : { lighting: options.lighting }), ...lookOption(options.look) });
  const site = (document as { site?: { trueNorth?: unknown } }).site;
  const trueNorth = typeof site?.trueNorth === 'number' ? site.trueNorth / 1e6 : 0;
  const skyLight = resolveSky(document, { ...(options.sky === undefined ? {} : { sky: options.sky }), ...(options.at === undefined ? {} : { at: options.at }), time: options.time ?? (options.sky === undefined && options.at === undefined && options.look?.weather === undefined ? 'night' : 'day'), ...options.look });
  const level = options.level ?? (options.room === undefined ? scene.levels[0]?.id : undefined);
  const day = skyLight.light.band === 'day';
  return renderSceneStill(scene, {
    skyLight,
    ...(options.camera === undefined ? {} : { camera: options.camera }),
    ...(options.room === undefined ? {} : { room: options.room }),
    ...(level === undefined ? {} : { level }),
    pixels: { width: w, height: Math.round((w * 3) / 4) },
    samples: day ? LIT_DAY_SAMPLES : LIT_SAMPLES,
    budgetMs: LIT_BUDGET_MS,
    lights: options.lights,
    ...(options.scene === undefined ? {} : { scene: options.scene }),
    trueNorth,
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(options.onPass === undefined ? {} : { onPass: options.onPass }),
  });
}
