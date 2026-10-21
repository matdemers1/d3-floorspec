/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DESIGN_PARTNER_PROMPT } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * FLR-T-16.4: floorspec_describe reports the thermal envelope — each assembly's R and U and the heat loss
 * and gain room by room, as ranges, advisory — for a plan that uses FS_thermal; an agent compares two
 * insulations by changing a layer's material and describing again.
 */
type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
const COURTYARD = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house-envelope.json', import.meta.url), 'utf8')) as Record<string, unknown>;

describe('FS_thermal through MCP', () => {
  it('describes assemblies’ R and U and the heat loss by room, advisory', async () => {
    const client = new ApplierClient(structuredClone(COURTYARD));
    const mcp = await connect(client);
    const d = texts(await mcp.callTool({ name: 'floorspec_describe', arguments: {} }));
    expect(d).toContain('## Envelope (FS_thermal; advisory, ±20%');
    expect(d).toContain('Atlanta, GA · zone 3A');
    expect(d).toMatch(/wall:wall-2x6-exterior-fibre-cement \(2x6 exterior wall, fibre-cement siding\) R-\d+, U-0\.\d+, 5 layers, framing 23%/);
    expect(d).toMatch(/roof:RF1 \(East wing shed roof\) R-\d+/);
    expect(d).toMatch(/whole house: heating \d+–\d+ kBtu\/h, cooling \d+–\d+ kBtu\/h/);
    expect(d).toMatch(/Kitchen \(R8, [\d,]+ ft²\) heating [\d,]+–[\d,]+ Btu\/h, cooling [\d,]+–[\d,]+ Btu\/h at \d+ (am|pm)/);
    expect(d).not.toMatch(/complian|meets? (the )?code/i);

    const kitchen = texts(await mcp.callTool({ name: 'floorspec_describe', arguments: { room: 'R8' } }));
    expect(kitchen).toMatch(/by room .*Kitchen \(R8/);
    expect(kitchen).not.toMatch(/Great room \(R7/);
  });

  it('shows the effect of an insulation swapped: batts for polyiso', async () => {
    const client = new ApplierClient(structuredClone(COURTYARD));
    const mcp = await connect(client);
    const before = texts(await mcp.callTool({ name: 'floorspec_describe', arguments: {} }));
    const r = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'setProperty', id: 'wall-2x6-exterior-fibre-cement', path: '/layers/3/material', value: 'polyiso-board' }] } });
    expect(r.isError, texts(r)).toBeFalsy();
    const after = texts(await mcp.callTool({ name: 'floorspec_describe', arguments: {} }));
    const r1 = /wall:wall-2x6-exterior-fibre-cement \([^)]*\) (R-[\d.]+)/.exec(before)![1];
    const r2 = /wall:wall-2x6-exterior-fibre-cement \([^)]*\) (R-[\d.]+)/.exec(after)![1];
    expect(r2).not.toBe(r1);
  });

  it('tells the agent how', () => {
    expect(DESIGN_PARTNER_PROMPT).toMatch(/FS_thermal 0\.1\.0/);
    expect(DESIGN_PARTNER_PROMPT).toMatch(/uFactor/);
  });
});
