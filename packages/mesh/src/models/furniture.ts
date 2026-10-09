/**
 * FS_furniture's casework, pieces and appliances (FS_furniture 2.2–2.5). Every one stands with its
 * back at x = 0 — against the wall it is set by — and its front, the side it is used from, at x = X.
 */
import { doors, drawer, drawers, legs, max, min, MM, rect, type Front, type Model, type ModelContext } from './common.js';
import type { Sketch } from './sketch.js';

// ─── Casework ────────────────────────────────────────────────────────────────────────────────

/** A carcass: a block, or — under a sink — sides, back and a bottom kept clear of the basins. */
function carcass(s: Sketch, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, ctx: ModelContext): void {
  if (ctx.cutouts.length === 0) {
    s.box('carcass', 'wood', x0, y0, z0, x1, y1, z1);
    return;
  }
  const low = min(z1, ...ctx.cutouts.map((c) => c.bottom - 2 * MM));
  // Sides and back no thicker than the counter's edge beside the cut-outs, so none shows in a basin.
  const ys = ctx.cutouts.flatMap((c) => c.outline.map((p) => p[1]));
  const xs = ctx.cutouts.flatMap((c) => c.outline.map((p) => p[0]));
  const t = min(18 * MM, (y1 - y0) * 0.05, (x1 - x0) * 0.05, min(...ys) - y0 - 2 * MM, y1 - max(...ys) - 2 * MM, min(...xs) - x0 - 2 * MM);
  if (low - z0 > 4 * MM) s.box('carcass', 'wood', x0, y0, z0, x1, y1, low);
  if (t < 2 * MM) return;
  s.box('side', 'wood', x0, y0, max(z0, low), x1, y0 + t, z1);
  s.box('side', 'wood', x0, y1 - t, max(z0, low), x1, y1, z1);
  s.box('back', 'wood', x0, y0 + t, max(z0, low), x0 + t, y1 - t, z1);
}

/** The cabinet-maker's proportions for a box: counter, overhang, toe kick, door thickness. */
function cabinet(s: Sketch): { t: number; ov: number; kick: number; kd: number; dt: number } {
  const { X, Z } = s;
  return { t: min(40 * MM, Z * 0.05), ov: min(25 * MM, X * 0.05), kick: min(100 * MM, Z * 0.12), kd: min(75 * MM, X * 0.1), dt: min(19 * MM, X * 0.04) };
}

/** A base cabinet: a stone counter top overhanging its front, a recessed toe kick, a drawer over its doors. */
const baseCabinet: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const c = cabinet(s);
  const f: Front = { x0: X - c.ov - c.dt, x1: X - c.ov, pull: c.ov - 2 * MM };
  s.extrude('top', 'stone', 'z', rect(0, 0, X, Y), Z - c.t, Z, ctx.cutouts.map((k) => k.outline));
  const top = Z - c.t;
  carcass(s, 0, 0, f.x0, Y, c.kick, top, ctx);
  s.box('kick', 'darkMetal', 0, 0, 0, f.x0 - c.kd, Y, c.kick);
  const dh = min(150 * MM, (top - c.kick) * 0.22);
  drawers(s, f, 0, Y, top - dh, top, 1, Y >= 1000 * MM ? 2 : 1);
  doors(s, f, 0, Y, c.kick, top - dh, 'top');
};

/** A vanity: a base cabinet with a false drawer front over a pair of doors. */
const vanity: Model = baseCabinet;

/** A wall cabinet: hung, doors to its underside, pulls low. */
const wallCabinet: Model = (s) => {
  const { X, Y, Z } = s;
  const hd = min(22 * MM, X * 0.06);
  const f: Front = { x0: X - hd - min(19 * MM, X * 0.05), x1: X - hd, pull: hd };
  s.box('carcass', 'wood', 0, 0, 0, f.x0, Y, Z);
  doors(s, f, 0, Y, 0, Z, 'bottom');
};

