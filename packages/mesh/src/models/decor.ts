/**
 * Decor (FLR-T-13.11): the FS_furniture starter library's rugs, art, lamps, plants, textiles,
 * window dressings, media and accessories, drawn as what each is. No category of FS_furniture 0.1
 * names a rug or a lamp, so the library gives them the category `other`; what one is comes from its
 * model — a starter-library proxy (FLR-T-12.33) names its item, and the item's family its model here.
 * A project's own model of any other digest is its own, and drawn as it is.
 *
 * Cheap geometry, a considered look: a rug's field inside a contrasting border and a fine line; a
 * framed picture with a muted composition chosen by the element's ID; pleated curtains; a throw that
 * drapes over an arm; foliage of leaves and blades. Round things come from the circle tables (no
 * trigonometry at run time) and every choice from a hash of the element's ID, so a model meshes to the
 * same bytes everywhere.
 */
import { furniture } from '@floorspec/engine';
import type { ModelRole } from '../roles.js';
import { COS, SIN } from './circle.js';
import { min, MM, type Json, type Model, type V2 } from './common.js';
import { ellipse, rounded, type Sketch } from './sketch.js';

type Doc = { readonly assets?: Readonly<Record<string, { readonly sha256?: unknown } | undefined>> };

/**
 * The starter-library item an FS_furniture element was placed from, read from its model's digest:
 * `rug-2400x1700`, `lamp-table-600`; undefined for a model of a project's own, or none.
 */
export function libraryItemOf(doc: unknown, element: Json): string | undefined {
  const fallback = element['fallback'] as Json | undefined;
  const asset = fallback?.['asset'];
  if (typeof asset !== 'string') return undefined;
  const assets = (doc as Doc).assets;
  const entry = assets !== undefined && Object.hasOwn(assets, asset) ? assets[asset] : undefined;
  return furniture.starterLibraryItem(entry?.sha256);
}

/** The family of a decor item — `rug` of `rug-2400x1700` — or undefined for an item that is not decor. */
export function decorFamily(item: string | undefined): string | undefined {
  if (item === undefined) return undefined;
  return FAMILIES.find((f) => item === f || item.startsWith(`${f}-`));
}

// ─── Chance, from the element's ID ──────────────────────────────────────────────────────────────

/** FNV-1a of a string: an element's seed. */
export function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The i-th number in [0, 1) of a seed's sequence: integer mixing only. */
function rnd(seed: number, i: number): number {
  let x = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4_294_967_296;
}

const pick = <T>(seed: number, i: number, xs: readonly T[]): T => xs[Math.floor(rnd(seed, i) * xs.length) % xs.length]!;

/** The muted accents textiles and pictures are drawn in. */
const ACCENTS: readonly ModelRole[] = ['clay', 'ochre', 'sage', 'slate'];

// ─── Round things from the circle tables ──────────────────────────────────────────────────────

/** The table's angles from straight down to straight up, by 15° · step: an ellipsoid's profile. */
const MERIDIAN = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6];

/** An ellipsoid about (x, y, z) with radii rx, ry across and rz up; `step` 2 or 3 for a coarser one. */
function blob(s: Sketch, name: string, role: ModelRole, x: number, y: number, z: number, rx: number, ry: number, rz: number, step = 2): void {
  if (rx < 2 || ry < 2 || rz < 2) return;
  const profile = MERIDIAN.filter((_, i) => i % step === 0).map((k): V2 => [Math.max(0, rx * COS[k]!), z + rz * SIN[k]!]);
  profile[0] = [0, z - rz];
  profile[profile.length - 1] = [0, z + rz];
  s.lathe(name, role, 'z', [x, y], profile, [1, ry / rx]);
}

/** A thin band of a lathe: a ring from radius r0 at h0 to r1 at h1, t thick (a lamp's shade, a bowl's wall). */
function band(s: Sketch, name: string, role: ModelRole, c: V2, r0: number, h0: number, r1: number, h1: number, t: number): void {
  s.lathe(name, role, 'z', c, [
    [r0 - t, h0],
    [r0, h0],
    [r1, h1],
    [r1 - t, h1],
  ]);
}

/** An arch's outline in (a, b): straight sides from b0 up to the spring, a half circle over them. */
function arch(a0: number, a1: number, b0: number, spring: number): V2[] {
  const r = (a1 - a0) / 2;
  const c = (a0 + a1) / 2;
  const top: V2[] = [];
  for (let k = 1; k < 12; k++) top.push([c + r * COS[k]!, spring + r * SIN[k]!]);
  return [[a0, b0], [a1, b0], [a1, spring], ...top, [a0, spring]];
}

// ─── Rugs ─────────────────────────────────────────────────────────────────────────────────────

