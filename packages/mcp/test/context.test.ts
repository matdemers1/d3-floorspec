/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { check, OFFICIAL_READER, type DerivedContext } from '@floorspec/engine';
import { describe, expect, it } from 'vitest';
import { DESIGN_PARTNER_PROMPT, fillContext } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * FLR-T-15.3: an agent generates the context of a lot — the street along its street edge, neighbours at
 * its setbacks, trees beyond — with one generateContext op, regenerates it (what it drew by hand stays),
 * and floorspec_describe reports it as never part of the design.
 */

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
const SLOPE = JSON.parse(readFileSync(new URL('../../engine/standard/conformance/ext/FS_site/0.1.0/examples/001-p15-garden-on-a-slope/input.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const FT = 390_144;
type Doc = { extensions?: { FS_context?: { streets?: Record<string, { name?: string }>; trees?: Record<string, unknown> } } };
const derived = (doc: unknown): DerivedContext => {
  const r = check(doc as object, OFFICIAL_READER);
  expect(r.diagnostics.filter((d) => d.severity === 'error'), JSON.stringify(r.diagnostics)).toEqual([]);
  return r.derived!.extensions!.FS_context!;
};

describe('FS_context through MCP', () => {
  it('generates the street, the neighbours and the trees from the lot, regenerates them, and describes them as never the design', async () => {
    const client = new ApplierClient(structuredClone(SLOPE));
    const mcp = await connect(client);
    const r = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'generateContext', name: 'Garden Lane', street: "30'", trees: 'some', seed: 3 }] } });
    expect(r.isError, texts(r)).toBeFalsy();
    expect(texts(r)).toMatch(/Context generated from the street side and setbacks \(FS_context, never part of the design\): 1 street, 2 neighbours, \d+ trees\./);
    const x = derived(client.document);
    expect(Object.values(x.streets)).toEqual([{ length: expect.any(Number) as number, width: 49 * FT }]);
    expect(Object.keys(x.neighbours)).toEqual(['NB1', 'NB2']);
    // no lint: everything stands beyond the lot
    expect(check(client.document, OFFICIAL_READER).diagnostics.filter((d) => d.code.startsWith('FS-CTXT'))).toEqual([]);

    // a tree drawn by hand, then regenerate with another seed: the hand-drawn tree stays, the street keeps its name
    const hand = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'setProperty', id: '$document', path: '/extensions/FS_context/trees/OAK', value: { at: [-60 * FT, 60 * FT], height: 50 * FT, spread: 40 * FT } }] } });
    expect(hand.isError, texts(hand)).toBeFalsy();
    const again = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'generateContext', seed: 4 }] } });
    expect(again.isError, texts(again)).toBeFalsy();
    expect(texts(again)).toMatch(/replacing \d+ generated before/);
    const doc = client.document as Doc;
    expect(doc.extensions!.FS_context!.trees!['OAK']).toBeDefined();
    expect(Object.values(doc.extensions!.FS_context!.streets!)[0]!.name).toBe('Garden Lane');

    const d = texts(await mcp.callTool({ name: 'floorspec_describe', arguments: {} }));
    expect(d).toContain('## Context (FS_context: beyond the lot — never part of the design');
    expect(d).toMatch(/street ST1 "Garden Lane": 49' 0" overall/);
    expect(d).toMatch(/neighbour NB1 .*(gable|hip) roof/);
    expect(d).toMatch(/trees beyond the lot: \d+ deciduous, \d+ evergreen/);
    expect(d).not.toMatch(/compliant/i);
  });

  it('says why when the plan has no lot, and keeps the agent\'s op where it was', async () => {
    const noLot = structuredClone(SLOPE);
    delete noLot['site'];
    const client = new ApplierClient(noLot);
    const mcp = await connect(client);
    const r = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'generateContext' }] } });
    expect(r.isError).toBe(true);
    expect(texts(r)).toContain('generateContext: The lot has no boundary');
    const f = fillContext(SLOPE, [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Kitchen' }, { op: 'generateContext', seed: 1 }]);
    expect(f.batch).toHaveLength(2);
    expect(f.batch[1]).toEqual({ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_context', value: '0.1.0' });
    expect(f.prefix.length).toBeGreaterThan(3);
  });

  it('tells the agent how', () => {
    expect(DESIGN_PARTNER_PROMPT).toMatch(/generateContext/);
    expect(DESIGN_PARTNER_PROMPT).toMatch(/FS_context/);
  });
});
