/**
 * FS_outdoor's outdoor rooms (FS_outdoor chapter 4; FLR-T-15.2): pools and spas, fences and garden
 * walls with their gates, shelters — pergolas, covered porches, shade sails — outdoor kitchens and
 * fire features, each drawn from its parameters inside its box (sketch units from the box's least
 * corner: x from its back to its front, y from its right to its left, z from its bottom to its top).
 *
 * What the extension derives, these draw from the same functions (@floorspec/engine `outdoor`): a
 * shelter's posts stand where `shelterPosts` puts them — so a pergola stretched longer gets more posts,
 * spaced again, each still its `postSize` square, never a wider one — a fence's posts where
 * `fencePosts` does, its gates along the line where `gateIntervals` says, a pool's water where
 * `poolWater` puts the water line. A fence on falling ground is drawn racked on the box's flat bottom:
 * this reader has no terrain under it (`onSlope` is not drawn).
 */
import { outdoor } from '@floorspec/engine';
import { MM, max, min, type Json, type Model, type V2 } from './common.js';
import { COS, SIN } from './circle.js';
import { rounded, type Sketch } from './sketch.js';
import type { ModelRole } from '../roles.js';

type Box = { min: number[]; max: number[] };
const boxOf = (el: Json): Box => (el['fallback'] as { box: Box }).box;
const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);

/** The ground in the sketch: the frame's origin (FS_outdoor 3.1), kept inside the box. */
const groundOf = (s: Sketch, el: Json): number => min(max(-boxOf(el).min[2]!, 0), s.Z);

/** What a fence, a wall, a shelter's frame or a kitchen's counter is drawn in, by its `material`. */
const FRAME: Readonly<Record<string, ModelRole>> = { timber: 'cedar', steel: 'darkMetal', aluminium: 'frame', vinyl: 'millwork', metal: 'darkMetal', stone: 'paver', brick: 'brick', concrete: 'concrete', glass: 'glass' };
const COPING: Readonly<Record<string, ModelRole>> = { stone: 'coping', concrete: 'concrete', brick: 'brick', tile: 'coping', timber: 'cedar' };
const COUNTER: Readonly<Record<string, ModelRole>> = { stone: 'stone', concrete: 'concrete', tile: 'ceramic', steel: 'stainless', timber: 'cedar' };

// ─── Pools ─────────────────────────────────────────────────────────────────────────────────

/**
 * A pool, a plunge pool, a spa: its coping, a frame `coping` wide round the basin at its top; the
 * basin's walls and floor in its interior's finish; and the water, a clear volume filling the basin to
 * the water line. A spa raised above the ground (its top above the frame's origin) has its walls above
 * the ground faced in its coping's material.
 */
export const pool: Model = (s, el) => {
  const { X, Y, Z } = s;
  const c = min(num(el['coping'], outdoor.DEFAULTS.coping), X / 2 - 2, Y / 2 - 2);
  const waterLine = min(num(el['waterLine'], outdoor.DEFAULTS.waterLine), Z - 4);
  const copingRole = COPING[str(el['copingMaterial'], 'stone')] ?? 'coping';
  const outer: V2[] = [[0, 0], [X, 0], [X, Y], [0, Y]];
  const basin: V2[] = [[c, c], [X - c, c], [X - c, Y - c], [c, Y - c]];
  const ct = min(50 * MM, Z / 10);
  const floor = min(100 * MM, Z / 8);
  const ground = groundOf(s, el);
  // the basin's walls, under the coping: in its finish below the ground, faced above it
  const wallTop = Z - ct;
  const below = min(ground, wallTop);
  if (below > 2) s.extrude('wall', 'poolInterior', 'z', outer, 0, below, [basin]);
  if (wallTop - below > 2) s.extrude('wall', copingRole, 'z', outer, below, wallTop, [basin]);
  s.box('floor', 'poolInterior', c, c, 0, X - c, Y - c, floor);
  s.extrude('coping', copingRole, 'z', outer, wallTop, Z, [basin]);
  // the water, a hair inside the basin's faces so it never shares one with them
  const inset = 2 * MM;
  s.box('water', 'water', c + inset, c + inset, floor + inset, X - c - inset, Y - c - inset, Z - waterLine);
};