/** A rug: a field inside a contrasting border, a fine line inside that — three colourways by its ID. */
const rug: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const seed = ctx.seed ?? 0;
  const [field, border, line] = pick<[ModelRole, ModelRole, ModelRole]>(seed, 0, [
    ['rug', 'rugBorder', 'clay'],
    ['rug', 'sage', 'ochre'],
    ['rugBorder', 'rug', 'ochre'],
    ['rug', 'slate', 'rug'],
  ]);
  const b = min(120 * MM, min(X, Y) * 0.075);
  const g = min(45 * MM, b * 0.4);
  const l = min(16 * MM, b * 0.16);
  // The field a hair under the border, so no two tops share a plane.
  const top = Z;
  const low = Z - min(1.5 * MM, Z * 0.15);
  s.box('border', border, 0, 0, 0, X, b, top);
  s.box('border', border, 0, Y - b, 0, X, Y, top);
  s.box('border', border, 0, b, 0, b, Y - b, top);
  s.box('border', border, X - b, b, 0, X, Y - b, top);
  s.box('field', field, b, b, 0, X - b, Y - b, low);
  if (line !== field && X - 2 * (b + g + l) > 4 * MM && Y - 2 * (b + g + l) > 4 * MM) {
    const [x0, y0, x1, y1] = [b + g, b + g, X - b - g, Y - b - g];
    s.box('line', line, x0, y0, low, x1, y0 + l, top);
    s.box('line', line, x0, y1 - l, low, x1, y1, top);
    s.box('line', line, x0, y0 + l, low, x0 + l, y1 - l, top);
    s.box('line', line, x1 - l, y0 + l, low, x1, y1 - l, top);
  }
};

/** A bath mat: a soft rounded slab and its tufted panel. */
const bathMat: Model = (s) => {
  const { X, Y, Z } = s;
  const c = min(60 * MM, min(X, Y) * 0.12);
  s.extrude('mat', 'linen', 'z', rounded(0, 0, X, Y, c), 0, Z * 0.7);
  const i = min(40 * MM, min(X, Y) * 0.08);
  s.extrude('pile', 'canvas', 'z', rounded(i, i, X - i, Y - i, c * 0.7), Z * 0.7, Z);
};

// ─── Pictures and mirrors ─────────────────────────────────────────────────────────────────────

/** A framed picture: frame, mat, and a muted composition on the canvas — horizon, arches or blocks. */
const art: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const seed = ctx.seed ?? 0;
  const f = min(28 * MM, min(Y, Z) * 0.05);
  const frame = pick<ModelRole>(seed, 1, ['wood', 'darkMetal', 'brass', 'wood']);
  s.box('frame', frame, 0, 0, 0, X, f, Z);
  s.box('frame', frame, 0, Y - f, 0, X, Y, Z);
  s.box('frame', frame, 0, f, 0, X, Y - f, f);
  s.box('frame', frame, 0, f, Z - f, X, Y - f, Z);
  // The mat, set back in the frame; the work on it, layer over layer a millimetre apart.
  const mx = X * 0.5;
  s.box('mat', 'canvas', 0, f, f, mx, Y - f, Z - f);
  const m = min(70 * MM, min(Y, Z) * 0.1);
  const [y0, y1, z0, z1] = [f + m, Y - f - m, f + m, Z - f - m];
  if (y1 - y0 < 20 * MM || z1 - z0 < 20 * MM) return;
  const w = y1 - y0;
  const h = z1 - z0;
  let layer = 0;
  const at = () => mx + 1 * MM * ++layer;
  const flat = (name: string, role: ModelRole, outline: V2[]) => {
    const x = at();
    s.extrude(name, role, 'x', outline, x - 1 * MM, x);
  };
  const rect = (a0: number, b0: number, a1: number, b1: number): V2[] => [[a0, b0], [a1, b0], [a1, b1], [a0, b1]];
  const [c1, c2, c3] = [pick(seed, 2, ACCENTS), pick(seed, 3, ACCENTS), pick(seed, 4, ACCENTS)];
  const style = Math.floor(rnd(seed, 5) * 3);
  if (style === 0) {
    // A horizon: sky, a far band, the ground, and a low sun.
    flat('ground', c1, rect(y0, z0, y1, z0 + h * (0.3 + rnd(seed, 6) * 0.12)));
    flat('band', c2 === c1 ? 'slate' : c2, rect(y0, z0 + h * 0.42, y1, z0 + h * 0.47));
    const r = min(w, h) * (0.12 + rnd(seed, 7) * 0.08);
    const cy = y0 + w * (0.25 + rnd(seed, 8) * 0.5);
    flat('sun', c3 === c1 ? 'ochre' : c3, ellipse(cy, z0 + h * 0.62, r, r));
  } else if (style === 1) {
    // Arches: a tall one and a lower one beside it, on a ground line.
    const aw = w * 0.34;
    const ya = y0 + w * (0.14 + rnd(seed, 9) * 0.1);
    flat('arch', c1, arch(ya, ya + aw, z0 + h * 0.12, z0 + h * 0.6 - aw / 2));
    const yb = Math.min(y1 - aw * 0.8, ya + aw * 0.75);
    flat('arch', c2 === c1 ? 'sage' : c2, arch(yb, yb + aw * 0.8, z0 + h * 0.12, z0 + h * 0.42 - aw * 0.4));
    flat('ground', 'slate', rect(y0 + w * 0.06, z0 + h * 0.08, y1 - w * 0.06, z0 + h * 0.12));
  } else {
    // Blocks: two fields of colour stacked, a thin line between them.
    const split = z0 + h * (0.38 + rnd(seed, 10) * 0.16);
    flat('block', c1, rect(y0 + w * 0.08, z0 + h * 0.08, y1 - w * 0.08, split - h * 0.03));
    flat('block', c2 === c1 ? 'slate' : c2, rect(y0 + w * 0.08, split + h * 0.03, y1 - w * 0.08, z1 - h * 0.08));
    flat('line', c3, rect(y0 + w * 0.2, split - h * 0.008, y1 - w * 0.2, split + h * 0.008));
  }
};

