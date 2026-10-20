/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe as group, expect, it } from 'vitest';
import { DESIGN_PARTNER_PROMPT, describe, describeJson } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * FLR-T-15.1: an agent reads the site — the lot and its edges, the survey, the surface and each graded
 * outline's cut and fill (estimates) — from floorspec_describe, and edits it with setProperty of $site
 * and $document as the design-partner prompt says: a spot added through floorspec_apply joins the
 * surface.
 */

const LOT = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house-on-its-lot.json', import.meta.url), 'utf8')) as Record<string, unknown>;
type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
const FT = 390144;

group('FS_site through MCP', () => {
  it('describes the lot, the survey, the surface and the cut and fill', () => {
    const s = describeJson(LOT);
    const site = s.site!;
    expect(site.lot!.acres).toBeCloseTo(0.41, 2);
    expect(site.lot!.edges.map((e) => e.kind)).toEqual(['front', 'side', 'rear', 'side']);
    expect(site.lot!.edges[0]!.setback!.ftIn).toBe(`30' 0"`);
    const t = site.terrain!;
    expect([t.benchmark, t.spots, t.contours, t.pads]).toEqual([814.5, 14, 5, ['PAD1']]);
    expect(t.surface!.lowFt).toBeLessThan(810);
    expect(t.surface!.highFt).toBeGreaterThan(816.5);
    expect(t.cutYd3!).toBeGreaterThan(0);
    expect(t.fillYd3!).toBeGreaterThan(0);
    expect(Object.keys(t.grading)).toContain('SL4C');
    expect(t.inSetbacks).toEqual([]);
    const text = describe(LOT);
    expect(text).toMatch(/Lot: \d+ ft² \(0\.41 ac\); edges 0 front/);
    expect(text).toMatch(/Terrain \(FS_site; heights in the survey's feet, first floor at 814\.5'\): 14 spots, 5 contour lines, surface/);
    expect(text).toContain('estimates');
    expect(text).not.toMatch(/compliant/i);
  });

  it('tells an agent how to write the site, and a spot it adds joins the surface', async () => {
    expect(DESIGN_PARTNER_PROMPT).toContain('/extensions/FS_site/spots/SP1');
    expect(DESIGN_PARTNER_PROMPT).toContain('"path":"/boundary"');
    const client = new ApplierClient(structuredClone(LOT));
    const mcp = await connect(client);
    const r = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'setProperty', id: '$document', path: '/extensions/FS_site/spots/SP99', value: { at: [40 * FT, 80 * FT], elevation: Math.round(1.5 * FT) } }] },
    });
    expect(r.isError, texts(r)).toBeFalsy();
    const d = await mcp.callTool({ name: 'floorspec_describe', arguments: {} });
    expect(texts(d)).toMatch(/15 spots/);
  });
});
