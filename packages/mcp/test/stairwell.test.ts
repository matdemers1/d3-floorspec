/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { contentHash, evaluate, OFFICIAL_READER } from '@floorspec/engine';
import { describe, expect, it } from 'vitest';
import { describe as summary, describeJson } from '../src/index.js';
import { landings, wells } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * FLR-T-12.11, from the first live house: a stair that declares minHeadroom got FS-LINT-019 and
 * nothing to do about it — the agent drew the well by hand, working the headroom out from Core 17.6,
 * and nothing said the stair's head landed 8" from a wall.
 */

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

const FT = 390144;
const IN = 32512;

/** A client whose validate runs the reference engine, as the API does. */
class Validating extends ApplierClient {
  override validate() {
    const ev = evaluate(this.document, OFFICIAL_READER);
    return Promise.resolve({ head: 'main', hash: contentHash(this.document), valid: ev.valid, diagnostics: ev.diagnostics.map(({ code, severity, message, elements }) => ({ code, severity, message, elements: [...elements] })) });
  }
}

/** 12' × 20' on two levels; upstairs a wall at x = 4' with a room either side; a stair rising north beside it. */
async function house(stairY = 2): Promise<{ client: Validating; mcp: Awaited<ReturnType<typeof connect>> }> {
  const client = new Validating({ floorspec: '0.4', project: { name: 'Stair test' } });
  const mcp = await connect(client);
  const box = (level: string) =>
    [
      [[0, 0], [12, 0]],
      [[12, 0], [12, 20]],
      [[12, 20], [0, 20]],
      [[0, 20], [0, 0]],
    ].map(([a, b]) => ({ op: 'drawWall', level, from: a!.map((v) => `${String(v)}'`), to: b!.map((v) => `${String(v)}'`), type: 'wall-2x6-exterior-fibre-cement' }));
  const first = await mcp.callTool({
    name: 'floorspec_apply',
    arguments: {
      batch: [
        { op: 'addElement', collection: 'buildings', id: 'B1', element: {} },
        { op: 'addLevel', building: 'B1', id: 'L1', elevation: 0, height: "10'" },
        { op: 'addLevel', building: 'B1', id: 'L2', above: 'L1', height: "9'" },
        { op: 'setProperty', id: 'L1', path: '/ceilingHeight', value: 9 * FT },
        ...box('L1'),
        ...box('L2'),
        { op: 'drawWall', level: 'L2', from: ["4'", "0'"], to: ["4'", "20'"], type: 'wall-2x4-interior' },
        { op: 'addRoom', level: 'L1', at: ["8'", "10'"], name: 'Hall' },
        { op: 'addRoom', level: 'L2', at: ["2'", "10'"], name: 'West' },
        // Anchored where the well will be: the batch has to move it out first.
        { op: 'addRoom', level: 'L2', at: ["6'", "10'"], name: 'Landing' },
        {
          op: 'addElement',
          collection: 'stairs',
          id: 'ST1',
          // 3' wide, its west edge 3 1/4" east of the wall's line — 1" clear of its face.
          element: { level: 'L1', to: 'L2', position: [4 * FT + Math.round(3.25 * IN) + 18 * IN, stairY * FT], rotation: 90_000_000, width: 36 * IN, tread: 10 * IN, maxRiser: Math.round(7.75 * IN), minHeadroom: 80 * IN },
        },
      ],
    },
  });
  expect(first.isError, texts(first)).toBeFalsy();
  return { client, mcp };
}

describe('a stair\'s well, as operations', () => {
  it('comes with FS-LINT-019: separators round the steps that need it, the wall side left to the wall, the room moved out', async () => {
    const { client, mcp } = await house();
    const validated = await mcp.callTool({ name: 'floorspec_validate', arguments: {} });
    expect(texts(validated)).toContain('FS-LINT-019');
    const [well] = (validated.structuredContent as { wells: ReturnType<typeof wells> }).wells;
    expect(well!.stair).toBe('ST1');
    expect(well!.level).toBe('L2');
    // The wall at x = 4' is one side; the stair arrives at the north one, left open; the other two get guards.
    expect(well!.batch.filter((op) => op.op === 'drawSeparator')).toHaveLength(1);
    const guards = well!.batch.filter((op) => op.op === 'drawWall');
    expect(guards).toHaveLength(2);
    expect(guards.every((g) => g['justification'] === 'exteriorFace' && (g['top'] as { height: number }).height === 36 * IN)).toBe(true);
    expect(well!.outline.every(([x]) => x >= 4 * FT)).toBe(true);
    expect(well!.outline.some(([x]) => x === 4 * FT)).toBe(true);
    // The Landing's anchor was in the way; it moves first.
    expect(well!.batch[0]).toMatchObject({ op: 'setProperty', path: '/anchor' });

    // Sent as it is, it clears the warning and leaves the Landing a room.
    const fixed = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: well!.batch } });
    expect(fixed.isError, texts(fixed)).toBeFalsy();
    const after = evaluate(client.document, OFFICIAL_READER);
    expect(after.diagnostics.map((d) => d.code)).not.toContain('FS-LINT-019');
    expect(describeJson(client.document).levels.find((l) => l.id === 'L2')!.rooms.map((r) => r.name).sort()).toEqual(['Landing', 'West']);
    expect(wells(client.document)).toEqual([]);
  });

  it('says how much floor a stair has at its foot and head, and when that is short of a landing', async () => {
    const roomy = await house();
    const [ok] = landings(roomy.client.document);
    // 16 risers, 15 treads of 10": the head is at 14' 6"; the north wall's face at 20' less 3 3/8".
    expect(ok!.head).toBeGreaterThan(5 * FT);
    expect(summary(roomy.client.document)).toMatch(/clear beyond the head(?! — short)/);
    // Moved 3' north, the head is 2' 4" from the wall's face: short of a landing.
    const tight = await house(5);
    const [short] = landings(tight.client.document);
    expect(short!.head).toBeLessThan(36 * IN);
    expect(summary(tight.client.document)).toMatch(/clear beyond the head — short of a landing/);
  });
});
