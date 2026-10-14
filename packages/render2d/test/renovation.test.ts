/**
 * Renovation filters in plan (FLR-T-18.13, FS_renovation 3.1): the kitchen remodel of the
 * courtyard house drawn as its existing, demolition, proposed and combined plans.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderPlan, RENOVATION_FILTERS, filteredDocument, renovationStyles } from '../src/index.js';

const remodel = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'apps', 'worker', 'test', 'fixtures', 'courtyard-remodel.json'), 'utf8')) as Record<string, unknown>;
const count = (svg: string, needle: string): number => svg.split(needle).length - 1;

describe('renovation filters', () => {
  it('styles each status as the filter says', () => {
    const s = renovationStyles(remodel as never, 'demolition')!;
    expect(s.get('W17')).toBe('demolished');
    expect(s.get('W90')).toBe('hidden');
    expect(s.get('W24')).toBe('existing');
    expect(renovationStyles(remodel as never, 'existing')!.get('W17')).toBe('plain');
    expect(renovationStyles({ floorspec: '0.4' } as never, 'proposed')).toBeNull();
  });

  it('draws a state: the existing plan has the pantry and not the new wall, the proposed plan the reverse', () => {
    const existing = filteredDocument(remodel as never, 'existing') as { walls: Record<string, unknown>; rooms: Record<string, unknown> };
    const proposed = filteredDocument(remodel as never, 'proposed') as { walls: Record<string, unknown>; rooms: Record<string, unknown> };
    expect(Object.keys(existing.walls)).toContain('W17');
    expect(Object.keys(existing.walls)).not.toContain('W90');
    expect(Object.keys(proposed.walls)).not.toContain('W17');
    expect(Object.keys(proposed.rooms)).not.toContain('R9');
    expect(filteredDocument(remodel as never, 'combined')).toBe(remodel);
  });

  it('draws the existing plan plainly, with no legend', () => {
    const svg = renderPlan(remodel, { renovation: 'existing' });
    expect(svg).toContain('Existing plan');
    expect(svg).not.toContain('data-renovation');
    expect(svg).not.toContain('renovation-legend');
  });

  it('draws demolished work dashed and existing work subdued in the demolition plan', () => {
    const svg = renderPlan(remodel, { renovation: 'demolition', style: 'technical' });
    expect(svg).toContain('id="walls-demolished"');
    expect(svg).toContain('data-renovation="existing"');
    expect(count(svg, 'data-renovation="demolished"')).toBeGreaterThan(8);
    expect(svg).not.toContain('data-renovation="new"');
    expect(svg).toContain('TO DEMOLISH');
    expect(svg).toContain('DEMOLITION PLAN');
  });

  it('draws new work in solid poché in the proposed plan, and nothing demolished', () => {
    const svg = renderPlan(remodel, { renovation: 'proposed' });
    expect(svg).toContain('id="walls-new"');
    expect(svg).not.toContain('data-renovation="demolished"');
    expect(count(svg, 'data-renovation="new"')).toBeGreaterThan(5);
  });

  it('draws all three in the combined plan, and every filter is deterministic', () => {
    const svg = renderPlan(remodel, { renovation: 'combined' });
    for (const k of ['existing', 'demolished', 'new']) expect(svg).toContain(`data-renovation="${k}"`);
    for (const f of RENOVATION_FILTERS) expect(renderPlan(remodel, { renovation: f })).toBe(renderPlan(remodel, { renovation: f }));
  });

  it('draws a document without FS_renovation as it is under every filter', () => {
    const house = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'apps', 'worker', 'test', 'fixtures', 'courtyard-house.json'), 'utf8')) as object;
    expect(renderPlan(house, { renovation: 'proposed' })).toBe(renderPlan(house));
  });
});
