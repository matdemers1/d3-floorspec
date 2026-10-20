/**
 * Daylight you can see (FLR-T-14.7): illuminance on every floor's work plane at a date and time,
 * sun-hours that day and over a year, and the desks and beds direct sun reaches — computed by the
 * path tracer's own pieces on the scene its stills draw (FLR-ADR on the method; docs/daylight.md).
 *
 * - **The scene** is the house's architecture alone — walls with their openings, floors, ceilings,
 *   slabs, roofs, stairs, doors and glazing — as `ptScene` gives the tracer it, with no furniture,
 *   fixtures or planting: furniture would cast its own shadows on the grid and put points inside
 *   cabinets, and the study is of the house's light, not of where the sofa is.
 * - **The grid** is every room's floor at one-foot pitch (`GRID_SPACING`), each point on the work
 *   plane (`WORK_PLANE`, 2′-6″) above the floor's top, facing up. Rooms whose function is `exterior`
 *   are left out.
 * - **Direct sun** at a point is one shadow ray toward the sun's centre: through glass by the pane's
 *   Fresnel transmission at its angle (brdf.ts `thinPane`, as every view draws glass), blocked by
 *   anything opaque — so a sun patch has the window's shape and a sharp edge. Its illuminance is the
 *   sun's (@floorspec/mesh `sunlight`, through the air mass) times the sine of its altitude.
 * - **Sky and bounced light** at a point are a path-traced irradiance gather: `DAYLIGHT_SAMPLES`
 *   cosine-weighted directions over the upper hemisphere, stratified 8 × 8, each followed through
 *   glass and up to four diffuse bounces off the room's surfaces (their colour's luminance as their
 *   reflectance), the sun sampled at each bounce, the sky's radiance (@floorspec/mesh's dome, the same
 *   cd/m² every view lights with) where a path escapes. E = π × the mean radiance. Each point's
 *   gather is smoothed with its neighbours in the same room (3 × 3), then the direct sun added.
 * - **Sun-hours** are shadow rays at moments: every ten minutes on the day (`DAY_STEP_MINUTES`),
 *   and on the half hour of every hour of the 21st of each month, each standing for its month's days
 *   (`YEAR_DAYS`). A room's sun-hours are the hours with sun somewhere on its work plane.
 * - **Glare** at a desk or a bed (analysis `glareZones`) is direct sun on any of nine points over
 *   its top or its pillow end, at the day's ten-minute moments.
 *
 * Deterministic: every point's paths draw from their own seeded stream (rng.ts), so a version, a time
 * and a sky always give the same study. Advisory, always (FLR-ADR-011).
 */
import { evaluate, OFFICIAL_READER, type ValidateOptions } from '@floorspec/engine';
import {
  bandShares,
  DAY_STEP_MINUTES,
  DAYLIGHT_ADVISORY,
  DAYLIGHT_SAMPLES,
  glareZones,
  GRID_SPACING,
  hourRanges,
  LOW_SUN,
  median,
  WORK_PLANE,
  YEAR_DAYS,
  type DaylightGrid,
  type DaylightRoom,
  type DaylightStudy,
  type GlareFlag,
} from '@floorspec/analysis';
import { GLASS_IOR, placeVector, skyIlluminance, skyRadiance, sunPlaceAt, type SkyField } from '@floorspec/mesh/sky';
import { buildSceneFrom, type Scene, type Vec3 } from '../export/gltf/scene.js';
import { paneAbsorption, thinPane } from './brdf.js';
import { Bvh, type Hit } from './bvh.js';
import { ptScene } from './index.js';
import { hash32, Rng } from './rng.js';
import { resolveSky } from './sky.js';
import type { PtScene } from './trace.js';

/** The seed every study is gathered with. */
export const DAYLIGHT_SEED = 0xda71_6417;
/** The skies a study is made under: a clear day, or an overcast one. */
export const DAYLIGHT_SKIES = ['clear', 'overcast'] as const;
export type DaylightSky = (typeof DAYLIGHT_SKIES)[number];

