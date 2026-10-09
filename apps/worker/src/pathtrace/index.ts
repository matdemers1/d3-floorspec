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
import { linear } from '../export/gltf/scene.js';
import { findRoom, PRESETS, presetCamera, roomCamera, type Camera, type Preset } from '../render3d/camera.js';
import { encodePng } from '../render3d/png.js';
import { denoise } from './denoise.js';
import { BUDGET_MS, DEFAULT_SUN, LIGHTS, MAX_WORK, QUALITIES, SIZES, TIMES, withinBudget, type Lights, type Quality, type Size, type SunInput, type TimeOfDay } from './presets.js';
import { decodeTexture, type Texture } from './textures.js';
import { toneMap, type PtLamp, type PtMaterial, type PtScene, type Sun } from './trace.js';
import { traceParallel } from './threads.js';

export { trace, toneMap, skyRadiance, type PtLamp, type PtScene, type PtMaterial, type Sun, type TraceOptions } from './trace.js';
export { Bvh, type Hit } from './bvh.js';
export { Rng, hash32 } from './rng.js';
export { decodeTexture, imageSize, sample, type Texture } from './textures.js';
export { denoise, type Features } from './denoise.js';
export { traceParallel, stillThreads, canThread } from './threads.js';
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
   * The luminaires (FLR-T-12.22): `on`, each lamp lights its room and its lens glows; `off`, dark
   * lenses and no lamps. Either way the still is exposed to a fixed exposure for its `time`, so the
   * two can be compared. Absent: lenses glow and light nothing, exposed to the picture (FLR-T-12.21).
   */
  readonly lights?: Lights;
  /** Default `night` with `lights`, else `day`. */
  readonly time?: TimeOfDay;
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
  /** With `lights`: how the still was lit, and how many lamps were on. */
  readonly lit?: { readonly lights: Lights; readonly time: TimeOfDay; readonly lamps: number };
  readonly ms: number;
}

const GROUND = linear('#cfcabd');
/** How bright a luminaire's lens looks to the camera, over its colour: about a sunlit white wall's. */
const LENS = 2.5;
const DEG = Math.PI / 180;
/** The tracer's irradiance unit in lux: the sun's 8 is about 100 000 lx. */
const LUX_PER_UNIT = 12_500;

/** The sky by time of day, scaled per channel: dusk a deep blue, night all but black. */
const SKY: Readonly<Record<TimeOfDay, Vec3>> = { day: [1, 1, 1], dusk: [0.0006, 0.0008, 0.0014], night: [0.00008, 0.0001, 0.00018] };
/**
 * The fixed exposure of a still with `lights`, by time of day: by day, a sunlit house's; at dusk and
 * at night, a room lit by its lamps' — about 50 lx on a pale floor reads as a mid-tone.
 */
export const EXPOSURE: Readonly<Record<TimeOfDay, number>> = { day: 0.2, dusk: 320, night: 320 };

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
 * luminous flux spread over the sphere (every way) or over its cone (a spot), in the tracer's units.
 */
export function lampsOf(scene: Scene, drawn: (level: string) => boolean = () => true): PtLamp[] {
  return scene.lights
    .filter((l) => drawn(l.level))
    .map((l) => {
      // Intensity (candela) = flux / solid angle: 4π sr, or a cap out to the middle of the cone's edge.
      const sr = l.spot === undefined ? 4 * Math.PI : 2 * Math.PI * (1 - (l.spot.inner + l.spot.outer) / 2);
      const k = l.lumens / sr / LUX_PER_UNIT;
      return {
        position: l.position,
        radius: Math.max(0.005, l.radius),
        intensity: [l.color[0] * k, l.color[1] * k, l.color[2] * k] as Vec3,
        ...(l.spot === undefined ? {} : { spot: { dir: l.spot.dir, inner: l.spot.inner, outer: l.spot.outer } }),
      };
    });
}