/** A tall cabinet: a pantry's doors, lower and upper, on a toe kick. */
const tallCabinet: Model = (s) => {
  const { X, Y, Z } = s;
  const c = cabinet(s);
  const hd = min(22 * MM, X * 0.06);
  const f: Front = { x0: X - hd - c.dt, x1: X - hd, pull: hd };
  s.box('carcass', 'wood', 0, 0, c.kick, f.x0, Y, Z);
  s.box('kick', 'darkMetal', 0, 0, 0, f.x0 - c.kd, Y, c.kick);
  const split = c.kick + (Z - c.kick) * 0.55;
  doors(s, f, 0, Y, c.kick, split, 'top');
  doors(s, f, 0, Y, split, Z, 'bottom');
};

/** An island: a counter top overhanging every side — deeply at its back, for stools — over drawers and doors. */
const island: Model = (s, _el, ctx) => {
  const { X, Y, Z } = s;
  const c = cabinet(s);
  const seat = X >= 800 * MM ? min(250 * MM, X * 0.3) : c.ov;
  const f: Front = { x0: X - c.ov - c.dt, x1: X - c.ov, pull: c.ov - 2 * MM };
  s.extrude('top', 'stone', 'z', rect(0, 0, X, Y), Z - c.t, Z, ctx.cutouts.map((k) => k.outline));
  const top = Z - c.t;
  const [y0, y1] = [c.ov, Y - c.ov];
  carcass(s, seat, y0, f.x0, y1, c.kick, top, ctx);
  s.box('kick', 'darkMetal', seat + c.kd, y0 + c.kd, 0, f.x0 - c.kd, y1 - c.kd, c.kick);
  const n = max(1, Math.round((y1 - y0) / (600 * MM)));
  const dh = min(150 * MM, (top - c.kick) * 0.22);
  for (let i = 0; i < n; i++) {
    const a = y0 + ((y1 - y0) * i) / n;
    const b = y0 + ((y1 - y0) * (i + 1)) / n;
    drawer(s, f, a, b, top - dh, top);
    doors(s, f, a, b, c.kick, top - dh, 'top', false);
  }
};

/** Shelving, and a bookcase: sides, top, plinth, back and shelves, open at the front, books on some. */
const bookcase: Model = (s) => {
  const { X, Y, Z } = s;
  const t = min(18 * MM, Y * 0.04, Z * 0.03);
  const plinth = min(70 * MM, Z * 0.06);
  const back = min(6 * MM, X * 0.03);
  s.box('side', 'wood', 0, 0, 0, X, t, Z);
  s.box('side', 'wood', 0, Y - t, 0, X, Y, Z);
  s.box('top', 'wood', 0, t, Z - t, X, Y - t, Z);
  s.box('plinth', 'wood', 0, t, 0, X, Y - t, plinth);
  s.box('back', 'wood', 0, t, plinth, back, Y - t, Z - t);
  const n = max(1, Math.floor((Z - plinth - t) / (320 * MM)));
  const gap = (Z - plinth - t) / n;
  for (let i = 0; i < n; i++) {
    const z = plinth + gap * i;
    if (i > 0) s.box('shelf', 'wood', back, t, z - t / 2, X, Y - t, z + t / 2);
    if (i % 2 === 1 || n === 1) continue;
    // A row of books along the shelf, a few heights, leaning on nothing.
    const h0 = z + (i > 0 ? t / 2 : 0);
    const room = gap - t;
    let y = t + 10 * MM;
    for (let k = 0; y < Y - t - 40 * MM && k < 40; k++) {
      const w = (22 + ((k * 7) % 4) * 6) * MM;
      const h = room * (0.6 + ((k * 5) % 3) * 0.1);
      const end = min(y + w, Y - t - 10 * MM);
      s.box('book', k % 3 === 0 ? 'fabric' : k % 3 === 1 ? 'cushion' : 'linen', back, y, h0, X * 0.85, end, h0 + h);
      y = end + (k % 5 === 4 ? 30 * MM : 1 * MM);
    }
  }
};

