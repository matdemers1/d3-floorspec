/**
 * A 360° panorama, path-traced (FLR-T-14.2): six cube faces, each a square 90° picture traced by the
 * still's tracer (pathtrace/trace.ts) on its threads — one pixel wider on every side, so resampling
 * never reaches past a face — denoised, metered once over all six, and resampled into an
 * equirectangular picture (@floorspec/mesh tour.ts: its middle looks project north). Seeded like a
 * still: the same version and options always give the same panorama.
 *
 * The cube rather than an equirectangular camera in the tracer: each face is a still's camera, so
 * nothing in the tracer changes, and a face is a sixth of the work and the memory of a panorama
 * traced whole — what lets a 4096 × 2048 panorama be traced on four threads at all.
 */
import { equirectYawPitch, directionOf, type Point3 } from '@floorspec/mesh';
import type { Camera } from '../render3d/camera.js';
import type { Vec3 } from '../export/gltf/scene.js';
import { denoise } from '../pathtrace/denoise.js';
import { exposureOf, toneMap, type ExposureBand, type PtScene, type TraceOptions } from '../pathtrace/trace.js';
import { traceParallel } from '../pathtrace/threads.js';

/** A cube face: where it looks and which way is up, in the scene's frame (+Y up, −Z project north). */
export interface Face {
  readonly name: 'north' | 'east' | 'south' | 'west' | 'up' | 'down';
  readonly forward: Vec3;
  readonly up: Vec3;
}

export const FACES: readonly Face[] = [
  { name: 'north', forward: [0, 0, -1], up: [0, 1, 0] },
  { name: 'east', forward: [1, 0, 0], up: [0, 1, 0] },
  { name: 'south', forward: [0, 0, 1], up: [0, 1, 0] },
  { name: 'west', forward: [-1, 0, 0], up: [0, 1, 0] },
  { name: 'up', forward: [0, 1, 0], up: [0, 0, 1] },
  { name: 'down', forward: [0, -1, 0], up: [0, 0, -1] },
];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A face's basis exactly as the tracer makes a camera's (trace.ts): it looks along −back. */
export function basisOf(face: Face): { forward: Vec3; right: Vec3; up: Vec3 } {
  const back: Vec3 = [-face.forward[0], -face.forward[1], -face.forward[2]];
  const right = norm(cross(face.up, back));
  return { forward: face.forward, right, up: cross(back, right) };
}

/** The tracer's field of view for a face `n` pixels across with a pixel's margin on each side: the inner n span 90°. */
export const faceFov = (n: number): number => (2 * Math.atan((n + 2) / n) * 180) / Math.PI;

/** A face's camera at the eye (the scene's frame). */
export function faceCamera(face: Face, eye: Vec3, n: number, label: string): Camera {
  return { eye, target: [eye[0] + face.forward[0], eye[1] + face.forward[1], eye[2] + face.forward[2]], up: face.up, fovY: faceFov(n), near: 0.02, label: `${label} · ${face.name}` };
}

/** The project frame's (x, y north, z up) to the scene's (+Y up, −Z north). */
export const toScene = (p: Point3): Vec3 => [p[0], p[2], -p[1]];

/**
 * Resample six faces (linear RGB, each `(n + 2)²` with its margin, in `FACES`' order) into an
 * equirectangular picture `width` × `width / 2`, bilinearly.
 */
export function resample(faces: readonly Float32Array[], n: number, width: number): Float32Array {
  const height = width / 2;
  const W = n + 2;
  const k = (n + 2) / n;
  const bases = FACES.map(basisOf);
  const out = new Float32Array(width * height * 3);
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const d = directionOf(equirectYawPitch((i + 0.5) / width, (j + 0.5) / height));
      const s = toScene(d);
      // The face it falls on: the one it is most along.
      let f = 0;
      let most = -Infinity;
      for (let q = 0; q < 6; q++) {
        const c = dot(s, bases[q]!.forward);
        if (c > most) {
          most = c;
          f = q;
        }
      }
      const b = bases[f]!;
      const fx = dot(s, b.right) / most / k;
      const fy = dot(s, b.up) / most / k;
      const px = ((fx + 1) / 2) * W - 0.5;
      const py = ((1 - fy) / 2) * W - 0.5;
      const x0 = Math.max(0, Math.min(W - 2, Math.floor(px)));
      const y0 = Math.max(0, Math.min(W - 2, Math.floor(py)));
      const tx = Math.max(0, Math.min(1, px - x0));
      const ty = Math.max(0, Math.min(1, py - y0));
      const img = faces[f]!;
      const o = 3 * (j * width + i);
      for (let c = 0; c < 3; c++) {
        const a = img[3 * (y0 * W + x0) + c]! * (1 - tx) + img[3 * (y0 * W + x0 + 1) + c]! * tx;
        const z = img[3 * ((y0 + 1) * W + x0) + c]! * (1 - tx) + img[3 * ((y0 + 1) * W + x0 + 1) + c]! * tx;
        out[o + c] = a * (1 - ty) + z * ty;
      }
    }
  return out;
}

export interface PanoOptions {
  /** A cube face's side, pixels (a quarter of the panorama's width). */
  readonly face: number;
  /** The panorama's width; its height is half. */
  readonly width: number;
  readonly samples: number;
  /** The light: the trace's sun, sky field and ground, its firefly cap — everything but the size and camera. */
  readonly trace: Omit<TraceOptions, 'width' | 'height' | 'samples' | 'camera' | 'onPass' | 'rows'>;
  /** The band the panorama is metered within. */
  readonly exposure: ExposureBand | undefined;
  readonly label: string;
  readonly onFace?: (face: number, faces: number, pass: number, passes: number) => void;
  readonly signal?: AbortSignal;
}

export interface Pano {
  /** Eight-bit RGB, rows top to bottom: `width` × `width / 2`. */
  readonly rgb: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** The exposure it was metered to. */
  readonly exposure: number;
  readonly threads: number;
}

/** Path-trace the panorama from the eye (the project frame, metres). */
export async function renderPano(pt: PtScene, eye: Point3, options: PanoOptions): Promise<Pano> {
  const n = options.face;
  const W = n + 2;
  const at = toScene(eye);
  const faces: Float32Array[] = [];
  let threads = 1;
  for (const [i, face] of FACES.entries()) {
    options.signal?.throwIfAborted();
    options.onFace?.(i, FACES.length, 0, options.samples);
    const traced = await traceParallel(
      pt,
      {
        ...options.trace,
        width: W,
        height: W,
        samples: options.samples,
        camera: faceCamera(face, at, n, options.label),
        onPass: (done, total) => { options.onFace?.(i, FACES.length, done, total); },
      },
      undefined,
      options.signal,
    );
    threads = traced.threads;
    faces.push(denoise(traced.color, traced.features, W, W));
  }
  // Metered once, over every face: the panorama is one photograph, not six.
  const all = new Float32Array(faces.reduce((s, f) => s + f.length, 0));
  let o = 0;
  for (const f of faces) {
    all.set(f, o);
    o += f.length;
  }
  const exposure = exposureOf(all, W, W * FACES.length, options.exposure);
  const hdr = resample(faces, n, options.width);
  const height = options.width / 2;
  return { rgb: toneMap(hdr, options.width, height, exposure), width: options.width, height, exposure, threads };
}
