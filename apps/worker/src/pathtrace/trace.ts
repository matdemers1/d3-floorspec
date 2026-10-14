/**
 * A small Monte-Carlo path tracer (FLR-T-12.6, FLR-REQ-154): surfaces in their material's colour,
 * maps, roughness and metalness, glazing that reflects and lets light through, one sun, the sky,
 * and — when they are turned on (FLR-T-12.22) — the lamps of the house's luminaires.
 *
 * - Every pixel is traced `samples` times, one sample a pass, each pass over the whole image — so a
 *   pass is the unit of progress, and an image is never part-traced.
 * - Surfaces reflect as the editor's GPU still's do (FLR-T-13.14, FLR-ADR-040; brdf.ts): a diffuse
 *   base under a GGX gloss — Smith's masking, Schlick's Fresnel, F₀ 4% for a dielectric and the base
 *   colour for a metal, its lost multiple scattering put back — so oak has a sheen, quartz a polish,
 *   steel and mirrors reflect the room in their own colour, and a metal has no diffuse at all.
 * - At each bounce the sun is sampled directly (next-event estimation, a shadow ray to a point on its
 *   disc) through the whole lobe, gloss and diffuse; the path then continues in a direction drawn
 *   from the lobe — a cosine-weighted one off the diffuse, or along a facet the viewer sees off the
 *   gloss (in proportion to what each reflects). A path that escapes sees the sky. Russian roulette
 *   ends paths after the third bounce.
 * - A shadow ray asks only whether anything blocks it (`Bvh.occluded`), and stops at the first wall.
 * - Lamps (`PtScene.lamps`) are small spheres, each shining every way or as a spot down a cone. At
 *   each bounce, beside the sun, one or two lamps are sampled directly — picked in proportion to what
 *   each could give the point, unshadowed — each with a shadow ray through the same BVH, so a lamp
 *   lights its own room and not the room behind the wall. A luminaire's lens lets its own lamp's
 *   light out: shadow rays toward a lamp pass through lenses — and a luminaire never shadows its own
 *   lamp (FLR-T-13.1): a shadow ray toward a lamp passes every piece of the fixture it is the lamp of
 *   (`PtScene.owner`), its canopy, trim and shade as well as its lens.
 * - Glazing is a thin pane of dielectric (brdf.ts `thinPane`, the rule @floorspec/mesh's glass.ts
 *   draws every view with): Fresnel by its ior at the angle it is seen, both faces, its tint along the
 *   slant. Where nothing stands in the way of what a pane reflects it shows the sky, and the path goes
 *   on through; where something does — the room behind the camera at night — the path is reflected
 *   or let through in proportion. A shadow ray passes glass the same way, so sun reaches the floor
 *   through a window.
 * - What the camera sees in a mirror or a polished face is the camera's own view: a lens glows in it,
 *   and its light is not clamped as bounced light is (FLR-T-13.16).
 * - The image is exposed to its own log-average luminance — or to a fixed exposure, or metered
 *   within a band (FLR-T-13.1: @floorspec/mesh `EXPOSURE_PER_NIT`), so a room with its lamps on and
 *   off can be compared — and tone-mapped with an ACES-style filmic curve, then written in sRGB.
 *
 * What it is not: a lighting simulation. A lamp's photometry is a guess from its kind and watts
 * (@floorspec/mesh lights.ts) — approximate lighting, which is what the screen says. Seeded (rng.ts),
 * so the same scene and options give the same picture.
 */
import { GLASS_IOR, groundAt, hazeAt, skyRadiance as fieldRadiance, type GroundArea, type SkyField } from '@floorspec/mesh/sky';
import type { Vec3 } from '../export/gltf/scene.js';
import type { Camera } from '../render3d/camera.js';
import { alphaOf, DIELECTRIC_F0, ggxD, lobeAlbedo, paneAbsorption, sampleVndf, smithLambda, smithV, thinPane } from './brdf.js';
import { Bvh, type Hit } from './bvh.js';
import type { Features } from './denoise.js';
import { Rng } from './rng.js';
import { sample, type Texture } from './textures.js';