/** FS_furniture 2.4: casework by its `category`. */
export const CASEWORK: Readonly<Record<string, Model>> = { baseCabinet, wallCabinet, tallCabinet, island, vanity, shelving: bookcase };

// ─── Pieces ──────────────────────────────────────────────────────────────────────────────────

/** A sofa, or an armchair (one seat): legs, a base, arms, a back, and seat and back cushions. */
function upholstered(seats: (s: Sketch, inner: number) => number): Model {
  return (s, el) => {
    const { X, Y, Z } = s;
    const legH = min(100 * MM, Z * 0.12);
    const arm = min(180 * MM, Y * 0.14);
    const seatTop = max(legH + Z * 0.2, min(Z * 0.52, 450 * MM));
    const ch = min(130 * MM, (seatTop - legH) * 0.45);
    const backD = min(220 * MM, X * 0.25);
    const lt = min(40 * MM, X * 0.05);
    legs(s, 'darkMetal', 0, 0, X, Y, 0, legH, lt, min(40 * MM, X * 0.05));
    s.box('base', 'fabric', backD, arm, legH, X, Y - arm, seatTop - ch);
    const armTop = min(Z * 0.75, seatTop + 200 * MM);
    s.box('arm', 'fabric', 0, 0, legH, X, arm, armTop);
    s.box('arm', 'fabric', 0, Y - arm, legH, X, Y, armTop);
    s.box('back', 'fabric', 0, arm, legH, backD, Y - arm, Z);
    const inner = Y - 2 * arm;
    const n = typeof el['seats'] === 'number' && el['seats'] >= 1 ? min(5, Math.floor(el['seats'])) : seats(s, inner);
    const g = 8 * MM;
    for (let i = 0; i < n; i++) {
      const a = arm + (inner * i) / n + (i === 0 ? 0 : g / 2);
      const b = arm + (inner * (i + 1)) / n - (i === n - 1 ? 0 : g / 2);
      s.box('seat', 'cushion', backD, a, seatTop - ch, X - min(10 * MM, X * 0.01), b, seatTop);
      s.box('backCushion', 'cushion', backD, a, seatTop, backD + min(150 * MM, X * 0.18), b, seatTop + (Z - seatTop) * 0.86);
    }
  };
}

const sofa = upholstered((_s, inner) => (inner >= 1500 * MM ? 3 : inner >= 900 * MM ? 2 : 1));
const armchair = upholstered(() => 1);

/** A dining chair: back posts rising into its back, front legs, a seat, a back rail. */
const chair: Model = (s) => {
  const { X, Y, Z } = s;
  const seatH = min(Z * 0.53, 460 * MM);
  const st = min(40 * MM, Z * 0.05);
  const lt = min(40 * MM, min(X, Y) * 0.08);
  s.box('post', 'wood', 0, 0, 0, lt, lt, Z);
  s.box('post', 'wood', 0, Y - lt, 0, lt, Y, Z);
  s.box('leg', 'wood', X - lt, 0, 0, X, lt, seatH - st);
  s.box('leg', 'wood', X - lt, Y - lt, 0, X, Y, seatH - st);
  // The seat a millimetre inside the legs' faces, so no two faces share a plane.
  const e = min(1 * MM, lt * 0.05);
  s.box('seat', 'cushion', e, e, seatH - st, X - e, Y - e, seatH);
  s.box('back', 'wood', 0, lt, seatH + (Z - seatH) * 0.45, lt * 0.8, Y - lt, Z * 0.97);
  s.box('rail', 'wood', 0, lt, seatH + (Z - seatH) * 0.15, lt * 0.6, Y - lt, seatH + (Z - seatH) * 0.25);
};

