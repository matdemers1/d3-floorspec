import { describe, expect, it } from 'vitest';
import { LIBRARY_03_HINT } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * FLR-T-12.41: the design-partner prompt names the US starter library's types, and the proxy eval's
 * agents reached for them in Floorspec 0.1 seeds, whose schema has none of a 0.3 door type's
 * members. The refusal says how to take one, and taking it that way works.
 */
const HOUSE_01 = {
  floorspec: '0.1',
  project: { name: 'Lake house' },
  buildings: { B1: {} },
  levels: { L1: { building: 'B1', elevation: 0, height: 3456000 } },
  types: { WT: { kind: 'wallType', layers: [{ thickness: 128000, function: 'core' }] } },
  junctions: {
    J1: { level: 'L1', position: [0, 0] },
    J2: { level: 'L1', position: [0, 3840000] },
    J3: { level: 'L1', position: [5120000, 3840000] },
    J4: { level: 'L1', position: [5120000, 0] },
  },
  walls: {
    W1: { level: 'L1', start: 'J1', end: 'J2', type: 'WT' },
    W2: { level: 'L1', start: 'J2', end: 'J3', type: 'WT' },
    W3: { level: 'L1', start: 'J3', end: 'J4', type: 'WT' },
    W4: { level: 'L1', start: 'J4', end: 'J1', type: 'WT' },
  },
  rooms: { R1: { level: 'L1', anchor: [2560000, 1920000], name: 'Kitchen', function: 'kitchen' } },
};

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

describe('a library type in a plan older than Floorspec 0.3', () => {
  it('is refused with the upgrade to send, and taken once the batch upgrades first', async () => {
    const door = { op: 'addOpening', wall: 'W3', at: 'centered', fill: 'door-interior-swing-36x80' };
    const refused = await (await connect(new ApplierClient(HOUSE_01))).callTool({ name: 'floorspec_apply', arguments: { batch: [door] } });
    expect(refused.isError).toBe(true);
    expect(texts(refused)).toContain(`Hint: ${LIBRARY_03_HINT}`);

    const upgrade = { op: 'setProperty', id: '$document', path: '/floorspec', value: '0.4' };
    const taken = await (await connect(new ApplierClient(HOUSE_01))).callTool({ name: 'floorspec_apply', arguments: { batch: [upgrade, door] } });
    expect(taken.isError, texts(taken)).toBeFalsy();
    expect(texts(taken)).toContain('Embedded from the US starter library');
  });
});
