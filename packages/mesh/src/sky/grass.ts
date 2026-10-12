/**
 * The lawn a house stands on (FLR-T-13.4): a tiling texture of mown grass at true scale, made here
 * rather than photographed — the same texels in the editor, the headless render and both path
 * tracers, from a few lines of arithmetic, with no asset to fetch or decode and no licence to carry.
 *
 * A tile is `GRASS_TILE` metres square: blades and clumps from periodic value noise at three
 * scales, a little straw among the green, and mowing stripes a metre wide along project x. Beyond a
 * tile, `lawnMacro` varies the lawn over tens of metres, so the repeat does not show from above.
 *
 * Where hardscape or planting covers the ground — slabs, patios and driveways are drawn on it by the
 * mesher; FS_landscape's beds, lawns and paving (FLR-T-13.5) are `GroundArea`s — it is drawn instead
 * of the grass: the lawn is what is left.
 */

export type Rgb = [number, number, number];

/** Metres a texture tile covers, each way. */
export const GRASS_TILE = 4;
/** Texels a tile, each way: about 8 mm a texel. */
export const GRASS_SIZE = 512;

/** A lawn's colours, linear sRGB: shaded blades, the lawn's own green, and sunlit straw tips. */
const DARK: Rgb = [0.045, 0.062, 0.03];
const GREEN: Rgb = [0.1, 0.145, 0.06];
const LIGHT: Rgb = [0.19, 0.215, 0.11];
const STRAW: Rgb = [0.27, 0.24, 0.13];

/** A 32-bit integer hash of lattice coordinates and a seed (lowbias32). */
function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Value noise in [0, 1) over a lattice `cells` across, wrapping at `cells` so it tiles; (u, v) in [0, 1). */
function periodic(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const w = (n: number): number => ((n % cells) + cells) % cells;
  const a = hash(w(x0), w(y0), seed);
  const b = hash(w(x0 + 1), w(y0), seed);
  const c = hash(w(x0), w(y0 + 1), seed);
  const d = hash(w(x0 + 1), w(y0 + 1), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Value noise over the plane, not tiling: for the lawn's variation across tens of metres. */
function noise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export interface GrassTexture {
  readonly width: number;
  readonly height: number;
  /** Linear RGB, three floats a texel, rows top to bottom; u along project x, v along project y. */
  readonly data: Float32Array;
}

let cached: GrassTexture | null = null;
let mips: GrassTexture[] | null = null;

/** The tile and its halvings down to 1 × 1: what a lookup reads from far off, where a texel is smaller than a pixel. */
export function grassMips(): readonly GrassTexture[] {
  if (mips !== null) return mips;
  const levels: GrassTexture[] = [grassTexture()];
  for (;;) {
    const prev = levels[levels.length - 1]!;
    if (prev.width <= 1) break;
    const w = prev.width >> 1;
    const data = new Float32Array(w * w * 3);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          const at = (yy: number, xx: number) => prev.data[3 * (yy * prev.width + xx) + c]!;
          data[3 * (y * w + x) + c] = (at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1)) / 4;
        }
    levels.push({ width: w, height: w, data });
  }
  mips = levels;
  return mips;
}

/** The lawn's tile (made once, then shared). */
export function grassTexture(): GrassTexture {
  if (cached !== null) return cached;
  const N = GRASS_SIZE;
  const data = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) {
    const v = (j + 0.5) / N;
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N;
      // Clumps half a metre across, tufts of a few centimetres, and single blades (a texel or two),
      // the blades stretched a little along a slant, as mown grass lies.
      const clump = periodic(u, v, 8, 1);
      const tuft = periodic(u, v, 96, 2);
      const blade = periodic(u + 0.35 * v, v, 320, 3) * 0.6 + hash(i, j, 4) * 0.4;
      let c = mix(DARK, GREEN, Math.min(1, 0.25 + 0.55 * tuft + 0.45 * blade));
      c = mix(c, LIGHT, Math.max(0, blade - 0.62) * 1.6);
      // Straw: a few pale, dry blades where the clump is thin.
      const dry = Math.max(0, hash(i, j, 5) - 0.985) * 40 * (1 - clump);
      c = mix(c, STRAW, Math.min(0.7, dry));
      const shade = 0.92 + 0.12 * clump;
      // Mowing stripes, a metre wide along project x: the mower's two directions catch the light differently.
      const stripe = 1 + 0.035 * Math.sin(2 * Math.PI * u * GRASS_TILE * 0.5);
      const o = 3 * ((N - 1 - j) * N + i);
      data[o] = c[0] * shade * stripe;
      data[o + 1] = c[1] * shade * stripe;
      data[o + 2] = c[2] * shade * stripe;
    }
  }
  cached = { width: N, height: N, data };
  return cached;
}