// ─── Fences ────────────────────────────────────────────────────────────────────────────────

/** A segment's unit direction and normal, and its length. */
function dir(a: V2, b: V2): { u: V2; n: V2; len: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  return len === 0 ? { u: [1, 0], n: [0, 1], len } : { u: [dx / len, dy / len], n: [-dy / len, dx / len], len };
}

/** A box along a segment: from t0 to t1 along it, `half` either side of it, from z0 to z1. */
function along(s: Sketch, name: string, role: ModelRole, a: V2, u: V2, n: V2, t0: number, t1: number, half: number, z0: number, z1: number): void {
  if (t1 - t0 < 2 || half * 2 < 2) return;
  const p = (t: number, h: number): V2 => [a[0] + u[0] * t + n[0] * h, a[1] + u[1] * t + n[1] * h];
  s.extrude(name, role, 'z', [p(t0, -half), p(t1, -half), p(t1, half), p(t0, half)], z0, z1);
}

/** The infill between two posts, from t0 to t1 along a segment, as its style fills it. */
function infill(s: Sketch, style: string, role: ModelRole, a: V2, u: V2, n: V2, t0: number, t1: number, w: number, Z: number): void {
  const half = w / 2;
  const foot = min(50 * MM, Z / 20);
  const rail = min(90 * MM, Z / 12);
  if (style === 'rail') {
    for (const k of [0.25, 0.55, 0.85]) along(s, 'rail', role, a, u, n, t0, t1, half * 0.6, Z * k - rail / 2, Z * k + rail / 2);
    return;
  }
  if (style === 'picket') {
    along(s, 'rail', role, a, u, n, t0, t1, half * 0.4, Z * 0.2, Z * 0.2 + rail * 0.8);
    along(s, 'rail', role, a, u, n, t0, t1, half * 0.4, Z * 0.7, Z * 0.7 + rail * 0.8);
    const pw = min(80 * MM, (t1 - t0) / 3);
    const pitch = pw * 2;
    const count = max(1, Math.floor((t1 - t0) / pitch));
    const gap = (t1 - t0 - count * pw) / (count + 1);
    for (let i = 0; i < count; i++) {
      const p0 = t0 + gap + i * (pw + gap);
      along(s, 'picket', role, a, u, n, p0, p0 + pw, half * 0.9, foot, Z - (i % 2 === 0 ? 0 : 20 * MM));
    }
    return;
  }
  if (style === 'mesh') {
    along(s, 'rail', role, a, u, n, t0, t1, half * 0.5, Z - rail, Z);
    along(s, 'panel', 'darkMetal', a, u, n, t0, t1, min(half * 0.2, 3 * MM), foot, Z - rail);
    return;
  }
  // privacy, panel, solid: boards edge to edge, a rail under a cap at the top
  along(s, 'boards', role, a, u, n, t0, t1, half * 0.6, foot, Z - rail);
  along(s, 'cap', role, a, u, n, t0, t1, half, Z - rail, Z);
}

/**
 * A fence or a garden wall along its line: posts (a wall's piers) where `fencePosts` puts them, the
 * infill between them as its style says, and each gate an opening along the line with its leaf — or
 * two — drawn closed in it.
 */