/** The scene's triangles as the tracer reads them, cut away above `level`, on a ground plate — with its lamps, when they are on. */
export function ptScene(scene: Scene, options: { level?: string; textures?: ReadonlyMap<number, Texture>; lights?: Lights } = {}): PtScene {
  const order = new Map(scene.levels.map((l, i) => [l.id, i]));
  const cut = options.level === undefined ? undefined : order.get(options.level);
  const pos: number[] = [];
  const mat: number[] = [];
  const uv: number[] = [];
  const materials: PtMaterial[] = scene.materials.map((m, i) => {
    const t = options.textures?.get(i);
    return {
      rgb: [m.baseColor[0], m.baseColor[1], m.baseColor[2]],
      glass: m.blend,
      ...(t === undefined ? {} : { texture: t }),
      ...(m.emissive === undefined ? {} : { lens: true }),
      ...(m.emissive === undefined || options.lights === 'off' ? {} : { emission: [m.emissive[0] * LENS, m.emissive[1] * LENS, m.emissive[2] * LENS] as Vec3 }),
    };
  });
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const level of scene.levels) {
    const at = order.get(level.id)!;
    if (cut !== undefined && at > cut) continue;
    for (const node of level.nodes)
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
        }
      }
  }
  // The ground: a plate under the house out to the horizon, as the headless render's.
  if (Number.isFinite(min[0])) {
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
  const lamps = options.lights === 'on' ? lampsOf(scene, (l) => cut === undefined || (order.get(l) ?? Infinity) <= cut) : [];
  return { count, positions, normals, material: Int32Array.from(mat), uvs: Float32Array.from(uv), materials, ...(lamps.length === 0 ? {} : { lamps }) };
}

/** The camera a still looks from: a named view framed on what is drawn, or a room. */
function cameraFor(scene: Scene, pt: PtScene, options: StillOptions, aspect: number): Camera {
  if (options.room !== undefined) {
    const room = findRoom(scene.rooms, options.room);
    if (room === undefined) {
      const known = scene.rooms.map((r) => (r.name === undefined ? r.id : `${r.id} (${r.name})`));
      throw new RangeError(`the model has no room ${options.room}${known.length === 0 ? '' : `; its rooms are ${known.slice(0, 20).join(', ')}`}`);
    }
    return roomCamera(room, scene.doors, scene.obstacles);
  }
  // Framed on the house, not the ground plate (its last two triangles).
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 9 * Math.max(0, pt.count - 2); i += 3)
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, pt.positions[i + c]!);
      max[c] = Math.max(max[c]!, pt.positions[i + c]!);
    }
  const box = Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
  return presetCamera(options.camera ?? 'sw', box, aspect);
}