export interface PtMaterial {
  /** Linear RGB. */
  readonly rgb: Vec3;
  /** Glazing: a thin pane whose `rgb` is what it lets through face on (glass.ts `paneTransmission`). */
  readonly glass: boolean;
  /** Glass's index of refraction (KHR_materials_ior). Default @floorspec/mesh's `GLASS_IOR`, 1.5. */
  readonly ior?: number;
  readonly texture?: Texture;
  /**
   * Linear RGB a luminaire's lens shows (FLR-T-12.21): added where a camera ray meets it, so the lens
   * looks lit. The light it gives the room is its lamp's (`PtScene.lamps`), sampled directly.
   */
  readonly emission?: Vec3;
  /** A luminaire's lens (lit or not): what a shadow ray toward a lamp passes through. */
  readonly lens?: boolean;
  /**
   * How rough and how metallic it is, 0–1 (Core 18.1): the factors — multiplying the ORM map's green
   * and blue where there is one (FLR-T-13.6). Absent: matte (1) and not metal (0).
   */
  readonly roughness?: number;
  readonly metallic?: number;
  /**
   * How much of a dielectric's 4% gloss it has, 0–1 (glTF's KHR_materials_specular specularFactor).
   * Default 1, as every glTF material; 0 is a pure diffuser — a lux meter's probe.
   */
  readonly specular?: number;
  /** Occlusion in red, roughness in green, metalness in blue, linear (glTF's channels, Core 18.2). */
  readonly orm?: Texture;
  /** A tangent-space normal map, linear, +X along u and +Y up the tile (Core 18.2). */
  readonly normalMap?: Texture;
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
  const shift = camera.shift ?? 0;
  const lens = camera.lens !== undefined && camera.lens.radius > 0 && camera.lens.focus > 0 ? camera.lens : undefined;

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
  /** The shadow ray's direction: the angle it crosses a pane at. */
  let sdx = 0;
  let sdy = 0;
  let sdz = 0;
  // Each pane's tint, one pass face on (brdf.ts `paneAbsorption`): worked out once, not per crossing.
  const absorb = mats.map((m) => {
    const a = new Float64Array(3);
    if (m.glass) paneAbsorption(m.rgb, m.ior ?? GLASS_IOR, a);
    return a;
  });
  const paneT = new Float64Array(3);
  const paneR = new Float64Array(3);
  /** Any triangle at all: whether something stands in the way of what a pane reflects. */
  const always = (): boolean => true;
  /** Whether triangle `tri` blocks a shadow ray; glass it passes dims `through`, by what the pane lets through at its angle. */
  const blocks = (tri: number): boolean => {
    const mi = scene.material[tri]!;
    const m = mats[mi]!;
    // A piece of the lamp's own fixture never shadows it; a lens lets the light out.
    if (toLamp && (m.lens === true || (shadowOwner >= 0 && owners !== undefined && owners[tri] === shadowOwner))) return false;
    if (!m.glass) return true;
    // Past eight crossings, call it blocked.
    if (++crossed > 8) return true;
    thinPane(absorb[mi]!, Math.abs(sdx * N[3 * tri]! + sdy * N[3 * tri + 1]! + sdz * N[3 * tri + 2]!), m.ior ?? GLASS_IOR, paneT, paneR);
    through[0] = through[0]! * paneT[0]!;
    through[1] = through[1]! * paneT[1]!;
    through[2] = through[2]! * paneT[2]!;
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
    sdx = lx;
    sdy = ly;
    sdz = lz;
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
   * Irradiance (linear RGB) into `out`, and the radiance the surface's gloss (`glossAt`) reflects of
   * it toward the viewer into `gloss`.
   */
  const lampsAt = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, picks: number, out: Float64Array, gloss: Float64Array): void => {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    gloss[0] = 0;
    gloss[1] = 0;
    gloss[2] = 0;
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
      const k = sp / d2 / p / picks;
      out[0] += lamp.intensity[0] * k * cosN * lampLight[0]!;
      out[1] += lamp.intensity[1] * k * cosN * lampLight[1]!;
      out[2] += lamp.intensity[2] * k * cosN * lampLight[2]!;
      glossAt(lx, ly, lz, spec);
      gloss[0] += lamp.intensity[0] * k * lampLight[0]! * spec[0]!;
      gloss[1] += lamp.intensity[1] * k * lampLight[1]! * spec[1]!;
      gloss[2] += lamp.intensity[2] * k * lampLight[2]! * spec[2]!;
    }
  };
  const lampE = new Float64Array(3);
  const lampS = new Float64Array(3);
  const shade = new Float64Array(3);
  /**
   * A normal map's normal (x, y, z in −1…1, tangent space) at a point of triangle `t`, in the scene:
   * the tangent along increasing u, the bitangent up the tile (decreasing v, glTF's v running down
   * its image), the triangle's own normal — turned with the geometric normal `n` the hit faces, so
   * it lies on the side the ray came from. Falls back to `n` where the mapping is degenerate.
   */
  const shadingNormal = (t: number, x: number, y: number, z: number, gnx: number, gny: number, gnz: number, out: Float64Array): void => {
    const o = 9 * t;
    const P = scene.positions;
    const e1x = P[o + 3]! - P[o]!, e1y = P[o + 4]! - P[o + 1]!, e1z = P[o + 5]! - P[o + 2]!;
    const e2x = P[o + 6]! - P[o]!, e2y = P[o + 7]! - P[o + 1]!, e2z = P[o + 8]! - P[o + 2]!;
    const du1 = UV[6 * t + 2]! - UV[6 * t]!, dv1 = UV[6 * t + 3]! - UV[6 * t + 1]!;
    const du2 = UV[6 * t + 4]! - UV[6 * t]!, dv2 = UV[6 * t + 5]! - UV[6 * t + 1]!;
    const det = du1 * dv2 - du2 * dv1;
    out[0] = gnx;
    out[1] = gny;
    out[2] = gnz;
    if (Math.abs(det) < 1e-12) return;
    // The triangle's normal as stored, and whether the hit turned it round.
    const n0x = N[3 * t]!, n0y = N[3 * t + 1]!, n0z = N[3 * t + 2]!;
    const flip = n0x * gnx + n0y * gny + n0z * gnz < 0 ? -1 : 1;
    let tx = (e1x * dv2 - e2x * dv1) / det, ty = (e1y * dv2 - e2y * dv1) / det, tz = (e1z * dv2 - e2z * dv1) / det;
    const bvx = (e2x * du1 - e1x * du2) / det, bvy = (e2y * du1 - e1y * du2) / det, bvz = (e2z * du1 - e1z * du2) / det;
    const d = tx * n0x + ty * n0y + tz * n0z;
    tx -= n0x * d;
    ty -= n0y * d;
    tz -= n0z * d;
    const tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-12) return;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // The bitangent: n × T, turned to point up the tile (−dP/dv).
    let bx = n0y * tz - n0z * ty, by = n0z * tx - n0x * tz, bz = n0x * ty - n0y * tx;
    if (bx * -bvx + by * -bvy + bz * -bvz < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
    }
    let sx2 = tx * x + bx * y + n0x * z, sy2 = ty * x + by * y + n0y * z, sz2 = tz * x + bz * y + n0z * z;
    const l = Math.hypot(sx2, sy2, sz2);
    if (l < 1e-9) return;
    sx2 = (flip * sx2) / l;
    sy2 = (flip * sy2) / l;
    sz2 = (flip * sz2) / l;
    // Never past the surface's horizon as seen from the side it is hit.
    if (sx2 * gnx + sy2 * gny + sz2 * gnz < 0.05) return;
    out[0] = sx2;
    out[1] = sy2;
    out[2] = sz2;
  };
  // The surface a path is at, as `glossAt` and the lobe's sampling read it (brdf.ts): toward the
  // viewer (V), its shading normal (S), α², n·v, how metallic, its base colour, and the boosts that
  // put back what a single bounce off the facets loses — the dielectric's and, per channel, a metal's.
  let Vx = 0, Vy = 0, Vz = 0, Sx = 0, Sy = 0, Sz = 0;
  let A2 = 1, NV = 1, MET = 0, SPEC = 1, BR = 0, BG = 0, BB = 0, BD = 1, BMR = 1, BMG = 1, BMB = 1;
  const spec = new Float64Array(3);
  /**
   * The radiance the surface's gloss reflects toward the viewer from a light arriving along `l`, per
   * unit of the light's irradiance on a surface square to it: the GGX lobe D V F (n·l) — F Schlick's,
   * from 4% for the dielectric part and from the base colour for the metal part — linear RGB.
   */
  const glossAt = (lx: number, ly: number, lz: number, out: Float64Array): void => {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    const nl = Sx * lx + Sy * ly + Sz * lz;
    if (nl <= 0) return;
    let hx = lx + Vx, hy = ly + Vy, hz = lz + Vz;
    const hl = Math.hypot(hx, hy, hz);
    if (hl < 1e-9) return;
    hx /= hl;
    hy /= hl;
    hz /= hl;
    const s = ggxD(Sx * hx + Sy * hy + Sz * hz, A2) * smithV(nl, NV, A2) * nl;
    if (!(s > 0)) return;
    const k = 1 - Math.min(1, Math.max(0, Vx * hx + Vy * hy + Vz * hz));
    const fw = k * k * k * k * k;
    const fd = (1 - MET) * SPEC * (DIELECTRIC_F0 + (1 - DIELECTRIC_F0) * fw) * BD;
    out[0] = s * (fd + MET * (BR + (1 - BR) * fw) * BMR);
    out[1] = s * (fd + MET * (BG + (1 - BG) * fw) * BMG);
    out[2] = s * (fd + MET * (BB + (1 - BB) * fw) * BMB);
  };
  const lobe = new Float64Array(3);
  const facet = new Float64Array(3);
  /** Past a bounce along a lobe this narrow (roughness 0.2), the camera still sees a reflection, not light that bounced. */
  const MIRROR_ALPHA = 0.04;

  for (let pass = 0; pass < samples; pass++) {
    const step = options.rows?.of ?? 1;
    for (let py = options.rows?.index ?? 0; py < H; py += step) {
      for (let px = 0; px < W; px++) {
        const pixel = py * W + px;
        rng.reseed(seed, pass, pixel);
        const fx = ((px + rng.next()) / W) * 2 - 1;
        // A shift lens (FLR-T-13.10): the picture's middle `shift` half-heights up.
        const fy = 1 - ((py + rng.next()) / H) * 2 + shift;
        let dx = right[0] * fx * tanX + up[0] * fy * tanY - back[0];
        let dy = right[1] * fx * tanX + up[1] * fy * tanY - back[1];
        let dz = right[2] * fx * tanX + up[2] * fy * tanY - back[2];
        let ox = ex;
        let oy = ey;
        let oz = ez;
        if (lens !== undefined) {
          // A thin lens (FLR-T-13.10): from a point on its disc toward where this ray meets the plane in
          // focus — `focus` along the line of sight, which the unnormalised ray advances by one a unit.
          const fpx = ex + dx * lens.focus;
          const fpy = ey + dy * lens.focus;
          const fpz = ez + dz * lens.focus;
          const rr = lens.radius * Math.sqrt(rng.next());
          const th = 2 * Math.PI * rng.next();
          const lx = rr * Math.cos(th);
          const ly = rr * Math.sin(th);
          ox = ex + right[0] * lx + up[0] * ly;
          oy = ey + right[1] * lx + up[1] * ly;
          oz = ez + right[2] * lx + up[2] * ly;
          dx = fpx - ox;
          dy = fpy - oy;
          dz = fpz - oz;
        }
        const dl = Math.hypot(dx, dy, dz);
        dx /= dl;
        dy /= dl;
        dz /= dl;
        let tMin = camera.near;
        let r = 0;
        let g = 0;
        let b = 0;
        let tr = 1;
        let tg = 1;
        let tb = 1;
        let depth = 0;
        let crossings = 0;
        /** The first surface's features (for the denoiser) are yet to be recorded: past a mirror, they are what it shows. */
        let first = true;
        /** Still the camera's own view: through glass, and off mirrors and polished faces. */
        let chain = true;
        let surfaced = false;
        let firstLum = 1;
        let travelled = 0;
        /** How far the camera's first surface is, metres. */
        let firstAt = 0;
        // What the camera's own view shows lit directly — its first surface, and what it sees of the
        // room in a mirror or a polished floor (and the sky and glass before them): kept apart from
        // what later bounces bring, which alone is clamped.
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
          const mi = onGround ? -1 : scene.material[t]!;
          const m = onGround ? GROUND : mats[mi]!;
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
            // A thin pane (brdf.ts, FLR-T-13.14): Fresnel by its ior at this angle, both faces, its tint.
            const cos = -(dx * nx + dy * ny + dz * nz);
            const ior = m.ior ?? GLASS_IOR;
            thinPane(absorb[mi]!, cos, ior, paneT, paneR);
            const k = 2 * (dx * nx + dy * ny + dz * nz);
            const rx = dx - k * nx;
            const ry = dy - k * ny;
            const rz = dz - k * nz;
            const qx = hx + nx * EPS;
            const qy = hy + ny * EPS;
            const qz = hz + nz * EPS;
            if (chain && !(ground !== undefined && ry < 0 && qy > ground.y) && !bvh.occluded(qx, qy, qz, rx, ry, rz, EPS, Infinity, always)) {
              // Seen by the camera, and nothing stands in the way of what its face reflects: the sky,
              // added here, and the path goes on through — no noise for a window seen from outside.
              // (Bounced light is not looked at: it is reflected or let through by chance, below,
              // without the shadow ray.)
              skyAlong(rx, ry, rz, sky);
              r += tr * paneR[0]! * sky[0]!;
              g += tg * paneR[1]! * sky[1]!;
              b += tb * paneR[2]! * sky[2]!;
              tr *= paneT[0]!;
              tg *= paneT[1]!;
              tb *= paneT[2]!;
              ox = hx;
              oy = hy;
              oz = hz;
              continue;
            }
            // Something does — the lit room behind the camera, at night — or the light has bounced:
            // reflected or let through, in proportion.
            const lr = 0.2126 * paneR[0]! + 0.7152 * paneR[1]! + 0.0722 * paneR[2]!;
            const lt = 0.2126 * paneT[0]! + 0.7152 * paneT[1]! + 0.0722 * paneT[2]!;
            const pr = lr / Math.max(1e-9, lr + lt);
            if (rng.next() < pr) {
              tr *= paneR[0]! / pr;
              tg *= paneR[1]! / pr;
              tb *= paneR[2]! / pr;
              dx = rx;
              dy = ry;
              dz = rz;
              ox = qx;
              oy = qy;
              oz = qz;
            } else {
              tr *= paneT[0]! / (1 - pr);
              tg *= paneT[1]! / (1 - pr);
              tb *= paneT[2]! / (1 - pr);
              ox = hx;
              oy = hy;
              oz = hz;
            }
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
          }
          // FLR-T-13.6: the surface's maps — its colour, how rough and metallic it is, and its relief.
          let snx = nx;
          let sny = ny;
          let snz = nz;
          let rough = m.roughness ?? 1;
          let metal = m.metallic ?? 0;
          let cavity = 1;
          if (!onGround && !Number.isNaN(UV[6 * t]!) && (m.texture !== undefined || m.orm !== undefined || m.normalMap !== undefined)) {
            const w0 = 1 - hit.u - hit.v;
            const u = w0 * UV[6 * t]! + hit.u * UV[6 * t + 2]! + hit.v * UV[6 * t + 4]!;
            const v = w0 * UV[6 * t + 1]! + hit.u * UV[6 * t + 3]! + hit.v * UV[6 * t + 5]!;
            if (m.texture !== undefined) {
              sample(m.texture, u, v, tex);
              ar *= tex[0]!;
              ag *= tex[1]!;
              ab *= tex[2]!;
            }
            if (m.orm !== undefined) {
              sample(m.orm, u, v, tex);
              cavity = tex[0]!;
              rough *= tex[1]!;
              metal *= tex[2]!;
            }
            if (m.normalMap !== undefined) {
              sample(m.normalMap, u, v, tex);
              shadingNormal(t, tex[0]! * 2 - 1, tex[1]! * 2 - 1, tex[2]! * 2 - 1, nx, ny, nz, shade);
              snx = shade[0]!;
              sny = shade[1]!;
              snz = shade[2]!;
            }
          }
          // The lobe (brdf.ts, FLR-T-13.14): GGX gloss over a diffuse base, as the GPU still's glTF
          // material. Its albedo E — 4% face on for a dielectric, the base colour for a metal, more at
          // a grazing angle — with what one bounce off the facets loses put back; what the gloss
          // reflects, the diffuse beneath it does not get.
          rough = Math.min(1, Math.max(0, rough));
          metal = Math.min(1, Math.max(0, metal));
          const alpha = alphaOf(rough);
          A2 = alpha * alpha;
          Vx = -dx;
          Vy = -dy;
          Vz = -dz;
          Sx = snx;
          Sy = sny;
          Sz = snz;
          NV = Math.max(1e-4, Sx * Vx + Sy * Vy + Sz * Vz);
          MET = metal;
          SPEC = Math.min(1, Math.max(0, m.specular ?? 1));
          BR = ar;
          BG = ag;
          BB = ab;
          lobeAlbedo(NV, rough, lobe);
          const ess = Math.max(1e-4, lobe[0]! + lobe[1]!);
          const lost = (1 - ess) / ess;
          BD = 1 + DIELECTRIC_F0 * lost;
          BMR = 1 + ar * lost;
          BMG = 1 + ag * lost;
          BMB = 1 + ab * lost;
          const eD = SPEC * (DIELECTRIC_F0 * lobe[0]! + lobe[1]!) * BD;
          const esr = (1 - metal) * eD + metal * (ar * lobe[0]! + lobe[1]!) * BMR;
          const esg = (1 - metal) * eD + metal * (ag * lobe[0]! + lobe[1]!) * BMG;
          const esb = (1 - metal) * eD + metal * (ab * lobe[0]! + lobe[1]!) * BMB;
          // The diffuse base. A map's occlusion is what the map's relief hides from the light round it
          // — a mortar joint, the shadow line under a lap board: it darkens the light a bounce brings
          // (below) fully, and the sun's and the lamps' by half, for the relief's own shadow the normal
          // map cannot cast (FLR-T-13.6).
          const base = (1 - metal) * (1 - eD);
          const lit = base * (0.5 + 0.5 * cavity);
          const kdr = ar * lit;
          const kdg = ag * lit;
          const kdb = ab * lit;
          const kbr = ar * base * cavity;
          const kbg = ag * base * cavity;
          const kbb = ab * base * cavity;
          // Which way the path goes on: off the gloss or the diffuse, in proportion to what each reflects.
          const ws = 0.2126 * esr + 0.7152 * esg + 0.0722 * esb;
          const wd = 0.2126 * kbr + 0.7152 * kbg + 0.0722 * kbb;
          const pGloss = ws + wd > 0 ? ws / (ws + wd) : 1;
          if (chain && m.emission !== undefined) {
            r += tr * m.emission[0];
            g += tg * m.emission[1];
            b += tb * m.emission[2];
          }
          if (!surfaced) {
            surfaced = true;
            firstAt = travelled;
          }
          // A mirror's features are what it shows (as a denoiser's guide is made): its own are one
          // flat face, and the room in it would be smoothed away.
          if (first && !(chain && alpha < MIRROR_ALPHA && pGloss > 0.9)) {
            first = false;
            const o = 3 * pixel;
            albedo[o] = albedo[o]! + kdr + esr;
            albedo[o + 1] = albedo[o + 1]! + kdg + esg;
            albedo[o + 2] = albedo[o + 2]! + kdb + esb;
            // The face's own normal, not its relief's: the denoiser finds edges by it, and a normal
            // map's every bump would read as one and keep its noise.
            normal[o] = normal[o]! + nx;
            normal[o + 1] = normal[o + 1]! + ny;
            normal[o + 2] = normal[o + 2]! + nz;
            depthSum[pixel] = depthSum[pixel]! + travelled;
            hits[pixel] = hits[pixel]! + 1;
            firstLum = Math.max(0.02, 0.2126 * (kdr + esr) + 0.7152 * (kdg + esg) + 0.0722 * (kdb + esb));
          }
          const px0 = hx + nx * EPS;
          const py0 = hy + ny * EPS;
          const pz0 = hz + nz * EPS;
          // The lamps, directly: their light on the diffuse, and the gloss's highlight of them.
          if (lampPicks > 0) {
            lampsAt(px0, py0, pz0, snx, sny, snz, chain ? lampPicks : 1, lampE, lampS);
            r += tr * ((kdr * lampE[0]!) / Math.PI + lampS[0]!);
            g += tg * ((kdg * lampE[1]!) / Math.PI + lampS[1]!);
            b += tb * ((kdb * lampE[2]!) / Math.PI + lampS[2]!);
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
            const cosN = snx * lx + sny * ly + snz * lz;
            if (cosN > 0 && nx * lx + ny * ly + nz * lz > 0) {
              transmit(px0, py0, pz0, lx, ly, lz, light);
              if (light[0]! > 0 || light[1]! > 0 || light[2]! > 0) {
                glossAt(lx, ly, lz, spec);
                const k = sun.irradiance;
                const d = cosN / Math.PI;
                r += tr * k * sun.color[0] * light[0]! * (kdr * d + spec[0]!);
                g += tg * k * sun.color[1] * light[1]! * (kdg * d + spec[1]!);
                b += tb * k * sun.color[2] * light[2]! * (kdb * d + spec[2]!);
              }
            }
          }
          if (chain) {
            direct = true;
            dr = r;
            dg = g;
            db = b;
          }
          if (++depth > bounces) break;
          // A lobe is drawn only where both reflect: a pure diffuser traces as it always has.
          const glossy = pGloss >= 1 || (pGloss > 0 && rng.next() < pGloss);
          if (glossy) {
            // Off the gloss: a facet the viewer sees (Heitz 2018), and the mirror direction about it.
            // Its weight is F G₂ / G₁(v) over the chance of choosing the gloss.
            const ux = Math.abs(Sx) < 0.9 ? 1 : 0;
            const uy = ux === 1 ? 0 : 1;
            let t1x = uy * Sz;
            let t1y = -ux * Sz;
            let t1z = ux * Sy - uy * Sx;
            const tl = Math.hypot(t1x, t1y, t1z);
            t1x /= tl;
            t1y /= tl;
            t1z /= tl;
            const t2x = Sy * t1z - Sz * t1y;
            const t2y = Sz * t1x - Sx * t1z;
            const t2z = Sx * t1y - Sy * t1x;
            sampleVndf(Vx * t1x + Vy * t1y + Vz * t1z, Vx * t2x + Vy * t2y + Vz * t2z, NV, alpha, rng.next(), rng.next(), facet);
            const fhx = t1x * facet[0]! + t2x * facet[1]! + Sx * facet[2]!;
            const fhy = t1y * facet[0]! + t2y * facet[1]! + Sy * facet[2]!;
            const fhz = t1z * facet[0]! + t2z * facet[1]! + Sz * facet[2]!;
            const vh = Vx * fhx + Vy * fhy + Vz * fhz;
            if (vh <= 0) break;
            let lx = 2 * vh * fhx - Vx;
            let ly = 2 * vh * fhy - Vy;
            let lz = 2 * vh * fhz - Vz;
            const nl = Sx * lx + Sy * ly + Sz * lz;
            if (nl <= 0) break;
            // Below the face itself (a normal map tilted it): turned back above it, as the GPU tracer does.
            const gl = nx * lx + ny * ly + nz * lz;
            if (gl <= 0) {
              lx -= 2 * gl * nx;
              ly -= 2 * gl * ny;
              lz -= 2 * gl * nz;
            }
            const lv = smithLambda(NV, A2);
            const w = (1 + lv) / (1 + lv + smithLambda(nl, A2)) / pGloss;
            const kk = 1 - Math.min(1, vh);
            const fw = kk * kk * kk * kk * kk;
            const fd = (1 - metal) * SPEC * (DIELECTRIC_F0 + (1 - DIELECTRIC_F0) * fw) * BD;
            tr *= w * (fd + metal * (ar + (1 - ar) * fw) * BMR);
            tg *= w * (fd + metal * (ag + (1 - ag) * fw) * BMG);
            tb *= w * (fd + metal * (ab + (1 - ab) * fw) * BMB);
            dx = lx;
            dy = ly;
            dz = lz;
          } else {
            tr *= kbr / (1 - pGloss);
            tg *= kbg / (1 - pGloss);
            tb *= kbb / (1 - pGloss);
          }
          if (depth >= 3) {
            const p = Math.max(tr, tg, tb);
            if (p <= 0 || rng.next() >= p) break;
            tr /= p;
            tg /= p;
            tb /= p;
          }
          if (!glossy) {
            // Off the diffuse: a cosine-weighted direction about the face's normal.
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
          }
          // Past a mirror or a polished face, still the camera's view; past anything rougher, bounced light.
          chain = chain && glossy && alpha < MIRROR_ALPHA;
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
