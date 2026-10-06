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
import { BUDGET_MS, DEFAULT_SUN, MAX_WORK, QUALITIES, SIZES, withinBudget, type Quality, type Size, type SunInput } from './presets.js';
import { decodeTexture, type Texture } from './textures.js';
import { toneMap, type PtMaterial, type PtScene, type Sun } from './trace.js';
import { traceParallel } from './threads.js';

export { trace, toneMap, skyRadiance, type PtScene, type PtMaterial, type Sun, type TraceOptions } from './trace.js';
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
  readonly ms: number;
}

const GROUND = linear('#cfcabd');
const DEG = Math.PI / 180;

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

/** The scene's triangles as the tracer reads them, cut away above `level`, on a ground plate. */
export function ptScene(scene: Scene, options: { level?: string; textures?: ReadonlyMap<number, Texture> } = {}): PtScene {
  const order = new Map(scene.levels.map((l, i) => [l.id, i]));
  const cut = options.level === undefined ? undefined : order.get(options.level);
  const pos: number[] = [];
  const mat: number[] = [];
  const uv: number[] = [];
  const materials: PtMaterial[] = scene.materials.map((m, i) => {
    const t = options.textures?.get(i);
    return { rgb: [m.baseColor[0], m.baseColor[1], m.baseColor[2]], glass: m.blend, ...(t === undefined ? {} : { texture: t }) };
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
  return { count, positions, normals, material: Int32Array.from(mat), uvs: Float32Array.from(uv), materials };
}

/** The camera a still looks from: a named view framed on what is drawn, or a room. */
function cameraFor(scene: Scene, pt: PtScene, options: StillOptions, aspect: number): Camera {
  if (options.room !== undefined) {
    const room = findRoom(scene.rooms, options.room);
    if (room === undefined) {
      const known = scene.rooms.map((r) => (r.name === undefined ? r.id : `${r.id} (${r.name})`));
      throw new RangeError(`the model has no room ${options.room}${known.length === 0 ? '' : `; its rooms are ${known.slice(0, 20).join(', ')}`}`);
    }
    return roomCamera(room, scene.doors);
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
  if (options.level !== undefined && !scene.levels.some((l) => l.id === options.level)) throw new RangeError(`the model has no level ${options.level} with anything to draw`);
  const [width, height] = options.pixels === undefined ? SIZES[size] : [options.pixels.width, options.pixels.height];
  const samples = options.samples ?? QUALITIES[quality];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || width * height * samples > MAX_WORK) throw new RangeError('the still is too big');
  const maps = texturesOf(scene, options.images);
  const pt = ptScene(scene, { ...(options.room === undefined && options.level !== undefined ? { level: options.level } : {}), textures: maps.textures });
  const camera = cameraFor(scene, pt, options, width / height);
  const sunIn = options.sun ?? DEFAULT_SUN;
  const sun = sunOf(sunIn, options.trueNorth ?? 0);
  const traced = await traceParallel(pt, { width, height, samples, camera, sun, seed: SEED, budgetMs: options.budgetMs ?? BUDGET_MS, ...(options.onPass === undefined ? {} : { onPass: options.onPass }) });
  const hdr = options.denoise === false ? traced.color : denoise(traced.color, traced.features, width, height);
  const png = encodePng(toneMap(hdr, width, height), width, height);
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
