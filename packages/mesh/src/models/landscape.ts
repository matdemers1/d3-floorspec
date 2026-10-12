/**
 * FS_landscape's plants, beds, lawns and hardscape (FS_landscape 2.2–2.6, chapter 4; FLR-T-13.5).
 *
 * A plant fills its box (3.3) as its form and habit say: a tree's trunk to its clear height and a
 * canopy of overlapping lobes above it — a main mass and smaller lobes in a lighter and a darker
 * green around it, so it reads as a crown from above and at eye level alike — a shrub's mass from the
 * ground, a grass's fountain of blades with its plumes, a groundcover's low mounds. Every lobe is a
 * solid of revolution from the circle table (circle.ts): no trigonometry at run time, so Node and
 * the browser mesh the same bytes.
 *
 * A bed, a lawn and a hardscape line are drawn from their own geometry — an outline or a line in
 * the element's frame (3.4) — taken into the box's local units (x from its least x, y from its least
 * y), from the box's bottom to its top: a lawn's turf, a bed's cover inside its edging (a raised
 * bed's edging is its walls), a path swept along its line with round joins, stepping stones laid
 * along it, a wall with a coping.
 */
import { MM, type Json, type Model, type V2 } from './common.js';
import { COS, SIN } from './circle.js';
import type { Sketch } from './sketch.js';
import type { ModelRole } from '../roles.js';

const min = Math.min;
const max = Math.max;

/** The element's box, as written: [min, max]. */
function boxOf(el: Json): { lo: number[]; hi: number[] } {
  const box = (el['fallback'] as { box: { min: number[]; max: number[] } }).box;
  return { lo: box.min, hi: box.max };
}

/** Local points of the element's frame, in the sketch's units: measured from the box's least corner. */
function local(el: Json, points: readonly (readonly number[])[]): V2[] {
  const { lo } = boxOf(el);
  return points.map((p): V2 => [p[0]! - lo[0]!, p[1]! - lo[1]!]);
}

/** Where the plant stands in the sketch: its position, the frame's origin, kept inside the box. */
function stem(s: Sketch, el: Json): V2 {
  const { lo } = boxOf(el);
  return [min(max(-lo[0]!, 0), s.X), min(max(-lo[1]!, 0), s.Y)];
}

/** Ellipsoid profile angles, from the bottom pole to the top, every 30° (circle.ts indices): a shrub's or a grass's. */
const MERIDIAN = [18, 20, 22, 0, 2, 4, 6] as const;
/** Every 15°: a tree's lobes, large enough that their facets would show at 30°. */
const FINE = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6] as const;

/**
 * A lobe: an ellipsoid about the vertical through `c`, of radius `r` across and half-height `b`,
 * centred at height `z` — clipped to the box by the sketch's placer, which no lobe here reaches.
 */
function lobe(s: Sketch, name: string, role: ModelRole, c: V2, r: number, b: number, z: number, fine = false): void {
  if (r < 4 * MM || b < 4 * MM) return;
  s.lathe(name, role, 'z', c, (fine ? FINE : MERIDIAN).map((k): V2 => [k === 18 || k === 6 ? 0 : r * COS[k]!, z + b * SIN[k]!]));
}

/** A point `d` from `c` at table angle `k` (15° steps). */
const around = (c: V2, d: number, k: number): V2 => [c[0] + d * COS[k % 24]!, c[1] + d * SIN[k % 24]!];

/** A dome sitting on z0: the upper half of an ellipsoid. */
function dome(s: Sketch, name: string, role: ModelRole, c: V2, r: number, h: number, z0: number): void {
  if (r < 4 * MM || h < 4 * MM) return;
  s.lathe(name, role, 'z', c, [[0, z0], [r, z0], [r * COS[2]!, z0 + h * SIN[2]!], [r * COS[4]!, z0 + h * SIN[4]!], [0, z0 + h]]);
}

