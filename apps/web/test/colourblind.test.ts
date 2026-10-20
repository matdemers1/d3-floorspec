/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { MODE_IDS, MODES, type ModeId } from '../src/editor/modes';
import { ModeIcon } from '../src/editor/ModeSwitcher';
import { colourVar, XRAY_LOOKS, XRAY_SYSTEMS } from '../src/editor/three/xray/xray';

/**
 * FLR-T-18.16: the trade modes' colours (modes.css, Okabe-Ito based) stay apart for colour-blind
 * people. Each theme's seven colours are run through a simulation of protanopia, deuteranopia and
 * tritanopia — Machado, Oliveira and Fernandes (2009), severity 1.0, on linear sRGB — and every pair
 * of modes must still differ by at least MIN_DE in CIEDE2000, as they must for normal vision. Each
 * colour also holds 3:1 (WCAG 1.4.11, a graphic) on every surface @d3cloud/ui puts an icon on, and
 * every mode has an icon to go with its colour: colour is never the only cue.
 *
 * FLR-T-14.5: X-ray's systems in 3D take the same colours — each its trade's (framing Construction's,
 * plumbing's supply and drain Plumbing's, wiring Electrical's, ducts Mechanical's; insulation the
 * reddish purple) — so the set they make is held to the same test, on the 3D view's background, and
 * the two that share a colour (supply and drain, both plumbing) are told apart by their pattern: a
 * drain's dashes alternate its blue with fg-muted, which must itself stand apart from the blue.
 */

/** The least CIEDE2000 difference between any two modes, under any simulation, in either theme. */
const MIN_DE = 7.5;

type Rgb = readonly [number, number, number];
type Matrix = readonly [Rgb, Rgb, Rgb];