/** A mirror with an arched top in a slim brass frame. */
const mirror: Model = (s) => {
  const { X, Y, Z } = s;
  const f = min(22 * MM, Y * 0.04);
  const spring = Z - Y / 2;
  if (spring <= f) {
    s.box('frame', 'brass', 0, 0, 0, X, Y, Z);
    s.box('glass', 'mirror', X, f, f, X, Y - f, Z - f);
    return;
  }
  const outer = arch(0, Y, 0, spring);
  const inner = arch(f, Y - f, f, spring);
  s.extrude('frame', 'brass', 'x', outer, X * 0.4, X, [inner]);
  s.extrude('back', 'darkMetal', 'x', outer, 0, X * 0.4);
  s.extrude('glass', 'mirror', 'x', inner, X * 0.4, X * 0.7);
};

// ─── Lamps ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a lamp's shade is, as fractions of its height (bottom, top): the light (lights.ts) shines from
 * its middle, and the shade, which does not shadow its own lamp, glows.
 */
export const LAMP_SHADES: Readonly<Record<string, readonly [number, number]>> = { 'lamp-floor': [0.76, 1], 'lamp-table': [0.6, 1] };

/** A floor lamp: a weighted disc, a slim stem, a tapered drum shade and its bulb. */
const floorLamp: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const c: V2 = [X / 2, Y / 2];
  const R = min(X, Y) / 2;
  const metal = pick<ModelRole>(ctx.seed ?? 0, 0, ['brass', 'darkMetal']);
  const bh = min(28 * MM, Z * 0.02);
  s.lathe('base', metal, 'z', c, [[0, 0], [R * 0.62, 0], [R * 0.58, bh], [0, bh]]);
  const [lo, hi] = LAMP_SHADES['lamp-floor']!;
  const z0 = Z * lo;
  s.cylinder('stem', metal, 'z', c, min(10 * MM, R * 0.05), bh, Z * (lo + hi) / 2);
  band(s, 'shade', 'shade', c, R * 0.98, z0, R * 0.8, Z, min(3 * MM, R * 0.02));
  blob(s, 'bulb', 'shade', c[0], c[1], Z * (lo + hi) / 2, R * 0.14, R * 0.14, R * 0.18);
};

/** A table lamp: a glazed ginger-jar base, a brass neck, a tapered drum shade. */
const tableLamp: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const c: V2 = [X / 2, Y / 2];
  const R = min(X, Y) / 2;
  const glaze = pick<ModelRole>(ctx.seed ?? 0, 0, ['ceramic', 'sage', 'clay', 'slate', 'ceramic']);
  const [lo, hi] = LAMP_SHADES['lamp-table']!;
  const h = Z * (lo - 0.08);
  const r = R * 0.42;
  s.lathe('base', glaze, 'z', c, [
    [0, 0],
    [r * 0.6, 0],
    [r * 0.92, h * 0.22],
    [r, h * 0.5],
    [r * 0.86, h * 0.78],
    [r * 0.48, h * 0.94],
    [r * 0.36, h],
    [0, h],
  ]);
  s.cylinder('neck', 'brass', 'z', c, min(9 * MM, R * 0.06), h, Z * (lo + hi) / 2);
  band(s, 'shade', 'shade', c, R * 0.98, Z * lo, R * 0.78, Z, min(3 * MM, R * 0.02));
  blob(s, 'bulb', 'shade', c[0], c[1], Z * (lo + hi) / 2, R * 0.16, R * 0.16, R * 0.2);
};

// ─── Plants ─────────────────────────────────────────────────────────────────────────────────────

/** A planter: tapered, with a rim, and the soil in it; its height. */
function planter(s: Sketch, c: V2, rTop: number, rFoot: number, h: number, role: ModelRole): number {
  const rim = min(12 * MM, h * 0.06);
  s.lathe('planter', role, 'z', c, [
    [0, 0],
    [rFoot, 0],
    [rTop * 0.97, h - rim],
    [rTop, h - rim],
    [rTop, h],
    [0, h],
  ]);
  s.cylinder('soil', 'darkMetal', 'z', c, rTop * 0.9, h, h + min(4 * MM, h * 0.02));
  return h;
}