export const fence: Model = (s, el) => {
  const lo = boxOf(el).min;
  const local = (p: readonly number[]): V2 => [p[0]! - lo[0]!, p[1]! - lo[1]!];
  const points = (el['points'] as [number, number][]).map((p): [number, number] => [p[0], p[1]]);
  const line = points.map(local);
  const w = num(el['width'], 100 * MM);
  const wall = el['form'] === 'wall';
  const role = FRAME[str(el['material'], wall ? 'brick' : 'timber')] ?? (wall ? 'brick' : 'cedar');
  const style = str(el['style'], wall ? 'solid' : 'privacy');
  const Z = s.Z;
  const post = wall ? w * 1.4 : max(w, 90 * MM);
  const gates = outdoor.gateIntervals(el['gates'] as outdoor.Gate[] | undefined);
  const gateGap = 15 * MM;
  // the infill, segment by segment, less the gates and the posts
  const lengths = outdoor.segmentLengths(points);
  let walked = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const { u, n, len } = dir(a, line[i + 1]!);
    const L = lengths[i]!;
    if (len < 1) continue;
    const scale = len / L;
    // the open intervals of this segment, in its own length: everything but the gates
    let parts: [number, number][] = [[0, len]];
    for (const [g0, g1] of gates) {
      const t0 = (g0 - walked) * scale;
      const t1 = (g1 - walked) * scale;
      if (t1 <= 0 || t0 >= len) continue;
      parts = parts.flatMap(([p0, p1]): [number, number][] => [
        ...(min(p1, t0) > p0 ? [[p0, min(p1, t0)] as [number, number]] : []),
        ...(max(p0, t1) < p1 ? [[max(p0, t1), p1] as [number, number]] : []),
      ]);
    }
    for (const [p0, p1] of parts) {
      if (wall) {
        const cap = min(50 * MM, Z / 8);
        along(s, 'wall', role, a, u, n, p0, p1, w / 2, 0, Z - cap);
        along(s, 'cap', role === 'concrete' ? 'paver' : 'concrete', a, u, n, p0, p1, w / 2 + min(20 * MM, w / 4), Z - cap, Z);
      } else infill(s, style, role, a, u, n, p0, p1, w, Z);
    }
    walked += L;
  }
  // the posts, square to the segment they stand on: where fencePosts puts them (its count), less any
  // that would stand in a gate's opening, and a post either side of each gate to hang it from
  const spacing = num(el['postSpacing'], outdoor.DEFAULTS.fencePostSpacing);
  const closed = points[0]![0] === points[points.length - 1]![0] && points[0]![1] === points[points.length - 1]![1];
  const stations: { seg: number; d: number }[] = [{ seg: 0, d: 0 }];
  let run = 0;
  lengths.forEach((L, i) => {
    const count = max(1, Math.ceil(L / spacing));
    for (let k = 1; k <= count; k++) stations.push({ seg: i, d: run + (L * k) / count });
    run += L;
  });
  if (closed) stations.pop();
  const inGate = (d: number): boolean => gates.some(([g0, g1]) => d > g0 - post && d < g1 + post);
  const hung = gates.flatMap(([g0, g1]) => [g0 - post / 2, g1 + post / 2]).filter((d) => d >= 0 && d <= run);
  const at = (d: number): { seg: number; t: number } => {
    let rest = d;
    for (let i = 0; i < lengths.length; i++) {
      if (rest <= lengths[i]! || i === lengths.length - 1) return { seg: i, t: rest };
      rest -= lengths[i]!;
    }
    return { seg: 0, t: 0 };
  };
  for (const d of [...stations.filter((p) => !inGate(p.d)).map((p) => p.d), ...hung]) {
    const { seg, t } = at(d);
    const a = line[seg]!;
    const { u, n, len } = dir(a, line[seg + 1]!);
    const tt = (t * len) / (lengths[seg] || 1);
    along(s, wall ? 'pier' : 'post', role, a, u, n, tt - post / 2, tt + post / 2, max(post, w) / 2, 0, Z);
  }
  // the gates: a leaf, or two, closed in each opening
  for (const [g0, g1] of gates) {
    const leaves = (el['gates'] as outdoor.Gate[]).find((g) => g.offset === g0)?.leaves ?? 1;
    const start = outdoor.alongLine(points, g0);
    const end = outdoor.alongLine(points, g1);
    if (start.segment !== end.segment) continue; // a gate round a corner is drawn as its opening alone
    const a = local(start.at);
    const { u, n } = dir(a, local(end.at));
    const span = g1 - g0;
    const leafW = (span - gateGap * (leaves + 1)) / leaves;
    for (let k = 0; k < leaves; k++) {
      const t0 = gateGap + k * (leafW + gateGap);
      along(s, 'gate', wall ? 'cedar' : role, a, u, n, t0, t0 + leafW, w * 0.3, 60 * MM, Z - (wall ? Z * 0.15 : 40 * MM));
    }
  }
};