const EPS = 1e-4;
/** Diffuse bounces a gathered path takes after leaving the point. */
const BOUNCES = 4;
/** A surface's reflectance is its colour's luminance, kept within what real finishes reflect. */
const RHO_MIN = 0.03;
const RHO_MAX = 0.9;
/** Light let through glass below this is none: a shadow ray stops trying past eight panes. */
const MAX_PANES = 8;
const LUM = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export interface DaylightOptions {
  /** A date and time at the site (presets.ts `AT_PATTERN`): without an offset, the site's clock by its longitude. */
  readonly at: string;
  readonly sky?: DaylightSky;
  readonly design?: Record<string, string>;
  readonly reader?: Omit<ValidateOptions, 'design'>;
  /** Paths a point (tests). Default `DAYLIGHT_SAMPLES`. */
  readonly samples?: number;
  /** Grid pitch, metres (tests). Default `GRID_SPACING`. */
  readonly spacing?: number;
  /** Leave out the year's sun-hours (tests). */
  readonly year?: boolean;
  readonly signal?: AbortSignal;
}

/** What the gather is given: the architecture's triangles and the light, in the tracer's frame (+Y up, −Z north). */
export interface DaylightScene {
  readonly pt: PtScene;
  /** Sky radiance along a direction in the scene's frame, cd/m² (luminance). */
  readonly sky: (dx: number, dy: number, dz: number) => number;
}

/** The gather's pieces over one scene: direct sun at a point, and the irradiance gather. */
export class DaylightProbe {
  readonly bvh: Bvh;
  private readonly pt: PtScene;
  private readonly sky: DaylightScene['sky'];
  private readonly absorb: Float64Array[];
  private readonly rho: Float64Array;
  private readonly hit: Hit = { tri: -1, t: 0, u: 0, v: 0 };
  private readonly t = new Float64Array(3);
  private readonly r = new Float64Array(3);
  // A shadow ray's state, kept here so its test is made once.
  private through = 1;
  private crossed = 0;
  private sdx = 0;
  private sdy = 0;
  private sdz = 0;
  private readonly blocks: (tri: number) => boolean;

  constructor(scene: DaylightScene) {
    this.pt = scene.pt;
    this.sky = scene.sky;
    this.bvh = new Bvh({ positions: scene.pt.positions, count: scene.pt.count });
    this.absorb = scene.pt.materials.map((m) => {
      const a = new Float64Array(3);
      if (m.glass) paneAbsorption(m.rgb, m.ior ?? GLASS_IOR, a);
      return a;
    });
    this.rho = Float64Array.from(scene.pt.materials, (m) => Math.min(RHO_MAX, Math.max(RHO_MIN, LUM(m.rgb[0], m.rgb[1], m.rgb[2]))));
    const N = scene.pt.normals;
    this.blocks = (tri: number): boolean => {
      const mi = this.pt.material[tri]!;
      const m = this.pt.materials[mi]!;
      if (!m.glass) return true;
      if (++this.crossed > MAX_PANES) return true;
      this.through *= this.pane(mi, Math.abs(this.sdx * N[3 * tri]! + this.sdy * N[3 * tri + 1]! + this.sdz * N[3 * tri + 2]!));
      return this.through <= 1e-4;
    };
  }

  /** What a pane lets straight through at `cos`, luminance. */
  private pane(material: number, cos: number): number {
    thinPane(this.absorb[material]!, cos, this.pt.materials[material]!.ior ?? GLASS_IOR, this.t, this.r);
    return LUM(this.t[0]!, this.t[1]!, this.t[2]!);
  }

