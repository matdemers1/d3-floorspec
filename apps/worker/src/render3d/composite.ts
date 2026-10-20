/**
 * A matched pair's composites (FLR-T-14.4): two pictures of one size from one camera — 8-bit RGB,
 * rows top to bottom — swiped at a divider, or side by side. Shared by the path-traced pair export
 * (pathtrace/pair.ts) and the rasterized comparison an agent asks for (render3d, `compare`).
 */

/** The divider's and the gap's colour, and the divider's width, pixels: a light line, as the editor's. */
const LINE: readonly [number, number, number] = [245, 245, 245];
const EDGE: readonly [number, number, number] = [32, 32, 36];
export const GAP = 8;

/**
 * A's left part and B's right part of two pictures of one size (8-bit RGB, rows top to bottom): the
 * divider at `at` (0–1 of the width), a light line two pixels wide edged in dark.
 */
export function swipeComposite(a: Uint8Array, b: Uint8Array, width: number, height: number, at = 0.5): Uint8Array {
  if (a.byteLength !== width * height * 3 || b.byteLength !== a.byteLength) throw new RangeError('the two pictures are not the same size');
  const x0 = Math.round(Math.min(1, Math.max(0, at)) * width);
  const out = new Uint8Array(a.byteLength);
  for (let y = 0; y < height; y++) {
    const row = y * width * 3;
    out.set(a.subarray(row, row + x0 * 3), row);
    out.set(b.subarray(row + x0 * 3, row + width * 3), row + x0 * 3);
    for (let dx = -2; dx < 2; dx++) {
      const x = x0 + dx;
      if (x < 0 || x >= width) continue;
      const c = dx === -2 || dx === 1 ? EDGE : LINE;
      out.set(c, row + x * 3);
    }
  }
  return out;
}

/** Two pictures of one size side by side, `GAP` pixels of dark between them. */
export function sideBySideComposite(a: Uint8Array, b: Uint8Array, width: number, height: number): { rgb: Uint8Array; width: number; height: number } {
  if (a.byteLength !== width * height * 3 || b.byteLength !== a.byteLength) throw new RangeError('the two pictures are not the same size');
  const w = width * 2 + GAP;
  const out = new Uint8Array(w * height * 3);
  for (let y = 0; y < height; y++) {
    const row = y * w * 3;
    out.set(a.subarray(y * width * 3, (y + 1) * width * 3), row);
    for (let x = width; x < width + GAP; x++) out.set(EDGE, row + x * 3);
    out.set(b.subarray(y * width * 3, (y + 1) * width * 3), row + (width + GAP) * 3);
  }
  return { rgb: out, width: w, height };
}