/** A cone tier: radius r at z0, its apex at z1. */
function cone(s: Sketch, name: string, role: ModelRole, c: V2, r: number, z0: number, z1: number): void {
  if (r < 4 * MM || z1 - z0 < 4 * MM) return;
  s.lathe(name, role, 'z', c, [[0, z0], [r, z0], [0, z1]]);
}

const evergreen = (el: Json): boolean => el['foliage'] === 'evergreen';

// ─── Plants ───────────────────────────────────────────────────────────────────────────────────

/** A tree: a tapering trunk to its clear height and into the crown, and a crown shaped by its habit. */
const tree: Model = (s, el) => {
  const c = stem(s, el);
  const H = s.Z;
  const R = min(c[0], s.X - c[0], c[1], s.Y - c[1]);
  const habit = typeof el['habit'] === 'string' ? el['habit'] : 'rounded';
  const given = typeof el['clearHeight'] === 'number' ? (el['clearHeight']) : H * 0.3;
  const clear = min(max(given, H * 0.08), H * 0.7);
  const hc = H - clear;
  const B = hc / 2;
  const main: ModelRole = evergreen(el) || habit === 'conical' ? 'foliageDark' : 'foliage';
  const rb = min(max(R * 0.07, 40 * MM), 260 * MM);
  s.lathe('trunk', 'trunk', 'z', c, [[0, 0], [rb * 1.25, 0], [rb, clear * 0.15], [rb * 0.65, clear + hc * 0.35], [0, clear + hc * 0.35]]);
  if (habit === 'conical') {
    // three tiers of needles, each narrower and higher, the last to the top
    cone(s, 'tier', main, c, R, clear, clear + hc * 0.55);
    cone(s, 'tier', 'foliage', c, R * 0.78, clear + hc * 0.25, clear + hc * 0.78);
    cone(s, 'tier', main, c, R * 0.55, clear + hc * 0.5, H);
    return;
  }
  if (habit === 'columnar') {
    // one tall mass, with a lit lobe and a shaded one set into it for texture
    lobe(s, 'crown', main, c, R * 0.92, hc * 0.49, clear + hc * 0.5, true);
    lobe(s, 'crown', 'foliageLight', around(c, R * 0.3, 4), R * 0.62, hc * 0.2, clear + hc * 0.62, true);
    lobe(s, 'crown', 'foliageDark', around(c, R * 0.3, 15), R * 0.62, hc * 0.2, clear + hc * 0.32, true);
    return;
  }
  if (habit === 'weeping') {
    // a dome whose skirt of branches hangs down past the clear height, almost to the ground
    const drop = clear * 0.45;
    s.lathe('crown', main, 'z', c, [[0, H], [R * 0.5, H - hc * 0.04], [R * 0.86, H - hc * 0.3], [R, clear + hc * 0.15], [R * 0.95, drop], [R * 0.78, drop], [R * 0.7, clear + hc * 0.2], [0, clear + hc * 0.35]]);
    lobe(s, 'crown', 'foliageLight', around(c, R * 0.2, 3), R * 0.5, hc * 0.22, H - hc * 0.24, true);
    return;
  }
  const spreading = habit === 'spreading';
  // the main mass, a little above the crown's middle
  lobe(s, 'crown', main, c, R * (spreading ? 0.66 : 0.76), B * (spreading ? 0.7 : 0.78), clear + B * (spreading ? 1.15 : 1.1), true);
  // lobes around it, alternately lit and shaded, at uneven angles so no two trees of a row look stamped
  const ring = spreading ? [0, 5, 10, 15, 20] : [1, 9, 17];
  const roles: ModelRole[] = ['foliageLight', 'foliageDark', 'foliage', 'foliageLight', 'foliageDark'];
  const d = R * (spreading ? 0.5 : 0.42);
  const r = R * (spreading ? 0.48 : 0.56);
  ring.forEach((k, i) => { lobe(s, 'lobe', roles[i]!, around(c, d, k), r, B * (spreading ? 0.5 : 0.56), clear + B * (spreading ? 0.75 : 0.85), true); });
  // a crown on top, catching the light
  lobe(s, 'lobe', 'foliageLight', around(c, R * 0.16, 6), R * 0.44, B * 0.42, clear + B * 1.5, true);
};

