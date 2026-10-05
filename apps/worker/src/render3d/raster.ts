/**
 * A small software rasterizer for the headless 3D render (FLR-T-8.5): flat-shaded triangles, a
 * depth buffer, supersampling for smooth edges, ink lines where planes meet (the drawing a person
 * reads a model by), and see-through glass blended over the rest.
 *
 * Why not a browser: the render is a picture for an agent to check its work by — the walls, the
 * rooms, the roof, from a named view — and a z-buffer over the mesh's triangles draws that in a few
 * hundred milliseconds, in plain JavaScript, identically on every machine (no GPU, no driver, no
 * Chromium in the worker image). Floats are fine here: no measurement is read from a picture.
 */
import type { Vec3 } from '../export/gltf/scene.js';
import type { Camera } from './camera.js';

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
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

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

  // The camera's basis: it looks along −back.
  const back = norm(sub(camera.eye, camera.target));
  let right = cross(camera.up, back);
  if (Math.hypot(...right) < 1e-9) right = cross([0, 0, -1], back);
  right = norm(right);
  const up = cross(back, right);
  // A light over the viewer's left shoulder, from above: every face the camera sees is lit, each
  // orientation differently.
  const flatBack = norm([back[0], 0, back[2]]);
  const light = norm([-0.5 * right[0] + 0.6 * flatBack[0], 1.1, -0.5 * right[2] + 0.6 * flatBack[2]]);

  const color = new Float32Array(W * H * 3);
  const depth = new Float32Array(W * H); // 1 / distance along the view: larger is nearer; 0 is the sky
  const key = new Int32Array(W * H).fill(-1);

  const [skyTop, skyBottom] = options.sky ?? [
    [0.86, 0.89, 0.93],
    [0.97, 0.97, 0.96],
  ];
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

  const P = list.positions;
  const view = (i: number): Vec3 => {
    const d: Vec3 = [P[i]! - camera.eye[0], P[i + 1]! - camera.eye[1], P[i + 2]! - camera.eye[2]];
    return [dot(d, right), dot(d, up), dot(d, back)];
  };

  const glass: number[] = [];
  const shadeOf = (t: number): Vec3 => {
    const n: Vec3 = [list.normals[3 * t]!, list.normals[3 * t + 1]!, list.normals[3 * t + 2]!];
    const lambert = Math.abs(dot(n, light));
    const sky = 0.5 + 0.5 * n[1];
    const k = 0.34 + 0.14 * sky + 0.58 * lambert;
    return [list.colors[3 * t]! * k, list.colors[3 * t + 1]! * k, list.colors[3 * t + 2]! * k];
  };

  /** Clip a view-space polygon to the near plane and draw it. */
  const draw = (t: number, blend: boolean): void => {
    const poly: Vec3[] = [view(9 * t), view(9 * t + 3), view(9 * t + 6)];
    const near = camera.near;
    const clipped: Vec3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const ina = a[2] <= -near;
      const inb = b[2] <= -near;
      if (ina) clipped.push(a);
      if (ina !== inb) {
        const s = (-near - a[2]) / (b[2] - a[2]);
        clipped.push([a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1]), -near]);
      }
    }
    if (clipped.length < 3) return;
    const screen = clipped.map((v) => {
      const w = -v[2];
      return [((v[0] * f) / aspect / w) * 0.5 * W + 0.5 * W, 0.5 * H - ((v[1] * f) / w) * 0.5 * H, 1 / w] as const;
    });
    const c = shadeOf(t);
    const alpha = list.alpha[t]!;
    const k = list.keys[t]!;
    const lift = 1 + list.bias[t]! * 2e-5;
    for (let i = 1; i + 1 < screen.length; i++) fill(screen[0]!, screen[i]!, screen[i + 1]!, c, alpha, k, blend, lift);
  };

  const fill = (a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number], rgb: Vec3, alpha: number, k: number, blend: boolean, lift: number): void => {
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
        if (blend) {
          color[o] = color[o]! * (1 - alpha) + rgb[0] * alpha;
          color[o + 1] = color[o + 1]! * (1 - alpha) + rgb[1] * alpha;
          color[o + 2] = color[o + 2]! * (1 - alpha) + rgb[2] * alpha;
        } else {
          depth[i] = z;
          key[i] = k;
          color[o] = rgb[0];
          color[o + 1] = rgb[1];
          color[o + 2] = rgb[2];
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
    for (let i = 0; i < W * H; i++)
      if (ink[i] === 1 && key[i] !== -2) {
        color[3 * i] = color[3 * i]! * 0.42;
        color[3 * i + 1] = color[3 * i + 1]! * 0.42;
        color[3 * i + 2] = color[3 * i + 2]! * 0.44;
      }
  }

  glass.sort((a, b) => {
    const za = view(9 * a)[2] + view(9 * a + 3)[2] + view(9 * a + 6)[2];
    const zb = view(9 * b)[2] + view(9 * b + 3)[2] + view(9 * b + 6)[2];
    return za - zb || a - b;
  });
  for (const t of glass) draw(t, true);

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