// ─── Shelters ──────────────────────────────────────────────────────────────────────────────

/**
 * A pergola, a covered porch, a shade sail: posts where `shelterPosts` puts them; for a pergola and a
 * porch, beams along x on the posts at y's least and greatest, rafters across them at its rafter
 * spacing, and its top — slats across the rafters, or a roof; a ledger on the wall along an attached
 * shelter's back; for a sail, a taut fabric between its posts' tops.
 */
export const shelter: Model = (s, el) => {
  const { X, Y, Z } = s;
  const top = str(el['top'], 'slats');
  const role = FRAME[str(el['material'], 'timber')] ?? 'cedar';
  const size = num(el['postSize'], outdoor.DEFAULTS.postSize);
  const h = size / 2;
  const attached = el['attached'] === true;
  const box = boxOf(el);
  const posts = outdoor.shelterPosts({ fallback: { box }, postSize: size, postSpacing: num(el['postSpacing'], outdoor.DEFAULTS.postSpacing), attached });
  if (top === 'sail') {
    for (const [x, y] of posts) s.box('post', role === 'cedar' ? 'darkMetal' : role, x - h, y - h, 0, x + h, y + h, Z);
    const t = min(8 * MM, Z / 50);
    const inset = size;
    s.extrude('sail', 'sail', 'z', [[inset, inset], [X - inset, inset * 2], [X - inset, Y - inset], [inset * 2, Y - inset]], Z - t, Z);
    return;
  }
  const slat = top === 'slats' ? min(32 * MM, Z / 40) : 0;
  const roof = top === 'solid' ? min(120 * MM, Z / 12) : 0;
  const rafterD = min(185 * MM, Z / 14);
  const beamD = min(235 * MM, Z / 10);
  const rafterTop = Z - slat - roof;
  const rafterBottom = rafterTop - rafterD;
  const beamTop = rafterBottom;
  const given = el['clearHeight'];
  const beamBottom = typeof given === 'number' ? min(max(given, 0), beamTop - 4) : beamTop - beamD;
  const bw = min(size * 0.75, 90 * MM);
  for (const [x, y] of posts) s.box('post', role, x - h, y - h, 0, x + h, y + h, beamBottom);
  // the beams, along x over the posts on each side, flush with the box's ends
  for (const y of [h, Y - h]) s.box('beam', role, 0, y - bw / 2, beamBottom, X, y + bw / 2, beamTop);
  if (attached) s.box('ledger', role, 0, 0, beamBottom, min(50 * MM, X / 10), Y, beamTop);
  // the rafters, across the beams along y, evenly at no more than the rafter spacing
  const rw = min(45 * MM, X / 20);
  const spacing = num(el['rafterSpacing'], outdoor.DEFAULTS.rafterSpacing);
  const nr = max(2, Math.ceil((X - rw) / spacing) + 1);
  for (let i = 0; i < nr; i++) {
    const x = rw / 2 + ((X - rw) * i) / (nr - 1);
    s.box('rafter', role, x - rw / 2, 0, rafterBottom, x + rw / 2, Y, rafterTop);
  }
  if (top === 'solid') {
    s.box('roof', 'roofing', 0, 0, Z - roof, X, Y, Z);
    return;
  }
  // slats along x across the rafters, about 150 mm apart
  const sw = min(38 * MM, Y / 20);
  const ns = max(2, Math.ceil((Y - sw) / (150 * MM)) + 1);
  for (let j = 0; j < ns; j++) {
    const y = sw / 2 + ((Y - sw) * j) / (ns - 1);
    s.box('slat', role, 0, y - sw / 2, Z - slat, X, y + sw / 2, Z);
  }
};

// ─── Kitchens ──────────────────────────────────────────────────────────────────────────────