/** A stool: a round seat on four legs. */
const stool: Model = (s) => {
  const { X, Y, Z } = s;
  const st = min(40 * MM, Z * 0.06);
  const lt = min(35 * MM, min(X, Y) * 0.1);
  s.cylinder('seat', 'cushion', 'z', [X / 2, Y / 2], min(X, Y) / 2, Z - st, Z);
  legs(s, 'wood', 0, 0, X, Y, 0, Z - st, lt, min(X, Y) * 0.15);
};

/** A bench: a long seat on four legs. */
const bench: Model = (s) => {
  const { X, Y, Z } = s;
  const st = min(40 * MM, Z * 0.08);
  s.box('seat', 'wood', 0, 0, Z - st, X, Y, Z);
  legs(s, 'wood', 0, 0, X, Y, 0, Z - st, min(50 * MM, min(X, Y) * 0.12), min(40 * MM, Y * 0.04));
};

/** A table: its top on four legs, an apron under the top; a coffee table has a shelf instead. */
function table(shelf: boolean): Model {
  return (s) => {
    const { X, Y, Z } = s;
    const t = min(40 * MM, Z * 0.06);
    const lt = min(70 * MM, min(X, Y) * 0.08);
    const inset = min(60 * MM, min(X, Y) * 0.06);
    s.box('top', 'wood', 0, 0, Z - t, X, Y, Z);
    legs(s, 'wood', 0, 0, X, Y, 0, Z - t, lt, inset);
    const ai = inset + lt * 0.3;
    if (!shelf) s.box('apron', 'wood', ai, ai, Z - t - min(90 * MM, Z * 0.12), X - ai, Y - ai, Z - t);
    else s.box('shelf', 'wood', inset + lt, inset, Z * 0.15, X - inset - lt, Y - inset, Z * 0.15 + t * 0.6);
  };
}

/** A desk: its top on a pedestal of drawers at one end and two legs at the other. */
const desk: Model = (s) => {
  const { X, Y, Z } = s;
  const t = min(30 * MM, Z * 0.05);
  const lt = min(50 * MM, min(X, Y) * 0.07);
  s.box('top', 'wood', 0, 0, Z - t, X, Y, Z);
  const ped = min(420 * MM, Y * 0.36);
  const hd = min(20 * MM, X * 0.04);
  const f: Front = { x0: X - hd - min(19 * MM, X * 0.04), x1: X - hd, pull: hd };
  s.box('pedestal', 'wood', 0, 0, 0, f.x0, ped, Z - t);
  drawers(s, f, 0, ped, 0, Z - t, 3, 1);
  s.box('leg', 'wood', min(30 * MM, X * 0.05), Y - lt - min(30 * MM, Y * 0.03), 0, min(30 * MM, X * 0.05) + lt, Y - min(30 * MM, Y * 0.03), Z - t);
  s.box('leg', 'wood', X - lt - min(30 * MM, X * 0.05), Y - lt - min(30 * MM, Y * 0.03), 0, X - min(30 * MM, X * 0.05), Y - min(30 * MM, Y * 0.03), Z - t);
  s.box('modesty', 'wood', min(30 * MM, X * 0.05), ped, Z * 0.45, min(30 * MM, X * 0.05) + lt * 0.4, Y - lt, Z - t);
};

/** A chest of drawers: a top, a carcass on a plinth, drawers in rows and columns. */
function chest(rows: (Z: number) => number, cols: (Y: number) => number): Model {
  return (s) => {
    const { X, Y, Z } = s;
    const plinth = min(60 * MM, Z * 0.08);
    const t = min(25 * MM, Z * 0.04);
    const hd = min(22 * MM, X * 0.06);
    const f: Front = { x0: X - hd - min(19 * MM, X * 0.04), x1: X - hd, pull: hd };
    s.box('top', 'wood', 0, 0, Z - t, min(X, f.x1 + min(10 * MM, hd * 0.5)), Y, Z);
    s.box('carcass', 'wood', 0, 0, plinth, f.x0, Y, Z - t);
    s.box('plinth', 'darkMetal', 0, min(20 * MM, Y * 0.04), 0, f.x0 - min(20 * MM, X * 0.05), Y - min(20 * MM, Y * 0.04), plinth);
    drawers(s, f, 0, Y, plinth, Z - t, rows(Z), cols(Y));
  };
}

