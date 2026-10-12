/**
 * A small Monte-Carlo path tracer (FLR-T-12.6, FLR-REQ-154): diffuse surfaces in their material's
 * colour and base-colour map, thin glass that lets light through, one sun, a clear sky, and — when
 * they are turned on (FLR-T-12.22) — the lamps of the house's luminaires.
 *
 * - Every pixel is traced `samples` times, one sample a pass, each pass over the whole image — so a
 *   pass is the unit of progress, and an image is never part-traced.
 * - At each diffuse bounce the sun is sampled directly (next-event estimation, a shadow ray to a
 *   point on its disc), and the path continues in a cosine-weighted direction; a path that escapes
 *   sees the sky. Russian roulette ends paths after the third bounce.
 * - A shadow ray asks only whether anything blocks it (`Bvh.occluded`), and stops at the first wall.
 * - Lamps (`PtScene.lamps`) are small spheres, each shining every way or as a spot down a cone. At
 *   each diffuse bounce, beside the sun, one or two lamps are sampled directly — picked in proportion
 *   to what each could give the point, unshadowed — each with a shadow ray through the same BVH, so
 *   a lamp lights its own room and not the room behind the wall. A luminaire's lens lets its own
 *   lamp's light out: shadow rays toward a lamp pass through lenses — and a luminaire never shadows
 *   its own lamp (FLR-T-13.1): a shadow ray toward a lamp passes every piece of the fixture it is
 *   the lamp of (`PtScene.owner`), its canopy, trim and shade as well as its lens.
 * - Glass shows a glint of the sky (8%) and lets the rest through, tinted by its colour; a shadow
 *   ray passes through glass the same way, so sun reaches the floor through a window.
 * - The image is exposed to its own log-average luminance — or to a fixed exposure, or metered
 *   within a band (FLR-T-13.1: @floorspec/mesh `EXPOSURE_PER_NIT`), so a room with its lamps on and
 *   off can be compared — and tone-mapped with an ACES-style filmic curve, then written in sRGB.
 *
 * What it is not: a lighting simulation. Metallic and roughness are ignored (every opaque surface is
 * matte), a lamp's photometry is a guess from its kind and watts (@floorspec/mesh lights.ts), and
 * the sky is a simple gradient — approximate lighting, which is what
 * the screen says. Seeded (rng.ts), so the same scene and options give the same picture.
 */
import { groundAt, hazeAt, skyRadiance as fieldRadiance, type GroundArea, type SkyField } from '@floorspec/mesh/sky';
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
  /**
   * Linear RGB a luminaire's lens shows (FLR-T-12.21): added where a camera ray meets it, so the lens
   * looks lit. The light it gives the room is its lamp's (`PtScene.lamps`), sampled directly.
   */
  readonly emission?: Vec3;
  /** A luminaire's lens (lit or not): what a shadow ray toward a lamp passes through. */
  readonly lens?: boolean;
}