/** How wide each appliance is along the run, in millimetres. */
const WIDE: Readonly<Record<string, number>> = { grill: 810, sideBurner: 330, sink: 600, refrigerator: 610, iceMaker: 380, pizzaOven: 810, smoker: 610, warmingDrawer: 760 };

/**
 * An outdoor kitchen: a masonry base, a counter top across it, and its appliances along its run from
 * its right end in their order — a grill's grate set into the top over its stainless front, a side
 * burner's, a sink's bowl cut into the top, a refrigerator's, an ice maker's, a warming drawer's or a
 * smoker's stainless door, a pizza oven's brick mouth — spaced evenly, scaled down to fit a short run.
 */
export const kitchen: Model = (s, el) => {
  const { X, Y, Z } = s;
  const counterRole = COUNTER[str(el['counter'], 'stone')] ?? 'stone';
  const baseRole: ModelRole = counterRole === 'concrete' ? 'paver' : 'concrete';
  const ct = min(40 * MM, Z / 12);
  const over = min(30 * MM, X / 12);
  const proud = min(15 * MM, X / 30);
  const front = X - over;
  const apps = (Array.isArray(el['appliances']) ? (el['appliances'] as unknown[]) : []).filter((a): a is string => typeof a === 'string');
  const want = apps.map((a) => (WIDE[a] ?? 600) * MM);
  const total = want.reduce((a, b) => a + b, 0);
  const k = total > Y * 0.92 ? (Y * 0.92) / total : 1;
  const gap = (Y - total * k) / (apps.length + 1);
  let y = gap;
  const sinks: V2[][] = [];
  const fronts: { a: string; y0: number; y1: number }[] = [];
  for (let i = 0; i < apps.length; i++) {
    const wd = want[i]! * k;
    fronts.push({ a: apps[i]!, y0: y, y1: y + wd });
    if (apps[i] === 'sink') sinks.push(rounded(front * 0.25, y + wd * 0.12, front * 0.85, y + wd * 0.88, 30 * MM));
    if (apps[i] === 'grill' || apps[i] === 'sideBurner') sinks.push([[front * 0.2, y + wd * 0.08], [front * 0.9, y + wd * 0.08], [front * 0.9, y + wd * 0.92], [front * 0.2, y + wd * 0.92]]);
    y += wd + gap;
  }
  s.box('base', baseRole, 0, 0, 0, front - proud, Y, Z - ct);
  s.slab('counter', counterRole, 0, 0, X, Y, Z - ct, Z, sinks);
  const lo = min(100 * MM, Z / 8);
  for (const { a, y0, y1 } of fronts) {
    const hi = Z - ct - 20 * MM;
    if (a === 'grill' || a === 'sideBurner') {
      s.box(`${a}Front`, 'stainless', front - proud, y0, Z - ct - min(250 * MM, Z / 3), front, y1, Z - ct);
      s.box(`${a}Grate`, 'darkMetal', front * 0.2, y0 + (y1 - y0) * 0.08, Z - ct - 30 * MM, front * 0.9, y1 - (y1 - y0) * 0.08, Z - 12 * MM);
      s.box(`${a}Doors`, 'stainless', front - proud, y0, lo, front, y1, Z - ct - min(280 * MM, Z / 3));
    } else if (a === 'sink') {
      s.box('sinkBowl', 'stainless', front * 0.27, y0 + (y1 - y0) * 0.14, Z - ct - min(220 * MM, Z / 3), front * 0.83, y1 - (y1 - y0) * 0.14, Z - ct);
      s.box('sinkDoors', 'stainless', front - proud, y0, lo, front, y1, hi);
    } else if (a === 'pizzaOven') {
      s.box('ovenFace', 'brick', front - proud, y0, lo, front, y1, hi);
      s.box('ovenMouth', 'darkMetal', front - proud - 2, y0 + (y1 - y0) * 0.25, Z * 0.45, front + 0, y1 - (y1 - y0) * 0.25, hi - 60 * MM);
    } else {
      s.box(`${a}Door`, 'stainless', front - proud, y0, lo, front, y1, hi);
      s.box(`${a}Handle`, 'darkMetal', front - 2, y0 + (y1 - y0) * 0.15, hi - 50 * MM, front, y1 - (y1 - y0) * 0.15, hi - 30 * MM);
    }
  }
};

