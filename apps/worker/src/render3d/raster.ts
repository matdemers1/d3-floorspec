/**
 * A small software rasterizer for the headless 3D render (FLR-T-8.5): flat-shaded triangles, a
 * depth buffer, supersampling for smooth edges, ink lines where planes meet (the drawing a person
 * reads a model by), and see-through glass blended over the rest.
 *
 * Light (FLR-T-12.23): a hemisphere — a cool sky above, a warm bounce from the ground below — a warm
 * key light over the viewer's left shoulder, a little of it bounced back onto what faces away, and a
 * soft cool fill from their right, so every face the camera sees is lit and each orientation
 * differently; then a gentle filmic shoulder on each pixel's
 * luminance, which keeps a finish's own hue and saturation where a plain clamp would bleach a bright
 * wall and dull a dark one.
 *
 * Why not a browser: the render is a picture for an agent to check its work by — the walls, the
 * rooms, the roof, from a named view — and a z-buffer over the mesh's triangles draws that in a few
 * hundred milliseconds, in plain JavaScript, identically on every machine (no GPU, no driver, no
 * Chromium in the worker image). Floats are fine here: no measurement is read from a picture.
 */
import { glassAt, groundAt, hazeAt, irradianceAt, skyRadiance, type GroundArea, type SkyField } from '@floorspec/mesh/sky';
import type { Vec3 } from '../export/gltf/scene.js';
import type { Camera } from './camera.js';
import { sampleLod, type Texture } from '../pathtrace/textures.js';

/** Triangles to draw: nine floats each in metres (+Y up), with a colour and an outline key each. */
export interface DrawList {
  /** Nine per triangle. */
  readonly positions: Float32Array;
  /** Three per triangle: unit, outward. */
  readonly normals: Float32Array;
  /** Three per triangle: linear RGB. */
  readonly colors: Float32Array;
  /** One per triangle: 1 opaque, less for glass. */
  readonly alpha: Float32Array;
  /** One per triangle: triangles of one key on one plane draw no line between them. */
  readonly keys: Int32Array;
  /** One per triangle: drawn from both sides. */
  readonly twoSided: Uint8Array;
  /**
   * One per triangle: drawn in front of what shares its plane (as the editor's polygon offset does) —
   * a ceiling (2) over the underside of the floor above it, a floor (1) over the slab it sits on.
   */
  readonly bias: Uint8Array;
  /** One per triangle, when present: drawn in its own colour, unshaded — a luminaire's lens. */
  readonly unlit?: Uint8Array;
  /**
   * FLR-T-13.6: a base colour map per triangle, when present — its index in `maps`, or −1 — and six
   * texture coordinates each (glTF's: v down the image). A mapped triangle's colour is white and the
   * map's texel is its colour, sampled perspective-correct from the map's mip chain.
   */
  readonly map?: Int32Array;
  /** Per triangle, when present: its normal map and its occlusion-roughness-metalness map, indices into `maps` or −1 — its relief, lit per pixel, and its occlusion. */
  readonly relief?: Int32Array;
  readonly occlusion?: Int32Array;
  readonly uvs?: Float32Array;
  readonly maps?: readonly (readonly Texture[])[];
  readonly count: number;
}

export interface RasterOptions {
  readonly width: number;
  readonly height: number;
  /** Subpixels per pixel along each axis. Default 2. */
  readonly supersample?: number;
  /** Linear RGB, top and bottom of the sky. */
  readonly sky?: readonly [Vec3, Vec3];
  /** Outlines. Default true. */
  readonly edges?: boolean;
  /**
   * Seen under a sky (FLR-T-13.4, 13.9) instead of the studio rig: lit by its sun (with shadows)
   * and its sky's image-based light, standing on the lawn out to the hazy horizon, exposed as the
   * editor's view is and tone-mapped with the path tracer's filmic curve.
   */
  readonly lighting?: RasterSky;
  /** Exposure compensation (FLR-T-13.10): the light is multiplied by this before the tone curve. Default 1. */
  readonly exposureScale?: number;
}