/** A shrub: a mass from the ground with two smaller mounds beside it; a clipped cone or column by habit. */
const shrub: Model = (s, el) => {
  const c = stem(s, el);
  const H = s.Z;
  const R = min(c[0], s.X - c[0], c[1], s.Y - c[1]);
  const habit = typeof el['habit'] === 'string' ? el['habit'] : 'rounded';
  const main: ModelRole = evergreen(el) ? 'foliageDark' : 'foliage';
  if (habit === 'conical') {
    cone(s, 'mass', main, c, R, 0, H);
    return;
  }
  if (habit === 'columnar') {
    lobe(s, 'mass', main, c, R * 0.95, H / 2, H / 2);
    return;
  }
  const flat = habit === 'spreading' ? 0.8 : 1;
  lobe(s, 'mass', main, c, R * 0.8, (H / 2) * flat, (H / 2) * flat);
  lobe(s, 'mound', 'foliageLight', around(c, R * 0.42, 3), R * 0.55, H * 0.4 * flat, H * 0.4 * flat);
  lobe(s, 'mound', main === 'foliage' ? 'foliageDark' : 'foliage', around(c, R * 0.42, 14), R * 0.52, H * 0.36 * flat, H * 0.36 * flat);
};

/** A level direction between table angles: `k` in half steps of 15°, so 48 about the circle. */
function heading(k: number): V2 {
  const i = Math.floor(k / 2) % 24;
  if (k % 2 === 0) return [COS[i]!, SIN[i]!];
  const x = COS[i]! + COS[(i + 1) % 24]!;
  const y = SIN[i]! + SIN[(i + 1) % 24]!;
  const n = Math.hypot(x, y);
  return [x / n, y / n];
}

/**
 * A blade rising from `base` out of the crown at `c` toward heading `u`, at height `z0`, reaching
 * `reach` further out at its tip: it climbs to `peak` at `at` of its run (past 1, still rising at
 * its tip) and arches over after it.
 */
function blade(c: V2, u: V2, z0: number, base: number, reach: number, peak: number, at: number, width: number): { points: [number, number, number][]; widths: number[] } {
  const S = [0, 0.3, 0.6, 0.85, 1];
  const points = S.map((s): [number, number, number] => {
    const d = base + reach * s;
    const q = s / at;
    return [c[0] + u[0] * d, c[1] + u[1] * d, max(z0 * 0.5, z0 + peak * (2 * q - q * q))];
  });
  // Narrower at its base than a little way up, as a leaf is: the base is a hole in the crown's top.
  return { points, widths: [width * 0.55, width, width * 0.75, width * 0.4, 0] };
}

/**
 * An ornamental grass (FLR-T-13.17): a clump of thin blades fanning out of a low crown — the young
 * ones upright and green in the middle, the older ones arching over and drooping toward the ground
 * at the edge, turning to straw — with feathery plumes on stalks above it. It reads as a clump of
 * grass from the street and from the room; drawn before as one lathed cup, it read as a cone.
 */
