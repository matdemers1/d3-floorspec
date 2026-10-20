/**
 * FS_electrical's devices: a receptacle's plate and its outlet faces, a switch's plate and toggle or
 * rocker, a panel's box and door, a smoke alarm's disc, and each kind of luminaire. A wall device's
 * box stands out from the face it is hosted on (x from the wall); a ceiling device's hangs below the
 * ceiling (its top, z = Z, is the ceiling).
 */
import { SIN, COS } from './circle.js';
import { max, min, MM, type Model } from './common.js';
import type { Sketch } from './sketch.js';
import { exteriorOf, type ExteriorKind } from '@floorspec/render2d/exterior';

/** An outlet face: the face, its two slots and its ground hole, centred on (y, z). */
function outletFace(s: Sketch, x: number, y: number, z: number, w: number, h: number): void {
  const ft = min(4 * MM, (s.X - x) * 0.4);
  s.box('face', 'plate', x, y - w / 2, z - h / 2, x + ft, y + w / 2, z + h / 2);
  const sd = min(1 * MM, (s.X - x - ft) * 0.5);
  const sw = max(1.5 * MM, w * 0.07);
  const x1 = x + ft;
  // Neutral (taller) and hot slots, above the round ground.
  s.box('slot', 'darkMetal', x1, y - w * 0.22 - sw / 2, z - h * 0.02, x1 + sd, y - w * 0.22 + sw / 2, z + h * 0.34);
  s.box('slot', 'darkMetal', x1, y + w * 0.22 - sw / 2, z + h * 0.04, x1 + sd, y + w * 0.22 + sw / 2, z + h * 0.3);
  s.cylinder('ground', 'darkMetal', 'x', [y, z - h * 0.24], max(1.5 * MM, w * 0.09), x1, x1 + sd);
}

export const receptacle: Model = (s, el) => {
  const { X, Y, Z } = s;
  const pt = min(6 * MM, X * 0.3);
  s.box('plate', 'plate', 0, 0, 0, pt, Y, Z);
  const features = Array.isArray(el['features']) ? (el['features'] as unknown[]) : [];
  const single = el['outlets'] === 1;
  const w = min(Y * 0.42, 36 * MM);
  const h = min(Z * (single ? 0.4 : 0.27), 34 * MM);
  if (features.includes('gfci')) {
    // A GFCI's rectangular face, its two outlets and the test and reset buttons between them.
    const ft = min(3 * MM, (X - pt) * 0.3);
    s.box('decora', 'plate', pt, Y * 0.27, Z * 0.14, pt + ft, Y * 0.73, Z * 0.86);
    const bw = Y * 0.12;
    s.box('test', 'darkMetal', pt + ft, Y / 2 - bw * 1.1, Z * 0.47, pt + ft + min(2 * MM, (X - pt - ft) * 0.5), Y / 2 - bw * 0.1, Z * 0.53);
    s.box('reset', 'trim', pt + ft, Y / 2 + bw * 0.1, Z * 0.47, pt + ft + min(2 * MM, (X - pt - ft) * 0.5), Y / 2 + bw * 1.1, Z * 0.53);
    for (const zc of [Z * 0.29, Z * 0.71]) outletFace(s, pt + ft, Y / 2, zc, w * 0.9, h * 0.85);
    return;
  }
  for (const zc of single ? [Z / 2] : [Z * 0.3, Z * 0.7]) outletFace(s, pt, Y / 2, zc, w, h);
};

export const switchModel: Model = (s, el) => {
  const { X, Y, Z } = s;
  const pt = min(6 * MM, X * 0.3);
  s.box('plate', 'plate', 0, 0, 0, pt, Y, Z);
  const control = typeof el['control'] === 'string' ? el['control'] : 'single';
  if (['dimmer', 'smart', 'occupancy', 'timer'].includes(control)) {
    // A rocker: the decora frame and its paddle.
    const ft = min(3 * MM, (X - pt) * 0.3);
    s.box('frame', 'plate', pt, Y * 0.29, Z * 0.18, pt + ft, Y * 0.71, Z * 0.82);
    const pd = min(3 * MM, (X - pt - ft) * 0.5);
    s.box('rocker', 'plate', pt + ft, Y * 0.33, Z * 0.22, pt + ft + pd, Y * 0.67, Z * 0.78);
    if (control === 'dimmer') s.box('slider', 'darkMetal', pt + ft, Y * 0.6, Z * 0.3, pt + ft + pd * 1.2, Y * 0.64, Z * 0.7);
    return;
  }
  // A toggle: its bushing plate and the bat, thrown up.
  const bt = min(2 * MM, (X - pt) * 0.2);
  s.box('bushing', 'plate', pt, Y * 0.42, Z * 0.36, pt + bt, Y * 0.58, Z * 0.64);
  // The bat, tapering as it reaches out and up: drawn in (z, x), run across y.
  const x0 = pt + bt;
  const x1 = x0 + min(13 * MM, X - x0);
  const hw = min(4 * MM, Y * 0.04);
  s.extrude('toggle', 'plate', 'y', [
    [Z * 0.44, x0],
    [Z * 0.56, x0],
    [Z * 0.64, x1],
    [Z * 0.59, x1],
  ], Y / 2 - hw, Y / 2 + hw);
};