export interface RasterSky {
  readonly field: SkyField;
  /** The sky's harmonics (@floorspec/mesh `skyHarmonics`), the project's frame. */
  readonly sh: Float64Array;
  /** What the tone curve is given per cd/m². */
  readonly exposure: number;
  /** The direct light, toward it in this frame (+Y up, −Z project north); null when there is none. */
  readonly sun: { readonly dir: Vec3; readonly lux: number; readonly color: Vec3 } | null;
  /** The ground plane's height, metres. */
  readonly groundY: number;
  /** The studio's floor (linear RGB) instead of the lawn. */
  readonly floor?: Vec3;
  /** An even fill for the light the house and the lawn bounce (@floorspec/mesh `skyBounce`), lux, linear RGB. */
  readonly bounce?: Vec3;
  readonly areas?: readonly GroundArea[];
}

/** What a triangle's maps are, as it is filled (FLR-T-13.6). */
interface Mapped {
  readonly albedo: readonly Texture[] | undefined;
  readonly relief: readonly Texture[] | undefined;
  readonly occlusion: readonly Texture[] | undefined;
  /** The normal map's frame and the light its relief is lit by (null: none, or no direct light). */
  readonly frame: { readonly t: Vec3; readonly b: Vec3; readonly n: Vec3; readonly l: Vec3 | null } | null;
  readonly lod: number;
  readonly uv: readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
}

/** Narkowicz's fit of the ACES filmic curve: the path tracer's. */
const aces = (x: number): number => (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);

/** A depth map from the sun over the opaque triangles: what is in shadow. */
interface ShadowMap {
  readonly size: number;
  readonly a: Vec3;
  readonly b: Vec3;
  readonly l: Vec3;
  readonly u0: number;
  readonly v0: number;
  readonly scale: number;
  readonly depth: Float32Array;
}

function shadowMap(list: DrawList, toSun: Vec3, size = 2048): ShadowMap | null {
  const l = norm(toSun);
  const a = norm(Math.abs(l[1]) < 0.99 ? cross([0, 1, 0], l) : cross([1, 0, 0], l));
  const b = cross(l, a);
  const P = list.positions;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let t = 0; t < list.count; t++) {
    if (list.alpha[t]! < 1 || list.keys[t] === -2) continue;
    for (let k = 0; k < 3; k++) {
      const p: Vec3 = [P[9 * t + 3 * k]!, P[9 * t + 3 * k + 1]!, P[9 * t + 3 * k + 2]!];
      const u = dot(p, a);
      const v = dot(p, b);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
  }
  if (!Number.isFinite(u0)) return null;
  const scale = (size - 2) / Math.max(1e-6, u1 - u0, v1 - v0);
  const depth = new Float32Array(size * size).fill(-Infinity);
  for (let t = 0; t < list.count; t++) {
    if (list.alpha[t]! < 1 || list.keys[t] === -2) continue;
    const q = [0, 1, 2].map((k) => {
      const p: Vec3 = [P[9 * t + 3 * k]!, P[9 * t + 3 * k + 1]!, P[9 * t + 3 * k + 2]!];
      return [(dot(p, a) - u0) * scale + 1, (dot(p, b) - v0) * scale + 1, dot(p, l)] as const;
    });
    const [A, B, C] = q as [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
    const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (Math.abs(area) < 1e-12) continue;
    const minX = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0])));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
    const minY = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1])));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px)) / area;
        const w1 = ((C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        // A texel the triangle touches at all: conservative, so thin walls cast whole shadows.
        if (w0 < -0.5 / scale || w1 < -0.5 / scale || w2 < -0.5 / scale) continue;
        const z = w0 * A[2] + w1 * B[2] + w2 * C[2];
        const i = y * size + x;
        if (z > depth[i]!) depth[i] = z;
      }
  }
  return { size, a, b, l, u0, v0, scale, depth };
}

/** 1 in the sun, 0 in shadow, between at a shadow's edge: four texels round the point. */
function lit(map: ShadowMap, p: Vec3, bias: number): number {
  const x = (dot(p, map.a) - map.u0) * map.scale + 1 - 0.5;
  const y = (dot(p, map.b) - map.v0) * map.scale + 1 - 0.5;
  const z = dot(p, map.l) + bias;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let s = 0;
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const xi = x0 + i;
      const yj = y0 + j;
      const inside = xi < 0 || yj < 0 || xi >= map.size || yj >= map.size ? true : z >= map.depth[yj * map.size + xi]!;
      s += (inside ? 1 : 0) * (i === 0 ? 1 - fx : fx) * (j === 0 ? 1 - fy : fy);
    }
  return s;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Rec. 709 luminance of linear RGB. */
