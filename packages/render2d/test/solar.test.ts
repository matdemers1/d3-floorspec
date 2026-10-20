/**
 * FLR-T-16.1: FS_energy in plan — the Courtyard House with solar (apps/worker/test/fixtures/courtyard-house-solar.json):
 * each array's modules as blue cells inside its footprint on its roof's level, the setbacks each face keeps as tinted
 * strips, the slope's arrow, and a tag "PV1 · 35 × 410 W · faces E"; the Solar layer on in Electrical mode, ghosted in
 * Construction, off elsewhere; an array inside a setback outlined in the warning colour; and light and dark goldens.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODES, PALETTES, renderPlan } from '../src/index.js';

const solarText = readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house-solar.json', import.meta.url), 'utf8');
const SOLAR = JSON.parse(solarText) as { extensions: { FS_energy: { collections: { pvArrays: Record<string, { host: { position: [number, number] } }> } } } };
const STREET = readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house-on-its-street.json', import.meta.url), 'utf8');

describe('FS_energy in plan', () => {
  it('draws each array on its roof’s level: its modules, its footprint and its tag, over the setbacks', () => {
    const upper = renderPlan(SOLAR, { mode: 'electrical', level: 'L2' });
    const order = ['solar-setbacks', 'solar-arrays', 'solar-tags'].map((id) => upper.indexOf(`<g id="${id}"`));
    expect(order.every((at) => at >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(upper.match(/data-array="PV1"/g)).toHaveLength(1);
    expect(upper.match(/data-module="/g)).toHaveLength(35);
    expect(upper).toContain('PV1 · 35 × 410 W · faces E');
    expect(upper).not.toContain('data-array="PV2"');
    const lower = renderPlan(SOLAR, { mode: 'electrical', level: 'L1' });
    expect(lower).toContain('PV2 · 15 × 410 W · faces N');
    // the garage's flat roof has no array: its face is labelled, with its setbacks
    expect(lower).toContain('Garage flat roof · flat roof');
    for (const k of ['eave', 'ridge', 'rake']) expect(upper + lower).toContain(`data-setback="${k}"`);
    expect(upper).toMatch(/data-slope="RF1:1"/);
  });

  it('draws modules in the palette’s solar blue, and an array inside a setback in the warning colour', () => {
    for (const theme of ['light', 'dark'] as const) {
      const svg = renderPlan(SOLAR, { mode: 'electrical', level: 'L2', theme });
      expect(svg).toContain(`fill="${PALETTES[theme].pv}"`);
    }
    const moved = structuredClone(SOLAR);
    const pv1 = moved.extensions.FS_energy.collections.pvArrays['PV1']!;
    pv1.host.position = [pv1.host.position[0] + 390_144 * 2, pv1.host.position[1]];
    const svg = renderPlan(moved, { mode: 'electrical', level: 'L2' });
    expect(svg).toMatch(/data-array="PV1"[^>]*data-in-setback=""/);
    expect(svg).toContain(`stroke="${PALETTES.light.opening}" stroke-width="1.2" stroke-dasharray="5 3"`);
  });

  it('follows the Solar layer: on in Electrical mode, ghosted in Construction, off elsewhere, and absent without FS_energy', () => {
    expect(MODES.electrical.layers.solar).toBe('on');
    expect(MODES.construction.layers.solar).toBe('ghost');
    for (const m of ['decorator', 'plumbing', 'mechanical', 'lowvoltage', 'landscape'] as const) expect(MODES[m].layers.solar).toBe('off');
    expect(renderPlan(SOLAR, { mode: 'construction', level: 'L2' })).toMatch(/data-ghost="solar"/);
    expect(renderPlan(SOLAR, { mode: 'electrical', level: 'L2', layers: { solar: 'off' } })).not.toContain('data-array=');
    expect(renderPlan(STREET, { mode: 'electrical', level: 'L2' })).not.toContain('solar-');
  });
});

describe('golden SVG: the Courtyard House with solar', () => {
  it.each(['light', 'dark'] as const)('%s', async (theme) => {
    await expect(renderPlan(solarText, { mode: 'electrical', level: 'L2', style: 'colour', theme, scale: 8 })).toMatchFileSnapshot(`./golden/solar-${theme}.svg`);
  });
});
