/**
 * The ground in 3D (FS_site 5.4, FLR-T-15.1): the site's surface as a grid, set to each graded outline's
 * elevation inside it and graded back to the surveyed ground at 1:4 outside it — the house's pad cut into
 * the slope uphill, a terrace filled below — with each vertex's change of grade (cut or fill, for a tint),
 * a skirt down to the lawn round its edge, and the contours of the ground as it ends up.
 *
 * Metres, Z up, about `origin` (base units), as the house's mesh is. View geometry only: nothing here is
 * normative, and a vertical exaggeration is the viewer's (scale the mesh's z), never the model's.
 */
import { gradeAt, type DrawSurface, type SiteDrawing } from '@floorspec/engine';
import { GRASS_TILE, lawnMacro } from './sky/grass.js';

const BU = 1_280_000; // base units a metre
const FT = 390_144;

/** The terrain's grid, ready for a BufferGeometry. */
export interface TerrainMesh {
  /** x, y, z per vertex, metres about the origin, Z up. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** The lawn's texture coordinates: a tile every `GRASS_TILE` metres, by world position. */
  readonly uvs: Float32Array;
  /** The lawn's colour variation (grey, as `lawnMacro`), per vertex. */
  readonly shade: Float32Array;
  /** Each vertex's change of grade, metres: below 0 cut, above 0 filled. */
  readonly change: Float32Array;
  readonly indices: Uint32Array;
  /** Contour lines on the finished ground: pairs of points, metres about the origin; and which pairs are majors. */
  readonly contours: Float32Array;
  readonly majors: Float32Array;
  /** The grid's vertices a row, and its rows: the first columns × rows vertices are the grid, row by row; the rest its skirt. */
  readonly columns: number;
  readonly rows: number;
  /** The lowest and highest ground, metres about the origin. */
  readonly low: number;
  readonly high: number;
}

export interface TerrainOptions {
  /** The house's mesh origin in base units: what the house's metres are measured from. */
  readonly origin: readonly [number, number, number];
  /** The grid's cell, base units (default 1′, coarser for a big site: at most 240 cells a side). */
  readonly cell?: number;
  /** How far the ground runs beyond the lot (base units, default 12′). */
  readonly margin?: number;
  /** The contour interval in the survey's datum, base units (default 1′; 0 for none), and every how many is a major. */
  readonly interval?: number;
  readonly majorEvery?: number;
  /** The slope a graded outline is graded back to the ground at: run per rise (default 4, 1:4). */
  readonly batter?: number;
}

type XY = readonly [number, number];

function inside(x: number, y: number, ring: readonly XY[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function distance(x: number, y: number, ring: readonly XY[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]!;
    const [bx, by] = ring[i]!;
    const vx = bx - ax;
    const vy = by - ay;
    const l = vx * vx + vy * vy;
    const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l));
    const d = Math.hypot(x - ax - t * vx, y - ay - t * vy);
    if (d < best) best = d;
  }
  return best;
}

/** The surveyed ground at a point, base units: the surface over its hull, the nearest survey point's beyond it. */
function natural(s: DrawSurface, x: number, y: number): number {
  const z = gradeAt(s, x, y);
  if (z !== undefined) return z;
  let best = Infinity;
  let h = s.points[0]![2];
  for (const p of s.points) {
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < best) {
      best = d;
      h = p[2];
    }
  }
  return h;
}