/** The lawn's average colour (linear RGB): what it looks like far away, and what it bounces. */
export function lawnAlbedo(): Rgb {
  const t = grassTexture();
  const sum: Rgb = [0, 0, 0];
  for (let i = 0; i < t.width * t.height; i++) for (let c = 0; c < 3; c++) sum[c] = sum[c]! + t.data[3 * i + c]!;
  const n = t.width * t.height;
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

/**
 * The lawn's variation across the site at a point (metres, project frame): about ±12% over patches
 * nine and thirty metres across, so the tile's repeat does not read from above.
 */
export function lawnMacro(x: number, y: number): number {
  return 0.86 + 0.08 * noise(x / 1.7, y / 1.7, 6) + 0.12 * noise(x / 9, y / 9, 7) + 0.1 * noise(x / 31, y / 31, 8);
}

/**
 * The lawn's colour at a point (metres, project frame), bilinear across the tile, into `out`. A view
 * that sees the point from far off gives the `footprint` its pixel covers there, metres: the lookup
 * then reads the halving whose texels are about that size, so the lawn does not sparkle and moiré.
 */
export function lawnAt(x: number, y: number, out: Rgb | Float64Array, footprint = 0): void {
  const levels = grassMips();
  const level = footprint <= 0 ? 0 : Math.max(0, Math.min(levels.length - 1, Math.round(Math.log2(footprint / (GRASS_TILE / GRASS_SIZE)))));
  const t = levels[level]!;
  const N = t.width;
  const fx = (x / GRASS_TILE) * N - 0.5;
  const fy = (1 - y / GRASS_TILE) * N - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const xa = ((x0 % N) + N) % N;
  const xb = (xa + 1) % N;
  const ya = ((y0 % N) + N) % N;
  const yb = (ya + 1) % N;
  const m = lawnMacro(x, y);
  const d = t.data;
  for (let c = 0; c < 3; c++) {
    const top = d[3 * (ya * N + xa) + c]! * (1 - ax) + d[3 * (ya * N + xb) + c]! * ax;
    const bottom = d[3 * (yb * N + xa) + c]! * (1 - ax) + d[3 * (yb * N + xb) + c]! * ax;
    out[c] = (top * (1 - ay) + bottom * ay) * m;
  }
}

/**
 * Something drawn on the ground in place of the lawn (FLR-T-13.5's hook): a polygon in metres in
 * the project's frame (x east, y north), and its colour (linear RGB). The lawn is drawn where no
 * area covers it.
 */
export interface GroundArea {
  readonly polygon: readonly (readonly [number, number])[];
  readonly rgb: Rgb;
}

/** Whether a point is inside a polygon (even–odd). */
export function insidePolygon(x: number, y: number, polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The ground's colour at a point: the last area that covers it, else the lawn (seen with a pixel `footprint` metres across). */
export function groundAt(x: number, y: number, areas: readonly GroundArea[], out: Rgb | Float64Array, footprint = 0): void {
  for (let i = areas.length - 1; i >= 0; i--) {
    const a = areas[i]!;
    if (insidePolygon(x, y, a.polygon)) {
      out[0] = a.rgb[0];
      out[1] = a.rgb[1];
      out[2] = a.rgb[2];
      return;
    }
  }
  lawnAt(x, y, out, footprint);
}