export const panel: Model = (s) => {
  const { X, Y, Z } = s;
  s.box('enclosure', 'stainless', 0, 0, 0, X * 0.8, Y, Z);
  s.box('door', 'trim', X * 0.8, Y * 0.06, Z * 0.05, X * 0.92, Y * 0.94, Z * 0.95);
  s.box('latch', 'darkMetal', X * 0.92, Y * 0.82, Z * 0.46, X, Y * 0.86, Z * 0.54);
};

export const alarm: Model = (s) => {
  const { X, Y, Z } = s;
  const R = min(X, Y) / 2;
  const c = [X / 2, Y / 2] as const;
  s.cylinder('base', 'plate', 'z', c, R, Z * 0.55, Z);
  s.lathe('cover', 'plate', 'z', c, [
    [0, Z * 0.06],
    [R * 0.55, Z * 0.06],
    [R * 0.8, Z * 0.3],
    [R * 0.86, Z * 0.55],
    [0, Z * 0.55],
  ]);
  s.cylinder('led', 'lens', 'z', c, min(R * 0.12, 6 * MM), 0, Z * 0.08);
};

/** A quarter-ellipse dome, its rim radius r at z1 and its crown h below it. */
const dome = (r: number, z1: number, h: number): [number, number][] => [...Array.from({ length: 7 }, (_, k): [number, number] => [r * SIN[k]!, z1 - h * COS[k]!]), [0, z1]];

/**
 * A ceiling light's canopy (its height, at the box's top) and the dome of its diffuser under it (its
 * depth below the canopy), for a box X × Y × Z: what the model draws, and where lights.ts puts its
 * lamp — inside the dome, not in the air under the box (FLR-T-13.16).
 */
export function ceilingDome(X: number, Y: number, Z: number): { readonly canopy: number; readonly depth: number } {
  const ch = min(15 * MM, Z * 0.12);
  return { canopy: ch, depth: min(Z - ch, (min(X, Y) / 2) * 0.55) };
}

const ceilingLight: Model = (s) => {
  const { X, Y, Z } = s;
  const R = min(X, Y) / 2;
  const c = [X / 2, Y / 2] as const;
  const { canopy: ch, depth } = ceilingDome(X, Y, Z);
  s.cylinder('canopy', 'trim', 'z', c, R, Z - ch, Z);
  s.lathe('dome', 'lens', 'z', c, dome(R * 0.9, Z - ch, depth));
};

const recessed: Model = (s) => {
  const { X, Y, Z } = s;
  const R = min(X, Y) / 2;
  const c = [X / 2, Y / 2] as const;
  const t = min(8 * MM, Z * 0.1);
  s.annulus('trim', 'trim', 'z', c, R * 0.72, R, Z - t, Z);
  s.cylinder('lens', 'lens', 'z', c, R * 0.72, Z - t / 2, Z);
};

const pendant: Model = (s) => {
  const { X, Y, Z } = s;
  const R = min(X, Y) / 2;
  const c = [X / 2, Y / 2] as const;
  const ch = min(20 * MM, Z * 0.08);
  s.cylinder('canopy', 'trim', 'z', c, min(R * 0.3, 60 * MM), Z - ch, Z);
  const lt = min(4 * MM, Z * 0.03);
  const sh = min(Z * 0.45, R * 1.1);
  s.cylinder('lens', 'lens', 'z', c, R * 0.8, 0, lt);
  s.lathe('shade', 'darkMetal', 'z', c, [
    [0, lt],
    [R * 0.95, lt],
    [R * 0.3, lt + sh],
    [0, lt + sh],
  ]);
  s.cylinder('cord', 'darkMetal', 'z', c, min(3 * MM, R * 0.03), lt + sh, Z - ch);
};

const sconce: Model = (s) => {
  const { X, Y, Z } = s;
  const bp = min(12 * MM, X * 0.1);
  s.box('backplate', 'trim', 0, Y * 0.36, Z * 0.3, bp, Y * 0.64, Z * 0.7);
  const r = min(X * 0.4, Y * 0.45);
  const cx = X - r;
  s.box('arm', 'darkMetal', bp, Y / 2 - min(8 * MM, Y * 0.04), Z * 0.45, cx, Y / 2 + min(8 * MM, Y * 0.04), Z * 0.5);
  s.lathe('shade', 'lens', 'z', [cx, Y / 2], [
    [0, Z * 0.2],
    [r * 0.65, Z * 0.2],
    [r, Z * 0.85],
    [0, Z * 0.85],
  ]);
};