/** An indoor tree — an olive, a fig — in a planter: a trunk, branches, and a canopy of leaf masses. */
const tree: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const seed = ctx.seed ?? 0;
  const c: V2 = [X / 2, Y / 2];
  const R = min(X, Y) / 2;
  const pot = planter(s, c, R * 0.56, R * 0.44, Z * 0.24, pick<ModelRole>(seed, 0, ['terracotta', 'ceramic', 'slate']));
  const t = min(24 * MM, R * 0.07);
  const crown = Z * 0.6;
  s.cylinder('trunk', 'wood', 'z', c, t, pot, crown);
  // Branches: slanted bars from the trunk into the canopy.
  for (let i = 0; i < 3; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    const lean = R * (0.25 + rnd(seed, 20 + i) * 0.2) * dir;
    const zb = crown - Z * 0.08 * i;
    const zt = Math.min(Z * 0.86, zb + Z * 0.2);
    const w = t * 0.7;
    const outline: V2[] = [[c[1] - w, zb], [c[1] + w, zb], [c[1] + lean + w * 0.6, zt], [c[1] + lean - w * 0.6, zt]];
    if (i === 1) s.extrude('branch', 'wood', 'y', outline.map(([a, b]): V2 => [b, a - c[1] + c[0]]), c[1] - w, c[1] + w);
    else s.extrude('branch', 'wood', 'x', outline, c[0] - w, c[0] + w);
  }
  // Leaf masses: a dozen ellipsoids in two greens, kept in the box.
  const n = 12;
  for (let i = 0; i < n; i++) {
    const r = R * (0.2 + rnd(seed, 40 + i) * 0.14);
    const a = (Math.floor(rnd(seed, 60 + i) * 24) + i * 7) % 24;
    const d = (R - r) * (0.25 + rnd(seed, 80 + i) * 0.75);
    const x = c[0] + d * COS[a]!;
    const y = c[1] + d * SIN[a]!;
    const rz = r * (0.75 + rnd(seed, 100 + i) * 0.3);
    const z = Math.min(Z - rz, crown + (Z - crown) * (0.1 + rnd(seed, 120 + i) * 0.75));
    blob(s, 'leaves', i % 3 === 0 ? 'sage' : 'foliage', x, y, z, r, r * (0.85 + rnd(seed, 140 + i) * 0.3), rz);
  }
};

/** A floor plant — a snake plant — in a planter: upright blades, alternately across and along. */
const bladePlant: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const seed = ctx.seed ?? 0;
  const c: V2 = [X / 2, Y / 2];
  const R = min(X, Y) / 2;
  const pot = planter(s, c, R * 0.62, R * 0.5, Z * 0.38, pick<ModelRole>(seed, 0, ['ceramic', 'terracotta', 'slate']));
  const n = 13;
  const t = min(8 * MM, R * 0.03);
  for (let i = 0; i < n; i++) {
    const a = (i * 11 + Math.floor(rnd(seed, 1 + i) * 5)) % 24;
    const d = R * 0.36 * rnd(seed, 30 + i);
    const x = c[0] + d * COS[a]!;
    const y = c[1] + d * SIN[a]!;
    const w = R * (0.13 + rnd(seed, 50 + i) * 0.08);
    const len = (Z - pot) * (0.55 + rnd(seed, 70 + i) * 0.45);
    const z0 = pot - 10 * MM;
    const z1 = min(Z, z0 + len);
    // Leaning a little outward, the tip kept in the box.
    const across = i % 2 === 0;
    const at = across ? y : x;
    const out = (across ? SIN[a]! : COS[a]!) * R * 0.18;
    const lim = across ? Y : X;
    const tip = Math.min(lim - w, Math.max(w, at + out));
    const blade: V2[] = [
      [at - w / 2, z0],
      [at + w / 2, z0],
      [(at + tip) / 2 + w * 0.48, z0 + (z1 - z0) * 0.62],
      [tip, z1],
      [(at + tip) / 2 - w * 0.48, z0 + (z1 - z0) * 0.62],
    ];
    const role: ModelRole = i % 4 === 3 ? 'sage' : 'foliage';
    if (across) s.extrude('blade', role, 'x', blade, x - t / 2, x + t / 2);
    else s.extrude('blade', role, 'y', blade.map(([p, q]): V2 => [q, p]), y - t / 2, y + t / 2);
  }
};

