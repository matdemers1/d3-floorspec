/**
 * A deterministic, edge-aware denoiser for a still: the spatial half of SVGF (Schied et al., 2017) —
 * five passes of an à-trous wavelet filter whose weights stop at edges in the first-hit normal and
 * depth, and at differences in brightness larger than the pixel's own noise (its variance, from
 * the samples). The colour is divided by the surface's albedo before filtering and multiplied back
 * after, so a texture or a painted edge stays sharp while the noise in the light is smoothed.
 *
 * Pixels that see the sky are left as they are. Every weight is a pure function of the buffers, so
 * the same trace gives the same picture.
 */

export interface Features {
  /** Three per pixel: the first surface's albedo, averaged over the samples. */
  readonly albedo: Float32Array;
  /** Three per pixel: the first surface's normal, averaged (its length shrinks at an edge). */
  readonly normal: Float32Array;
  /** One per pixel: distance to the first surface; Infinity for the sky. */
  readonly depth: Float32Array;
  /** One per pixel: the variance of a sample's luminance. */
  readonly variance: Float32Array;
}

const KERNEL = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16];

export function denoise(color: Float32Array, f: Features, width: number, height: number, passes = 5): Float32Array {
  const n = width * height;
  // Demodulate: the light reaching each surface.
  let irr = new Float32Array(3 * n);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) irr[3 * i + c] = color[3 * i + c]! / Math.max(0.02, f.albedo[3 * i + c]!);
  // The noise of the mean of the samples, blurred a little so one unlucky pixel does not stand alone.
  let variance = new Float32Array(n);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let s = 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          s += f.variance[yy * width + xx]!;
          k++;
        }
      variance[y * width + x] = s / k;
    }
  const lum = (a: Float32Array, i: number): number => 0.2126 * a[3 * i]! + 0.7152 * a[3 * i + 1]! + 0.0722 * a[3 * i + 2]!;
  for (let pass = 0; pass < passes; pass++) {
    const step = 1 << pass;
    const out = new Float32Array(3 * n);
    const outVar = new Float32Array(n);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const zp = f.depth[p]!;
        if (!Number.isFinite(zp)) {
          out[3 * p] = irr[3 * p]!;
          out[3 * p + 1] = irr[3 * p + 1]!;
          out[3 * p + 2] = irr[3 * p + 2]!;
          outVar[p] = variance[p]!;
          continue;
        }
        const npx = f.normal[3 * p]!, npy = f.normal[3 * p + 1]!, npz = f.normal[3 * p + 2]!;
        const lp = lum(irr, p);
        const sigma = 4 * Math.sqrt(Math.max(0, variance[p]!)) + 1e-4;
        let wr = 0, wg = 0, wb = 0, ws = 0, wv = 0;
        for (let j = -2; j <= 2; j++) {
          const yy = y + j * step;
          if (yy < 0 || yy >= height) continue;
          for (let i = -2; i <= 2; i++) {
            const xx = x + i * step;
            if (xx < 0 || xx >= width) continue;
            const q = yy * width + xx;
            const zq = f.depth[q]!;
            if (!Number.isFinite(zq)) continue;
            const h = KERNEL[i + 2]! * KERNEL[j + 2]!;
            const dn = Math.max(0, npx * f.normal[3 * q]! + npy * f.normal[3 * q + 1]! + npz * f.normal[3 * q + 2]!);
            const wn = dn ** 64;
            const wz = Math.exp(-Math.abs(zp - zq) / (0.02 * zp * step + 1e-3));
            const wl = Math.exp(-Math.abs(lp - lum(irr, q)) / sigma);
            const w = q === p ? h : h * wn * wz * wl;
            wr += w * irr[3 * q]!;
            wg += w * irr[3 * q + 1]!;
            wb += w * irr[3 * q + 2]!;
            ws += w;
            wv += w * w * variance[q]!;
          }
        }
        out[3 * p] = wr / ws;
        out[3 * p + 1] = wg / ws;
        out[3 * p + 2] = wb / ws;
        outVar[p] = wv / (ws * ws);
      }
    irr = out;
    variance = outVar;
  }
  const result = new Float32Array(3 * n);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) result[3 * i + c] = Number.isFinite(f.depth[i]!) ? irr[3 * i + c]! * Math.max(0.02, f.albedo[3 * i + c]!) : color[3 * i + c]!;
  return result;
}