const dresser = chest((Z) => (Z > 900 * MM ? 4 : 3), (Y) => (Y >= 1000 * MM ? 2 : 1));
const nightstand = chest(() => 2, () => 1);

/** A sideboard or media unit: drawers over doors, on a plinth. */
const sideboard: Model = (s) => {
  const { X, Y, Z } = s;
  const plinth = min(80 * MM, Z * 0.1);
  const t = min(25 * MM, Z * 0.04);
  const hd = min(22 * MM, X * 0.06);
  const f: Front = { x0: X - hd - min(19 * MM, X * 0.04), x1: X - hd, pull: hd };
  s.box('top', 'wood', 0, 0, Z - t, f.x1, Y, Z);
  s.box('carcass', 'wood', 0, 0, plinth, f.x0, Y, Z - t);
  s.box('plinth', 'darkMetal', 0, min(20 * MM, Y * 0.04), 0, f.x0 - min(20 * MM, X * 0.05), Y - min(20 * MM, Y * 0.04), plinth);
  const split = Z - t - (Z - t - plinth) * 0.28;
  const cols = max(1, Math.round(Y / (500 * MM)));
  drawers(s, f, 0, Y, split, Z - t, 1, cols);
  for (let i = 0; i < cols; i++) doors(s, f, (Y * i) / cols, (Y * (i + 1)) / cols, plinth, split, 'top', false);
};

/** A wardrobe: plinth, carcass, cornice and tall doors. */
const wardrobe: Model = (s) => {
  const { X, Y, Z } = s;
  const plinth = min(80 * MM, Z * 0.05);
  const cornice = min(40 * MM, Z * 0.03);
  const hd = min(22 * MM, X * 0.05);
  const f: Front = { x0: X - hd - min(19 * MM, X * 0.04), x1: X - hd, pull: hd };
  s.box('plinth', 'darkMetal', 0, min(20 * MM, Y * 0.03), 0, f.x0 - min(20 * MM, X * 0.05), Y - min(20 * MM, Y * 0.03), plinth);
  s.box('carcass', 'wood', 0, 0, plinth, f.x0, Y, Z - cornice);
  s.box('cornice', 'wood', 0, 0, Z - cornice, f.x1, Y, Z);
  doors(s, f, 0, Y, plinth, Z - cornice, 'middle', Y >= 700 * MM);
};

/** A wall shelf: a board on two brackets. */
const shelf: Model = (s) => {
  const { X, Y, Z } = s;
  const t = min(25 * MM, Z * 0.3);
  s.box('board', 'wood', 0, 0, Z - t, X, Y, Z);
  for (const y of [Y * 0.15, Y * 0.85]) s.box('bracket', 'darkMetal', 0, y - min(10 * MM, Y * 0.02), 0, X * 0.7, y + min(10 * MM, Y * 0.02), Z - t);
};