/** A small potted plant — a trailing pothos — in a glazed pot. */
const smallPlant: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const seed = ctx.seed ?? 0;
  const c: V2 = [X / 2, Y / 2];
  const R = min(X, Y) / 2;
  const pot = planter(s, c, R * 0.64, R * 0.52, Z * 0.38, pick<ModelRole>(seed, 0, ['ceramic', 'terracotta', 'sage']));
  for (let i = 0; i < 6; i++) {
    const r = R * (0.26 + rnd(seed, 10 + i) * 0.12);
    const a = (i * 4 + Math.floor(rnd(seed, 20 + i) * 3)) % 24;
    const d = (R - r) * (i === 0 ? 0 : 0.6 + rnd(seed, 30 + i) * 0.4);
    const rz = r * 0.8;
    const z = Math.min(Z - rz, pot + rz * (i === 0 ? 1.6 : 0.5 + rnd(seed, 40 + i) * 0.6));
    blob(s, 'leaves', i % 3 === 1 ? 'sage' : 'foliage', c[0] + d * COS[a]!, c[1] + d * SIN[a]!, z, r, r, rz, 3);
  }
};

// ─── Textiles ───────────────────────────────────────────────────────────────────────────────────

/** A cushion's colour by its seed — warm accents and linen, which read against any upholstery. */
const cushionRole = (seed: number): ModelRole => pick<ModelRole>(seed, 0, ['ochre', 'clay', 'linen', 'sage', 'rug']);

/** A cushion standing against a back: a plump square, its edge seamed, in an accent or linen. */
const cushion: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const seed = ctx.seed ?? 0;
  const role = cushionRole(seed);
  // A seam all round at its middle, the body plumper inside it: a pillow's soft square.
  const c = min(Y, Z) * 0.06;
  s.extrude('seam', role, 'x', rounded(0, 0, Y, Z, c), X * 0.38, X * 0.62);
  const i = min(Y, Z) * 0.05;
  s.extrude('body', role, 'x', rounded(i, i, Y - i, Z - i, c * 1.6), 0, X, [], true);
};

/** A throw over a sofa's arm: down its outside, over its top, onto the seat — striped near its ends. */
const sofaThrow: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const seed = ctx.seed ?? 0;
  const t = min(18 * MM, Z * 0.08);
  const arm = Y * 0.43;
  const section: V2[] = [
    [0, 0],
    [t, 0],
    [t, Z - t],
    [arm + t, Z - t],
    [Y - t, 0],
    [Y, 0],
    [Y, t * 0.6],
    [arm + 2 * t, Z],
    [0, Z],
  ];
  // Its colours chosen with the cushions it shares a sofa with (the same seed): never the same as theirs.
  const ways: [ModelRole, ModelRole][] = [
    ['ochre', 'linen'],
    ['linen', 'slate'],
    ['sage', 'linen'],
    ['clay', 'linen'],
    ['rugBorder', 'ochre'],
  ];
  const [body, stripe] = pick(seed, 1, ways.filter(([b]) => b !== cushionRole(seed)));
  const cuts = [0, 0.1, 0.14, 0.18, 0.22, 0.78, 0.82, 0.86, 0.9, 1];
  for (let k = 0; k + 1 < cuts.length; k++) s.extrude('throw', k === 1 || k === 3 || k === 5 || k === 7 ? stripe : body, 'x', section, X * cuts[k]!, X * cuts[k + 1]!, [], true);
};

/** A throw across the foot of a bed: over its top and down both sides, with a band near each edge. */
const bedThrow: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const seed = ctx.seed ?? 0;
  const t = min(20 * MM, Y * 0.015);
  const section: V2[] = [
    [0, 0],
    [t, 0],
    [t, Z - t],
    [Y - t, Z - t],
    [Y - t, 0],
    [Y, 0],
    [Y, Z],
    [0, Z],
  ];
  const [body, stripe] = pick<[ModelRole, ModelRole]>(seed, 0, [
    ['ochre', 'linen'],
    ['slate', 'linen'],
    ['sage', 'linen'],
    ['clay', 'canvas'],
    ['rugBorder', 'rug'],
  ]);
  const cuts = [0, 0.08, 0.12, 0.88, 0.92, 1];
  for (let k = 0; k + 1 < cuts.length; k++) s.extrude('throw', k === 1 || k === 3 ? stripe : body, 'x', section, X * cuts[k]!, X * cuts[k + 1]!);
};

// ─── Window dressings ───────────────────────────────────────────────────────────────────────────

/** A pleated panel of curtain in plan (x out from the wall, y along it), from y0 to y1, pleats about x. */
function pleats(y0: number, y1: number, x: number, amp: number, t: number): V2[] {
  const n = Math.max(4, Math.round((y1 - y0) / (12 * MM)));
  const front: V2[] = [];
  for (let j = 0; j <= n; j++) front.push([x + amp * SIN[(j * 3) % 24]!, y0 + ((y1 - y0) * j) / n]);
  const back = front.map(([px, py]): V2 => [px - t, py]).reverse();
  return [...front, ...back];
}