const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Where the shoulder starts, and how the curve rolls off above it towards 1. */
const KNEE = 0.62;
/** The filmic shoulder: linear up to the knee, then an exponential roll-off that never reaches 1. */
export function shoulder(x: number): number {
  return x <= KNEE ? x : KNEE + (1 - KNEE) * (1 - Math.exp(-(x - KNEE) / (1 - KNEE)));
}

/**
 * Tone-map a linear RGB pixel: the shoulder on its luminance, the colour scaled with it, and a
 * channel still above 1 pulled towards the pixel's grey rather than clipped — so the hue holds.
 */
export function tone(r: number, g: number, b: number): [number, number, number] {
  const l = luma(r, g, b);
  if (l <= 0) return [0, 0, 0];
  const k = shoulder(l) / l;
  let o: [number, number, number] = [r * k, g * k, b * k];
  const m = Math.max(o[0], o[1], o[2]);
  if (m > 1) {
    const L = shoulder(l);
    const t = (1 - L) / (m - L);
    o = [L + (o[0] - L) * t, L + (o[1] - L) * t, L + (o[2] - L) * t];
  }
  return o;
}

/**
 * The lights, each a linear RGB intensity: the sky above and the ground's bounce below (a
 * hemisphere); a warm key, a part of which comes back off the floor onto what faces away from it (a
 * ceiling, a wall turned from the key); and a cool fill.
 */
export const LIGHTS = {
  sky: [0.45, 0.47, 0.5],
  ground: [0.42, 0.39, 0.34],
  key: [0.7, 0.66, 0.58],
  bounce: 0.32,
  fill: [0.15, 0.16, 0.18],
} as const;

const toSrgb = (c: number): number => {
  const x = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
};

