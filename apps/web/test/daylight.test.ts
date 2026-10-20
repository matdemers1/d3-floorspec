/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DaylightGrid, GlareFlag } from '@floorspec/analysis';
import { atOf, dayIn, otherSolstice } from '../src/editor/daylight/state';
import { cellBand, declutter } from '../src/editor/daylight/paint';
import { flagPlace } from '../src/editor/daylight/Daylight';

/**
 * FLR-T-14.7: the editor's daylight — the clock as the api reads it, the other solstice, each cell's
 * band, glare pills that never cover one another, a flag's words, and four band colours that stay
 * apart for colour-blind people (with the brightest hatched and the dimmest dotted besides).
 */

describe('the clock, as the api reads it', () => {
  it('writes the sun study’s clock with its offset', () => {
    expect(atOf({ date: '2026-06-21', minutes: 900, offset: -240 })).toBe('2026-06-21T15:00-04:00');
    expect(atOf({ date: '2026-12-21', minutes: 15 * 60 + 30, offset: 330 })).toBe('2026-12-21T15:30+05:30');
    expect(atOf({ date: '2026-12-21', minutes: 0, offset: 0 })).toBe('2026-12-21T00:00+00:00');
  });

  it('compares June with December and back, in the same year', () => {
    expect(otherSolstice('2026-06-21')).toBe('2026-12-21');
    expect(otherSolstice('2026-04-01')).toBe('2026-12-21');
    expect(otherSolstice('2026-12-21')).toBe('2026-06-21');
    expect(otherSolstice('2027-01-10')).toBe('2027-06-21');
    expect(dayIn('2031-10-19', 3, 20)).toBe('2031-03-20');
  });
});

describe('the picture', () => {
  const grid: DaylightGrid = { level: 'L1', origin: [0, 0], spacing: 0.3048, columns: 4, rows: 1, elevation: 0, lux: [-1, 50, 500, 5000], sunToday: [-1, 0, 1, 2], sunYear: [-1, 0, 300, 2000] };

  it('bands each cell by what is shown, and leaves cells outside the rooms empty', () => {
    expect([0, 1, 2, 3].map((i) => cellBand(grid, i, 'illuminance'))).toEqual([null, 'dim', 'useful', 'bright']);
    // A year of sun-hours in the same four colours: none, some, lots.
    expect([0, 1, 2, 3].map((i) => cellBand(grid, i, 'sunHours'))).toEqual([null, 'dim', 'useful', 'bright']);
  });

  it('lifts glare pills clear of one another, the lowest staying put', () => {
    const lifts = declutter([
      { x: 100, y: 200, w: 160, h: 24 },
      { x: 110, y: 195, w: 160, h: 24 },
      { x: 600, y: 190, w: 160, h: 24 },
    ]);
    expect(lifts[0]).toBe(0);
    expect(lifts[2]).toBe(0);
    // The second rose past the first: its bottom above the first's top, with a gap.
    expect(195 - 6 - lifts[1]!).toBeLessThanOrEqual(200 - 6 - 24 - 6);
  });

  it('names a flag as the board does: "Den desk", "Primary bed"', () => {
    const flag = (kind: 'desk' | 'bed', roomName: string): GlareFlag => ({ id: 'X', name: kind, kind, roomName, level: 'L1', at: [0, 0], z: 0, hours: [], now: false, low: false });
    expect(flagPlace(flag('desk', 'Den'))).toBe('Den');
    expect(flagPlace(flag('bed', 'Primary bedroom'))).toBe('Primary');
    expect(flagPlace(flag('bed', 'Bedroom 2'))).toBe('Bedroom 2');
  });
});

describe('the four bands for colour-blind people', () => {
  type Rgb = readonly [number, number, number];
  const SIM: Readonly<Record<string, readonly Rgb[]>> = {
    normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
    tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
  };
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as unknown as Rgb;
  const lab = (l: Rgb): Rgb => {
    const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
    const x = f((0.4124564 * l[0] + 0.3575761 * l[1] + 0.1804375 * l[2]) / 0.95047);
    const y = f(0.2126729 * l[0] + 0.7151522 * l[1] + 0.072175 * l[2]);
    const z = f((0.0193339 * l[0] + 0.119192 * l[1] + 0.9503041 * l[2]) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const css = readFileSync(new URL('../src/editor/daylight/daylight.css', import.meta.url), 'utf8');
  const hexOf = (band: string): string => new RegExp(`--fs-daylight-${band}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1] ?? '';
  const ui = dirname(createRequire(import.meta.url).resolve('@d3cloud/ui/package.json'));
  const token = (theme: 'light' | 'dark', name: string): string => {
    const tokens = JSON.parse(readFileSync(join(ui, 'src/tokens', `color.semantic.${theme}.json`), 'utf8')) as { color: Record<string, { $extensions?: { 'd3.resolved'?: string } }> };
    return tokens.color[name]?.$extensions?.['d3.resolved'] ?? '';
  };

  it('keeps every pair apart under protanopia, deuteranopia and tritanopia, in both themes', () => {
    expect(css).toMatch(/--fs-daylight-bright:\s*var\(--color-warning\)/);
    expect(css).toMatch(/--fs-daylight-useful:\s*var\(--color-success\)/);
    for (const theme of ['light', 'dark'] as const) {
      const bands: Record<string, string> = { bright: token(theme, 'warning'), useful: token(theme, 'success'), lamp: hexOf('lamp'), dim: hexOf('dim') };
      for (const v of Object.values(bands)) expect(v).toMatch(/^#[0-9a-f]{6}$/i);
      for (const [sim, m] of Object.entries(SIM)) {
        const seen = Object.fromEntries(Object.entries(bands).map(([k, hex]) => {
          const c = rgb(hex);
          const s = m.map((row) => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))) as unknown as Rgb;
          return [k, lab(s)];
        }));
        const names = Object.keys(seen);
        for (let i = 0; i < names.length; i++)
          for (let j = i + 1; j < names.length; j++) {
            const [a, b] = [seen[names[i]!]!, seen[names[j]!]!];
            expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), `${theme} ${sim}: ${names[i]!} and ${names[j]!}`).toBeGreaterThanOrEqual(15);
          }
      }
    }
  });

  it('never leaves colour the only cue: bright is hatched and dim dotted in every swatch', () => {
    expect(css).toMatch(/\.fs-daylight__swatch--bright\s*{[^}]*repeating-linear-gradient/);
    expect(css).toMatch(/\.fs-daylight__swatch--dim\s*{[^}]*radial-gradient/);
  });
});