const track: Model = (s) => {
  const { X, Y, Z } = s;
  const w = min(30 * MM, X * 0.2);
  const rh = min(25 * MM, Z * 0.15);
  s.box('rail', 'darkMetal', X / 2 - w / 2, Y * 0.03, Z - rh, X / 2 + w / 2, Y * 0.97, Z);
  const r = min(X * 0.35, Y * 0.12, 35 * MM);
  const lt = min(4 * MM, Z * 0.04);
  for (const f of [0.2, 0.5, 0.8]) {
    const c = [X / 2, Y * f] as const;
    s.cylinder('stem', 'darkMetal', 'z', c, min(5 * MM, r * 0.2), Z * 0.55, Z - rh);
    s.cylinder('head', 'darkMetal', 'z', c, r, lt, Z * 0.55);
    s.cylinder('lens', 'lens', 'z', c, r * 0.8, 0, lt);
  }
};

const underCabinet: Model = (s) => {
  const { X, Y, Z } = s;
  s.box('body', 'trim', X * 0.1, Y * 0.02, Z * 0.35, X * 0.9, Y * 0.98, Z);
  s.box('lens', 'lens', X * 0.2, Y * 0.05, 0, X * 0.8, Y * 0.95, Z * 0.35);
};

const fan: Model = (s) => {
  const { X, Y, Z } = s;
  const R = min(X, Y) / 2;
  const c = [X / 2, Y / 2] as const;
  const ch = min(20 * MM, Z * 0.1);
  s.cylinder('canopy', 'trim', 'z', c, R * 0.2, Z - ch, Z);
  s.cylinder('downrod', 'darkMetal', 'z', c, min(10 * MM, R * 0.05), Z * 0.5, Z - ch);
  s.cylinder('motor', 'stainless', 'z', c, R * 0.24, Z * 0.25, Z * 0.5);
  s.lathe('light', 'lens', 'z', c, dome(R * 0.2, Z * 0.25, Z * 0.25));
  const bt = min(8 * MM, Z * 0.05);
  const z0 = Z * 0.33;
  for (const k of [3, 9, 15, 21]) {
    const d = [COS[k]!, SIN[k]!] as const;
    const p = [-d[1], d[0]] as const;
    const at = (r: number, w: number): [number, number] => [c[0] + d[0] * r + p[0] * w, c[1] + d[1] * r + p[1] * w];
    s.extrude('blade', 'wood', 'z', [at(R * 0.22, -R * 0.08), at(R * 0.97, -R * 0.12), at(R * 0.97, R * 0.12), at(R * 0.22, R * 0.08)], z0, z0 + bt);
  }
};

export const lantern: Model = (s) => {
  const { X, Y, Z } = s;
  const pt = min(15 * MM, X * 0.08);
  s.box('plate', 'darkMetal', 0, Y * 0.36, Z * 0.25, pt, Y * 0.64, Z * 0.85);
  const w = min(X * 0.6, Y * 0.6);
  const x0 = X - w;
  const y0 = (Y - w) / 2;
  const y1 = y0 + w;
  s.box('arm', 'darkMetal', pt, Y / 2 - Y * 0.03, Z * 0.62, x0, Y / 2 + Y * 0.03, Z * 0.68);
  const e = w * 0.08;
  s.box('cap', 'darkMetal', x0, y0, Z * 0.76, X, y1, Z * 0.84);
  s.box('roof', 'darkMetal', x0 + e, y0 + e, Z * 0.84, X - e, y1 - e, Z * 0.9);
  s.box('base', 'darkMetal', x0 + e / 2, y0 + e / 2, Z * 0.2, X - e / 2, y1 - e / 2, Z * 0.26);
  s.box('glass', 'glass', x0 + e / 2, y0 + e / 2, Z * 0.26, X - e / 2, y1 - e / 2, Z * 0.76);
  const q = e * 0.6;
  for (const gx of [x0 + e / 2, X - e / 2])
    for (const gy of [y0 + e / 2, y1 - e / 2]) s.box('post', 'darkMetal', gx - q / 2, gy - q / 2, Z * 0.26, gx + q / 2, gy + q / 2, Z * 0.76);
  s.cylinder('bulb', 'lens', 'z', [x0 + w / 2, Y / 2], w * 0.14, Z * 0.32, Z * 0.6);
};

// ─── Exterior lights (FLR-T-15.5) ────────────────────────────────────────────────────────────