const grass: Model = (s, el) => {
  const c = stem(s, el);
  const H = s.Z;
  const R = min(c[0], s.X - c[0], c[1], s.Y - c[1]);
  const w = max(R * 0.045, 1 * MM);
  const zc = min(H * 0.04, 30 * MM);
  // Each ring of blades leaves the crown at a radius of its own, the blades of a ring evenly round
  // it with room between their bases: the crown's top is triangulated round them.
  const ring = (n: number, offset: number, base: number, reach: number, peak: number, at: number, width: number) =>
    Array.from({ length: n }, (_, i) => blade(c, heading(Math.round(((i + offset) * 48) / n) % 48), zc, base, reach, peak, at, width));
  const circle = (r: number): V2[] => Array.from({ length: 24 }, (_, k): V2 => [c[0] + r * COS[k]!, c[1] + r * SIN[k]!]);
  // the upright heart, green
  s.tuft('blades', 'grass', circle(R * 0.17), null, zc, [...ring(10, 0.2, R * 0.075, R * 0.26, H * 0.9, 1.25, w), ...ring(16, 0.6, R * 0.13, R * 0.52, H * 0.76, 0.95, w)]);
  // the arching skirt, its tips down toward the ground, sun-bleached
  s.tuft('skirt', 'meadow', circle(R * 0.27), circle(R * 0.18), zc, ring(24, 0.35, R * 0.225, R * 0.7, H * 0.48, 0.62, w * 1.1));
  // plumes: a stalk each, and a feathery head on it above the blades
  [1, 9, 17, 25, 33, 41].forEach((k, i) => {
    const u = heading(k);
    const d = R * (0.08 + 0.05 * (i % 3));
    const top = H * (0.98 - 0.05 * (i % 3));
    const z0 = H * 0.72;
    const r = max(R * 0.045, 8 * MM);
    const rs = max(R * 0.008, 2 * MM);
    s.lathe('plume', 'plume', 'z', [c[0] + u[0] * d, c[1] + u[1] * d], [[0, 0], [rs, 0], [rs, z0], [r * 0.6, z0 + (top - z0) * 0.2], [r, z0 + (top - z0) * 0.5], [r * 0.55, z0 + (top - z0) * 0.85], [0, top]]);
  });
};

/** A groundcover: low mounds over the ground. */
const groundcover: Model = (s, el) => {
  const c = stem(s, el);
  const H = s.Z;
  const R = min(c[0], s.X - c[0], c[1], s.Y - c[1]);
  dome(s, 'mat', 'foliageLight', c, R * 0.72, H, 0);
  dome(s, 'mat', 'foliage', around(c, R * 0.5, 5), R * 0.48, H * 0.8, 0);
  dome(s, 'mat', 'foliageLight', around(c, R * 0.5, 16), R * 0.46, H * 0.75, 0);
};

export const PLANTS: Readonly<Record<string, Model>> = { tree, shrub, grass, groundcover };

// ─── Beds and lawns ───────────────────────────────────────────────────────────────────────────

/** What a bed's cover is drawn with (2.4). */
const COVER: Readonly<Record<string, ModelRole>> = { mulch: 'mulch', bark: 'barkMulch', gravel: 'gravel', soil: 'soil' };
/** Each edging's material and width (a raised bed's walls are its edging). */
const EDGING: Readonly<Record<string, readonly [ModelRole, number]>> = {
  steel: ['corten', 8 * MM],
  stone: ['stone', 150 * MM],
  brick: ['brick', 110 * MM],
  timber: ['wood', 100 * MM],
  concrete: ['concrete', 120 * MM],
};

/** A raised bed's soil is this far below its walls' top; an edging at grade stands this proud of its cover. */
const RAISED_LIP = 50 * MM;
const LIP = 15 * MM;
/** A bed whose top stands this far above the ground is a raised bed, a planter. */
const RAISED = 150 * MM;

/** A bed: its cover over its outline — inside its edging, a little below the edging's top. */
export const bed: Model = (s, el) => {
  const outline = local(el, el['boundary'] as number[][]);
  const cover = COVER[typeof el['cover'] === 'string' ? el['cover'] : 'mulch'] ?? 'mulch';
  const edging = EDGING[typeof el['edging'] === 'string' ? el['edging'] : 'none'];
  if (edging === undefined) {
    s.region('cover', cover, [outline], 0, s.Z);
    return;
  }
  const [role, w0] = edging;
  const ground = -boxOf(el).lo[2]!;
  const lip = s.Z - ground > RAISED ? RAISED_LIP : LIP;
  const w = min(w0, s.X / 4, s.Y / 4);
  s.band('edging', role, outline, w, 0, s.Z);
  s.region('cover', cover, [outline], 0, max(s.Z - min(lip, s.Z / 2), 2), -w);
};