/** Machado et al. 2009, severity 1.0: linear RGB in, linear RGB out. */
const SIMULATIONS: Readonly<Record<string, Matrix>> = {
  normal: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const hexRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as unknown as Rgb;
const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toLinear = (rgb: Rgb): Rgb => [linear(rgb[0]), linear(rgb[1]), linear(rgb[2])];
const clamp = (v: number): number => Math.min(1, Math.max(0, v));
const simulate = (lin: Rgb, m: Matrix): Rgb => [0, 1, 2].map((i) => clamp(m[i]![0] * lin[0] + m[i]![1] * lin[1] + m[i]![2] * lin[2])) as unknown as Rgb;

/** Linear sRGB to CIELAB, D65. */
function lab(lin: Rgb): Rgb {
  const x = (0.4124564 * lin[0] + 0.3575761 * lin[1] + 0.1804375 * lin[2]) / 0.95047;
  const y = 0.2126729 * lin[0] + 0.7151522 * lin[1] + 0.072175 * lin[2];
  const z = (0.0193339 * lin[0] + 0.119192 * lin[1] + 0.9503041 * lin[2]) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 (Sharma, Wu and Dalal 2005), kL = kC = kH = 1. */
export function ciede2000(p: Rgb, q: Rgb): number {
  const [l1, a1, b1] = p;
  const [l2, a2, b2] = q;
  const rad = Math.PI / 180;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (x: number, y: number) => {
    if (x === 0 && y === 0) return 0;
    const h = Math.atan2(y, x) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(a1p, b1);
  const h2p = hue(a2p, b2);
  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * rad) / 2);
  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP = h1p + h2p;
  if (c1p * c2p !== 0) hBarP = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2 : (h1p + h2p) / 2;
  const t = 1 - 0.17 * Math.cos((hBarP - 30) * rad) + 0.24 * Math.cos(2 * hBarP * rad) + 0.32 * Math.cos((3 * hBarP + 6) * rad) - 0.2 * Math.cos((4 * hBarP - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const rC = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sL = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;
  const rT = -Math.sin(2 * dTheta * rad) * rC;
  return Math.sqrt((dLp / sL) ** 2 + (dCp / sC) ** 2 + (dHp / sH) ** 2 + rT * (dCp / sC) * (dHp / sH));
}

const luminance = (lin: Rgb): number => 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(toLinear(hexRgb(a))), luminance(toLinear(hexRgb(b)))].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

// ─── The colours, from modes.css; the surfaces, from @d3cloud/ui's tokens ──────────────────────

const CSS = readFileSync(new URL('../src/editor/modes.css', import.meta.url), 'utf8');

/** The `--fs-mode-*` colours a rule block sets. */
function colours(selector: string): Record<string, string> {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `modes.css has a ${selector} block`).toBeGreaterThanOrEqual(0);
  const block = CSS.slice(at, CSS.indexOf('}', at));
  return Object.fromEntries([...block.matchAll(/--fs-mode-([a-z]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1] as string, (m[2] as string).toLowerCase()]));
}

const THEMES = { light: colours(':root'), dark: colours("[data-theme='dark']") } as const;

const ui = dirname(createRequire(import.meta.url).resolve('@d3cloud/ui/package.json'));
/** Where a mode's icon sits: the switcher's sunken well, panels, menus, hover rows, the page. */
const SURFACES = ['bg', 'bg-sunken', 'surface', 'surface-raised', 'surface-card', 'surface-hover'] as const;
/** A semantic colour token, as @d3cloud/ui resolves it in a theme. */
function token(theme: 'light' | 'dark', name: string): string {
  const tokens = JSON.parse(readFileSync(join(ui, 'src/tokens', `color.semantic.${theme}.json`), 'utf8')) as { color: Record<string, { $extensions?: { 'd3.resolved'?: string } }> };
  return tokens.color[name]?.$extensions?.['d3.resolved'] ?? '';
}
function surfaces(theme: 'light' | 'dark'): Record<string, string> {
  return Object.fromEntries(SURFACES.map((s) => [s, token(theme, s)]));
}

describe('mode colours for colour-blind people (FLR-T-18.16)', () => {
  it('measures CIEDE2000 as Sharma, Wu and Dalal’s test data does', () => {
    // Pairs 1, 17 and 25 of the paper's table 1.
    expect(ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(ciede2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 3);
    expect(ciede2000([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(1.2644, 3);
  });

  it('sets every mode a colour in both themes', () => {
    for (const theme of Object.values(THEMES)) expect(Object.keys(theme).sort()).toEqual([...MODE_IDS].sort());
  });

  for (const [theme, set] of Object.entries(THEMES)) {
    for (const [name, matrix] of Object.entries(SIMULATIONS)) {
      it(`keeps every pair of modes apart in the ${theme} theme, seen with ${name}`, () => {
        const ids = MODE_IDS as readonly ModeId[];
        const seen = ids.map((id) => lab(simulate(toLinear(hexRgb(set[id] ?? '#000000')), matrix)));
        const close: string[] = [];
        let least = Infinity;
        for (let i = 0; i < ids.length; i++)
          for (let j = i + 1; j < ids.length; j++) {
            const d = ciede2000(seen[i]!, seen[j]!);
            least = Math.min(least, d);
            if (d < MIN_DE) close.push(`${MODES[ids[i]!].label} and ${MODES[ids[j]!].label}: ΔE ${d.toFixed(1)}`);
          }
        expect(close, `least ΔE ${least.toFixed(1)}`).toEqual([]);
      });
    }

    it(`holds 3:1 on every surface an icon sits on in the ${theme} theme`, () => {
      const grounds = surfaces(theme as 'light' | 'dark');
      const low: string[] = [];
      for (const id of MODE_IDS)
        for (const [surface, ground] of Object.entries(grounds)) {
          expect(ground, `${theme} ${surface} resolved`).toMatch(/^#[0-9a-f]{6}$/i);
          const r = contrast(set[id] ?? '#000000', ground);
          if (r < 3) low.push(`${MODES[id].label} on ${surface}: ${r.toFixed(2)}:1`);
        }
      expect(low).toEqual([]);
    });
  }

  it('pairs every mode’s colour with an icon', () => {
    for (const id of MODE_IDS) {
      const html = renderToStaticMarkup(createElement(ModeIcon, { trade: id }));
      expect(html, id).toContain(`fs-mode-icon--${id}`);
      expect(html, id).toMatch(/<svg[\s>]/);
    }
  });
});

describe('X-ray’s systems for colour-blind people (FLR-T-14.5)', () => {
  it('draws each system in its trade’s colour from modes.css: one colour per system in 2D and 3D', () => {
    for (const system of XRAY_SYSTEMS) {
      const { trade } = XRAY_LOOKS[system];
      expect(MODE_IDS, system).toContain(trade);
      expect(colourVar(system)).toBe(`--fs-mode-${trade}`);
    }
    expect(XRAY_LOOKS.framing.trade).toBe('construction');
    expect(XRAY_LOOKS.supply.trade).toBe('plumbing');
    expect(XRAY_LOOKS.drain.trade).toBe('plumbing');
    expect(XRAY_LOOKS.electrical.trade).toBe('electrical');
    expect(XRAY_LOOKS.ducts.trade).toBe('mechanical');
  });

  it('gives every system a pattern of its own: colour is never the only cue', () => {
    const patterns = XRAY_SYSTEMS.map((s) => XRAY_LOOKS[s].pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
    // The two that share a colour are told apart by line and dashes.
    expect([XRAY_LOOKS.supply.pattern, XRAY_LOOKS.drain.pattern]).toEqual(['line', 'dash']);
  });

  for (const [theme, set] of Object.entries(THEMES)) {
    const colourOf = (system: (typeof XRAY_SYSTEMS)[number]) => set[XRAY_LOOKS[system].trade] ?? '#000000';
    const trades = [...new Set(XRAY_SYSTEMS.map((s) => XRAY_LOOKS[s].trade))];
    for (const [name, matrix] of Object.entries(SIMULATIONS)) {
      it(`keeps X-ray’s colours apart in the ${theme} theme, seen with ${name}, a drain’s dashes too`, () => {
        const seen = trades.map((t) => lab(simulate(toLinear(hexRgb(set[t] ?? '#000000')), matrix)));
        const close: string[] = [];
        for (let i = 0; i < trades.length; i++)
          for (let j = i + 1; j < trades.length; j++) {
            const d = ciede2000(seen[i]!, seen[j]!);
            if (d < MIN_DE) close.push(`${trades[i]!} and ${trades[j]!}: ΔE ${d.toFixed(1)}`);
          }
        expect(close).toEqual([]);
        // The dashes: plumbing's blue against fg-muted.
        const muted = token(theme as 'light' | 'dark', 'fg-muted');
        expect(muted).toMatch(/^#[0-9a-f]{6}$/i);
        const d = ciede2000(lab(simulate(toLinear(hexRgb(colourOf('drain'))), matrix)), lab(simulate(toLinear(hexRgb(muted)), matrix)));
        expect(d, `drain dashes ΔE ${d.toFixed(1)}`).toBeGreaterThanOrEqual(MIN_DE);
      });
    }

    it(`holds 3:1 on the 3D view’s background in the ${theme} theme`, () => {
      const ground = token(theme as 'light' | 'dark', 'bg-sunken');
      const low = XRAY_SYSTEMS.filter((s) => contrast(colourOf(s), ground) < 3).map((s) => `${s}: ${contrast(colourOf(s), ground).toFixed(2)}:1`);
      expect(low).toEqual([]);
    });
  }
});
