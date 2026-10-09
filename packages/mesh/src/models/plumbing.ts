/**
 * FS_plumbing's fixtures and water heaters: a toilet's tank, bowl and seat; a basin; a kitchen
 * sink's bowls set into the counter; a tub with its recess; a shower's base and glass; a hose bibb;
 * a water heater's tank. A floor fixture's back (x = 0) is against the wall it is set by; a basin
 * hung on a wall stands out from it, its rim at its frame's origin — its mounting height (13.1).
 */
import { min, MM, rect, type ModelContext, type Model, type V2 } from './common.js';
import { ellipse, rounded, type Sketch } from './sketch.js';

/** A rim's height in a box Z high: at `at` — the counter it is set into, else its frame's origin (its mounting height) — when that is in the box's upper part, else the box's top. */
export const rimIn = (Z: number, at: number | undefined): number => (at !== undefined && at >= Z * 0.3 ? min(at, Z) : Z);

const rimOf = (s: Sketch, ctx: ModelContext): number => rimIn(s.Z, ctx.counter ?? ctx.originZ);

/** How deep each basin is. */
export const BASIN_DEPTH: Readonly<Record<string, number>> = { kitchenSink: 200 * MM, barSink: 160 * MM, laundryTub: 300 * MM, lavatory: 150 * MM };

/** The fixtures a counter top is cut for. */
export const SINKS: ReadonlySet<string> = new Set(Object.keys(BASIN_DEPTH));

/** A kitchen sink's bowls' outlines (its counter cut-outs), in its own frame: two bowls in a wide one. */
function bowls(X: number, Y: number): V2[][] {
  const m = min(40 * MM, 0.08 * min(X, Y));
  const ledge = min(70 * MM, 0.15 * X);
  const c = min(25 * MM, 0.06 * min(X, Y));
  const [x0, x1] = [m + ledge, X - m];
  if (Y < 760 * MM) return [rounded(x0, m, x1, Y - m, c)];
  const d = min(40 * MM, 0.05 * Y);
  return [rounded(x0, m, x1, Y / 2 - d / 2, c), rounded(x0, Y / 2 + d / 2, x1, Y - m, c)];
}

/** A basin's oval: its centre and radii in its own frame. */
function oval(X: number, Y: number): { cx: number; cy: number; rx: number; ry: number } {
  return { cx: X * 0.56, cy: Y / 2, rx: X * 0.42, ry: Y * 0.44 };
}

/** The outlines a counter top is cut along for a sink set into it, in the sink's own frame. */
export function cutoutsOf(kind: string, X: number, Y: number): V2[][] {
  if (kind === 'lavatory') {
    const o = oval(X, Y);
    return [ellipse(o.cx, o.cy, o.rx * 0.93, o.ry * 0.93)];
  }
  return bowls(X, Y);
}

/** A tap standing on a deck at (x, y) from z0 up to z1, its spout reaching forward to x2. */
function tap(s: Sketch, x: number, y: number, z0: number, z1: number, x2: number): void {
  const h = z1 - z0;
  if (h < 50 * MM) return;
  const rb = min(25 * MM, h * 0.12, s.X * 0.06);
  s.cylinder('tapBase', 'stainless', 'z', [x, y], rb, z0, z0 + min(20 * MM, h * 0.12));
  const r = min(12 * MM, rb * 0.55);
  s.cylinder('tap', 'stainless', 'z', [x, y], r, z0, z1 - r);
  s.cylinder('spout', 'stainless', 'x', [y, z1 - r], r, x - r, x2);
  s.cylinder('nozzle', 'stainless', 'z', [x2 - r, y], r * 0.9, z1 - 2 * r - min(30 * MM, h * 0.15), z1 - 2 * r);
  s.box('lever', 'stainless', x - r, y + r, z1 - h * 0.45, x + r, y + r + min(50 * MM, s.Y * 0.1), z1 - h * 0.45 + min(10 * MM, h * 0.06));
}

const kitchenSink: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const rim = rimOf(s, ctx);
  const depth = min(BASIN_DEPTH[ctx.kind] ?? BASIN_DEPTH['kitchenSink']!, rim);
  const bottom = rim - depth;
  const w = min(2 * MM, depth * 0.05);
  const outlines = bowls(X, Y);
  // Set into a counter, its bowls hang under the counter's cut-out (undermount); standing alone, a
  // stainless deck rims them.
  const dt = ctx.counter === undefined ? min(3 * MM, depth * 0.05) : 0;
  if (dt > 0) s.extrude('deck', 'stainless', 'z', rect(0, 0, X, Y), rim - dt, rim, outlines);
  for (const o of outlines) {
    const xs = o.map((p) => p[0]);
    const ys = o.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const inner = rounded(x0 + w, y0 + w, x1 - w, y1 - w, min(25 * MM, 0.06 * min(X, Y)) - w / 2);
    s.extrude('basin', 'stainless', 'z', o, bottom, rim - dt, [inner]);
    s.extrude('floor', 'stainless', 'z', inner, bottom, bottom + w);
    s.cylinder('drain', 'darkMetal', 'z', [(x0 + x1) / 2, (y0 + y1) / 2], min(45 * MM, (x1 - x0) * 0.12), bottom + w, bottom + w + min(1 * MM, depth * 0.01));
  }
  const ledge = min(70 * MM, 0.15 * X);
  const m = min(40 * MM, 0.08 * min(X, Y));
  tap(s, m / 2 + ledge / 2, Y / 2, rim, Z, X * 0.45);
};