/** A lawn: its turf over its outline. */
export const lawn: Model = (s, el) => {
  s.region('turf', el['cover'] === 'meadow' ? 'meadow' : 'lawn', [local(el, el['boundary'] as number[][])], 0, s.Z);
};

// ─── Hardscape ────────────────────────────────────────────────────────────────────────────────

const MATERIAL: Readonly<Record<string, ModelRole>> = { stone: 'paver', gravel: 'gravel', concrete: 'concrete', brick: 'brick', timber: 'wood', steel: 'corten' };
const DEFAULT_MATERIAL: Readonly<Record<string, ModelRole>> = { path: 'paver', steppingStones: 'paver', curb: 'concrete', wall: 'concrete' };

/** A line's unit direction and length between two points (√ is exact in IEEE arithmetic, unlike trigonometry). */
function dir(a: V2, b: V2): { u: V2; n: V2; len: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  return { u: [dx / len, dy / len], n: [-dy / len, dx / len], len };
}

/** The strip a line sweeps at half-width h: a rectangle along each segment and a round join at each bend. */
function strip(line: readonly V2[], h: number): V2[][] {
  const polys: V2[][] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const { n, len } = dir(a, b);
    if (len < 1) continue;
    polys.push([
      [a[0] + n[0] * h, a[1] + n[1] * h],
      [a[0] - n[0] * h, a[1] - n[1] * h],
      [b[0] - n[0] * h, b[1] - n[1] * h],
      [b[0] + n[0] * h, b[1] + n[1] * h],
    ]);
  }
  for (let i = 1; i + 1 < line.length; i++) polys.push(Array.from({ length: 24 }, (_, k): V2 => around(line[i]!, h, k)));
  return polys;
}

/** Stones laid along a line: each `w` across and 0.6 w along it, a third of w apart, turned to its segment. */
function stones(s: Sketch, role: ModelRole, line: readonly V2[], w: number, z1: number): void {
  const along = w * 0.6;
  const gap = w * 0.38;
  let next = along / 2;
  let walked = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const { u, n, len } = dir(a, line[i + 1]!);
    for (; next <= walked + len; next += along + gap) {
      const t = next - walked;
      const m: V2 = [a[0] + u[0] * t, a[1] + u[1] * t];
      const h = w / 2;
      const l = along / 2;
      s.extrude('stone', role, 'z', [
        [m[0] - u[0] * l - n[0] * h, m[1] - u[1] * l - n[1] * h],
        [m[0] + u[0] * l - n[0] * h, m[1] + u[1] * l - n[1] * h],
        [m[0] + u[0] * l + n[0] * h, m[1] + u[1] * l + n[1] * h],
        [m[0] - u[0] * l + n[0] * h, m[1] - u[1] * l + n[1] * h],
      ], 0, z1);
    }
    walked += len;
  }
}

/** A path, stepping stones, a curb or a wall, swept along its line from its box's bottom to its top. */
export const hardscape: Model = (s, el) => {
  const form = typeof el['form'] === 'string' ? el['form'] : 'path';
  const line = local(el, el['points'] as number[][]);
  const w = typeof el['width'] === 'number' ? (el['width']) : 600 * MM;
  const role = MATERIAL[typeof el['material'] === 'string' ? el['material'] : ''] ?? DEFAULT_MATERIAL[form] ?? 'paver';
  if (form === 'steppingStones') {
    stones(s, role, line, w, s.Z);
    return;
  }
  const polys = strip(line, w / 2);
  if (form === 'wall') {
    // its body, and a coping of stone along its top
    const cap = min(40 * MM, s.Z / 8);
    s.region('wall', role, polys, 0, s.Z - cap);
    s.region('coping', role === 'concrete' ? 'stone' : 'concrete', polys, s.Z - cap, s.Z);
    return;
  }
  s.region(form, role, polys, 0, s.Z);
};