/** A bed: a headboard, a frame, the mattress, a duvet folded at its foot, pillows at its head. */
const bed: Model = (s) => {
  const { X, Y, Z } = s;
  const hb = min(60 * MM, X * 0.04);
  const frameTop = Z * 0.32;
  const mattress = Z * 0.56;
  s.box('headboard', 'wood', 0, 0, 0, hb, Y, Z);
  s.box('frame', 'wood', hb, 0, 0, X, Y, frameTop);
  const e = min(15 * MM, Y * 0.01);
  s.box('mattress', 'linen', hb + e, e, frameTop, X - e, Y - e, mattress);
  s.box('duvet', 'fabric', X * 0.45, e / 2, mattress, X - e / 2, Y - e / 2, mattress + min(40 * MM, Z * 0.04));
  s.box('duvet', 'fabric', X * 0.45, e / 2, frameTop + (mattress - frameTop) * 0.4, X - e / 2, e, mattress);
  s.box('duvet', 'fabric', X * 0.45, Y - e, frameTop + (mattress - frameTop) * 0.4, X - e / 2, Y - e / 2, mattress);
  s.box('duvet', 'fabric', X - e, e, frameTop + (mattress - frameTop) * 0.4, X - e / 2, Y - e, mattress);
  const n = Y >= 1200 * MM ? 2 : 1;
  const pw = (Y - 2 * e) / n;
  for (let i = 0; i < n; i++) {
    const a = e + pw * i + pw * 0.08;
    s.box('pillow', 'linen', hb + min(40 * MM, X * 0.02), a, mattress, hb + min(40 * MM, X * 0.02) + min(380 * MM, X * 0.19), a + pw * 0.84, mattress + min(120 * MM, Z * 0.1));
  }
};

/** FS_furniture 2.2: a piece by its `category`. */
export const PIECES: Readonly<Record<string, Model>> = {
  sofa,
  armchair,
  chair,
  bench,
  stool,
  diningTable: table(false),
  sideTable: table(false),
  coffeeTable: table(true),
  desk,
  bed,
  crib: bed,
  nightstand,
  dresser,
  wardrobe,
  bookcase,
  sideboard,
  mediaUnit: sideboard,
  shelf,
};

// ─── Appliances ──────────────────────────────────────────────────────────────────────────────

/** A refrigerator: French doors over a freezer drawer, their handles, a grille at the toe. */
const refrigerator: Model = (s) => {
  const { X, Y, Z } = s;
  const hd = min(35 * MM, X * 0.05);
  const dt = min(50 * MM, X * 0.07);
  const f = X - hd - dt;
  s.box('body', 'stainless', 0, 0, 0, f, Y, Z);
  const kick = min(60 * MM, Z * 0.04);
  const r = 2 * MM;
  s.box('grille', 'darkMetal', f, Y * 0.05, 0, f + dt * 0.5, Y * 0.95, kick);
  const split = Z * 0.32;
  s.box('drawer', 'stainless', f, r, kick + r, f + dt, Y - r, split - r);
  s.box('handle', 'darkMetal', f + dt, Y * 0.25, split - min(70 * MM, Z * 0.05), X, Y * 0.75, split - min(50 * MM, Z * 0.035));
  const french = Y >= 750 * MM;
  const doorsAt: [number, number][] = french ? [[r, Y / 2 - r], [Y / 2 + r, Y - r]] : [[r, Y - r]];
  for (const [a, b] of doorsAt) s.box('door', 'stainless', f, a, split + r, f + dt, b, Z - r);
  const hl = (Z - split) * 0.45;
  const hz = split + (Z - split) * 0.2;
  const hw = min(15 * MM, Y * 0.02);
  if (french) {
    s.box('handle', 'darkMetal', f + dt, Y / 2 - min(60 * MM, Y * 0.07) - hw, hz, X, Y / 2 - min(60 * MM, Y * 0.07), hz + hl);
    s.box('handle', 'darkMetal', f + dt, Y / 2 + min(60 * MM, Y * 0.07), hz, X, Y / 2 + min(60 * MM, Y * 0.07) + hw, hz + hl);
  } else s.box('handle', 'darkMetal', f + dt, Y * 0.9 - hw, hz, X, Y * 0.9, hz + hl);
};

/** A freezer: one door and its handle. */
const freezer: Model = (s) => {
  const { X, Y, Z } = s;
  const hd = min(35 * MM, X * 0.05);
  const dt = min(50 * MM, X * 0.07);
  const f = X - hd - dt;
  s.box('body', 'stainless', 0, 0, 0, f, Y, Z);
  s.box('door', 'stainless', f, 2 * MM, min(60 * MM, Z * 0.04), f + dt, Y - 2 * MM, Z - 2 * MM);
  s.box('handle', 'darkMetal', f + dt, Y * 0.88, Z * 0.35, X, Y * 0.88 + min(15 * MM, Y * 0.025), Z * 0.75);
};