  /** How much of the light from direction `d` (unit, scene frame) reaches a point: 0 behind anything opaque, less through glass. */
  transmit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    this.through = 1;
    this.crossed = 0;
    this.sdx = dx;
    this.sdy = dy;
    this.sdz = dz;
    return this.bvh.occluded(ox, oy, oz, dx, dy, dz, EPS, Infinity, this.blocks) ? 0 : this.through;
  }

  /**
   * The irradiance (lux) on an upward-facing point from the sky and from what the room bounces — the
   * sun's own direct light excluded — by `n` cosine-weighted paths, stratified. `sun` is the
   * sun's direction (scene frame) and illuminance square to it, lux; null when it is down.
   */
  gather(ox: number, oy: number, oz: number, n: number, rng: Rng, sun: { readonly dir: Vec3; readonly lux: number } | null): number {
    const side = Math.max(1, Math.round(Math.sqrt(n)));
    const count = side * side;
    let sum = 0;
    for (let s = 0; s < count; s++) {
      // A cosine-weighted direction about +Y in stratum s.
      const u1 = ((s % side) + rng.next()) / side;
      const u2 = (Math.floor(s / side) + rng.next()) / side;
      const r = Math.sqrt(u1);
      const phi = 2 * Math.PI * u2;
      sum += this.path(ox, oy, oz, r * Math.cos(phi), Math.sqrt(Math.max(0, 1 - u1)), r * Math.sin(phi), rng, sun);
    }
    return (Math.PI * sum) / count;
  }

  /** The radiance (cd/m², luminance) arriving at a point from direction `d`, by one path. */
  private path(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, rng: Rng, sun: { readonly dir: Vec3; readonly lux: number } | null): number {
    const N = this.pt.normals;
    const mats = this.pt.materials;
    let throughput = 1;
    let radiance = 0;
    let bounces = 0;
    let panes = 0;
    for (;;) {
      if (!this.bvh.intersect(ox, oy, oz, dx, dy, dz, EPS, Infinity, this.hit)) return radiance + throughput * this.sky(dx, dy, dz);
      const tri = this.hit.tri;
      const mi = this.pt.material[tri]!;
      const px = ox + dx * this.hit.t;
      const py = oy + dy * this.hit.t;
      const pz = oz + dz * this.hit.t;
      let nx = N[3 * tri]!;
      let ny = N[3 * tri + 1]!;
      let nz = N[3 * tri + 2]!;
      const cos = nx * dx + ny * dy + nz * dz;
      if (mats[mi]!.glass) {
        // Through the pane, on along the same line, dimmed by what it lets through at this angle.
        if (++panes > MAX_PANES) return radiance;
        throughput *= this.pane(mi, Math.abs(cos));
        ox = px;
        oy = py;
        oz = pz;
        continue;
      }
      // Opaque: face the normal back toward where the path came from.
      if (cos > 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const rho = this.rho[mi]!;
      // The sun on this surface, seen from here (Lambertian: ρ/π × E).
      if (sun !== null) {
        const c = nx * sun.dir[0] + ny * sun.dir[1] + nz * sun.dir[2];
        if (c > 0) {
          const lx = px + nx * EPS;
          const ly = py + ny * EPS;
          const lz = pz + nz * EPS;
          const t = this.transmit(lx, ly, lz, sun.dir[0], sun.dir[1], sun.dir[2]);
          if (t > 0) radiance += (throughput * rho * sun.lux * c * t) / Math.PI;
        }
      }
      if (++bounces > BOUNCES) return radiance;
      throughput *= rho;
      // Russian roulette after the second bounce.
      if (bounces > 2) {
        const keep = Math.min(0.95, Math.max(0.05, throughput));
        if (rng.next() >= keep) return radiance;
        throughput /= keep;
      }
      // A cosine-weighted direction about the normal.
      const u1 = rng.next();
      const u2 = rng.next();
      const r = Math.sqrt(u1);
      const phi = 2 * Math.PI * u2;
      const a0 = r * Math.cos(phi);
      const a1 = r * Math.sin(phi);
      const a2 = Math.sqrt(Math.max(0, 1 - u1));
      // An orthonormal frame (t, b, n).
      const sgn = nz >= 0 ? 1 : -1;
      const ka = -1 / (sgn + nz);
      const kb = nx * ny * ka;
      const tx = 1 + sgn * nx * nx * ka, ty = sgn * kb, tz = -sgn * nx;
      const bx = kb, by = sgn + ny * ny * ka, bz = -ny;
      dx = a0 * tx + a1 * bx + a2 * nx;
      dy = a0 * ty + a1 * by + a2 * ny;
      dz = a0 * tz + a1 * bz + a2 * nz;
      ox = px + nx * EPS;
      oy = py + ny * EPS;
      oz = pz + nz * EPS;
    }
  }
}

/** The sky's radiance along a direction in the scene's frame, luminance, from @floorspec/mesh's field. */
export function fieldSky(field: SkyField): DaylightScene['sky'] {
  const look = new Float64Array(3);
  const out = new Float64Array(3);
  return (dx, dy, dz) => {
    // The scene's frame (+Y up, −Z project north) to the project's (x, y north, z up).
    look[0] = dx;
    look[1] = -dz;
    look[2] = dy;
    skyRadiance(field, look, out);
    return LUM(out[0]!, out[1]!, out[2]!);
  };
}