/** A lamp (FLR-T-12.22): a small sphere that shines every way, or a spot down a cone. */
export interface PtLamp {
  /** Its centre, metres, +Y up. */
  readonly position: Vec3;
  readonly radius: number;
  /** Radiant intensity (on its axis, for a spot), in the tracer's irradiance units at one metre: linear RGB. */
  readonly intensity: Vec3;
  /** A spot: its axis (unit) and its cone's cosines — full inside `inner`, dark past `outer`. */
  readonly spot?: { readonly dir: Vec3; readonly inner: number; readonly outer: number };
  /** The fixture it is the lamp of: the triangles of `PtScene.owner` this number never shadow it. */
  readonly owner?: number;
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
  /** The lamps that are on; none when the lights are off. */
  readonly lamps?: readonly PtLamp[];
  /**
   * One per triangle, when present: the luminaire it is a piece of (a lamp's `owner`), or −1 — what
   * a shadow ray toward that luminaire's lamp passes (FLR-T-13.1).
   */
  readonly owner?: Int32Array;
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
  /** The sky's radiance, scaled per channel: dimmed and blued at dusk and at night. Default [1, 1, 1]. */
  readonly sky?: Vec3;
  /**
   * The sky as @floorspec/mesh draws it (FLR-T-13.4): a preset's HDRI dome in cd/m², read in place
   * of the simple gradient; `unit` is the tracer's, in lux (`LUX_PER_UNIT`).
   */
  readonly field?: { readonly sky: SkyField; readonly unit: number };
  /**
   * The ground (FLR-T-13.4): a level plane at height `y` out to the horizon, the lawn (or what
   * `areas` lay on it) under the sun and sky, lost in the haze with distance.
   */
  readonly ground?: { readonly y: number; readonly areas?: readonly GroundArea[]; /** The studio's floor instead of the lawn. */ readonly floor?: Vec3 };
  /**
   * The most the light a single sample gathers past its first bounce may add to a pixel, in
   * luminance (what the camera's first surface shows lit directly is never clamped, FLR-T-13.16).
   * Default 12: a dim night's is less.
   */
  readonly clamp?: number;
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
/** The ground plane's material (FLR-T-13.4): its colour is the lawn's, looked up where it is hit. */
const GROUND: PtMaterial = { rgb: [1, 1, 1], glass: false };
/** The most a single sample's bounced light may add to a pixel (in luminance), so a rare lucky path does not spark. */
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
  const [skyR, skyG, skyB] = options.sky ?? [1, 1, 1];
  const clamp = options.clamp ?? CLAMP;
  const lamps = scene.lamps ?? [];
  const lampW = new Float64Array(lamps.length);
  /**
   * How many lamps the first surface a pixel sees samples; every later bounce samples one
   * (FLR-T-13.16): its light reaches the picture dimmed by the bounces before it, and a shadow ray
   * is most of a lit render's time.
   */
  const lampPicks = Math.min(2, lamps.length);
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
  const tex = new Float64Array(3);
  const sky = new Float64Array(3);
  const field = options.field;
  const unit = field?.unit ?? 1;
  const ground = options.ground;
  const areas = ground?.areas ?? [];
  const look = new Float64Array(3);
  /** The sky along a direction, in the tracer's units, scaled: the field's, else the gradient. */
  const skyAlong = (x: number, y: number, z: number, out: Float64Array): void => {
    if (field === undefined) {
      skyRadiance(x, y, z, sun, out);
      out[0] = out[0]! * skyR;
      out[1] = out[1]! * skyG;
      out[2] = out[2]! * skyB;
      return;
    }
    // The scene's frame (+Y up, −Z project north) to the project's (x, y north, z up).
    look[0] = x;
    look[1] = -z;
    look[2] = y;
    fieldRadiance(field.sky, look, out);
    out[0] = out[0]! / unit;
    out[1] = out[1]! / unit;
    out[2] = out[2]! / unit;
  };
  const horizon = field === undefined ? null : field.sky.horizon.map((c) => c / unit);