/** Burners on a cooktop at height z: grates' rings and their caps, two by two. */
function burners(s: Sketch, x0: number, x1: number, z: number, h: number): void {
  const { Y } = s;
  if (h < 2 * MM) return;
  const r = min(Y * 0.14, (x1 - x0) * 0.17, 110 * MM);
  for (const fx of [0.3, 0.7])
    for (const fy of [0.27, 0.73]) {
      const c = [x0 + (x1 - x0) * fx, Y * fy] as const;
      s.annulus('grate', 'darkMetal', 'z', c, r * 0.8, r, z, z + h * 0.6);
      s.cylinder('burner', 'stainless', 'z', c, r * 0.42, z, z + h);
    }
}

/** An oven door on a body's face at x: its window and the handle across its top. */
function ovenDoor(s: Sketch, x: number, dt: number, hd: number, z0: number, z1: number): void {
  const { Y } = s;
  s.box('door', 'stainless', x, Y * 0.03, z0, x + dt, Y * 0.97, z1);
  const h = z1 - z0;
  s.box('window', 'darkMetal', x + dt, Y * 0.18, z0 + h * 0.2, x + dt + min(2 * MM, hd * 0.1), Y * 0.82, z1 - h * 0.3);
  const r = min(10 * MM, hd * 0.35);
  if (r >= 2 * MM) s.cylinder('handle', 'stainless', 'y', [z1 - min(45 * MM, h * 0.1), x + dt + hd - r], r, Y * 0.1, Y * 0.9);
}

/** A range: an oven under a cooktop of burners, its knobs, a backguard when it is tall enough. */
export const range: Model = (s) => {
  const { X, Y, Z } = s;
  const hd = min(30 * MM, X * 0.05);
  const dt = min(30 * MM, X * 0.05);
  const cook = Z >= 1000 * MM ? 914 * MM : Z - min(12 * MM, Z * 0.02);
  const ct = min(15 * MM, cook * 0.03);
  const face = X - hd - dt;
  s.box('body', 'stainless', 0, 0, 0, face, Y, cook - ct);
  s.box('cooktop', 'darkMetal', 0, 0, cook - ct, X - hd, Y, cook);
  if (Z - cook >= 40 * MM) s.box('backguard', 'stainless', 0, 0, cook, min(80 * MM, X * 0.12), Y, Z);
  burners(s, Z - cook >= 40 * MM ? min(80 * MM, X * 0.12) : 0, X - hd, cook, min(12 * MM, Z - cook));
  const ctrl = min(90 * MM, cook * 0.1);
  const drawerTop = cook * 0.14;
  s.box('drawer', 'stainless', face, Y * 0.03, min(20 * MM, cook * 0.02), face + dt, Y * 0.97, drawerTop);
  ovenDoor(s, face, dt, hd, drawerTop + 2 * MM, cook - ct - ctrl);
  const kr = min(18 * MM, ctrl * 0.3, Y * 0.03);
  for (const fy of [0.12, 0.24, 0.36, 0.64, 0.76, 0.88]) s.cylinder('knob', 'darkMetal', 'x', [Y * fy, cook - ct - ctrl / 2], kr, face, face + min(25 * MM, dt + hd));
};

/** A cooktop: its glass on the counter and its burners. */
export const cooktop: Model = (s) => {
  const { X, Y, Z } = s;
  s.box('glass', 'darkMetal', 0, 0, 0, X, Y, Z * 0.6);
  burners(s, 0, X, Z * 0.6, Z * 0.35);
};

