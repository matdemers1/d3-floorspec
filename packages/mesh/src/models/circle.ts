/**
 * Round things are drawn with 24 sides, at multiples of 15°, from this table of cosines and sines
 * — written out, never computed with Math.cos at run time — so a model meshes to the same bytes in
 * every JavaScript engine (the browser-versus-Node digests, determinism.browser.test.ts).
 */

export const SIDES = 24;

/** cos 0°, 15°, …, 90°. */
const Q = [1, 0.9659258262890683, 0.8660254037844387, 0.7071067811865476, 0.5, 0.25881904510252074, 0] as const;

/** cos(15° · k), k = 0 … 23. */
export const COS: readonly number[] = Array.from({ length: SIDES }, (_, k) => (k <= 6 ? Q[k]! : k <= 12 ? -Q[12 - k]! : k <= 18 ? -Q[k - 12]! : Q[24 - k]!));
/** sin(15° · k) = cos(15° · (k − 6)). */
export const SIN: readonly number[] = Array.from({ length: SIDES }, (_, k) => COS[(k + 18) % SIDES]!);
