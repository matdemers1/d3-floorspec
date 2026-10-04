import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import expectedText from '../../../packages/engine/standard/conformance/core/0.1/examples/001-three-room-house/expected.json?raw';
import { PlanThumbnail } from '../src/components/PlanThumbnail';
import { describeOps } from '../src/dashboard/describe';
import { describeModel, eachLimited, formatSquareFeet, squareFeet, summarize, timeAgo, twice } from '../src/projects/model';
import { TEMPLATES } from '../src/projects/templates';

const house = TEMPLATES.find((t) => t.id === 'three-room-house')?.document ?? '';
const expected = JSON.parse(expectedText) as { hash: string; derived: { rooms: Record<string, { area: string }> } };

describe('the head-model summary', () => {
  it('sums the rooms the engine derived, exactly, for the bundled three-room house', () => {
    const summary = summarize(house);
    expect(summary.valid).toBe(true);
    expect(summary.rooms).toBe(3);
    expect(summary.levels.map((l) => [l.id, l.rooms])).toEqual([['MAIN', 3]]);
    const area2 = Object.values(expected.derived.rooms).reduce((sum, room) => sum + twice(room.area), 0n);
    expect(summary.area2).toBe(area2);
    // 36 by 24 ft outside, 2x6 walls: just under 795 ft² of rooms inside.
    expect(squareFeet(summary.area2)).toBe(794.9);
    expect(describeModel(summary)).toBe('1 level · 3 rooms · 795 ft²');
  });

  it('calls the empty document of a new project valid and empty', () => {
    const summary = summarize({ floorspec: '0.1', project: { name: 'New' } });
    expect(summary.valid).toBe(true);
    expect(summary.empty).toBe(true);
    expect(describeModel(summary)).toBe('Nothing drawn yet');
  });

  it('reports an invalid document with its diagnostics instead of throwing', () => {
    const summary = summarize('{"floorspec": "0.1"}');
    expect(summary.valid).toBe(false);
    expect(summary.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(summary.document).toBeNull();
    expect(describeModel(summary)).toBe('The model does not validate');
  });

  it('reads a file that is not JSON as invalid, not as a crash', () => {
    const summary = summarize('not json at all');
    expect(summary.valid).toBe(false);
    expect(summary.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('areas and times', () => {
  it('doubles half-unit areas exactly', () => {
    expect(twice('12')).toBe(24n);
    expect(twice('12.5')).toBe(25n);
    expect(twice('-3.5')).toBe(-7n);
  });

  it('shows square feet grouped and whole', () => {
    const oneFoot = 390_144n * 390_144n;
    expect(formatSquareFeet(2n * 2412n * oneFoot)).toBe('2,412');
  });

  it('writes the short relative times the design uses', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    expect(timeAgo('2026-10-04T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-10-04T10:00:00Z', now)).toBe('2 h ago');
    expect(timeAgo('2026-10-03T12:00:00Z', now)).toBe('yesterday');
    expect(timeAgo('2026-10-01T12:00:00Z', now)).toBe('3 d ago');
    expect(timeAgo('2026-09-20T12:00:00Z', now)).toBe('2 wk ago');
  });
});

describe('the dashboard', () => {
  it('names an op-log entry in words', () => {
    expect(describeOps([{ op: 'createProject' }])).toBe('Created the project');
    expect(describeOps([{ op: 'moveJunction' }, { op: 'moveJunction' }])).toBe('moveJunction · 2 ops');
  });

  it('draws the plan from derived geometry, with token classes and no raw colour', () => {
    const summary = summarize(house);
    if (summary.document === null || summary.derived === null) throw new Error('the template must derive');
    const svg = renderToStaticMarkup(
      createElement(PlanThumbnail, { document: summary.document, derived: summary.derived, labels: true, title: 'Plan' }),
    );
    expect(svg).toContain('role="img"');
    expect(svg.match(/<path /g)?.length).toBe(3);
    expect(svg.match(/<polygon /g)?.length).toBeGreaterThanOrEqual(9);
    expect(svg).toContain('Living room');
    expect(svg).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(svg).not.toMatch(/\bfill="(?!none)/);
  });

  it('caps how many models load at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await eachLimited([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });
    expect(peak).toBe(4);
  });
});