/** A path light: a stake, a post, a shallow cap and the lamp's lens under it. */
const pathLight: Model = (s) => {
  const { X, Y, Z } = s;
  const c = [X / 2, Y / 2] as const;
  const R = min(X, Y) / 2;
  const capH = min(25 * MM, Z * 0.08);
  const lensH = min(45 * MM, Z * 0.12);
  s.cylinder('post', 'darkMetal', 'z', c, min(12 * MM, R * 0.18), 0, Z - capH - lensH);
  s.cylinder('lens', 'lens', 'z', c, R * 0.42, Z - capH - lensH, Z - capH);
  s.lathe('cap', 'darkMetal', 'z', c, [
    [0, Z - capH],
    [R, Z - capH],
    [R * 0.5, Z],
    [0, Z],
  ]);
};

/** An uplight: a canister on a knuckle, its lens at its top. */
const uplight: Model = (s) => {
  const { X, Y, Z } = s;
  const c = [X / 2, Y / 2] as const;
  const R = min(X, Y) / 2;
  s.cylinder('stake', 'darkMetal', 'z', c, R * 0.25, 0, Z * 0.35);
  s.cylinder('canister', 'darkMetal', 'z', c, R * 0.9, Z * 0.35, Z - min(6 * MM, Z * 0.05));
  s.cylinder('lens', 'lens', 'z', c, R * 0.7, Z - min(6 * MM, Z * 0.05), Z);
};

/** A wall-washer: a short arm off its plate and a hood with its lens under it. */
const wallWash: Model = (s) => {
  const { X, Y, Z } = s;
  const pt = min(10 * MM, X * 0.12);
  s.box('plate', 'darkMetal', 0, Y * 0.3, Z * 0.2, pt, Y * 0.7, Z * 0.8);
  s.box('hood', 'darkMetal', pt, 0, Z * 0.45, X, Y, Z);
  s.box('lens', 'lens', pt + (X - pt) * 0.1, Y * 0.06, Z * 0.38, X * 0.96, Y * 0.94, Z * 0.45);
};

/** A step light: a plate in the riser, a louvre across its lens. */
const stepLight: Model = (s) => {
  const { X, Y, Z } = s;
  s.box('plate', 'darkMetal', 0, 0, 0, X * 0.5, Y, Z);
  s.box('lens', 'lens', X * 0.5, Y * 0.08, Z * 0.12, X * 0.8, Y * 0.92, Z * 0.6);
  s.box('louvre', 'darkMetal', X * 0.5, Y * 0.04, Z * 0.6, X, Y * 0.96, Z * 0.88);
};

/** String lights: a cable hung in a catenary along x, a bulb every 2', at the box's top at either end. */
const stringLights: Model = (s) => {
  const { X, Y, Z } = s;
  const n = max(2, Math.round(X / (2 * 304.8 * MM)));
  const r = min(30 * MM, Y * 0.45, Z * 0.2);
  const cable = min(4 * MM, Y * 0.08);
  const sag = Z - 2 * r - cable;
  const zAt = (t: number) => Z - cable - sag * (1 - (2 * t - 1) * (2 * t - 1));
  // The cable, in pieces between the bulbs.
  const pts = n * 2;
  for (let i = 0; i < pts; i++) {
    const t0 = i / pts;
    const t1 = (i + 1) / pts;
    const z0 = zAt((t0 + t1) / 2);
    s.box(`cable${String(i)}`, 'darkMetal', X * t0, Y / 2 - cable / 2, z0, X * t1, Y / 2 + cable / 2, z0 + cable);
  }
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const z = zAt(t);
    s.cylinder(`socket${String(i)}`, 'darkMetal', 'z', [X * t, Y / 2], r * 0.45, z - r * 0.5, z);
    s.lathe(`bulb${String(i)}`, 'lens', 'z', [X * t, Y / 2], [
      [0, z - r * 2],
      [r * 0.7, z - r * 1.7],
      [r, z - r * 1.1],
      [r * 0.5, z - r * 0.5],
      [0, z - r * 0.5],
    ]);
  }
};

const EXTERIOR_MODELS: Readonly<Record<ExteriorKind, Model>> = { path: pathLight, uplight, wallWash, step: stepLight, string: stringLights };

/** An exterior light: its kind's model, or the lantern an exterior light without one has always been. */
const exterior: Model = (s, el, ctx) => {
  const ext = exteriorOf(el);
  (ext === null ? lantern : EXTERIOR_MODELS[ext.kind])(s, el, ctx);
};

/** FS_electrical 2.4: a luminaire by its `fixture`. */
export const LIGHTS: Readonly<Record<string, Model>> = {
  ceiling: ceilingLight,
  recessed,
  pendant,
  wall: sconce,
  track,
  underCabinet,
  fan,
  exterior,
};

