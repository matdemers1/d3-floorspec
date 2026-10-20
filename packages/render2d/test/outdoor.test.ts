/**
 * FLR-T-15.2: FS_outdoor in plan — the conformance suite's Phase 15 back terrace: a plunge pool's water
 * inside its coping, a spa in the courtyard, the fence's posts where FS_outdoor derives them and its gate
 * with its leaf and swing, the kitchen's appliances along its run, the fire pit's flame, and the pergola
 * over everything — its posts solid, its beams and rafters dashed. None of them is a plain box, and the
 * Outdoor layer follows the modes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { outdoor } from '@floorspec/engine';
import { layerOfElement, MODES, outdoorOf, PALETTES, renderPlan } from '../src/index.js';

const terraceText = readFileSync(new URL('../../engine/standard/conformance/ext/FS_outdoor/0.1.0/examples/001-p15-back-terrace/input.json', import.meta.url), 'utf8');
const terrace = JSON.parse(terraceText) as { extensions: { FS_outdoor: { collections: Record<string, Record<string, Record<string, unknown>>> } } };
const IN = 32512;
const FT = 12 * IN;

const group = (svg: string, id: string): string => {
  const at = svg.indexOf(`<g id="${id}"`);
  expect(at, id).toBeGreaterThanOrEqual(0);
  let depth = 0;
  const re = /<g[\s>]|<\/g>/g;
  re.lastIndex = at;
  for (let m = re.exec(svg); m !== null; m = re.exec(svg)) {
    depth += m[0] === '</g>' ? -1 : 1;
    if (depth === 0) return svg.slice(at, m.index + 4);
  }
  return svg.slice(at);
};
const item = (svg: string, id: string): string => {
  const at = svg.indexOf(`data-id="${id}" data-kind="FS_outdoor`);
  expect(at, id).toBeGreaterThanOrEqual(0);
  return svg.slice(at, svg.indexOf('data-kind="FS_outdoor', at + 30) === -1 ? undefined : svg.indexOf('data-kind="FS_outdoor', at + 30));
};

describe('FS_outdoor in plan', () => {
  const svg = renderPlan(terraceText);

  it('draws pools, fences, kitchens and fires over the floors and shelters over everything, and none as a box', () => {
    const order = ['floors', 'outdoor', 'walls', 'overhead'].map((id) => svg.indexOf(`<g id="${id}"`));
    expect(order.every((at) => at >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const fallbacks = svg.includes('<g id="fallbacks"') ? group(svg, 'fallbacks') : '';
    expect(fallbacks).not.toContain('FS_outdoor');
    expect(group(svg, 'overhead')).toContain('data-kind="FS_outdoor:shelters"');
    expect(group(svg, 'outdoor')).not.toContain('FS_outdoor:shelters');
  });

  it('draws a pool as its water inside its coping', () => {
    const pool = item(svg, 'X1');
    expect(pool).toContain(`fill="${PALETTES.light.coping}"`);
    expect(pool).toContain('data-water="X1"');
    expect(pool).toContain(`fill="${PALETTES.light.water}"`);
    const x = outdoorOf('pools', terrace.extensions.FS_outdoor.collections['pools']!['X1']!, { point: [7 * FT, -18 * FT, 0], facing: 0 });
    expect(x?.kind).toBe('pool');
    if (x?.kind !== 'pool') return;
    // 12" of coping all round an 8' x 14' pool: a basin 6' x 12'
    expect(x.basin[0]).toEqual([3 * FT + FT, -25 * FT + FT]);
    expect(x.basin[2]).toEqual([11 * FT - FT, -11 * FT - FT]);
    expect(item(svg, 'X2')).toContain('data-form="spa"');
  });

  it("puts the fence's posts where FS_outdoor counts them, and draws its gate with a leaf and a swing", () => {
    const el = terrace.extensions.FS_outdoor.collections['fences']!['X6']!;
    const fence = item(svg, 'X6');
    const n = outdoor.fencePostCount(el['points'] as [number, number][], el['postSpacing'] as number);
    expect(n).toBe(9);
    expect(fence).toContain(`data-posts="${n}"`);
    expect(fence.match(/<circle /g)).toHaveLength(n);
    expect(fence).toContain('data-gate="X6"');
    expect(fence).toContain('data-gate-leaf="X6"');
    expect(fence).toContain('data-gate-swing="X6"');
    expect(fence).toContain(`stroke="${PALETTES.light.timber}"`);
    // the gate is 40' to 44' along the line: 6' to 10' east along its south run, at y = -30'; its leaf swings north, into the yard
    const x = outdoorOf('fences', el, undefined);
    if (x?.kind !== 'fence') throw new Error('not a fence');
    expect(x.gates[0]!.a).toEqual([-4 * FT, -30 * FT]);
    expect(x.gates[0]!.b).toEqual([0, -30 * FT]);
    expect(x.gates[0]!.side).toEqual([-0, 1]);
  });

  it('draws the kitchen with its appliances in order, and the fire pit with its flame', () => {
    const k = item(svg, 'X4');
    expect([...k.matchAll(/data-appliance="(\w+)"/g)].map((m) => m[1])).toEqual(['grill', 'sink', 'refrigerator']);
    const f = item(svg, 'X5');
    expect(f).toContain('data-flame="X5"');
    expect(f).toContain(`fill="${PALETTES.light.flame}"`);
  });

  it("draws the pergola's posts solid and its beams and rafters dashed, as many posts as derived", () => {
    const p = item(svg, 'X3');
    expect(p).toContain('data-posts="8"');
    expect(p).toMatch(/data-beams="X3"[^>]*stroke-dasharray/);
    expect(p).toMatch(/data-rafters="\d+"[^>]*stroke-dasharray/);
    // stretched to 20', it has ten posts, re-spaced
    const longer = JSON.parse(terraceText) as typeof terrace;
    const box = (longer.extensions.FS_outdoor.collections['shelters']!['X3']!['fallback'] as { box: { min: number[]; max: number[] } }).box;
    box.max[0] = box.min[0]! + 20 * FT;
    expect(item(renderPlan(JSON.stringify(longer)), 'X3')).toContain('data-posts="10"');
  });

  it('belongs to the Outdoor layer: on in Landscape mode, ghosted in the Decorator mode, off in Construction', () => {
    expect(layerOfElement('FS_outdoor', 'pools')).toBe('outdoor');
    expect(MODES.landscape.layers.outdoor).toBe('on');
    expect(renderPlan(terraceText, { mode: 'landscape' })).toContain('<g id="overhead"');
    expect(renderPlan(terraceText, { mode: 'decorator' })).toContain('data-ghost="outdoor"');
    const c = renderPlan(terraceText, { mode: 'construction' });
    expect(c).not.toContain('FS_outdoor');
  });

  it('is the same text every time, in each theme’s inks', () => {
    expect(renderPlan(terraceText)).toBe(svg);
    const dark = renderPlan(terraceText, { theme: 'dark' });
    expect(dark).toContain(`fill="${PALETTES.dark.water}"`);
    expect(dark).toContain(`stroke="${PALETTES.dark.overhead}"`);
  });
});

describe('golden SVG: the back terrace', () => {
  it.each(['light', 'dark'] as const)('landscape plan, colour, %s', async (theme) => {
    await expect(renderPlan(terraceText, { mode: 'landscape', style: 'colour', theme, scale: 16 })).toMatchFileSnapshot(`./golden/back-terrace-${theme}.svg`);
  });
});