const lavatory: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  // Under a counter, its rim a little below the counter's top, which covers the rim's outer edge.
  const rim = rimOf(s, ctx) - (ctx.counter === undefined ? 0 : min(2 * MM, s.Z * 0.01));
  const d = min(BASIN_DEPTH['lavatory']!, rim);
  const b = rim - d;
  const o = oval(X, Y);
  // A hollow bowl: out along its underside, up its outside, in across the rim, down its inside.
  s.lathe('basin', 'porcelain', 'z', [o.cx, o.cy], [
    [0, b],
    [0.45, b],
    [0.8, b + d * 0.4],
    [0.96, b + d * 0.8],
    [1, rim],
    [0.86, rim],
    [0.8, rim - d * 0.25],
    [0.55, b + d * 0.32],
    [0, b + d * 0.25],
  ], [o.rx, o.ry]);
  s.cylinder('drain', 'stainless', 'z', [o.cx, o.cy], o.rx * 0.08, b + d * 0.25, b + d * 0.25 + min(1 * MM, d * 0.01));
  const back = o.cx - o.rx;
  if (ctx.counter === undefined) s.box('deck', 'porcelain', 0, Y * 0.06, rim - d * 0.3, back + o.rx * 0.2, Y * 0.94, rim - min(1 * MM, d * 0.01));
  tap(s, back / 2 + o.rx * 0.05, Y / 2, rim, Z, o.cx - o.rx * 0.45);
};

const waterCloset: Model = (s) => {
  const { X, Y, Z } = s;
  const tankD = X * 0.25;
  const tankTop = Z * 0.95;
  // The tank against the wall, its lid a little wider.
  s.box('tank', 'porcelain', X * 0.02, Y * 0.06, Z * 0.48, tankD, Y * 0.94, tankTop);
  s.box('lid', 'porcelain', 0, Y * 0.03, tankTop, tankD + X * 0.02, Y * 0.97, Z);
  s.box('lever', 'stainless', tankD, Y * 0.72, Z * 0.84, tankD + min(15 * MM, X * 0.02), Y * 0.86, Z * 0.86);
  // The bowl: an oval pedestal swelling to its rim, hollow, seat on top.
  const rx = X * 0.38;
  const ry = Y * 0.47;
  const cx = X - rx;
  const rim = Z * 0.46;
  s.lathe('bowl', 'porcelain', 'z', [cx, Y / 2], [
    [0, 0],
    [0.55, 0],
    [0.58, rim * 0.3],
    [0.8, rim * 0.68],
    [0.98, rim * 0.92],
    [1, rim],
    [0.84, rim],
    [0.62, rim * 0.78],
    [0.3, rim * 0.6],
    [0, rim * 0.58],
  ], [rx, ry]);
  // The trapway's column, joining the bowl to the tank's foot.
  s.box('neck', 'porcelain', tankD * 0.7, Y * 0.3, rim * 0.2, cx - rx * 0.55, Y * 0.7, rim * 0.97);
  const seat = Z * 0.03;
  const ring = (k: number): V2[] => ellipse(cx, Y / 2, rx * k, ry * k);
  s.extrude('seat', 'plate', 'z', ring(0.99), rim, rim + seat, [ring(0.64)]);
  // The seat's hinge block, behind the bowl.
  s.box('hinge', 'plate', tankD, Y * 0.3, rim, cx - rx * 0.8, Y * 0.7, rim + seat * 1.4);
};

/** A bathtub's shell: the outline less its recess, the recess's floor, and a spout at its end. */
function tub(s: Sketch, h: number): { inner: V2[]; wall: number; end: number } {
  const { X, Y } = s;
  const wall = min(80 * MM, X * 0.1);
  const end = min(110 * MM, Y * 0.08);
  const inner = rounded(wall, end, X - wall, Y - end, min(150 * MM, X * 0.2));
  s.extrude('tub', 'porcelain', 'z', rect(0, 0, X, Y), 0, h, [inner]);
  s.extrude('recess', 'porcelain', 'z', inner, 0, min(h * 0.2, 90 * MM));
  const sp = min(h * 0.12, 40 * MM);
  s.box('spout', 'stainless', X * 0.44, end, h - sp * 3, X * 0.56, end + min(120 * MM, Y * 0.08), h - sp * 2);
  s.cylinder('drain', 'stainless', 'z', [X / 2, end + min(150 * MM, Y * 0.1)], min(30 * MM, X * 0.04), min(h * 0.2, 90 * MM), min(h * 0.2, 90 * MM) + min(1 * MM, h * 0.01));
  return { inner, wall, end };
}

