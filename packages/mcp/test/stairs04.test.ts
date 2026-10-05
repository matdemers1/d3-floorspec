/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe as group, expect, it } from 'vitest';
import { describe, describeJson, DESIGN_PARTNER_PROMPT, NEWEL_HINT, STAIR_04_HINT, TAPER_HINT } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * Winder and spiral stairs (Floorspec Core 0.4, 17.6, 17.7; FLR-T-11.3) through MCP: floorspec_describe
 * lists their tapered treads' least goings and a stair's designed headroom with the opening it needs,
 * the design-partner prompt names them where it names L stairs, and a rejected batch says how to fix it.
 */

const SUITE = '../../engine/standard/conformance/core/0.4/stairs';
const input = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`${SUITE}/${name}/input.json`, import.meta.url), 'utf8')) as Record<string, unknown>;

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

group('Core 0.4: winder and spiral stairs in floorspec_describe', () => {
  it('lists a winder with a newel: its least goings at the walkline and the narrow end', () => {
    const d = input('050-winder-with-newel');
    const st = describeJson(d).levels.flatMap((l) => l.stairs ?? [])[0]!;
    expect([st.form, st.walklineGoing?.baseUnits, st.narrowGoing?.baseUnits]).toEqual(['winder', 298_160, 73_901]);
    expect(describe(JSON.stringify(d))).toMatch(/- ST1: winder to L2, 14 risers × [^\n]*; tapered treads: least going [^\n]* at the walkline, [^\n]* at the narrow end/);
  });

  it('lists a spiral the same way', () => {
    const st = describeJson(input('016-spiral')).levels.flatMap((l) => l.stairs ?? [])[0]!;
    expect([st.form, st.walklineGoing?.baseUnits, st.narrowGoing?.baseUnits]).toEqual(['spiral', 249_716, 49_943]);
  });

  it('says where the floor above must be open for the headroom a stair is designed for', () => {
    const d = input('058-opening');
    const st = describeJson(d).levels.flatMap((l) => l.stairs ?? [])[0]!;
    expect([st.minHeadroom?.baseUnits, st.openFromStep, st.walklineGoing]).toEqual([2_304_000, 4, undefined]);
    expect(describe(JSON.stringify(d))).toMatch(/; designed for [^\n]* headroom, the floor above open from step 4/);
  });

  it('is named in the design-partner prompt where L stairs are', () => {
    expect(DESIGN_PARTNER_PROMPT).toMatch(/"kind":"winder"/);
    expect(DESIGN_PARTNER_PROMPT).toMatch(/"kind":"spiral"/);
    expect(DESIGN_PARTNER_PROMPT).toMatch(/"newel"/);
    expect(DESIGN_PARTNER_PROMPT).toMatch(/"minHeadroom"/);
  });
});

group('Core 0.4: hints for winder and spiral stairs', () => {
  const as03 = (d: Record<string, unknown>) => ({ ...d, floorspec: '0.3' });

  it('says to upgrade to 0.4 when a newel or a minHeadroom is sent to a 0.3 plan, and the upgrade then commits', async () => {
    const d = input('050-winder-with-newel');
    const st = (d['stairs'] as Record<string, Record<string, unknown>>)['ST1']!;
    const form = { ...(st['form'] as Record<string, unknown>) };
    delete form['newel'];
    const plan = as03({ ...d, stairs: { ST1: { ...st, form } } });
    const client = new ApplierClient(plan);
    const mcp = await connect(client);
    const batch = [{ op: 'setProperty', id: 'ST1', path: '/form/newel', value: 128_000 }];
    const result = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch } });
    expect(result.isError).toBe(true);
    expect(texts(result)).toContain(`Hint: ${STAIR_04_HINT}`);
    const upgraded = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.4' }, ...batch] } });
    expect(upgraded.isError, texts(upgraded)).toBeFalsy();
  });

  it('explains a newel that reaches the walkline (FS-INV-905), and a spiral of too few risers (FS-INV-906)', async () => {
    const mcp = await connect(new ApplierClient(input('050-winder-with-newel')));
    const deep = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'setProperty', id: 'ST1', path: '/form/newel', value: 600_000 }] } });
    expect(deep.isError).toBe(true);
    expect(texts(deep)).toContain('FS-INV-905');
    expect(texts(deep)).toContain(`Hint: ${NEWEL_HINT}`);
    const spiral = await connect(new ApplierClient(input('016-spiral')));
    // Two risers on a 270° sweep: its one tread turns through 270°.
    const one = await spiral.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'setProperty', id: 'ST1', path: '/risers', value: 2 }] } });
    expect(one.isError).toBe(true);
    expect(texts(one)).toContain('FS-INV-906');
    expect(texts(one)).toContain(`Hint: ${TAPER_HINT}`);
  });
});