/** Curtains on a rod: the rod, its brackets and finials, and a pleated panel drawn back to each side. */
const curtains: Model = (s) => {
  const { X, Y, Z } = s;
  const r = min(12 * MM, X * 0.09);
  const rx = X * 0.72;
  const rz = Z - r - min(10 * MM, Z * 0.005);
  s.cylinder('rod', 'brass', 'y', [rz, rx], r, r * 2.4, Y - r * 2.4);
  for (const y of [r * 1.2, Y - r * 1.2]) blob(s, 'finial', 'brass', rx, y, rz, r * 1.2, r * 1.2, r * 1.2, 3);
  for (const y of [Y * 0.06, Y * 0.94]) s.box('bracket', 'brass', 0, y - 6 * MM, rz - 6 * MM, rx, y + 6 * MM, rz + 6 * MM);
  const stack = min(400 * MM, Y * 0.2);
  const amp = min(28 * MM, X * 0.2);
  const t = min(5 * MM, X * 0.04);
  const xc = X * 0.45;
  const z0 = min(15 * MM, Z * 0.01);
  for (const [a, b] of [[r * 3, stack], [Y - stack, Y - r * 3]] as const) s.extrude('panel', 'linen', 'z', pleats(a, b, xc, amp, t), z0, rz - r * 1.6, [], true);
};

/** A roman blind: its headrail and the soft folds stacked under it. */
const romanBlind: Model = (s) => {
  const { X, Y, Z } = s;
  const rail = min(40 * MM, Z * 0.12);
  s.box('rail', 'linen', 0, 0, Z - rail, X * 0.9, Y, Z);
  const n = 4;
  const h = (Z - rail) / n;
  for (let i = 0; i < n; i++) {
    const z = i * h;
    s.extrude('fold', 'linen', 'y', [[z, 0], [z, X * 0.55], [z + h * 0.5, X], [z + h, X * 0.55], [z + h, 0]], 0, Y);
  }
};

// ─── Media ──────────────────────────────────────────────────────────────────────────────────────

/** A television on its pedestal stand: the panel, its screen and bezel, the stand's neck and foot. */
const television: Model = (s) => {
  const { X, Y, Z } = s;
  const foot = min(14 * MM, Z * 0.02);
  s.box('foot', 'darkMetal', X * 0.12, Y * 0.32, 0, X * 0.88, Y * 0.68, foot);
  const pz = Z * 0.08;
  s.box('neck', 'darkMetal', X * 0.42, Y * 0.47, foot, X * 0.58, Y * 0.53, pz + Z * 0.06);
  const t = min(36 * MM, X * 0.14);
  const x0 = X / 2 - t / 2;
  s.box('panel', 'darkMetal', x0, 0, pz, x0 + t, Y, Z);
  const b = min(8 * MM, Y * 0.006);
  s.box('screen', 'screen', x0 + t, b, pz + b * 2, x0 + t + min(1.5 * MM, X * 0.005), Y - b, Z - b);
};

// ─── Books and accessories ──────────────────────────────────────────────────────────────────────

/** A stack of three books: each its covers and spine in a colour, its pages showing on three edges. */
const books: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const seed = ctx.seed ?? 0;
  const h = Z / 3;
  for (let i = 0; i < 3; i++) {
    const inset = i * min(10 * MM, X * 0.05);
    const [x0, x1, y0, y1] = [inset * 0.5, X - inset, inset, Y - inset * 0.6];
    const z0 = h * i;
    const role = pick<ModelRole>(seed, i, ['slate', 'clay', 'sage', 'ochre', 'rugBorder', 'linen', 'canvas']);
    const c = min(2.5 * MM, h * 0.1);
    s.box('cover', role, x0, y0, z0, x1, y1, z0 + c);
    s.box('cover', role, x0, y0, z0 + h - c, x1, y1, z0 + h);
    s.box('spine', role, x0, y0, z0 + c, x1, y0 + c * 2, z0 + h - c);
    s.box('pages', 'canvas', x0 + c, y0 + c * 2, z0 + c, x1 - c, y1 - c, z0 + h - c);
  }
};