/** A shower's head on the back wall at (y, z) and its valve below it. */
function showerHead(s: Sketch, y: number, z: number, valveZ: number): void {
  const { X } = s;
  const r = min(12 * MM, X * 0.015);
  s.cylinder('arm', 'stainless', 'x', [y, z], r, 0, X * 0.2);
  s.cylinder('head', 'stainless', 'z', [X * 0.2, y], min(75 * MM, X * 0.08), z - r * 4, z - r);
  s.cylinder('valve', 'stainless', 'x', [y, valveZ], min(50 * MM, X * 0.05), 0, min(15 * MM, X * 0.02));
}

const bathtub: Model = (s) => {
  tub(s, s.Z);
};

const bathtubShower: Model = (s) => {
  const { X, Y, Z } = s;
  const h = min(Z, 560 * MM);
  const t = tub(s, h);
  if (Z - h < 600 * MM) return;
  // A screen standing on the rim along half its front, and the shower over the tub's end.
  s.box('screen', 'glass', X - t.wall * 0.7, Y * 0.5, h, X - t.wall * 0.7 + min(8 * MM, t.wall * 0.2), Y - t.end, h + (Z - h) * 0.82);
  showerHead(s, t.end + min(250 * MM, Y * 0.15), h + (Z - h) * 0.85, h + (Z - h) * 0.3);
};

const shower: Model = (s) => {
  const { X, Y, Z } = s;
  const tray = min(80 * MM, Z * 0.05);
  s.box('base', 'porcelain', 0, 0, 0, X, Y, tray);
  s.cylinder('drain', 'stainless', 'z', [X / 2, Y / 2], min(55 * MM, min(X, Y) * 0.06), tray, tray + min(1 * MM, Z * 0.001));
  const g = min(10 * MM, X * 0.015);
  const top = tray + (Z - tray) * 0.85;
  s.box('panel', 'glass', X - g, 0, tray, X, Y * 0.48, top);
  s.box('door', 'glass', X - g, Y * 0.5, tray, X, Y, top);
  if (X > 4 * g) s.box('handle', 'stainless', X - 3 * g, Y * 0.53, tray + (Z - tray) * 0.42, X - g, Y * 0.545, tray + (Z - tray) * 0.55);
  showerHead(s, Y / 2, tray + (Z - tray) * 0.88, tray + (Z - tray) * 0.45);
};

const hoseBibb: Model = (s) => {
  const { X, Y, Z } = s;
  const c = [Y / 2, Z * 0.6] as const;
  const R = min(Y, Z) / 2;
  s.cylinder('flange', 'stainless', 'x', c, R * 0.7, 0, X * 0.12);
  s.cylinder('body', 'stainless', 'x', c, R * 0.3, X * 0.12, X * 0.75);
  s.cylinder('spout', 'stainless', 'z', [X * 0.62, Y / 2], R * 0.22, 0, Z * 0.6);
  s.cylinder('stem', 'stainless', 'x', c, R * 0.12, X * 0.75, X * 0.88);
  s.cylinder('wheel', 'darkMetal', 'x', c, R * 0.55, X * 0.88, X);
};

/** FS_plumbing 2.1: a fixture by its `fixture`. */
export const FIXTURES: Readonly<Record<string, Model>> = {
  waterCloset,
  bidet: waterCloset,
  lavatory,
  kitchenSink,
  barSink: kitchenSink,
  laundryTub: kitchenSink,
  bathtub,
  shower,
  bathtubShower,
  hoseBibb,
};

/** FS_plumbing 2.2: a water heater — a tank, or a tankless unit on the wall. */
export const waterHeater: Model = (s, el) => {
  const { X, Y, Z } = s;
  if (el['heater'] === 'tankless') {
    s.box('unit', 'plate', 0, Y * 0.1, Z * 0.35, X * 0.6, Y * 0.9, Z * 0.95);
    for (const f of [0.35, 0.5, 0.65]) s.cylinder('pipe', 'stainless', 'z', [X * 0.3, Y * f], min(12 * MM, Y * 0.03), Z * 0.1, Z * 0.35);
    return;
  }
  const R = min(X, Y) * 0.48;
  const c = [X / 2, Y / 2] as const;
  s.cylinder('tank', 'plate', 'z', c, R, 0, Z * 0.9);
  s.lathe('top', 'stainless', 'z', c, [
    [0, Z * 0.9],
    [R * 0.98, Z * 0.9],
    [R * 0.9, Z * 0.93],
    [0, Z * 0.935],
  ]);
  for (const f of [-0.45, 0.45]) s.cylinder('pipe', 'stainless', 'z', [X / 2, Y / 2 + R * f], min(14 * MM, R * 0.08), Z * 0.92, Z);
  // The burner's or the elements' access panel, on the front.
  const px = X / 2 + R;
  s.box('panel', 'darkMetal', px - min(6 * MM, R * 0.03), Y / 2 - R * 0.3, Z * 0.12, min(X, px + 2 * MM), Y / 2 + R * 0.3, Z * 0.24);
};
