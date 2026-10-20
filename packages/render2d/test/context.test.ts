/**
 * FLR-T-15.3: FS_context in plan — the Courtyard House on its street (apps/worker/test/fixtures/
 * courtyard-house-on-its-street.json): Laurel Ridge Drive under everything, the neighbours' massing hatched
 * and dashed, the trees beyond the lot as dashed crowns, and a "Context ·" tag on each kind; one neutral
 * style that never takes the design's colours; the Context layer on, ghosted or off; only on the lowest
 * level; and light and dark goldens.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTEXT_TAGS, MODES, PALETTES, renderPlan } from '../src/index.js';

const streetText = readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house-on-its-street.json', import.meta.url), 'utf8');
const STREET = JSON.parse(streetText) as object;
const LOT = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house-outdoor.json', import.meta.url), 'utf8')) as object;

describe('FS_context in plan', () => {
  it('draws the street and the neighbours under everything, the trees and the tags over it', () => {
    const svg = renderPlan(STREET, { mode: 'landscape' });
    const order = ['context-streets', 'context-neighbours', 'floors', 'walls', 'lot', 'context-trees', 'context-tags'].map((id) => svg.indexOf(`<g id="${id}"`));
    expect(order.every((at) => at >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(svg.match(/data-context="street"/g)).toHaveLength(1);
    expect(svg.match(/data-context="neighbour"/g)).toHaveLength(2);
    expect(svg.match(/data-context="tree"/g)!.length).toBeGreaterThanOrEqual(8);
    for (const t of Object.values(CONTEXT_TAGS)) expect(svg).toContain(t);
    expect(svg).toContain('Laurel Ridge Drive');
    // carriageway, curbs, strips and sidewalks, the centreline dashed
    for (const a of ['data-carriageway', 'data-curb', 'data-strip', 'data-sidewalk', 'data-centreline']) expect(svg).toContain(a);
    expect(svg).toMatch(/<pattern id="fs-context-context-hatch"/);
  });

  it('draws context in its own neutral inks, never the design\'s colours', () => {
    for (const theme of ['light', 'dark'] as const) {
      const svg = renderPlan(STREET, { mode: 'landscape', theme });
      const p = PALETTES[theme];
      const groups = [...svg.matchAll(/<g data-context="(street|neighbour|tree)"[^>]*>(.*?)<\/g>/g)].map((m) => m[2]!);
      expect(groups.length).toBeGreaterThan(0);
      const colours = new Set(groups.flatMap((g) => [...g.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/g)].map((m) => m[1]!)));
      for (const c of colours) expect([p.context, p.contextFill, p.contextPave, p.paper]).toContain(c);
    }
  });

  it('follows the Context layer: on in Landscape mode, ghosted when asked, off in every other mode', () => {
    expect(MODES.landscape.layers.context).toBe('on');
    for (const m of ['construction', 'decorator', 'electrical', 'plumbing', 'mechanical', 'lowvoltage'] as const) expect(MODES[m].layers.context).toBe('off');
    expect(renderPlan(STREET, { mode: 'landscape', layers: { context: 'ghost' } })).toMatch(/data-ghost="context"/);
    const off = renderPlan(STREET, { mode: 'landscape', layers: { context: 'off' } });
    expect(off).not.toContain('data-context=');
    expect(off).not.toContain('Context ·');
  });

  it('draws context on the lowest level only, and the house on its lot is the same house on its street', () => {
    expect(renderPlan(STREET, { mode: 'landscape', level: 'L2' })).not.toContain('data-context=');
    // with context off, the plan on its street is the plan on its lot: context changes nothing of the design
    const strip = (s: string) => s.replaceAll('Courtyard House — on its street', '').replaceAll('Courtyard House — the back terrace', '');
    expect(strip(renderPlan(STREET, { mode: 'landscape', layers: { context: 'off' } }))).toBe(strip(renderPlan(LOT, { mode: 'landscape' })));
  });
});

describe('golden SVG: the Courtyard House on its street', () => {
  it.each(['light', 'dark'] as const)('%s', async (theme) => {
    await expect(renderPlan(streetText, { mode: 'landscape', style: 'colour', theme, scale: 8 })).toMatchFileSnapshot(`./golden/on-its-street-${theme}.svg`);
  });
});
