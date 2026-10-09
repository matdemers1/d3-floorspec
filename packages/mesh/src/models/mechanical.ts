/**
 * FS_mechanical's gas appliances: a range, cooktop, oven or dryer drawn as FS_furniture's are; a
 * grill on its cart; a fireplace in its surround — or, set out low and round, a fire pit.
 */
import { lantern } from './electrical.js';
import { legs, min, MM, type Model } from './common.js';
import { APPLIANCES, cooktop, range, wallOven } from './furniture.js';

const grill: Model = (s) => {
  const { X, Y, Z } = s;
  legs(s, 'darkMetal', X * 0.1, Y * 0.25, X * 0.9, Y * 0.75, 0, Z * 0.12, min(40 * MM, X * 0.06));
  s.box('cart', 'darkMetal', X * 0.1, Y * 0.25, Z * 0.12, X * 0.9, Y * 0.75, Z * 0.55);
  s.box('shelf', 'stainless', X * 0.15, 0, Z * 0.55, X * 0.85, Y * 0.25, Z * 0.58);
  s.box('shelf', 'stainless', X * 0.15, Y * 0.75, Z * 0.55, X * 0.85, Y, Z * 0.58);
  s.box('firebox', 'stainless', X * 0.05, Y * 0.25, Z * 0.55, X * 0.95, Y * 0.75, Z * 0.72);
  // The hood: a half-octagon across the firebox, drawn in (z, x) and run along y.
  s.extrude('hood', 'stainless', 'y', [
    [Z * 0.72, X * 0.05],
    [Z * 0.72, X * 0.95],
    [Z * 0.86, X * 0.95],
    [Z * 0.95, X * 0.75],
    [Z * 0.95, X * 0.25],
    [Z * 0.86, X * 0.05],
  ], Y * 0.25, Y * 0.75);
  const r = min(10 * MM, X * 0.02);
  s.cylinder('handle', 'stainless', 'y', [Z * 0.84, X - r], r, Y * 0.32, Y * 0.68);
  for (const fy of [0.35, 0.5, 0.65]) s.cylinder('knob', 'darkMetal', 'x', [Y * fy, Z * 0.63], min(15 * MM, Z * 0.03), X * 0.95, X * 0.98);
};

/** A fireplace: hearth, surround, a dark firebox behind glass with its flame, a mantel, the breast above. */
const fireplace: Model = (s) => {
  const { X, Y, Z } = s;
  if (Z < 0.6 * min(X, Y) && X < 1.35 * Y && Y < 1.35 * X) {
    // A fire pit: a round stone bowl, embers and logs in it.
    const R = min(X, Y) / 2;
    const c = [X / 2, Y / 2] as const;
    s.lathe('bowl', 'stone', 'z', c, [
      [0, 0],
      [R * 0.85, 0],
      [R, Z * 0.9],
      [R, Z],
      [R * 0.8, Z],
      [R * 0.75, Z * 0.35],
      [0, Z * 0.35],
    ]);
    s.cylinder('embers', 'lens', 'z', c, R * 0.55, Z * 0.35, Z * 0.42);
    s.box('log', 'wood', X / 2 - R * 0.45, Y / 2 - R * 0.08, Z * 0.42, X / 2 + R * 0.45, Y / 2 + R * 0.08, Z * 0.52);
    s.box('log', 'wood', X / 2 - R * 0.08, Y / 2 - R * 0.45, Z * 0.52, X / 2 + R * 0.08, Y / 2 + R * 0.45, Z * 0.62);
    return;
  }
  const hz = min(60 * MM, Z * 0.06);
  s.box('hearth', 'stone', 0, 0, 0, X, Y, hz);
  const face = X * 0.9;
  s.box('pier', 'stone', 0, 0, hz, face, Y * 0.18, Z * 0.8);
  s.box('pier', 'stone', 0, Y * 0.82, hz, face, Y, Z * 0.8);
  s.box('header', 'stone', 0, Y * 0.18, Z * 0.62, face, Y * 0.82, Z * 0.8);
  // The firebox: a dark back, cheeks and floor lining the opening, the flame over its logs.
  const lin = min(10 * MM, Y * 0.01);
  s.box('firebox', 'darkMetal', 0, Y * 0.18, hz, X * 0.45, Y * 0.82, Z * 0.62);
  s.box('cheek', 'darkMetal', X * 0.45, Y * 0.18, hz, face - lin, Y * 0.18 + lin, Z * 0.62);
  s.box('cheek', 'darkMetal', X * 0.45, Y * 0.82 - lin, hz, face - lin, Y * 0.82, Z * 0.62);
  s.box('floor', 'darkMetal', X * 0.45, Y * 0.18 + lin, hz, face - lin, Y * 0.82 - lin, hz + lin);
  const r = min(Y * 0.08, X * 0.1);
  for (const [fy, h] of [[0.36, 0.16], [0.5, 0.24], [0.64, 0.18]] as const) s.lathe('flame', 'lens', 'z', [X * 0.56, Y * fy], [[0, hz + lin], [r, hz + lin], [0, hz + Z * h]]);
  s.box('log', 'wood', X * 0.62, Y * 0.26, hz + lin, X * 0.7, Y * 0.74, hz + Z * 0.05);
  s.box('log', 'wood', X * 0.56, Y * 0.32, hz + Z * 0.05, X * 0.64, Y * 0.68, hz + Z * 0.09);
  s.box('mantel', 'wood', 0, 0, Z * 0.8, X, Y, Z * 0.86);
  s.box('breast', 'stone', 0, Y * 0.1, Z * 0.86, X * 0.7, Y * 0.9, Z);
};

/** FS_mechanical 2.4: a gas appliance by its `appliance`. */
export const GAS_APPLIANCES: Readonly<Record<string, Model>> = {
  range,
  cooktop,
  oven: wallOven,
  dryer: APPLIANCES['dryer']!,
  grill,
  fireplace,
  lamp: lantern,
};