  // A shadow ray asks only whether something blocks it (Bvh.occluded), not what is nearest: glass
  // and lenses it passes dim or pass it in any order, and the first wall it meets ends it. Its state
  // is kept here, so the one test function is not made anew for every ray.
  const owners = scene.owner;
  /** Toward a lamp (not the sun), and the fixture it is the lamp of (−1: none). */
  let toLamp = false;
  let shadowOwner = -1;
  let crossed = 0;
  let through: Float64Array = new Float64Array(3);
  /** Whether triangle `tri` blocks a shadow ray; glass it passes dims `through`. */
  const blocks = (tri: number): boolean => {
    const m = mats[scene.material[tri]!]!;
    // A piece of the lamp's own fixture never shadows it; a lens lets the light out.
    if (toLamp && (m.lens === true || (shadowOwner >= 0 && owners !== undefined && owners[tri] === shadowOwner))) return false;
    if (!m.glass) return true;
    // Past eight crossings, call it blocked.
    if (++crossed > 8) return true;
    through[0] = through[0]! * 0.9 * (0.7 + 0.3 * m.rgb[0]);
    through[1] = through[1]! * 0.9 * (0.7 + 0.3 * m.rgb[1]);
    through[2] = through[2]! * 0.9 * (0.7 + 0.3 * m.rgb[2]);
    return false;
  };
  /** How much light reaches a point along `l` from up to `tMax` away: 0 behind anything opaque, less through glass. */
  const shadow = (ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, tMax: number, lamp: boolean, owner: number, out: Float64Array): void => {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    toLamp = lamp;
    shadowOwner = owner;
    crossed = 0;
    through = out;
    if (bvh.occluded(ox, oy, oz, lx, ly, lz, EPS, tMax, blocks)) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
    }
  };
  /** How much sunlight reaches a point along `l`: 0 behind anything opaque, less through glass. */
  const transmit = (ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, out: Float64Array): void => { shadow(ox, oy, oz, lx, ly, lz, Infinity, false, -1, out); };
  const light = new Float64Array(3);

  /**
   * How much of a lamp's light reaches a point along `l`, up to `tMax`: through glass, through
   * lenses, through every piece of its own fixture (`owner`, its place in `PtScene.owner`, or −1
   * when it has none), and not past anything else.
   */
  const reaches = (ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, tMax: number, owner: number, out: Float64Array): void => { shadow(ox, oy, oz, lx, ly, lz, tMax, true, owner, out); };
  /** A spot's falloff toward its cone's edge, for the cosine of the angle off its axis. */
  const spotFactor = (lamp: PtLamp, cosA: number): number => {
    const s = lamp.spot;
    if (s === undefined) return 1;
    if (cosA <= s.outer) return 0;
    if (cosA >= s.inner) return 1;
    const t = (cosA - s.outer) / (s.inner - s.outer);
    return t * t * (3 - 2 * t);
  };
  const lampLight = new Float64Array(3);
  /**
   * The lamps' light at a point with normal n, directly: `picks` lamps picked in proportion to
   * what each could give it unshadowed, each sampled at a point on its sphere and shadow-tested.
   * Irradiance (linear RGB) into `out`.
   */
  const lampsAt = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, picks: number, out: Float64Array): void => {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    let total = 0;
    for (let i = 0; i < lamps.length; i++) {
      const lamp = lamps[i]!;
      const vx = lamp.position[0] - px;
      const vy = lamp.position[1] - py;
      const vz = lamp.position[2] - pz;
      const d2 = vx * vx + vy * vy + vz * vz;
      const d = Math.sqrt(d2);
      // Facing it (to within its radius), and within its cone.
      const cosN = (vx * nx + vy * ny + vz * nz) / d;
      const sin = lamp.radius / Math.max(d, lamp.radius);
      let w = 0;
      if (cosN > -sin) {
        const sp = lamp.spot === undefined ? 1 : spotFactor(lamp, -(vx * lamp.spot.dir[0] + vy * lamp.spot.dir[1] + vz * lamp.spot.dir[2]) / d + sin);
        const I = lamp.intensity;
        w = (Math.max(cosN, 0.05 * sin) * sp * (I[0] + I[1] + I[2])) / Math.max(d2, lamp.radius * lamp.radius);
      }
      lampW[i] = w;
      total += w;
    }
    if (total <= 0) return;
    for (let pick = 0; pick < picks; pick++) {
      let x = rng.next() * total;
      let i = 0;
      while (i < lamps.length - 1 && x >= lampW[i]!) x -= lampW[i++]!;
      if (lampW[i]! <= 0) continue;
      const p = lampW[i]! / total;
      const lamp = lamps[i]!;
      // A point in its sphere.
      const u = 2 * rng.next() - 1;
      const phi = 2 * Math.PI * rng.next();
      const rr = lamp.radius * Math.cbrt(rng.next());
      const across = Math.sqrt(Math.max(0, 1 - u * u)) * rr;
      const qx = lamp.position[0] + Math.cos(phi) * across;
      const qy = lamp.position[1] + u * rr;
      const qz = lamp.position[2] + Math.sin(phi) * across;
      let lx = qx - px;
      let ly = qy - py;
      let lz = qz - pz;
      const d2 = Math.max(lx * lx + ly * ly + lz * lz, lamp.radius * lamp.radius);
      const d = Math.sqrt(d2);
      lx /= d;
      ly /= d;
      lz /= d;
      const cosN = nx * lx + ny * ly + nz * lz;
      if (cosN <= 0) continue;
      const sp = lamp.spot === undefined ? 1 : spotFactor(lamp, -(lx * lamp.spot.dir[0] + ly * lamp.spot.dir[1] + lz * lamp.spot.dir[2]));
      if (sp <= 0) continue;
      reaches(px, py, pz, lx, ly, lz, d, lamp.owner ?? -1, lampLight);
      if (lampLight[0] === 0 && lampLight[1] === 0 && lampLight[2] === 0) continue;
      const k = (sp * cosN) / d2 / p / picks;
      out[0] += lamp.intensity[0] * k * lampLight[0]!;
      out[1] += lamp.intensity[1] * k * lampLight[1]!;
      out[2] += lamp.intensity[2] * k * lampLight[2]!;
    }
  };
  const lampE = new Float64Array(3);

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
        /** How far the camera's first surface is, metres. */
        let firstAt = 0;
        // What the camera's first surface shows lit directly (and the sky and glass before it): kept
        // apart from what later bounces bring, which alone is clamped.
        let direct = false;
        let dr = 0;
        let dg = 0;
        let db = 0;
        for (;;) {
          // The ground plane, when there is one: nothing past it is seen.
          const tGround = ground !== undefined && dy < 0 && oy > ground.y ? (ground.y - oy) / dy : Infinity;
          const onGround = !bvh.intersect(ox, oy, oz, dx, dy, dz, tMin, tGround, hit);
          if (onGround && tGround === Infinity) {
            skyAlong(dx, dy, dz, sky);
            r += tr * sky[0]!;
            g += tg * sky[1]!;
            b += tb * sky[2]!;
            break;
          }
          const t = onGround ? -1 : hit.tri;
          const tHit = onGround ? tGround : hit.t;
          const m = onGround ? GROUND : mats[scene.material[t]!]!;
          travelled += tHit;
          const hx = ox + dx * tHit;
          const hy = onGround ? ground!.y : oy + dy * tHit;
          const hz = oz + dz * tHit;
          let nx = onGround ? 0 : N[3 * t]!;
          let ny = onGround ? 1 : N[3 * t + 1]!;
          let nz = onGround ? 0 : N[3 * t + 2]!;
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
            skyAlong(dx - k * nx, dy - k * ny, dz - k * nz, sky);
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
          if (onGround && ground!.floor !== undefined) {
            ar = ground!.floor[0];
            ag = ground!.floor[1];
            ab = ground!.floor[2];
          } else if (onGround) {
            // The lawn, or what is laid on it: the scene's (x, −z) is the project's (x, y).
            // Seen from the camera, its pixel's footprint there, so the far lawn is its mean, not sparkle.
            groundAt(hx, -hz, areas, tex, depth === 0 && crossings === 0 ? (travelled * 2 * tanY) / H / Math.max(0.05, -dy) : 0.05);
            ar = tex[0]!;
            ag = tex[1]!;
            ab = tex[2]!;
          } else if (m.texture !== undefined && !Number.isNaN(UV[6 * t]!)) {
            const w0 = 1 - hit.u - hit.v;
            const u = w0 * UV[6 * t]! + hit.u * UV[6 * t + 2]! + hit.v * UV[6 * t + 4]!;
            const v = w0 * UV[6 * t + 1]! + hit.u * UV[6 * t + 3]! + hit.v * UV[6 * t + 5]!;
            sample(m.texture, u, v, tex);
            ar *= tex[0]!;
            ag *= tex[1]!;
            ab *= tex[2]!;
          }
          if (first && m.emission !== undefined) {
            r += tr * m.emission[0];
            g += tg * m.emission[1];
            b += tb * m.emission[2];
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
            firstAt = travelled;
            firstLum = Math.max(0.02, 0.2126 * ar + 0.7152 * ag + 0.0722 * ab);
          }
          const px0 = hx + nx * EPS;
          const py0 = hy + ny * EPS;
          const pz0 = hz + nz * EPS;
          // The lamps, directly.
          if (lampPicks > 0) {
            lampsAt(px0, py0, pz0, nx, ny, nz, depth === 0 ? lampPicks : 1, lampE);
            r += (tr * ar * lampE[0]!) / Math.PI;
            g += (tg * ag * lampE[1]!) / Math.PI;
            b += (tb * ab * lampE[2]!) / Math.PI;
          }
          // The sun, directly: a point on its disc.
          if (sun.irradiance > 0 && nx * sx + ny * sy + nz * sz > 0) {
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
          if (depth === 0) {
            direct = true;
            dr = r;
            dg = g;
            db = b;
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
        if (!direct) {
          dr = r;
          dg = g;
          db = b;
        } else if (horizon !== null && field !== undefined) {
          // The haze between the camera and the first surface it sees (FLR-T-13.4): the far lawn
          // fades into the horizon's colour.
          const h = hazeAt(field.sky.light, firstAt);
          if (h > 0) {
            dr = dr * (1 - h) + horizon[0]! * h;
            dg = dg * (1 - h) + horizon[1]! * h;
            db = db * (1 - h) + horizon[2]! * h;
            r = r * (1 - h) + horizon[0]! * h;
            g = g * (1 - h) + horizon[1]! * h;
            b = b * (1 - h) + horizon[2]! * h;
          }
        }
        // Only the light a path gathers past its first bounce is clamped (FLR-T-13.16): a lucky bounce
        // onto the bright ceiling over a lamp is what sparks, while a lit lens, a surface by a lamp
        // and a sunlit wall seen directly are smooth — clamped, they flattened to one white and a
        // fixture vanished into the ceiling around it.
        const ir = r - dr;
        const ig = g - dg;
        const ib = b - db;
        const lumIn = 0.2126 * ir + 0.7152 * ig + 0.0722 * ib;
        const k = lumIn > clamp ? clamp / lumIn : 1;
        const o = 3 * pixel;
        const d = (0.2126 * dr + 0.7152 * dg + 0.0722 * db + lumIn * k) / firstLum;
        moment1[pixel] = moment1[pixel]! + d;
        moment2[pixel] = moment2[pixel]! + d * d;
        accum[o] = accum[o]! + dr + ir * k;
        accum[o + 1] = accum[o + 1]! + dg + ig * k;
        accum[o + 2] = accum[o + 2]! + db + ib * k;
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

/** A metered exposure's band: the least and most it may be, and the key it meters to (default 0.18). */
export interface ExposureBand {
  readonly min: number;
  readonly max: number;
  readonly key?: number;
}

/**
 * The exposure that puts an image's log-average luminance at `key`; a pixel darker than `floor`
 * counts as `floor`, so a black sky does not drag the average to nothing.
 */
export function meter(hdr: Float32Array, width: number, height: number, key = 0.18, floor = 1e-4): number {
  const n = width * height;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.log(floor + 0.2126 * hdr[3 * i]! + 0.7152 * hdr[3 * i + 1]! + 0.0722 * hdr[3 * i + 2]!);
  const avg = Math.exp(sum / Math.max(1, n));
  return key / Math.max(floor, avg);
}

/** The exposure an image is given: metered, a fixed scale, or metered and held within a band. */
export function exposureOf(hdr: Float32Array, width: number, height: number, exposure?: number | ExposureBand): number {
  if (typeof exposure === 'number') return exposure;
  if (exposure === undefined) return meter(hdr, width, height);
  // What the band's most open exposure would show at a hundredth of its key counts as black.
  const key = exposure.key ?? 0.18;
  return Math.min(exposure.max, Math.max(exposure.min, meter(hdr, width, height, key, key / exposure.max / 100)));
}

/**
 * Expose to the image's log-average luminance (key 0.18) — or to `exposure`: a fixed scale, so two
 * pictures of one scene under different light can be compared, or a band the metered exposure is
 * held within (FLR-T-13.1) — tone-map, and write 8-bit sRGB.
 */
export function toneMap(hdr: Float32Array, width: number, height: number, exposure?: number | ExposureBand): Uint8Array {
  const n = width * height;
  const k = exposureOf(hdr, width, height, exposure);
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < 3 * n; i++) out[i] = Math.round(toSrgb(aces(hdr[i]! * k)) * 255);
  return out;
}
