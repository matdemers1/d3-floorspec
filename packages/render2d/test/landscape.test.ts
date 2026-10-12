/**
 * FLR-T-13.5: FS_landscape in plan — the conformance suite's Phase 13 garden drawn as a planting plan:
 * lawns under the paving, beds and hardscape over it, each plant's canopy on top, and none of them as
 * its plain fallback box. A courtyard bed hosted on a room's floor and turned with its host is drawn
 * turned.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { landscapeOf, renderPlan } from '../src/index.js';

const garden = readFileSync(new URL('../../engine/standard/conformance/ext/FS_landscape/0.1.0/examples/001-p13-garden/input.json', import.meta.url), 'utf8');
const FT = 390144;

const group = (svg: string, id: string): string => {
  const at = svg.indexOf(`<g id="${id}"`);
  expect(at, id).toBeGreaterThanOrEqual(0);
  return svg.slice(at, svg.indexOf('</g>', svg.indexOf('>', at)));
};

describe('FS_landscape in plan', () => {
  it('draws lawns before the slabs, beds and lines after the floors, plants after everything, and no landscape element as a box', () => {
    const svg = renderPlan(garden);
    const order = ['lawns', 'slabs', 'floors', 'landscape', 'walls', 'plants'].map((id) => svg.indexOf(`<g id="${id}"`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(svg).toContain('data-kind="FS_landscape:lawns"');
    expect(svg.match(/data-kind="FS_landscape:beds"/g)).toHaveLength(3);
    expect(svg.match(/data-kind="FS_landscape:plants"/g)).toHaveLength(6);
    expect(svg).toContain('data-form="steppingStones"');
    // no landscape element is left to the fallbacks layer
    const fallbacks = svg.includes('<g id="fallbacks"') ? group(svg, 'fallbacks') : '';
    expect(fallbacks).not.toContain('FS_landscape');
    // the trees are scalloped crowns with a trunk
    expect(svg).toMatch(/data-form="tree"><path d="M[^"]*A/);
  });

  it('is the same text every time, and draws the dark theme in its own palette', () => {
    expect(renderPlan(garden)).toBe(renderPlan(garden));
    const dark = renderPlan(garden, { theme: 'dark' });
    expect(dark).toContain('fill="#222b1d"');
  });

  it('takes a hosted outline to the plan by its host: turned 90°, the courtyard bed\'s corner [-3\', -3\'] lands at [3\', -3\'] from its host', () => {
    const el = { boundary: [[-3 * FT, -3 * FT], [3 * FT, -3 * FT], [3 * FT, 3 * FT], [-3 * FT, 3 * FT]], fallback: { level: 'L1', box: { min: [0, 0, 0], max: [1, 1, 1] } } };
    const x = landscapeOf('beds', el, { point: [24 * FT, 6 * FT, 0], facing: 90_000_000 });
    if (x?.kind !== 'bed') throw new Error('not a bed');
    const [p] = x.outline;
    expect(p![0]).toBeCloseTo(27 * FT, 6);
    expect(p![1]).toBeCloseTo(3 * FT, 6);
  });
});