/** Decode every base-colour map the scene's materials name and the store has. */
function texturesOf(scene: Scene, images: ImageSource | undefined): { textures: Map<number, Texture>; used: string[]; missing: string[] } {
  const textures = new Map<number, Texture>();
  const used = new Set<string>();
  const missing = new Set<string>();
  scene.materials.forEach((m, i) => {
    const id = m.texture?.maps.asset;
    if (id === undefined) return;
    const asset = scene.assets[id];
    const bytes = asset === undefined || images === undefined ? undefined : images({ id, sha256: asset.sha256, mediaType: asset.mediaType });
    const t = bytes === undefined || asset === undefined ? undefined : decodeTexture(bytes, asset.mediaType);
    if (t === undefined) missing.add(id);
    else {
      textures.set(i, t);
      used.add(id);
    }
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
  const maps = texturesOf(scene, options.images);
  const pt = ptScene(scene, { ...(options.room === undefined && options.level !== undefined ? { level: options.level } : {}), textures: maps.textures, ...(options.lights === undefined ? {} : { lights: options.lights }) });
  const camera = cameraFor(scene, pt, options, width / height);
  const sunIn = options.sun ?? DEFAULT_SUN;
  const time = options.time ?? (options.lights === undefined ? 'day' : 'night');
  const daylight = sunOf(sunIn, options.trueNorth ?? 0);
  // After sunset, no sun: the sky (dimmed) and the lamps.
  const sun = time === 'day' ? daylight : { ...daylight, irradiance: 0 };
  const exposure = options.lights === undefined && options.time === undefined ? undefined : EXPOSURE[time];
  const traced = await traceParallel(pt, {
    width,
    height,
    samples,
    camera,
    sun,
    seed: SEED,
    budgetMs: options.budgetMs ?? BUDGET_MS,
    ...(time === 'day' ? {} : { sky: SKY[time] }),
    // A firefly's cap, in what the picture shows: the same after exposure by day and by night.
    ...(exposure === undefined ? {} : { clamp: 12 * (EXPOSURE.day / exposure) }),
    ...(options.onPass === undefined ? {} : { onPass: options.onPass }),
  });
  const hdr = options.denoise === false ? traced.color : denoise(traced.color, traced.features, width, height);
  const png = encodePng(toneMap(hdr, width, height, exposure), width, height);
  return {
    png,
    width,
    height,
    samples,
    camera: camera.label,
    sun: { azimuth: sunIn.azimuth, altitude: sunIn.altitude, source: options.sun === undefined ? 'default' : 'yours' },
    design: scene.design,
    triangles: pt.count,
    threads: traced.threads,
    maps: { used: maps.used, missing: maps.missing },
    ...(options.lights === undefined ? {} : { lit: { lights: options.lights, time, lamps: pt.lamps?.length ?? 0 } }),
    ms: Date.now() - started,
  };
}

/** Path-trace a still of a version (FLR-REQ-154). Throws for an invalid model, an unknown room or level, or work over the budget. */
export async function renderStill(document: object, options: StillOptions = {}): Promise<StillResult> {
  const scene = await buildScene(document, { ...(options.design === undefined ? {} : { design: options.design }), ...(options.reader === undefined ? {} : { reader: options.reader }) });
  const site = (document as { site?: { trueNorth?: unknown } }).site;
  const trueNorth = typeof site?.trueNorth === 'number' ? site.trueNorth / 1e6 : 0;
  return renderSceneStill(scene, { ...options, trueNorth });
}

/** A lit render's samples a pixel (FLR-T-12.22): few, smoothed by the denoiser, so an agent's render returns while it waits. */
export const LIT_SAMPLES = 16;
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
  readonly onPass?: (done: number, total: number) => void | Promise<void>;
}

/**
 * The 3D render with its lights on or off (FLR-T-12.22, `floorspec_render` with `lights`): the same
 * views as the headless render, path-traced — so a lamp's light pools on its room's floor and walls
 * and stops at them — at a fixed exposure for the time of day, so on and off can be compared.
 */
export async function renderLit(document: object, options: LitOptions): Promise<StillResult> {
  const w = options.width ?? LIT_WIDTH;
  if (!Number.isInteger(w) || w < 64 || w > LIT_MAX_WIDTH) throw new RangeError(`a render with lights is 64 to ${String(LIT_MAX_WIDTH)} pixels wide`);
  const scene = await buildScene(document, { ...(options.design === undefined ? {} : { design: options.design }), ...(options.reader === undefined ? {} : { reader: options.reader }) });
  const site = (document as { site?: { trueNorth?: unknown } }).site;
  const trueNorth = typeof site?.trueNorth === 'number' ? site.trueNorth / 1e6 : 0;
  const level = options.level ?? (options.room === undefined ? scene.levels[0]?.id : undefined);
  return renderSceneStill(scene, {
    ...(options.camera === undefined ? {} : { camera: options.camera }),
    ...(options.room === undefined ? {} : { room: options.room }),
    ...(level === undefined ? {} : { level }),
    pixels: { width: w, height: Math.round((w * 3) / 4) },
    samples: LIT_SAMPLES,
    budgetMs: LIT_BUDGET_MS,
    lights: options.lights,
    time: options.time ?? 'night',
    trueNorth,
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(options.onPass === undefined ? {} : { onPass: options.onPass }),
  });
}
