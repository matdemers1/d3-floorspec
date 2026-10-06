/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe as group, expect, it } from 'vitest';
import { ARC_04_HINT, ARC_FIT_HINT, ARC_ROUTE_HINT, describe, describeJson, DESIGN_PARTNER_PROMPT } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * Arc walls (Floorspec Core 0.4, chapter 21; FLR-T-11.1) through MCP: floorspec_describe lists an arc wall
 * once, with its length along the arc, its sagitta and chord - never its segments - the design-partner
 * prompt says how to draw one, and a rejected batch says how to fix it.
 */

const SUITE = '../../engine/standard/conformance/core/0.4/arcs';
const input = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`${SUITE}/${name}/input.json`, import.meta.url), 'utf8')) as Record<string, unknown>;

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

group('Core 0.4: arc walls in floorspec_describe', () => {
  it('lists the bay wall once, with its length along the arc, its sagitta and its chord', () => {
    const d = input('001-bay-room');
    const room = describeJson(d).levels[0]!.rooms[0]!;
    const edges = Object.values(room.sides).flat();
    expect(edges.map((e) => e.id).sort()).toEqual(['W1', 'W2', 'W3', 'W4']);
    const w2 = edges.find((e) => e.id === 'W2')!;
    expect(w2.arc?.sagitta.baseUnits).toBe(1_280_000);
    expect(w2.arc?.chord.baseUnits).toBe(6_400_000);
    expect(w2.length.baseUnits).toBeGreaterThan(6_400_000);
    expect(describe(JSON.stringify(d))).toMatch(/- wall W2, [^\n]*\(an arc: sagitta [^\n]*, chord [^\n]*, length along the arc\)/);
    expect(describe(JSON.stringify(d))).not.toMatch(/W2~|W2\^/);
  });

  it('names a room across an arc separator as its neighbour', () => {
    const j = describeJson(input('015-arc-separator'));
    const adj = j.levels[0]!.adjacency;
    expect(adj.some((a) => a.separators.includes('S1'))).toBe(true);
  });

  it('is in the design-partner prompt', () => {
    expect(DESIGN_PARTNER_PROMPT).toMatch(/"arc": \{"sagitta": h\}/);
  });
});

group('Core 0.4: hints for arc walls', () => {
  it('says to upgrade a 0.3 plan, to keep an arc to a semicircle, and to end walls at junctions on an arc', async () => {
    const d = input('001-bay-room');
    const straight = { ...d, floorspec: '0.3', walls: { ...(d['walls'] as Record<string, Record<string, unknown>>) } };
    const w2 = { ...straight.walls['W2'] };
    delete w2['arc'];
    straight.walls['W2'] = w2;
    const old = await connect(new ApplierClient(straight));
    const bend = [{ op: 'setProperty', id: 'W2', path: '/arc', value: { sagitta: 1_280_000 } }];
    const r1 = await old.callTool({ name: 'floorspec_apply', arguments: { batch: bend } });
    expect(r1.isError).toBe(true);
    expect(texts(r1)).toContain(`Hint: ${ARC_04_HINT}`);

    const mcp = await connect(new ApplierClient(d));
    const far = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'setProperty', id: 'W2', path: '/arc/sagitta', value: 4_000_000 }] } });
    expect(texts(far)).toContain('FS-INV-113');
    expect(texts(far)).toContain(`Hint: ${ARC_FIT_HINT}`);
    const across = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'drawWall', level: 'L1', from: [3_200_000, 3_840_000], to: [3_200_000, 8_000_000], type: 'WT' }] },
    });
    expect(texts(across)).toContain('FS-OPS-013');
    expect(texts(across)).toContain(`Hint: ${ARC_ROUTE_HINT}`);
  });
});