/** The house's architecture as the tracer reads it: no extension elements (furniture, fixtures, planting), no lamps, no ground plate. */
export function architecture(scene: Scene): PtScene {
  const bare: Scene = { ...scene, lights: [], levels: scene.levels.map((l) => ({ ...l, nodes: l.nodes.filter((n) => n.kind !== 'extension') })) };
  return ptScene(bare, { plate: false });
}

/** A point is inside a polygon (even–odd). */
function inside(x: number, y: number, poly: readonly (readonly [number, number])[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Toward the sun at an instant, in the scene's frame, and its altitude; null when it is down. */
function sunToward(ms: number, site: { latitude: number; longitude: number; trueNorth: number }): { dir: Vec3; altitude: number } | null {
  const place = sunPlaceAt(ms, site.latitude, site.longitude);
  if (place.altitude <= 0) return null;
  const d = placeVector(place, site.trueNorth);
  return { dir: [d[0], d[2], -d[1]], altitude: place.altitude };
}

interface Cell {
  readonly level: number;
  readonly index: number;
  readonly room: number;
  /** The point on the work plane, scene frame. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** Throw if the job has been cancelled. */
const check = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new Error('the daylight study was cancelled');
};

/**
 * A daylight study of a version at a date and time (FLR-T-14.7). Throws a RangeError for a bad
 * `at` or sky, and the scene's own error for a model that does not validate.
 */
export async function daylightStudy(document: object, options: DaylightOptions): Promise<DaylightStudy> {
  const started = Date.now();
  const skyName = options.sky ?? 'clear';
  if (!(DAYLIGHT_SKIES as readonly string[]).includes(skyName)) throw new RangeError('sky is clear or overcast');
  const samples = options.samples ?? DAYLIGHT_SAMPLES;
  const spacing = options.spacing ?? GRID_SPACING;
  const reader = options.reader ?? OFFICIAL_READER;
  const ev = evaluate(document, options.design === undefined ? reader : { ...reader, design: options.design });
  const scene = await buildSceneFrom(ev);
  const doc = (ev.view ?? ev.document) as unknown as { rooms?: Record<string, { function?: string; name?: string }> };
  const sky = resolveSky(document, { sky: skyName, at: options.at });
  const at = sky.at;
  if (at === null) throw new RangeError('at is a date and time at the site, such as 2026-06-21T15:00');
  const site = sky.site;
  const probe = new DaylightProbe({ pt: architecture(scene), sky: fieldSky(sky.field) });
  check(options.signal);

  // The sun now: its direction, and its illuminance square to it.
  const d = sky.light.direct;
  const sunNow = d !== null && d.kind === 'sun' && d.lux > 0 ? { dir: [d.dir[0], d.dir[2], -d.dir[1]] as Vec3, lux: d.lux } : null;
  const outside = skyIlluminance(sky.light, sky.field.maps);

  // The grid: every room's floor, level by level.
  const levelIds = scene.levels.map((l) => l.id);
  const rooms = scene.rooms.filter((r) => doc.rooms?.[r.id]?.function !== 'exterior' && levelIds.includes(r.level) && r.outer.length >= 3);
  const grids: { level: string; elevation: number; x0: number; y0: number; columns: number; rows: number }[] = [];
  const cells: Cell[] = [];
  for (const level of scene.levels) {
    const on = rooms.map((r, i) => ({ r, i })).filter(({ r }) => r.level === level.id);
    if (on.length === 0) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { r } of on)
      for (const [x, y] of r.outer) {
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    const x0 = Math.floor(minX / spacing) * spacing;
    const y0 = Math.floor(minY / spacing) * spacing;
    const columns = Math.max(1, Math.ceil((maxX - x0) / spacing));
    const rows = Math.max(1, Math.ceil((maxY - y0) / spacing));
    const g = grids.length;
    grids.push({ level: level.id, elevation: Math.max(...on.map(({ r }) => r.floor)), x0, y0, columns, rows });
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < columns; i++) {
        const x = x0 + (i + 0.5) * spacing;
        const y = y0 + (j + 0.5) * spacing;
        const hit = on.find(({ r }) => inside(x, y, r.outer));
        if (hit === undefined) continue;
        cells.push({ level: g, index: j * columns + i, room: hit.i, x, y: hit.r.floor + WORK_PLANE, z: -y });
      }
  }

  // Direct sun now, and the gather.
  const direct = new Float64Array(cells.length);
  const gathered = new Float64Array(cells.length);
  const rng = new Rng(DAYLIGHT_SEED);
  for (let c = 0; c < cells.length; c++) {
    const p = cells[c]!;
    if (sunNow !== null) direct[c] = sunNow.lux * sunNow.dir[1] * probe.transmit(p.x, p.y, p.z, sunNow.dir[0], sunNow.dir[1], sunNow.dir[2]);
    rng.reseed(DAYLIGHT_SEED, p.level, hash32(p.index));
    gathered[c] = probe.gather(p.x, p.y, p.z, samples, rng, sunNow);
    if ((c & 255) === 255) {
      check(options.signal);
      // Let the drain's heartbeat and cancellation through.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  // Smooth each gather with its neighbours in the same room.
  const at2 = new Map<string, number>();
  cells.forEach((p, c) => at2.set(`${String(p.level)}:${String(p.index)}`, c));
  const lux = new Float64Array(cells.length);
  for (let c = 0; c < cells.length; c++) {
    const p = cells[c]!;
    const cols = grids[p.level]!.columns;
    const ci = p.index % cols;
    const cj = Math.floor(p.index / cols);
    let s = 0;
    let n = 0;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || i >= cols || j < 0) continue;
        const q = at2.get(`${String(p.level)}:${String(j * cols + i)}`);
        if (q === undefined || cells[q]!.room !== p.room) continue;
        s += gathered[q]!;
        n += 1;
      }
    lux[c] = s / n + direct[c]!;
  }

  // The day's moments: every ten minutes, each standing for the ten minutes from it.
  const today: { minute: number; ms: number; sun: { dir: Vec3; altitude: number } }[] = [];
  for (let m = 0; m < 1440; m += DAY_STEP_MINUTES) {
    const ms = at.midnight + (m + DAY_STEP_MINUTES / 2) * 60_000;
    const s = sunToward(ms, site);
    if (s !== null) today.push({ minute: m, ms, sun: s });
  }
  const sunToday = new Float64Array(cells.length);
  const roomToday = rooms.map(() => new Set<number>());
  for (const moment of today) {
    const [sx, sy, sz] = moment.sun.dir;
    for (let c = 0; c < cells.length; c++) {
      const p = cells[c]!;
      if (probe.transmit(p.x, p.y, p.z, sx, sy, sz) > 0.02) {
        sunToday[c]! += DAY_STEP_MINUTES / 60;
        roomToday[p.room]!.add(moment.minute);
      }
    }
    check(options.signal);
  }

  // The year: the half hour of every hour of the 21st of each month, standing for its month's days.
  const sunYear = new Float64Array(cells.length);
  const roomYear = new Float64Array(rooms.length);
  if (options.year !== false) {
    const year = Number(options.at.slice(0, 4));
    for (const day of YEAR_DAYS) {
      const midnight = Date.UTC(year, day.month - 1, day.day) - at.offset * 60_000;
      for (let h = 0; h < 24; h++) {
        const s = sunToward(midnight + (h * 60 + 30) * 60_000, site);
        if (s === null) continue;
        const lit = new Uint8Array(rooms.length);
        for (let c = 0; c < cells.length; c++) {
          const p = cells[c]!;
          if (probe.transmit(p.x, p.y, p.z, s.dir[0], s.dir[1], s.dir[2]) > 0.02) {
            sunYear[c]! += day.days;
            lit[p.room] = 1;
          }
        }
        for (let r = 0; r < rooms.length; r++) if (lit[r] === 1) roomYear[r]! += day.days;
      }
      check(options.signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // Glare: direct sun on nine points over a desk's top or a bed's pillow end, at the day's moments.
  const obstacles = new Map(scene.obstacles.map((o) => [o.id, o]));
  const glare: GlareFlag[] = [];
  const nowMinute = Math.round((at.ms - at.midnight) / 60_000);
  // Under an overcast sky there is no direct sun: no glare. (Sun-hours are the sun's path, sky or not.)
  for (const zone of skyName === 'overcast' ? [] : glareZones(ev.view ?? ev.document)) {
    const o = obstacles.get(zone.id);
    if (o === undefined) continue;
    const z = o.bottom + zone.height;
    const [a, b, c2, d2] = zone.corners as [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]];
    const points: [number, number][] = [];
    for (const u of [1 / 6, 1 / 2, 5 / 6])
      for (const v of [1 / 6, 1 / 2, 5 / 6]) {
        const x = (1 - u) * (1 - v) * a[0] + u * (1 - v) * b[0] + u * v * c2[0] + (1 - u) * v * d2[0];
        const y = (1 - u) * (1 - v) * a[1] + u * (1 - v) * b[1] + u * v * c2[1] + (1 - u) * v * d2[1];
        points.push([x, y]);
      }
    const lit: number[] = [];
    let altitude = 0;
    for (const moment of today) {
      const [sx, sy, sz] = moment.sun.dir;
      if (points.some(([x, y]) => probe.transmit(x, z + 0.005, -y, sx, sy, sz) > 0.02)) {
        lit.push(moment.minute);
        altitude += moment.sun.altitude;
      }
    }
    if (lit.length === 0) continue;
    const hours = hourRanges(lit);
    const roomName = zone.room === undefined ? undefined : doc.rooms?.[zone.room]?.name;
    glare.push({
      id: zone.id,
      name: zone.name,
      kind: zone.kind,
      ...(zone.room === undefined ? {} : { room: zone.room }),
      ...(roomName === undefined ? {} : { roomName }),
      level: o.level,
      at: [(a[0] + b[0] + c2[0] + d2[0]) / 4, (a[1] + b[1] + c2[1] + d2[1]) / 4],
      z,
      hours,
      now: hours.some((r) => nowMinute >= r.from && nowMinute < r.to),
      low: altitude / lit.length < LOW_SUN,
    });
  }

  // The grids and each room's summary.
  const levels: DaylightGrid[] = grids.map((g) => {
    const size = g.columns * g.rows;
    return { level: g.level, origin: [round3(g.x0), round3(g.y0)], spacing, columns: g.columns, rows: g.rows, elevation: round3(g.elevation), lux: new Array<number>(size).fill(-1), sunToday: new Array<number>(size).fill(-1), sunYear: new Array<number>(size).fill(-1) };
  });
  const byRoom = rooms.map(() => [] as number[]);
  cells.forEach((p, c) => {
    const g = levels[p.level]!;
    (g.lux as number[])[p.index] = Math.round(lux[c]!);
    (g.sunToday as number[])[p.index] = Math.round(sunToday[c]! * 10) / 10;
    (g.sunYear as number[])[p.index] = Math.round(sunYear[c]!);
    byRoom[p.room]!.push(lux[c]!);
  });
  const summaries: DaylightRoom[] = [];
  rooms.forEach((r, i) => {
    const values = byRoom[i]!;
    if (values.length === 0) return;
    const name = doc.rooms?.[r.id]?.name ?? r.name;
    summaries.push({
      id: r.id,
      ...(name === undefined ? {} : { name }),
      level: r.level,
      cells: values.length,
      median: Math.round(median(values)),
      mean: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
      shares: roundShares(bandShares(values)),
      sunToday: Math.round((roomToday[i]!.size * DAY_STEP_MINUTES) / 6) / 10,
      sunYear: Math.round(roomYear[i]!),
    });
  });
  const local = new Date(at.midnight + at.offset * 60_000);
  const date = `${String(local.getUTCFullYear()).padStart(4, '0')}-${two(local.getUTCMonth() + 1)}-${two(local.getUTCDate())}`;
  return {
    at: `${date}T${two(Math.floor(nowMinute / 60))}:${two(nowMinute % 60)}`,
    offset: at.offset,
    sky: skyName,
    sun: sky.sun === null || sky.sun.altitude <= 0 ? null : { azimuth: round1(sky.sun.azimuth), altitude: round1(sky.sun.altitude) },
    site: { latitude: site.latitude, longitude: site.longitude, assumed: site.assumed },
    outside: { sky: Math.round(outside.sky), sun: Math.round(outside.direct) },
    workPlane: WORK_PLANE,
    spacing,
    samples: Math.max(1, Math.round(Math.sqrt(samples))) ** 2,
    levels,
    rooms: summaries,
    glare,
    advisory: DAYLIGHT_ADVISORY,
    ms: Date.now() - started,
  };
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const roundShares = (s: Record<'bright' | 'useful' | 'lamp' | 'dim', number>): Record<'bright' | 'useful' | 'lamp' | 'dim', number> => ({ bright: round3(s.bright), useful: round3(s.useful), lamp: round3(s.lamp), dim: round3(s.dim) });