/** Draw the list from the camera: RGB, eight bits a channel, rows top to bottom. */
export function rasterize(list: DrawList, camera: Camera, options: RasterOptions): Uint8Array {
  const ss = Math.max(1, Math.round(options.supersample ?? 2));
  const W = options.width * ss;
  const H = options.height * ss;
  const aspect = options.width / options.height;
  const f = 1 / Math.tan((camera.fovY * Math.PI) / 360);
  // A shift lens (FLR-T-13.10, two-point perspective): the picture's middle moved up by this many half-heights.
  const shift = camera.shift ?? 0;
  // Exposure compensation (FLR-T-13.10): a factor on the light before the tone curve.
  const gain = options.exposureScale ?? 1;

  // The camera's basis: it looks along −back.
  const back = norm(sub(camera.eye, camera.target));
  let right = cross(camera.up, back);
  if (Math.hypot(...right) < 1e-9) right = cross([0, 0, -1], back);
  right = norm(right);
  const up = cross(back, right);
  // A key light over the viewer's left shoulder, from above, and a fill low from their right: every
  // face the camera sees is lit, each orientation differently.
  const flatBack = norm([back[0], 0, back[2]]);
  const light = norm([-0.5 * right[0] + 0.6 * flatBack[0], 1.1, -0.5 * right[2] + 0.6 * flatBack[2]]);
  const fillLight = norm([0.8 * right[0] + 0.5 * flatBack[0], 0.25, 0.8 * right[2] + 0.5 * flatBack[2]]);

  const color = new Float32Array(W * H * 3);
  const depth = new Float32Array(W * H); // 1 / distance along the view: larger is nearer; 0 is the sky
  const key = new Int32Array(W * H).fill(-1);
  const sky = options.lighting;
  const shadows = sky === undefined || sky.sun === null ? null : shadowMap(list, sky.sun.dir);
  /** A subpixel's point in the world, from its place and its 1 / distance along the view. */
  const worldAt = (x: number, y: number, inv: number): Vec3 => {
    const w = 1 / inv;
    const vx = (((x + 0.5) / W) * 2 - 1) * (aspect / f) * w;
    const vy = (1 - ((y + 0.5) / H) * 2 + shift) * (1 / f) * w;
    return [camera.eye[0] + right[0] * vx + up[0] * vy - back[0] * w, camera.eye[1] + right[1] * vx + up[1] * vy - back[1] * w, camera.eye[2] + right[2] * vx + up[2] * vy - back[2] * w];
  };

  const [skyTop, skyBottom] = options.sky ?? [
    [0.86, 0.89, 0.93],
    [0.97, 0.97, 0.96],
  ];
  if (sky === undefined)
    for (let y = 0; y < H; y++) {
      const t = y / Math.max(1, H - 1);
      const r = skyTop[0] + (skyBottom[0] - skyTop[0]) * t;
      const g = skyTop[1] + (skyBottom[1] - skyTop[1]) * t;
      const b = skyTop[2] + (skyBottom[2] - skyTop[2]) * t;
      for (let x = 0; x < W; x++) {
        const o = 3 * (y * W + x);
        color[o] = r;
        color[o + 1] = g;
        color[o + 2] = b;
      }
    }
  else {
    // The sky behind, and the ground out to the horizon: a plane, lit and hazed as the tracer's is.
    const out = new Float64Array(3);
    const alb = new Float64Array(3);
    const d = new Float64Array(3);
    const k = sky.exposure;
    const up3: Vec3 = [0, 0, 1];
    const E = new Float64Array(3);
    irradianceAt(sky.sh, up3, E);
    const sun = sky.sun;
    const sunUp = sun === null ? 0 : sun.lux * Math.max(0, sun.dir[1]);
    const hz = sky.field.horizon;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const vx = (((x + 0.5) / W) * 2 - 1) * (aspect / f);
        const vy = (1 - ((y + 0.5) / H) * 2 + shift) * (1 / f);
        const wx = right[0] * vx + up[0] * vy - back[0];
        const wy = right[1] * vx + up[1] * vy - back[1];
        const wz = right[2] * vx + up[2] * vy - back[2];
        const len = Math.hypot(wx, wy, wz);
        const i = y * W + x;
        const o = 3 * i;
        if (wy < 0 && camera.eye[1] > sky.groundY) {
          // Along the view, 1 unit of -back per unit of this ray's w: the plane is `t` units of it away.
          const t = (sky.groundY - camera.eye[1]) / wy;
          const p: Vec3 = [camera.eye[0] + wx * t, sky.groundY, camera.eye[2] + wz * t];
          // A subpixel's footprint on the ground: its angle times the distance, stretched at a glancing view.
          const foot = ((t * len) / (f * H * 0.5)) / Math.max(0.05, -wy / len);
          if (sky.floor === undefined) groundAt(p[0], -p[2], sky.areas ?? [], alb, foot);
          else alb.set(sky.floor);
          const s = sun === null || shadows === null ? 1 : lit(shadows, p, 0.04);
          const h = hazeAt(sky.field.light, t * len);
          for (let c = 0; c < 3; c++) {
            const L = (alb[c]! * (E[c]! + sunUp * s * (sun?.color[c] ?? 1))) / Math.PI;
            color[o + c] = (L * (1 - h) + hz[c]! * h) * k;
          }
          depth[i] = 1 / t;
          key[i] = -2;
          continue;
        }
        d[0] = wx / len;
        d[1] = -wz / len;
        d[2] = wy / len;
        skyRadiance(sky.field, d, out);
        color[o] = out[0]! * k;
        color[o + 1] = out[1]! * k;
        color[o + 2] = out[2]! * k;
      }
  }

  const P = list.positions;
  const view = (i: number): Vec3 => {
    const d: Vec3 = [P[i]! - camera.eye[0], P[i + 1]! - camera.eye[1], P[i + 2]! - camera.eye[2]];
    return [dot(d, right), dot(d, up), dot(d, back)];
  };

  const glass: number[] = [];
  const irr = new Float64Array(3);
  /** Under a sky: a triangle's light without the sun (its sky), and the sun's when it is not shadowed, times its colour and the exposure. */
  const skyShade = (t: number): { ambient: Vec3; direct: Vec3; n: Vec3 } => {
    const rgb: Vec3 = [list.colors[3 * t]!, list.colors[3 * t + 1]!, list.colors[3 * t + 2]!];
    const k = sky!.exposure / Math.PI;
    if (list.unlit?.[t] === 1) return { ambient: rgb, direct: [0, 0, 0], n: [0, 1, 0] };
    let n: Vec3 = [list.normals[3 * t]!, list.normals[3 * t + 1]!, list.normals[3 * t + 2]!];
    const toEye = sub(camera.eye, [P[9 * t]!, P[9 * t + 1]!, P[9 * t + 2]!]);
    if (dot(n, toEye) < 0) n = [-n[0], -n[1], -n[2]];
    irradianceAt(sky!.sh, [n[0], -n[2], n[1]], irr);
    const fill = sky!.bounce ?? [0, 0, 0];
    irr[0] = irr[0]! + fill[0];
    irr[1] = irr[1]! + fill[1];
    irr[2] = irr[2]! + fill[2];
    const sun = sky!.sun;
    const nl = sun === null ? 0 : Math.max(0, dot(n, sun.dir)) * sun.lux;
    return {
      ambient: [rgb[0] * irr[0] * k, rgb[1] * irr[1] * k, rgb[2] * irr[2] * k],
      direct: sun === null ? [0, 0, 0] : [rgb[0] * nl * sun.color[0] * k, rgb[1] * nl * sun.color[1] * k, rgb[2] * nl * sun.color[2] * k],
      n,
    };
  };
  const shadeOf = (t: number): Vec3 => {
    const rgb: Vec3 = [list.colors[3 * t]!, list.colors[3 * t + 1]!, list.colors[3 * t + 2]!];
    if (list.unlit?.[t] === 1) return rgb;
    let n: Vec3 = [list.normals[3 * t]!, list.normals[3 * t + 1]!, list.normals[3 * t + 2]!];
    // A two-sided face is lit on the side the camera sees.
    const toEye = sub(camera.eye, [P[9 * t]!, P[9 * t + 1]!, P[9 * t + 2]!]);
    if (dot(n, toEye) < 0) n = [-n[0], -n[1], -n[2]];
    const up = 0.5 + 0.5 * n[1];
    const nl = dot(n, light);
    const k = nl >= 0 ? nl : -LIGHTS.bounce * nl;
    const q = Math.max(0, dot(n, fillLight));
    const out: Vec3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) out[c] = rgb[c]! * (LIGHTS.ground[c]! + (LIGHTS.sky[c]! - LIGHTS.ground[c]!) * up + LIGHTS.key[c]! * k + LIGHTS.fill[c]! * q);
    return out;
  };

  /** The pane being drawn: what it lets through and what it reflects. */
  let pane: { through: Vec3; reflected: Vec3 } | null = null;
  /** Clip a view-space polygon to the near plane and draw it. */
  const draw = (t: number, blend: boolean): void => {
    const poly: Vec3[] = [view(9 * t), view(9 * t + 3), view(9 * t + 6)];
    const mi = list.map?.[t] ?? -1;
    const ni = list.relief?.[t] ?? -1;
    const oi = list.occlusion?.[t] ?? -1;
    const albedoChain = mi >= 0 ? list.maps?.[mi] : undefined;
    const reliefChain = ni >= 0 ? list.maps?.[ni] : undefined;
    const occlusionChain = oi >= 0 ? list.maps?.[oi] : undefined;
    // The chain that sets the level of detail, and whether the triangle has coordinates at all.
    const chain = albedoChain ?? reliefChain ?? occlusionChain;
    const U = list.uvs;
    const uvIn: [number, number][] = chain === undefined || U === undefined ? [] : [0, 1, 2].map((j) => [U[6 * t + 2 * j]!, U[6 * t + 2 * j + 1]!]);
    const near = camera.near;
    const clipped: Vec3[] = [];
    const uvOut: [number, number][] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const ina = a[2] <= -near;
      const inb = b[2] <= -near;
      if (ina) {
        clipped.push(a);
        if (chain !== undefined) uvOut.push(uvIn[i]!);
      }
      if (ina !== inb) {
        const s = (-near - a[2]) / (b[2] - a[2]);
        clipped.push([a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1]), -near]);
        if (chain !== undefined) {
          const ua = uvIn[i]!;
          const ub = uvIn[(i + 1) % poly.length]!;
          uvOut.push([ua[0] + s * (ub[0] - ua[0]), ua[1] + s * (ub[1] - ua[1])]);
        }
      }
    }
    if (clipped.length < 3) return;
    const screen = clipped.map((v) => {
      const w = -v[2];
      return [((v[0] * f) / aspect / w) * 0.5 * W + 0.5 * W, 0.5 * H - ((v[1] * f) / w - shift) * 0.5 * H, 1 / w] as const;
    });
    // The map's level of detail: texels a subpixel covers, from the whole polygon's areas on screen and in the map.
    let lod = 0;
    if (chain !== undefined) {
      const base = chain[0]!;
      let sa = 0;
      let ua = 0;
      for (let i = 1; i + 1 < screen.length; i++) {
        const [p0, p1, p2] = [screen[0]!, screen[i]!, screen[i + 1]!];
        sa += Math.abs((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])) / 2;
        const [q0, q1, q2] = [uvOut[0]!, uvOut[i]!, uvOut[i + 1]!];
        ua += Math.abs((q1[0] - q0[0]) * (q2[1] - q0[1]) - (q1[1] - q0[1]) * (q2[0] - q0[0])) / 2;
      }
      lod = sa > 0 ? 0.5 * Math.log2(Math.max(1e-12, (ua * base.width * base.height) / sa)) : 0;
    }
    const lightOf = sky === undefined ? null : skyShade(t);
    const c = lightOf === null ? shadeOf(t) : lightOf.ambient;
    const alpha = list.alpha[t]!;
    const k = list.keys[t]!;
    const lift = 1 + list.bias[t]! * 2e-5;
    // The sun's share, where the shadow map says it reaches: a face turned from it has none.
    const direct = lightOf === null || shadows === null || (lightOf.direct[0] === 0 && lightOf.direct[1] === 0 && lightOf.direct[2] === 0) ? null : lightOf.direct;
    const bias = lightOf === null || sky === undefined || sky.sun === null ? 0 : 0.03 + 0.05 * Math.sqrt(Math.max(0, 1 - dot(lightOf.n, sky.sun.dir) ** 2));
    // A normal map's frame on this triangle, in the world: the tangent along u, the bitangent up the
    // tile (glTF's v runs down its image), the face's normal turned to the camera.
    let frame: { t: Vec3; b: Vec3; n: Vec3; l: Vec3 | null } | null = null;
    if (reliefChain !== undefined && U !== undefined) {
      const p = (j: number): Vec3 => [P[9 * t + 3 * j]!, P[9 * t + 3 * j + 1]!, P[9 * t + 3 * j + 2]!];
      const e1 = sub(p(1), p(0));
      const e2 = sub(p(2), p(0));
      const du1 = U[6 * t + 2]! - U[6 * t]!, dv1 = U[6 * t + 3]! - U[6 * t + 1]!;
      const du2 = U[6 * t + 4]! - U[6 * t]!, dv2 = U[6 * t + 5]! - U[6 * t + 1]!;
      const det = du1 * dv2 - du2 * dv1;
      let n: Vec3 = [list.normals[3 * t]!, list.normals[3 * t + 1]!, list.normals[3 * t + 2]!];
      if (dot(n, sub(camera.eye, p(0))) < 0) n = [-n[0], -n[1], -n[2]];
      if (Math.abs(det) > 1e-12) {
        const tan = norm([(e1[0] * dv2 - e2[0] * dv1) / det, (e1[1] * dv2 - e2[1] * dv1) / det, (e1[2] * dv2 - e2[2] * dv1) / det]);
        let bit = cross(n, tan);
        const up: Vec3 = [-(e2[0] * du1 - e1[0] * du2) / det, -(e2[1] * du1 - e1[1] * du2) / det, -(e2[2] * du1 - e1[2] * du2) / det];
        if (dot(bit, up) < 0) bit = [-bit[0], -bit[1], -bit[2]];
        frame = { t: tan, b: bit, n, l: sky === undefined ? light : sky.sun === null ? null : sky.sun.dir };
      }
    }
    // Glass (FLR-T-13.17, @floorspec/mesh glass.ts): what is behind it, times what the pane lets
    // through at the angle it is seen at, and what its face reflects — the sky, under one; the
    // studio's light, else. Its colour is what it lets through face on; it has no colour of its own.
    pane = null;
    if (blend) {
      const p0: Vec3 = [(P[9 * t]! + P[9 * t + 3]! + P[9 * t + 6]!) / 3, (P[9 * t + 1]! + P[9 * t + 4]! + P[9 * t + 7]!) / 3, (P[9 * t + 2]! + P[9 * t + 5]! + P[9 * t + 8]!) / 3];
      const v = norm(sub(p0, camera.eye));
      let n: Vec3 = [list.normals[3 * t]!, list.normals[3 * t + 1]!, list.normals[3 * t + 2]!];
      if (dot(n, v) > 0) n = [-n[0], -n[1], -n[2]];
      const through = new Float64Array(3);
      const f = glassAt([list.colors[3 * t]!, list.colors[3 * t + 1]!, list.colors[3 * t + 2]!], -dot(n, v), through);
      let reflected: Vec3;
      if (sky === undefined) reflected = [c[0] * f, c[1] * f, c[2] * f];
      else {
        const k2 = 2 * dot(v, n);
        const out = new Float64Array(3);
        skyRadiance(sky.field, [v[0] - k2 * n[0], -(v[2] - k2 * n[2]), v[1] - k2 * n[1]], out);
        reflected = [out[0]! * sky.exposure * f, out[1]! * sky.exposure * f, out[2]! * sky.exposure * f];
      }
      pane = { through: [through[0]!, through[1]!, through[2]!], reflected };
    }
    for (let i = 1; i + 1 < screen.length; i++) {
      const tex = chain === undefined ? null : { albedo: albedoChain, relief: reliefChain, occlusion: occlusionChain, frame, lod, uv: [uvOut[0]!, uvOut[i]!, uvOut[i + 1]!] as const };
      fill(screen[0]!, screen[i]!, screen[i + 1]!, c, alpha, k, blend, lift, direct, bias, tex);
    }
  };

  const texel = new Float64Array(3);
  const fill = (a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number], rgb: Vec3, alpha: number, k: number, blend: boolean, lift: number, direct: Vec3 | null = null, bias = 0, tex: Mapped | null = null): void => {
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-12) return;
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    if (minX > maxX || minY > maxY) return;
    const inv = 1 / area;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) * inv;
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
        const z = (w0 * a[2] + w1 * b[2] + w2 * c[2]) * lift;
        const i = y * W + x;
        // Opaque: only what is nearer. Glass: only what is clearly in front of the opaque surface there,
        // so a pane never shimmers on the reveal it shares a plane with.
        if (blend ? z <= depth[i]! * (1 + 1e-5) : z <= depth[i]!) continue;
        const o = 3 * i;
        let r0 = rgb[0];
        let g0 = rgb[1];
        let b0 = rgb[2];
        // FLR-T-13.6: a mapped surface's texel (perspective-correct: each corner's coordinates over its
        // distance, interpolated, over 1 / distance interpolated), its relief lit by the key light or
        // the sun, and its occlusion on the light round it.
        let relief = 1;
        let ao = 1;
        if (tex !== null) {
          const za = w0 * a[2];
          const zb = w1 * b[2];
          const zc = w2 * c[2];
          const zs = za + zb + zc;
          const u = (za * tex.uv[0][0] + zb * tex.uv[1][0] + zc * tex.uv[2][0]) / zs;
          const v = (za * tex.uv[0][1] + zb * tex.uv[1][1] + zc * tex.uv[2][1]) / zs;
          if (tex.occlusion !== undefined) {
            sampleLod(tex.occlusion, u, v, tex.lod, texel);
            ao = texel[0]!;
          }
          const f0 = tex.frame;
          if (tex.relief !== undefined && f0 !== null && f0.l !== null) {
            sampleLod(tex.relief, u, v, tex.lod, texel);
            const nx = texel[0]! * 2 - 1;
            const ny = texel[1]! * 2 - 1;
            const nz = texel[2]! * 2 - 1;
            const sx = f0.t[0] * nx + f0.b[0] * ny + f0.n[0] * nz;
            const sy = f0.t[1] * nx + f0.b[1] * ny + f0.n[1] * nz;
            const sz = f0.t[2] * nx + f0.b[2] * ny + f0.n[2] * nz;
            const sl = Math.hypot(sx, sy, sz) || 1;
            const flat = dot(f0.n, f0.l);
            const bumped = (sx * f0.l[0] + sy * f0.l[1] + sz * f0.l[2]) / sl;
            relief = flat > 0.02 ? Math.max(0, Math.min(2.5, bumped / flat)) : 1;
          }
          if (direct === null) {
            // The studio's light, every part of it one shade: the relief on a part of it, the occlusion on the rest.
            const k2 = (0.6 + 0.4 * relief) * (0.55 + 0.45 * ao);
            r0 *= k2;
            g0 *= k2;
            b0 *= k2;
          } else {
            r0 *= ao;
            g0 *= ao;
            b0 *= ao;
          }
        }
        if (direct !== null && shadows !== null) {
          const s = lit(shadows, worldAt(x, y, z / lift), bias) * relief * (0.5 + 0.5 * ao);
          r0 += direct[0] * s;
          g0 += direct[1] * s;
          b0 += direct[2] * s;
        }
        if (tex?.albedo !== undefined) {
          const za = w0 * a[2];
          const zb = w1 * b[2];
          const zc = w2 * c[2];
          const zs = za + zb + zc;
          sampleLod(tex.albedo, (za * tex.uv[0][0] + zb * tex.uv[1][0] + zc * tex.uv[2][0]) / zs, (za * tex.uv[0][1] + zb * tex.uv[1][1] + zc * tex.uv[2][1]) / zs, tex.lod, texel);
          r0 *= texel[0]!;
          g0 *= texel[1]!;
          b0 *= texel[2]!;
        }
        if (blend && pane !== null) {
          color[o] = color[o]! * pane.through[0] + pane.reflected[0];
          color[o + 1] = color[o + 1]! * pane.through[1] + pane.reflected[1];
          color[o + 2] = color[o + 2]! * pane.through[2] + pane.reflected[2];
        } else if (blend) {
          color[o] = color[o]! * (1 - alpha) + r0 * alpha;
          color[o + 1] = color[o + 1]! * (1 - alpha) + g0 * alpha;
          color[o + 2] = color[o + 2]! * (1 - alpha) + b0 * alpha;
        } else {
          depth[i] = z;
          key[i] = k;
          color[o] = r0;
          color[o + 1] = g0;
          color[o + 2] = b0;
        }
      }
    }
  };

  // Opaque first, nearest-plane wins; glass after, far to near, over what is behind it.
  for (let t = 0; t < list.count; t++) {
    const n: Vec3 = [list.normals[3 * t]!, list.normals[3 * t + 1]!, list.normals[3 * t + 2]!];
    const toEye = sub(camera.eye, [P[9 * t]!, P[9 * t + 1]!, P[9 * t + 2]!]);
    if (list.twoSided[t] === 0 && dot(n, toEye) <= 0) continue;
    if (list.alpha[t]! < 1) {
      glass.push(t);
      continue;
    }
    draw(t, false);
  }

  if (options.edges !== false) {
    // Ink where one plane meets another, or meets the sky: one subpixel wide.
    const ink = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const k = key[i]!;
        const r = x + 1 < W ? key[i + 1]! : k;
        const d = y + 1 < H ? key[i + W]! : k;
        if (k !== r || k !== d) ink[k === -1 ? (k !== r ? i + 1 : i + W) : i] = 1;
      }
    // Under a sky the house is a picture more than a drawing: its lines lighter.
    const inkK = sky === undefined ? [0.42, 0.42, 0.44] : [0.62, 0.62, 0.64];
    for (let i = 0; i < W * H; i++)
      if (ink[i] === 1 && key[i] !== -2) {
        color[3 * i] = color[3 * i]! * inkK[0]!;
        color[3 * i + 1] = color[3 * i + 1]! * inkK[1]!;
        color[3 * i + 2] = color[3 * i + 2]! * inkK[2]!;
      }
  }

  glass.sort((a, b) => {
    const za = view(9 * a)[2] + view(9 * a + 3)[2] + view(9 * a + 6)[2];
    const zb = view(9 * b)[2] + view(9 * b + 3)[2] + view(9 * b + 6)[2];
    return za - zb || a - b;
  });
  for (const t of glass) draw(t, true);

  // What was drawn is tone-mapped; the sky (or the paper) behind it keeps its colour. Under a sky,
  // everything — sky and ground included — through the path tracer's filmic curve.
  if (sky !== undefined) for (let i = 0; i < 3 * W * H; i++) color[i] = aces(color[i]! * gain);
  else for (let i = 0; i < W * H; i++) {
    if (key[i] === -1) continue;
    const [tr, tg, tb] = tone(color[3 * i]! * gain, color[3 * i + 1]! * gain, color[3 * i + 2]! * gain);
    color[3 * i] = tr;
    color[3 * i + 1] = tg;
    color[3 * i + 2] = tb;
  }

  // Down to the output size, in linear light, then sRGB.
  const out = new Uint8Array(options.width * options.height * 3);
  const n = ss * ss;
  for (let y = 0; y < options.height; y++)
    for (let x = 0; x < options.width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const o = 3 * ((y * ss + sy) * W + x * ss + sx);
          r += color[o]!;
          g += color[o + 1]!;
          b += color[o + 2]!;
        }
      const o = 3 * (y * options.width + x);
      out[o] = Math.round(toSrgb(r / n) * 255);
      out[o + 1] = Math.round(toSrgb(g / n) * 255);
      out[o + 2] = Math.round(toSrgb(b / n) * 255);
    }
  return out;
}