/** The site's ground as a grid, or null when the site has no surface. */
export function terrainMesh(site: SiteDrawing, options: TerrainOptions): TerrainMesh | null {
  const s = site.surface;
  if (!s) return null;
  const margin = options.margin ?? 12 * FT;
  const batter = options.batter ?? 4;
  const pts: XY[] = [...(site.lot ?? []), ...s.points.map((p) => [p[0], p[1]] as const)];
  let x0 = Math.min(...pts.map((p) => p[0])) - margin;
  let y0 = Math.min(...pts.map((p) => p[1])) - margin;
  const x1 = Math.max(...pts.map((p) => p[0])) + margin;
  const y1 = Math.max(...pts.map((p) => p[1])) + margin;
  const cell = Math.max(options.cell ?? FT, (x1 - x0) / 240, (y1 - y0) / 240);
  const nx = Math.ceil((x1 - x0) / cell);
  const ny = Math.ceil((y1 - y0) / cell);
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  const graded = site.graded.map((g) => ({ ...g, box: [Math.min(...g.ring.map((p) => p[0])), Math.min(...g.ring.map((p) => p[1])), Math.max(...g.ring.map((p) => p[0])), Math.max(...g.ring.map((p) => p[1]))] as const }));
  const [ox, oy, oz] = options.origin;
  const W = nx + 1;
  const H = ny + 1;
  const z = new Float64Array(W * H);
  const nat = new Float64Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const x = x0 + i * cell;
      const y = y0 + j * cell;
      const n = natural(s, x, y);
      let h = n;
      let held = false;
      // inside an outline: its elevation; beyond it, the nearest outline's grading back to the ground at 1:batter
      let reach = Infinity;
      for (const g of graded) {
        if (x >= g.box[0] && x <= g.box[2] && y >= g.box[1] && y <= g.box[3] && inside(x, y, g.ring)) {
          h = g.elevation;
          held = true;
          break;
        }
      }
      if (!held)
        for (const g of graded) {
          const dz = g.elevation - n;
          const run = Math.abs(dz) * batter;
          if (run <= 0) continue;
          if (x < g.box[0] - run || x > g.box[2] + run || y < g.box[1] - run || y > g.box[3] + run) continue;
          const d = distance(x, y, g.ring);
          if (d < run && d < reach) {
            reach = d;
            h = n + dz * (1 - d / run);
          }
        }
      z[j * W + i] = h;
      nat[j * W + i] = n;
    }
  // the grid, and a skirt down to the lowest ground round its edge
  let low = Infinity;
  let high = -Infinity;
  for (const h of z) {
    if (h < low) low = h;
    if (h > high) high = h;
  }
  const border: number[] = [];
  for (let i = 0; i < W; i++) border.push(i);
  for (let j = 1; j < H; j++) border.push(j * W + W - 1);
  for (let i = W - 2; i >= 0; i--) border.push((H - 1) * W + i);
  for (let j = H - 2; j > 0; j--) border.push(j * W);
  const nv = W * H + border.length;
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const uvs = new Float32Array(nv * 2);
  const shade = new Float32Array(nv);
  const change = new Float32Array(nv);
  const put = (k: number, x: number, y: number, h: number, dz: number) => {
    const wx = x / BU;
    const wy = y / BU;
    positions[k * 3] = (x - ox) / BU;
    positions[k * 3 + 1] = (y - oy) / BU;
    positions[k * 3 + 2] = (h - oz) / BU;
    uvs[k * 2] = wx / GRASS_TILE;
    uvs[k * 2 + 1] = wy / GRASS_TILE;
    shade[k] = lawnMacro(wx, wy);
    change[k] = dz / BU;
  };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) put(j * W + i, x0 + i * cell, y0 + j * cell, z[j * W + i]!, z[j * W + i]! - nat[j * W + i]!);
  border.forEach((v, k) => { put(W * H + k, x0 + (v % W) * cell, y0 + Math.floor(v / W) * cell, low - 0.05 * BU, 0); });
  // normals from the grid's slopes
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const at = (a: number, b: number) => z[Math.min(H - 1, Math.max(0, b)) * W + Math.min(W - 1, Math.max(0, a))]!;
      const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell);
      const dy = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
      const l = Math.hypot(dx, dy, 1);
      const k = j * W + i;
      normals[k * 3] = -dx / l;
      normals[k * 3 + 1] = -dy / l;
      normals[k * 3 + 2] = 1 / l;
    }
  for (let k = W * H; k < nv; k++) normals[k * 3 + 2] = 1;
  const index: number[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * W + i;
      index.push(a, a + 1, a + W + 1, a, a + W + 1, a + W);
    }
  for (let k = 0; k < border.length; k++) {
    const a = border[k]!;
    const b = border[(k + 1) % border.length]!;
    const c = W * H + k;
    const d = W * H + ((k + 1) % border.length);
    // the grid's border runs counter-clockwise: its outside faces outward
    index.push(a, c, b, b, c, d);
  }
  // contours of the finished ground, by marching the grid's triangles
  const lines: number[] = [];
  const majors: number[] = [];
  const interval = options.interval ?? FT;
  const every = options.majorEvery ?? 5;
  if (interval > 0) {
    const first = Math.ceil((low + site.benchmark) / interval);
    const last = Math.floor((high + site.benchmark) / interval);
    if (last - first < 400)
      for (let q = first; q <= last; q++) {
        const level = q * interval - site.benchmark;
        const out = every > 0 && q % every === 0 ? majors : lines;
        for (let t = 0; t < index.length && t < nx * ny * 6; t += 3) {
          const tri = [index[t]!, index[t + 1]!, index[t + 2]!];
          const cross: number[] = [];
          for (let e = 0; e < 3; e++) {
            const p = tri[e]!;
            const r = tri[(e + 1) % 3]!;
            const zp = z[p]!;
            const zr = z[r]!;
            if (zp >= level === zr >= level) continue;
            const f = (level - zp) / (zr - zp);
            for (let c = 0; c < 2; c++) cross.push(positions[p * 3 + c]! + f * (positions[r * 3 + c]! - positions[p * 3 + c]!));
            cross.push((level - oz) / BU + 0.02);
          }
          if (cross.length === 6) out.push(...cross);
        }
      }
  }
  return {
    positions,
    normals,
    uvs,
    shade,
    change,
    indices: new Uint32Array(index),
    contours: new Float32Array(lines),
    majors: new Float32Array(majors),
    columns: W,
    rows: H,
    low: (low - oz) / BU,
    high: (high - oz) / BU,
  };
}
