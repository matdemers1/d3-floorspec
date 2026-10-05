/**
 * A small Monte-Carlo path tracer (FLR-T-12.6, FLR-REQ-154): diffuse surfaces in their material's
 * colour and base-colour map, thin glass that lets light through, one sun and a clear sky.
 *
 * - Every pixel is traced `samples` times, one sample a pass, each pass over the whole image — so a
 *   pass is the unit of progress, and an image is never part-traced.
 * - At each diffuse bounce the sun is sampled directly (next-event estimation, a shadow ray to a
 *   point on its disc), and the path continues in a cosine-weighted direction; a path that escapes
 *   sees the sky. Russian roulette ends paths after the third bounce.
 * - Glass shows a glint of the sky (8%) and lets the rest through, tinted by its colour; a shadow
 *   ray passes through glass the same way, so sun reaches the floor through a window.
 * - The image is exposed to its own log-average luminance and tone-mapped with an ACES-style
 *   filmic curve, then written in sRGB.
 *
 * What it is not: a lighting simulation. Metallic and roughness are ignored (every opaque surface is
 * matte), there are no lamps, and the sky is a simple gradient — approximate lighting, which is what
 * the screen says. Seeded (rng.ts), so the same scene and options give the same picture.
 */
import type { Vec3 } from '../export/gltf/scene.js';
import type { Camera } from '../render3d/camera.js';
import { Bvh, type Hit } from './bvh.js';
import type { Features } from './denoise.js';
import { Rng } from './rng.js';
import { sample, type Texture } from './textures.js';

export interface PtMaterial {
  /** Linear RGB. */
  readonly rgb: Vec3;
  readonly glass: boolean;
  readonly texture?: Texture;
}

/** What the tracer traces: triangles with a material each and, for mapped materials, texture coordinates. */
export interface PtScene {
  readonly count: number;
  /** Nine per triangle, metres, +Y up. */
  readonly positions: Float64Array;
  /** Three per triangle: the unit geometric normal. */
  readonly normals: Float64Array;
  readonly material: Int32Array;
  /** Six per triangle: (u, v) at each vertex; NaN where the material has no map. */
  readonly uvs: Float32Array;
  readonly materials: readonly PtMaterial[];
}

export interface Sun {
  /** Unit, toward the sun, in the scene's frame. */
  readonly dir: Vec3;
  /** Irradiance on a surface square to it, in the tracer's units (the sky's zenith is about 0.4). */
  readonly irradiance: number;
  /** Half the angle the disc subtends, radians: the softness of its shadows. */
  readonly radius: number;
  readonly color: Vec3;
}

export interface TraceOptions {
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly camera: Camera;
  readonly sun: Sun;
  readonly seed: number;
  /** Diffuse bounces after the first hit. Default 4. */
  readonly bounces?: number;
  /** Called after each pass, with the passes done and in all; awaited, so it may yield. */
  readonly onPass?: (done: number, total: number) => void | Promise<void>;
  /** Stop with an error once this much time (ms) has passed. */
  readonly budgetMs?: number;
  /**
   * Trace only every `of`-th row, starting at `index`: one thread's share of the image. The rows
   * left out stay zero, and every pixel draws from its own seeded stream, so the shares add up to
   * exactly the image one thread would trace.
   */
  readonly rows?: { readonly of: number; readonly index: number };
}

const EPS = 1e-4;
/** The most a single sample may add to a pixel (in luminance), so a rare lucky path does not spark. */
const CLAMP = 12;

/** Sky radiance seen along a direction (the sun's disc excluded: it is sampled directly). */
export function skyRadiance(dx: number, dy: number, dz: number, sun: Sun, out: Float64Array): void {
  if (dy <= 0) {
    // Below the horizon and past the ground plate: dim, warm ground light.
    out[0] = 0.12;
    out[1] = 0.115;
    out[2] = 0.1;
    return;
  }
  const t = Math.pow(dy, 0.55);
  const glow = Math.pow(Math.max(0, dx * sun.dir[0] + dy * sun.dir[1] + dz * sun.dir[2]), 12) * 0.35;
  out[0] = (0.62 + (0.16 - 0.62) * t) * 0.62 + glow * sun.color[0];
  out[1] = (0.69 + (0.27 - 0.69) * t) * 0.62 + glow * sun.color[1];
  out[2] = (0.78 + (0.55 - 0.78) * t) * 0.62 + glow * sun.color[2];
}

