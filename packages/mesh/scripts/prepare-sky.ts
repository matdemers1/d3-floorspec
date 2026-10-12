/**
 * Prepare the sky maps (FLR-T-13.9) from Poly Haven's CC0 originals: `sky/SOURCES.json` names each
 * original, where it is downloaded from and its SHA-256. Run with the originals downloaded beside
 * each other in one directory:
 *
 *   pnpm --filter @d3-floorspec/server exec tsx ../../packages/mesh/scripts/prepare-sky.ts <dir-with-the-originals>
 *
 * For each map it checks the original's digest, finds its sun (or, at night, its moon) — the
 * brightest point of the upper hemisphere — and takes the disc out: within a few degrees of it, no
 * pixel is left brighter than a few times its surroundings, so the analytic sun every view adds is
 * the only sun (and the glow round it stays). Then it keeps the sky only — from the zenith down to
 * 6° under the horizon, where every view draws its own ground and haze — and writes it as a
 * run-length-encoded `.hdr` beside the sources, with the sun's place printed for `maps.ts`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeHdr, encodeHdr, type HdrImage } from '../src/sky/hdr.js';

interface Source {
  readonly id: string;
  readonly original: string;
  readonly url: string;
  readonly sha256: string;
}

const SKY = new URL('../sky/', import.meta.url);
const sources = (JSON.parse(readFileSync(new URL('SOURCES.json', SKY), 'utf8')) as { maps: Source[] }).maps;
const dir = process.argv[2];
if (dir === undefined) throw new Error('usage: prepare-sky.ts <dir-with-the-originals>');

/** Rows kept: from the zenith to this far below the horizon, degrees. */
const BELOW = 6;
const RAD = Math.PI / 180;
const lum = (d: Float32Array, i: number): number => 0.2126 * d[3 * i]! + 0.7152 * d[3 * i + 1]! + 0.0722 * d[3 * i + 2]!;

function prepare(src: HdrImage): { out: HdrImage; sun: { u: number; elevation: number; peak: number } } {
  const { width: W, height: H, data } = src;
  const d = Float32Array.from(data);
  // The brightest pixel above the horizon.
  let best = 0;
  let at = 0;
  for (let y = 0; y < H / 2; y++)
    for (let x = 0; x < W; x++) {
      const l = lum(d, y * W + x);
      if (l > best) {
        best = l;
        at = y * W + x;
      }
    }
  const sx = at % W;
  const sy = Math.floor(at / W);
  const dirOf = (x: number, y: number): [number, number, number] => {
    const az = ((x + 0.5) / W) * 2 * Math.PI;
    const el = (0.5 - (y + 0.5) / H) * Math.PI;
    return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
  };
  const s = dirOf(sx, sy);
  // Its surroundings: the mean luminance 5°–9° from it.
  let ring = 0;
  let n = 0;
  const near: number[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = dirOf(x, y);
      const a = Math.acos(Math.min(1, v[0] * s[0] + v[1] * s[1] + v[2] * s[2])) / RAD;
      if (a < 5) near.push(y * W + x);
      else if (a < 9) {
        ring += lum(d, y * W + x);
        n++;
      }
    }
  const cap = 3 * (ring / Math.max(1, n));
  for (const i of near) {
    const l = lum(d, i);
    if (l > cap) for (let c = 0; c < 3; c++) d[3 * i + c] = d[3 * i + c]! * (cap / l);
  }
  const rows = Math.round(((90 + BELOW) / 180) * H);
  const out: HdrImage = { width: W, height: rows, data: d.slice(0, rows * W * 3) };
  return { out, sun: { u: (sx + 0.5) / W, elevation: (0.5 - (sy + 0.5) / H) * 180, peak: best / cap } };
}

for (const source of sources) {
  const bytes = readFileSync(join(dir, source.original));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== source.sha256) throw new Error(`${source.original}: SHA-256 ${digest}, not the ${source.sha256} SOURCES.json records`);
  const { out, sun } = prepare(decodeHdr(bytes));
  const file = encodeHdr(out);
  writeFileSync(new URL(`${source.id}.hdr`, SKY), file);
  const kept = createHash('sha256').update(file).digest('hex');
  process.stdout.write(`${source.id}: ${String(out.width)}×${String(out.height)}, ${String(file.length)} bytes, sha256 ${kept}; sun at u ${sun.u.toFixed(5)}, elevation ${sun.elevation.toFixed(2)}° (peak ${sun.peak.toFixed(0)}× its surroundings)\n`);
}