// ─── Fires ─────────────────────────────────────────────────────────────────────────────────

/** A closed ring of 24 points about c, radii rx and ry. */
const ring = (c: V2, rx: number, ry: number): V2[] => Array.from({ length: 24 }, (_, k): V2 => [c[0] + rx * COS[k]!, c[1] + ry * SIN[k]!]);

/**
 * A fire feature: a pit — a stone ring round a dark bowl, its embers glowing at the top — a bowl on a
 * pedestal, a table with a burner pan, or a fireplace whose firebox opens at its front under a
 * chimney. A pit, a bowl or a table in a square box is round; in a longer one, oval or long.
 */
export const fire: Model = (s, el) => {
  const { X, Y, Z } = s;
  const form = str(el['form'], 'pit');
  const c: V2 = [X / 2, Y / 2];
  const round = Math.abs(X - Y) < 0.05 * max(X, Y);
  const stone: ModelRole = el['fuel'] === 'wood' ? 'brick' : 'paver';
  if (form === 'fireplace') {
    const lower = Z * 0.45;
    const opening: V2[] = [[Y * 0.22, Z * 0.12], [Y * 0.78, Z * 0.12], [Y * 0.78, lower * 0.85], [Y * 0.22, lower * 0.85]];
    s.box('back', stone, 0, 0, 0, X * 0.35, Y, lower);
    s.extrude('surround', stone, 'x', [[0, 0], [Y, 0], [Y, lower], [0, lower]], X * 0.35, X, [opening]);
    s.box('hearth', 'darkMetal', X * 0.35, Y * 0.22, Z * 0.12 - 4 * MM, X * 0.95, Y * 0.78, Z * 0.12);
    s.box('embers', 'ember', X * 0.4, Y * 0.3, Z * 0.12, X * 0.75, Y * 0.7, Z * 0.12 + min(40 * MM, Z / 30));
    s.box('chimney', stone, X * 0.1, Y * 0.25, lower, X * 0.8, Y * 0.75, Z);
    return;
  }
  const wall = min(150 * MM, min(X, Y) * 0.15);
  const outer = round ? ring(c, X / 2, Y / 2) : rounded(0, 0, X, Y, 40 * MM);
  const inner = round ? ring(c, X / 2 - wall, Y / 2 - wall) : rounded(wall, wall, X - wall, Y - wall, 20 * MM);
  const emberT = min(30 * MM, Z / 12);
  if (form === 'bowl') {
    const r = min(X, Y) / 2;
    s.lathe('bowl', 'concrete', 'z', c, [[0, Z * 0.35], [r * 0.3, Z * 0.35], [r * 0.3, 0], [r * 0.45, 0], [r * 0.4, Z * 0.4], [r, Z], [r * 0.85, Z], [0, Z * 0.6]]);
    s.lathe('embers', 'ember', 'z', c, [[0, Z * 0.6], [r * 0.8, Z - emberT * 2], [r * 0.8, Z - emberT], [0, Z - emberT]]);
    return;
  }
  s.extrude(form === 'table' ? 'table' : 'ring', form === 'table' ? 'concrete' : stone, 'z', outer, 0, Z, [inner]);
  s.extrude('bowl', 'darkMetal', 'z', inner, 0, Z - emberT * 3);
  const glow = round ? ring(c, X / 2 - wall * 1.6, Y / 2 - wall * 1.6) : rounded(wall * 1.6, wall * 1.6, X - wall * 1.6, Y - wall * 1.6, 10 * MM);
  s.extrude('embers', 'ember', 'z', glow, Z - emberT * 3, Z - emberT);
};

/** FS_outdoor's models, by collection. */
export const OUTDOOR_MODELS: Readonly<Record<string, Model>> = { pools: pool, fences: fence, shelters: shelter, kitchens: kitchen, fires: fire };