/**
 * Trace an image: linear HDR RGB, three floats a pixel, rows top to bottom — and the first surface
 * each pixel sees (its albedo, normal and distance) and the noise of its samples, for the denoiser.
 */
export async function trace(scene: PtScene, options: TraceOptions): Promise<{ color: Float32Array; features: Features }> {
  const { width: W, height: H, samples, camera, sun, seed } = options;
  const bounces = options.bounces ?? 4;
  const started = Date.now();
  const bvh = new Bvh({ positions: scene.positions, count: scene.count });
  const N = scene.normals;
  const UV = scene.uvs;
  const mats = scene.materials;

  // The camera's basis, as the rasterizer's: it looks along −back.
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const back = norm(sub(camera.eye, camera.target));
  let right = cross(camera.up, back);
  if (Math.hypot(...right) < 1e-9) right = cross([0, 0, -1], back);
  right = norm(right);
  const up = cross(back, right);
  const tanY = Math.tan((camera.fovY * Math.PI) / 360);
  const tanX = tanY * (W / H);
  const [ex, ey, ez] = camera.eye;

  // The sun's disc: a frame around its direction, to sample points on it.
  const [sx, sy, sz] = sun.dir;
  const sa: Vec3 = norm(Math.abs(sx) < 0.9 ? cross([1, 0, 0], sun.dir) : cross([0, 1, 0], sun.dir));
  const sb: Vec3 = cross(sun.dir, sa);
  const cosMax = Math.cos(sun.radius);

  const accum = new Float32Array(W * H * 3);
  const albedo = new Float32Array(W * H * 3);
  const normal = new Float32Array(W * H * 3);
  const depthSum = new Float32Array(W * H);
  const hits = new Uint32Array(W * H);
  const moment1 = new Float64Array(W * H);
  const moment2 = new Float64Array(W * H);
  const rng = new Rng(seed);
  const hit: Hit = { tri: -1, t: 0, u: 0, v: 0 };
  const shadowHit: Hit = { tri: -1, t: 0, u: 0, v: 0 };
  const tex = new Float64Array(3);
  const sky = new Float64Array(3);

  /** How much sunlight reaches a point along `l`: 0 behind anything opaque, less through glass. */
  const transmit = (ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, out: Float64Array): void => {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    let tFrom = EPS;
    for (let k = 0; k < 8; k++) {
      if (!bvh.intersect(ox, oy, oz, lx, ly, lz, tFrom, Infinity, shadowHit)) return;
      const m = mats[scene.material[shadowHit.tri]!]!;
      if (!m.glass) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        return;
      }
      out[0] *= 0.9 * (0.7 + 0.3 * m.rgb[0]);
      out[1] *= 0.9 * (0.7 + 0.3 * m.rgb[1]);
      out[2] *= 0.9 * (0.7 + 0.3 * m.rgb[2]);
      tFrom = shadowHit.t + EPS;
    }
  };
  const light = new Float64Array(3);

  for (let pass = 0; pass < samples; pass++) {
    const step = options.rows?.of ?? 1;
    for (let py = options.rows?.index ?? 0; py < H; py += step) {
      for (let px = 0; px < W; px++) {
        const pixel = py * W + px;
        rng.reseed(seed, pass, pixel);
        const fx = ((px + rng.next()) / W) * 2 - 1;
        const fy = 1 - ((py + rng.next()) / H) * 2;
        let dx = right[0] * fx * tanX + up[0] * fy * tanY - back[0];
        let dy = right[1] * fx * tanX + up[1] * fy * tanY - back[1];
        let dz = right[2] * fx * tanX + up[2] * fy * tanY - back[2];
        const dl = Math.hypot(dx, dy, dz);
        dx /= dl;
        dy /= dl;
        dz /= dl;
        let ox = ex;
        let oy = ey;
        let oz = ez;
        let tMin = camera.near;
        let r = 0;
        let g = 0;
        let b = 0;
        let tr = 1;
        let tg = 1;
        let tb = 1;
        let depth = 0;
        let crossings = 0;
        let first = true;
        let firstLum = 1;
        let travelled = 0;
        for (;;) {
          if (!bvh.intersect(ox, oy, oz, dx, dy, dz, tMin, Infinity, hit)) {
            skyRadiance(dx, dy, dz, sun, sky);
            r += tr * sky[0]!;
            g += tg * sky[1]!;
            b += tb * sky[2]!;
            break;
          }
          const t = hit.tri;
          const m = mats[scene.material[t]!]!;
          travelled += hit.t;
          const hx = ox + dx * hit.t;
          const hy = oy + dy * hit.t;
          const hz = oz + dz * hit.t;
          let nx = N[3 * t]!;
          let ny = N[3 * t + 1]!;
          let nz = N[3 * t + 2]!;
          if (nx * dx + ny * dy + nz * dz > 0) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
          }
          tMin = EPS;
          if (m.glass) {
            if (++crossings > 8) break;
            // A glint of the sky (8%, not traced further), and the rest straight through, tinted.
            const k = 2 * (dx * nx + dy * ny + dz * nz);
            skyRadiance(dx - k * nx, dy - k * ny, dz - k * nz, sun, sky);
            r += tr * 0.08 * sky[0]!;
            g += tg * 0.08 * sky[1]!;
            b += tb * 0.08 * sky[2]!;
            tr *= 0.92 * (0.7 + 0.3 * m.rgb[0]);
            tg *= 0.92 * (0.7 + 0.3 * m.rgb[1]);
            tb *= 0.92 * (0.7 + 0.3 * m.rgb[2]);
            ox = hx;
            oy = hy;
            oz = hz;
            continue;
          }
          // The surface's colour: its material's, times its map where it has one.
          let ar = m.rgb[0];
          let ag = m.rgb[1];
          let ab = m.rgb[2];
          if (m.texture !== undefined && !Number.isNaN(UV[6 * t]!)) {
            const w0 = 1 - hit.u - hit.v;
            const u = w0 * UV[6 * t]! + hit.u * UV[6 * t + 2]! + hit.v * UV[6 * t + 4]!;
            const v = w0 * UV[6 * t + 1]! + hit.u * UV[6 * t + 3]! + hit.v * UV[6 * t + 5]!;
            sample(m.texture, u, v, tex);
            ar *= tex[0]!;
            ag *= tex[1]!;
            ab *= tex[2]!;
          }
          if (first) {
            first = false;
            const o = 3 * pixel;
            albedo[o] = albedo[o]! + ar;
            albedo[o + 1] = albedo[o + 1]! + ag;
            albedo[o + 2] = albedo[o + 2]! + ab;
            normal[o] = normal[o]! + nx;
            normal[o + 1] = normal[o + 1]! + ny;
            normal[o + 2] = normal[o + 2]! + nz;
            depthSum[pixel] = depthSum[pixel]! + travelled;
            hits[pixel] = hits[pixel]! + 1;
            firstLum = Math.max(0.02, 0.2126 * ar + 0.7152 * ag + 0.0722 * ab);
          }
          const px0 = hx + nx * EPS;
          const py0 = hy + ny * EPS;
          const pz0 = hz + nz * EPS;
          // The sun, directly: a point on its disc.
          if (nx * sx + ny * sy + nz * sz > 0) {
            const cosA = 1 - rng.next() * (1 - cosMax);
            const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
            const phi = 2 * Math.PI * rng.next();
            const ca = Math.cos(phi) * sinA;
            const cb = Math.sin(phi) * sinA;
            const lx = sx * cosA + sa[0] * ca + sb[0] * cb;
            const ly = sy * cosA + sa[1] * ca + sb[1] * cb;
            const lz = sz * cosA + sa[2] * ca + sb[2] * cb;
            const cosN = nx * lx + ny * ly + nz * lz;
            if (cosN > 0) {
              transmit(px0, py0, pz0, lx, ly, lz, light);
              const k = (sun.irradiance / Math.PI) * cosN;
              r += tr * ar * k * sun.color[0] * light[0]!;
              g += tg * ag * k * sun.color[1] * light[1]!;
              b += tb * ab * k * sun.color[2] * light[2]!;
            }
          }
          if (++depth > bounces) break;
          tr *= ar;
          tg *= ag;
          tb *= ab;
          if (depth >= 3) {
            const p = Math.max(tr, tg, tb);
            if (p <= 0 || rng.next() >= p) break;
            tr /= p;
            tg /= p;
            tb /= p;
          }
          // A cosine-weighted direction about the normal.
          const r1 = rng.next();
          const r2 = rng.next();
          const rad = Math.sqrt(r1);
          const phi = 2 * Math.PI * r2;
          const lx = rad * Math.cos(phi);
          const ly = rad * Math.sin(phi);
          const lz = Math.sqrt(Math.max(0, 1 - r1));
          const ux = Math.abs(nx) < 0.9 ? 1 : 0;
          const uy = ux === 1 ? 0 : 1;
          // t1 = normalize(cross(u, n)), t2 = cross(n, t1)
          let t1x = uy * nz;
          let t1y = -ux * nz;
          let t1z = ux * ny - uy * nx;
          const tl = Math.hypot(t1x, t1y, t1z);
          t1x /= tl;
          t1y /= tl;
          t1z /= tl;
          const t2x = ny * t1z - nz * t1y;
          const t2y = nz * t1x - nx * t1z;
          const t2z = nx * t1y - ny * t1x;
          dx = t1x * lx + t2x * ly + nx * lz;
          dy = t1y * lx + t2y * ly + ny * lz;
          dz = t1z * lx + t2z * ly + nz * lz;
          ox = px0;
          oy = py0;
          oz = pz0;
        }
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const k = lum > CLAMP ? CLAMP / lum : 1;
        const o = 3 * pixel;
        const d = (lum * k) / firstLum;
        moment1[pixel] = moment1[pixel]! + d;
        moment2[pixel] = moment2[pixel]! + d * d;
        accum[o] = accum[o]! + r * k;
        accum[o + 1] = accum[o + 1]! + g * k;
        accum[o + 2] = accum[o + 2]! + b * k;
      }
    }
    if (options.budgetMs !== undefined && Date.now() - started > options.budgetMs)
      throw new Error(`the still was stopped after ${String(Math.round(options.budgetMs / 60_000))} minutes, at pass ${String(pass + 1)} of ${String(samples)}: choose a smaller size or a lower quality`);
    await options.onPass?.(pass + 1, samples);
    // Let the process breathe between passes: its heartbeat, and the queue's progress writes.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (let i = 0; i < accum.length; i++) accum[i] = accum[i]! / samples;
  const depthOut = new Float32Array(W * H);
  const variance = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const k = hits[p]!;
    depthOut[p] = k === 0 ? Infinity : depthSum[p]! / k;
    for (let c = 0; c < 3; c++) {
      albedo[3 * p + c] = k === 0 ? 1 : albedo[3 * p + c]! / k;
      normal[3 * p + c] = k === 0 ? 0 : normal[3 * p + c]! / k;
    }
    const mean = moment1[p]! / samples;
    variance[p] = Math.max(0, moment2[p]! / samples - mean * mean) / samples;
  }
  return { color: accum, features: { albedo, normal, depth: depthOut, variance } };
}

const toSrgb = (c: number): number => {
  const x = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
};
/** Narkowicz's fit of the ACES filmic curve. */
const aces = (x: number): number => (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);

/** Expose to the image's log-average luminance (key 0.18), tone-map, and write 8-bit sRGB. */
export function toneMap(hdr: Float32Array, width: number, height: number): Uint8Array {
  const n = width * height;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.log(1e-4 + 0.2126 * hdr[3 * i]! + 0.7152 * hdr[3 * i + 1]! + 0.0722 * hdr[3 * i + 2]!);
  const avg = Math.exp(sum / Math.max(1, n));
  const exposure = 0.18 / Math.max(1e-4, avg);
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < 3 * n; i++) out[i] = Math.round(toSrgb(aces(hdr[i]! * exposure)) * 255);
  return out;
}
