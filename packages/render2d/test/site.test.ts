/**
 * FLR-T-15.1: FS_site in plan — the Courtyard House on its lot (apps/worker/test/fixtures/
 * courtyard-house-on-its-lot.json): contours under the house, cut hatched and fill dashed over the
 * paving, the spots, and the lot with its bearings and its setback line on top; only on the lowest
 * level, only in the layers that are on; and the conformance suite's garden on a slope, whose contours
 * and spots are where the survey puts them.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderPlan, surveyHeight } from '../src/index.js';

const LOT = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house-on-its-lot.json', import.meta.url), 'utf8')) as object;
const HOUSE = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as object;
const garden = readFileSync(new URL('../../engine/standard/conformance/ext/FS_site/0.1.0/examples/001-p15-garden-on-a-slope/input.json', import.meta.url), 'utf8');
const FT = 390144;

describe('FS_site in plan', () => {
  it('draws contours under the floors, cut and fill over the paving, and the spots and the lot on top', () => {
    const svg = renderPlan(LOT, { mode: 'landscape' });
    const order = ['contours', 'slabs', 'floors', 'grading', 'walls', 'spots', 'lot'].map((id) => svg.indexOf(`<g id="${id}"`));
    expect(order.every((at) => at >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(svg.match(/data-spot="/g)).toHaveLength(14);
    expect(svg.match(/data-contour-line="/g)).toHaveLength(5);
    // the house's pad cuts into the slope and the walk and the drive are filled: a pattern each, never colour alone
    expect(svg).toContain('data-cut="PAD1"');
    expect(svg).toContain('data-fill="SL3"');
    expect(svg).toMatch(/<pattern id="fs-site-cut-hatch"[^>]*patternTransform="rotate\(45\)"/);
    expect(svg).toContain('<pattern id="fs-site-fill-dash"');
    // the street edge, its bearing and its length; the setback line and its front, side and rear
    expect(svg).toContain('street line');
    expect(svg).toContain('data-setbacks=""');
    expect(svg.match(/data-setback-label="(front|side|rear)"/g)?.sort()).toEqual(['data-setback-label="front"', 'data-setback-label="rear"', 'data-setback-label="side"', 'data-setback-label="side"']);
    // heights in the survey's datum: the floor is 814' 6"
    expect(surveyHeight(0, 814 * FT + FT / 2)).toBe('814.50′');
  });

  it('draws the lot on the lowest level only, and nothing of a house with no site', () => {
    expect(renderPlan(LOT, { mode: 'landscape', level: 'L2' })).not.toContain('<g id="lot"');
    const plain = renderPlan(HOUSE, { mode: 'landscape' });
    for (const id of ['contours', 'grading', 'spots', 'lot']) expect(plain).not.toContain(`<g id="${id}"`);
  });

  it('follows the layers: contours off, cut and fill ghosted', () => {
    const svg = renderPlan(LOT, { mode: 'landscape', layers: { contours: 'off', grading: 'ghost' } });
    expect(svg).not.toContain('<g id="contours"');
    expect(svg).toMatch(/data-ghost="grading"/);
    // a mode that does not draw the site draws none of it
    expect(renderPlan(LOT, { mode: 'electrical' })).not.toContain('<g id="lot"');
  });

  it('labels every foot of the garden on a slope, the fifth ones heavier', () => {
    const svg = renderPlan(garden);
    const heights = [...svg.matchAll(/data-contour="(\d+)"/g)].map((m) => Number(m[1]));
    expect(heights).toEqual([810, 811, 812, 813, 814, 815, 816, 817]);
    expect(svg).toContain('816.50′'); // the north-east corner's spot
  });

  it('draws the lot the same way in both themes, in each theme’s inks', () => {
    const light = renderPlan(LOT, { mode: 'landscape', theme: 'light' });
    const dark = renderPlan(LOT, { mode: 'landscape', theme: 'dark' });
    expect(light).toContain('stroke="#5432be"');
    expect(dark).toContain('stroke="#a99dff"');
    expect(light.match(/data-spot="/g)?.length).toBe(dark.match(/data-spot="/g)?.length);
  });
});

describe('golden SVG: the Courtyard House on its lot', () => {
  it.each(['light', 'dark'] as const)('landscape plan, colour, %s', async (theme) => {
    await expect(renderPlan(LOT, { mode: 'landscape', style: 'colour', theme, scale: 10 })).toMatchFileSnapshot(`./golden/courtyard-on-its-lot-${theme}.svg`);
  });
});