/** A vase of eucalyptus: a glazed bottle and branches of round leaves. */
const vase: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const seed = ctx.seed ?? 0;
  const c: V2 = [X / 2, Y / 2];
  const R = min(X, Y) / 2;
  const h = Z * 0.48;
  const r = R * 0.5;
  s.lathe('vase', pick<ModelRole>(seed, 0, ['ceramic', 'slate', 'clay', 'ceramic']), 'z', c, [
    [0, 0],
    [r * 0.7, 0],
    [r, h * 0.3],
    [r * 0.9, h * 0.6],
    [r * 0.4, h * 0.86],
    [r * 0.48, h],
    [0, h],
  ]);
  for (let i = 0; i < 5; i++) {
    const a = (i * 5 + 1) % 24;
    const reach = R * (0.45 + rnd(seed, 10 + i) * 0.4);
    const tip: V2 = [c[0] + reach * COS[a]!, c[1] + reach * SIN[a]!];
    const zt = Z * (0.78 + rnd(seed, 20 + i) * 0.2);
    const w = min(3 * MM, R * 0.03);
    const across = i % 2 === 0;
    const from = across ? c[1] : c[0];
    const to = across ? tip[1] : tip[0];
    const stem: V2[] = [[from - w, h * 0.8], [from + w, h * 0.8], [to + w, zt], [to - w, zt]];
    if (across) s.extrude('stem', 'wood', 'x', stem, c[0] - w, c[0] + w);
    else s.extrude('stem', 'wood', 'y', stem.map(([p, q]): V2 => [q, p]), c[1] - w, c[1] + w);
    for (let k = 1; k <= 4; k++) {
      const u = k / 4;
      const lr = R * (0.11 - u * 0.02);
      // Along the stem: across y for a stem drawn across x, along x for one drawn across y.
      const px = across ? c[0] : c[0] + (tip[0] - c[0]) * u;
      const py = across ? c[1] + (tip[1] - c[1]) * u : c[1];
      const pz = h * 0.8 + (zt - h * 0.8) * u;
      blob(s, 'leaf', 'sage', Math.min(X - lr, Math.max(lr, px)), Math.min(Y - lr, Math.max(lr, py)), Math.min(Z - lr * 0.5, pz), lr, lr, lr * 0.45, 3);
    }
  }
};

/** A shallow glazed bowl of fruit. */
const fruitBowl: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const seed = ctx.seed ?? 0;
  const c: V2 = [X / 2, Y / 2];
  const R = min(X, Y) / 2;
  const hb = Z * 0.5;
  s.lathe('bowl', pick<ModelRole>(seed, 0, ['ceramic', 'slate', 'ceramic']), 'z', c, [
    [0, 0],
    [R * 0.36, 0],
    [R * 0.4, hb * 0.1],
    [R * 0.86, hb * 0.62],
    [R, hb],
    [R * 0.96, hb],
    [R * 0.82, hb * 0.68],
    [R * 0.32, hb * 0.24],
    [0, hb * 0.24],
  ]);
  const fr = min(40 * MM, R * 0.26);
  const spots: [number, number, number][] = [
    [0, 0, hb * 0.24 + fr],
    [R * 0.42, 0, hb * 0.36 + fr],
    [-R * 0.21, R * 0.36, hb * 0.36 + fr],
    [-R * 0.21, -R * 0.36, hb * 0.36 + fr],
    [R * 0.12, R * 0.12, hb * 0.24 + fr * 2.3],
  ];
  spots.forEach(([dx, dy, z], i) => { blob(s, 'fruit', pick<ModelRole>(seed, 1 + i, ['ochre', 'clay', 'sage', 'ochre']), c[0] + dx, c[1] + dy, Math.min(Z - fr, z), fr, fr, fr * 0.95, 3); });
};

/** Two boards leaning on the backsplash: an oak board and a marble one before it. */
const cuttingBoard: Model = (s) => {
  const { X, Y, Z } = s;
  const t = min(20 * MM, X * 0.3);
  s.extrude('board', 'wood', 'y', [[0, X - 1.3 * t], [0, X * 0.55], [Z, 0], [Z, t * 1.1]], 0, Y * 0.82);
  s.extrude('board', 'stone', 'y', [[0, X], [0, X - t * 0.9], [Z * 0.72, X * 0.3], [Z * 0.72, X * 0.3 + t * 0.8]], Y * 0.4, Y);
};

/** A kettle on its base: a stainless body, lid and knob, a spout and a handle. */
const kettle: Model = (s) => {
  const { X, Y, Z } = s;
  const R = min(X, Y * 0.84) / 2;
  const c: V2 = [X / 2, Y / 2];
  const base = min(14 * MM, Z * 0.06);
  s.cylinder('base', 'darkMetal', 'z', c, R * 0.95, 0, base);
  const h = Z * 0.78;
  s.lathe('body', 'stainless', 'z', c, [
    [0, base],
    [R * 0.9, base],
    [R, base + (h - base) * 0.3],
    [R * 0.9, h * 0.82],
    [R * 0.55, h],
    [0, h],
  ]);
  s.cylinder('knob', 'darkMetal', 'z', c, R * 0.16, h, h + min(14 * MM, Z * 0.06));
  const w = min(7 * MM, Y * 0.03);
  // The handle over its back, the spout from its front: drawn in (z, y) and run across x.
  s.extrude('handle', 'darkMetal', 'x', [[Y / 2 - w, h * 0.92], [Y / 2 + w, h * 0.92], [Y / 2 + w, Z], [Y / 2 - w, Z]], c[0] - R * 0.5, c[0] + R * 0.5);
  s.extrude('handle', 'darkMetal', 'x', [[Y / 2 - w, h * 0.55], [Y / 2 + w, h * 0.55], [Y / 2 + w, Z - w * 2], [Y / 2 - w, Z - w * 2]], c[0] - R * 0.55, c[0] - R * 0.45);
  s.extrude('spout', 'stainless', 'x', [[c[1] - R * 0.7, h * 0.35], [c[1] - R * 0.85, h * 0.35], [w, h * 0.85], [w * 3, h * 0.9]], c[0] - w, c[0] + w);
};