/** A wall oven: its door and window, its controls above. */
export const wallOven: Model = (s) => {
  const { X, Y, Z } = s;
  const hd = min(30 * MM, X * 0.05);
  const dt = min(30 * MM, X * 0.05);
  const face = X - hd - dt;
  s.box('body', 'stainless', 0, 0, 0, face, Y, Z);
  ovenDoor(s, face, dt, hd, Z * 0.04, Z * 0.8);
  s.box('controls', 'darkMetal', face, Y * 0.05, Z * 0.84, face + min(3 * MM, dt * 0.2), Y * 0.95, Z * 0.96);
  s.box('display', 'lens', face + min(3 * MM, dt * 0.2), Y * 0.42, Z * 0.88, face + min(4 * MM, dt * 0.25), Y * 0.58, Z * 0.92);
};

/** A microwave: its window door and its control panel. */
const microwave: Model = (s) => {
  const { X, Y, Z } = s;
  const dt = min(20 * MM, X * 0.05);
  s.box('body', 'stainless', 0, 0, 0, X - dt, Y, Z);
  s.box('door', 'darkMetal', X - dt, Y * 0.03, Z * 0.06, X, Y * 0.72, Z * 0.94);
  s.box('panel', 'darkMetal', X - dt, Y * 0.75, Z * 0.06, X - dt * 0.5, Y * 0.97, Z * 0.94);
  s.box('display', 'lens', X - dt * 0.5, Y * 0.78, Z * 0.72, X - dt * 0.3, Y * 0.94, Z * 0.86);
};

/** A dishwasher: its door, the control strip along its top, the handle. */
const dishwasher: Model = (s) => {
  const { X, Y, Z } = s;
  const hd = min(30 * MM, X * 0.05);
  const dt = min(25 * MM, X * 0.04);
  const face = X - hd - dt;
  const kick = min(90 * MM, Z * 0.1);
  s.box('body', 'stainless', 0, 0, 0, face, Y, Z);
  s.box('kick', 'darkMetal', face - min(50 * MM, X * 0.08), Y * 0.02, 0, face, Y * 0.98, kick);
  s.box('door', 'stainless', face, Y * 0.01, kick, face + dt, Y * 0.99, Z * 0.88);
  s.box('controls', 'darkMetal', face, Y * 0.01, Z * 0.89, face + dt, Y * 0.99, Z);
  const r = min(10 * MM, hd * 0.35);
  if (r >= 2 * MM) s.cylinder('handle', 'stainless', 'y', [Z * 0.8, face + dt + hd - r], r, Y * 0.15, Y * 0.85);
};

/** A front-loading washer or dryer: white body, control panel and dial, round door. */
function laundry(window: boolean): Model {
  return (s) => {
    const { X, Y, Z } = s;
    const dt = min(20 * MM, X * 0.04);
    const face = X - dt;
    s.box('body', 'porcelain', 0, 0, 0, face, Y, Z);
    const pf = X - dt * 0.3;
    s.box('panel', 'trim', face, Y * 0.03, Z * 0.84, pf, Y * 0.97, Z * 0.98);
    s.cylinder('dial', 'darkMetal', 'x', [Y * 0.78, Z * 0.91], min(30 * MM, Z * 0.05, Y * 0.06), face, X);
    s.box('display', 'lens', pf, Y * 0.36, Z * 0.88, pf + dt * 0.1, Y * 0.56, Z * 0.94);
    const R = min(Y * 0.34, Z * 0.32);
    const c = [Y / 2, Z * 0.44] as const;
    s.annulus('door', 'stainless', 'x', c, R * 0.74, R, face, X);
    s.cylinder('drum', 'darkMetal', 'x', c, R * 0.74, face, face + dt * 0.4);
    if (window) s.cylinder('window', 'glass', 'x', c, R * 0.74, face + dt * 0.4, face + dt * 0.8);
  };
}

/** FS_furniture 2.3: an appliance by its `category`. */
export const APPLIANCES: Readonly<Record<string, Model>> = {
  refrigerator,
  freezer,
  range,
  cooktop,
  wallOven,
  microwave,
  dishwasher,
  washer: laundry(true),
  dryer: laundry(false),
};
