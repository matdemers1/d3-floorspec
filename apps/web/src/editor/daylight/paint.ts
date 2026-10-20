import { useEffect, useState } from 'react';
import { bandOf, sunBandOf, SUN_BAND_COLOUR, type DaylightBand, type DaylightGrid } from '@floorspec/analysis';
import type { DaylightMeasure } from './state';

/**
 * How a study is drawn (FLR-T-14.7): each cell of a level's grid in its band's colour — four named
 * bands, never a rainbow — softened at its edges, with the brightest band hatched and the dimmest
 * dotted so the colour is never the only cue (the read-me's "read the colour twice"). The colours are
 * the stylesheet's (daylight.css), read in the page's theme; the same picture is the plan's overlay
 * and the 3D view's floor texture.
 */

export type BandColours = Readonly<Record<DaylightBand, string>>;

const FALLBACK: BandColours = { bright: 'goldenrod', useful: 'seagreen', lamp: 'steelblue', dim: 'midnightblue' };

/** The band colours in the page's theme: daylight.css's custom properties. */
export function readBandColours(el: Element = document.documentElement): BandColours {
  const s = getComputedStyle(el);
  const v = (band: DaylightBand): string => s.getPropertyValue(`--fs-daylight-${band}`).trim() || FALLBACK[band];
  return { bright: v('bright'), useful: v('useful'), lamp: v('lamp'), dim: v('dim') };
}

/** The band colours, read again when the theme changes. */
export function useBandColours(): BandColours {
  const [colours, setColours] = useState<BandColours>(FALLBACK);
  useEffect(() => {
    const update = () => { setColours(readBandColours()); };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', update);
    return () => {
      observer.disconnect();
      query.removeEventListener('change', update);
    };
  }, []);
  return colours;
}

/** A cell's band, for what is shown; null outside every room. */
export function cellBand(grid: DaylightGrid, i: number, measure: DaylightMeasure): DaylightBand | null {
  if (measure === 'illuminance') {
    const v = grid.lux[i] ?? -1;
    return v < 0 ? null : bandOf(v);
  }
  const h = grid.sunYear[i] ?? -1;
  return h < 0 ? null : SUN_BAND_COLOUR[sunBandOf(h)];
}

/** Pixels a cell is drawn at: enough for the hatching to read. */
export const CELL_PX = 8;

/**
 * A level's study as a picture: north up, `CELL_PX` a cell, transparent outside the rooms. `alpha`
 * is how strongly the colour lies over the floor.
 */
export function paintGrid(grid: DaylightGrid, measure: DaylightMeasure, colours: BandColours, alpha = 0.62): HTMLCanvasElement {
  const { columns: W, rows: H } = grid;
  // One pixel a cell first, then drawn up smoothly: soft edges at the walls, as light has.
  const small = document.createElement('canvas');
  small.width = W;
  small.height = H;
  const sc = small.getContext('2d');
  const big = document.createElement('canvas');
  big.width = W * CELL_PX;
  big.height = H * CELL_PX;
  const bc = big.getContext('2d');
  if (sc === null || bc === null) return big;
  const bands: (DaylightBand | null)[] = [];
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const band = cellBand(grid, j * W + i, measure);
      bands.push(band);
      if (band === null) continue;
      sc.fillStyle = colours[band];
      // Row 0 is the southernmost: drawn at the bottom.
      sc.fillRect(i, H - 1 - j, 1, 1);
    }
  bc.globalAlpha = alpha;
  bc.imageSmoothingEnabled = true;
  bc.imageSmoothingQuality = 'high';
  bc.drawImage(small, 0, 0, big.width, big.height);
  bc.globalAlpha = 1;
  // The second cue: hatching over the brightest band, dots over the dimmest.
  bc.lineWidth = 1.25;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const band = bands[j * W + i];
      if (band !== 'bright' && band !== 'dim') continue;
      const x = i * CELL_PX;
      const y = (H - 1 - j) * CELL_PX;
      if (band === 'bright') {
        bc.strokeStyle = colours.bright;
        bc.beginPath();
        bc.moveTo(x, y + CELL_PX);
        bc.lineTo(x + CELL_PX, y);
        bc.stroke();
      } else {
        bc.fillStyle = colours.lamp;
        bc.fillRect(x + CELL_PX / 2 - 1, y + CELL_PX / 2 - 1, 2, 2);
      }
    }
  return big;
}

/** A flag's pill on screen: its pin (x, y) and its size, pixels. */
export interface Pill {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The gap between a pin and its pill, and between two pills, pixels. */
const GAP = 6;

/**
 * How far to lift each pill above its pin so no two overlap: the lowest on screen keeps its place,
 * and each one above it rises past any it would cover. Pills are centred over their pins.
 */
export function declutter(pills: readonly Pill[]): number[] {
  const order = pills.map((p, i) => ({ p, i })).sort((a, b) => b.p.y - a.p.y || a.p.x - b.p.x);
  const placed: { l: number; r: number; t: number; b: number }[] = [];
  const lift = new Array<number>(pills.length).fill(0);
  for (const { p, i } of order) {
    const l = p.x - p.w / 2;
    const r = p.x + p.w / 2;
    let b = p.y - GAP;
    for (let moved = true, guard = 0; moved && guard < 64; guard++) {
      moved = false;
      for (const q of placed) {
        if (l < q.r + GAP && r > q.l - GAP && b > q.t - GAP && b - p.h < q.b + GAP) {
          b = q.t - GAP;
          moved = true;
        }
      }
    }
    placed.push({ l, r, t: b - p.h, b });
    lift[i] = p.y - GAP - b;
  }
  return lift;
}