/** Three canisters, tall to short, with oak lids. */
const canisters: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const r = min(X / 2, Y / 6) * 0.96;
  const glaze = pick<ModelRole>(ctx.seed ?? 0, 0, ['ceramic', 'slate', 'sage']);
  [1, 0.83, 0.66].forEach((f, i) => {
    const c: V2 = [X / 2, Y * (1 / 6 + i / 3)];
    const lid = min(22 * MM, Z * 0.1);
    s.cylinder('canister', glaze, 'z', c, r, 0, Z * f - lid);
    s.cylinder('lid', 'wood', 'z', c, r, Z * f - lid, Z * f);
  });
};

/** A towel bar and a towel folded over it. */
const towelBar: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const metal = pick<ModelRole>(ctx.seed ?? 0, 0, ['brass', 'stainless']);
  const r = min(9 * MM, X * 0.1);
  const bx = X * 0.55;
  const bz = Z - r * 2.6;
  for (const y of [Y * 0.02, Y * 0.98 - 12 * MM]) s.box('post', metal, 0, y, bz - 8 * MM, bx, y + 12 * MM, bz + 8 * MM);
  s.cylinder('bar', metal, 'y', [bz, bx], r, Y * 0.02, Y * 0.98);
  const t = min(8 * MM, X * 0.09);
  const role = pick<ModelRole>(ctx.seed ?? 0, 1, ['linen', 'linen', 'sage', 'slate', 'canvas']);
  // Folded over the bar: a long fall in front, a shorter one behind, joined over the top.
  const section: V2[] = [
    [Z * 0.18, bx - r - t],
    [Z * 0.18, bx - r],
    [bz, bx - r],
    [bz, bx + r],
    [0, bx + r],
    [0, bx + r + t],
    [Z, bx + r + t],
    [Z, bx - r - t],
  ];
  s.extrude('towel', role, 'y', section, Y * 0.12, Y * 0.88);
};

/** Three towels folded and stacked. */
const towels: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const h = Z / 3;
  for (let i = 0; i < 3; i++) {
    const role = i === 1 ? pick<ModelRole>(ctx.seed ?? 0, 0, ['sage', 'slate', 'canvas', 'clay']) : 'linen';
    const e = i * min(6 * MM, X * 0.03);
    s.extrude('towel', role, 'y', rounded(h * i, e, h * (i + 1), X - e, h * 0.35), e, Y - e);
  }
};

/** A soap dispenser and a tumbler on a stone tray. */
const soapSet: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const tray = min(12 * MM, Z * 0.07);
  s.extrude('tray', pick<ModelRole>(ctx.seed ?? 0, 0, ['stone', 'darkMetal', 'wood']), 'z', rounded(0, 0, X, Y, min(X, Y) * 0.15), 0, tray);
  const r = min(X * 0.32, Y * 0.18);
  const cb: V2 = [X / 2, Y * 0.28];
  const hb = Z * 0.66;
  s.lathe('bottle', pick<ModelRole>(ctx.seed ?? 0, 1, ['ceramic', 'clay', 'slate']), 'z', cb, [[0, tray], [r, tray], [r, hb * 0.86], [r * 0.4, hb], [0, hb]]);
  s.cylinder('pump', 'brass', 'z', cb, r * 0.22, hb, Z * 0.86);
  s.box('pump', 'brass', cb[0] - r * 0.2, cb[1] - r * 0.25, Z * 0.86, cb[0] + r * 0.2, cb[1] + r * 0.9, Z * 0.93);
  const ct: V2 = [X / 2, Y * 0.72];
  s.lathe('tumbler', 'ceramic', 'z', ct, [[r * 0.75, tray], [r * 0.9, Z * 0.55], [r * 0.75, Z * 0.55], [r * 0.62, tray + 6 * MM]]);
  s.cylinder('tumbler', 'ceramic', 'z', ct, r * 0.62, tray, tray + 6 * MM);
};

/** Decor by family: what an item of the library of each prefix is drawn as. */
export const DECOR: Readonly<Record<string, Model>> = {
  rug,
  runner: rug,
  'bath-mat': bathMat,
  art,
  mirror,
  'lamp-floor': floorLamp,
  'lamp-table': tableLamp,
  'plant-tree': tree,
  'plant-floor': bladePlant,
  'plant-small': smallPlant,
  cushion,
  'throw-sofa': sofaThrow,
  'throw-bed': bedThrow,
  curtains,
  'blind-roman': romanBlind,
  tv: television,
  books,
  'vase-stems': vase,
  'bowl-fruit': fruitBowl,
  'cutting-board': cuttingBoard,
  kettle,
  canisters,
  'towel-bar': towelBar,
  towels,
  'soap-set': soapSet,
};

/** The families, longest first, so `lamp-floor` is found before a shorter prefix could be. */
const FAMILIES = Object.keys(DECOR).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

