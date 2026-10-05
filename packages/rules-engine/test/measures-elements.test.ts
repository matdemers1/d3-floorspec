/** Chapter 7: measures of extension elements and clearance envelopes, on small hand-made documents. */
import { describe, expect, it } from 'vitest';
import { box, doc, element, envelope, free, FT, HALF, IN, measures, one, thing, type Spec } from './docs.js';

const W = 12 * FT;
const H = 10 * FT;

/** A panel on the inside of W1 (its east face, x = T/2), 5' along it, with a 30" × 3' working space. */
const PANEL = {
  ...thing({ min: [0, -256000, -512000], max: [128000, 256000, 512000] }, { mode: 'wallFace', wall: 'W1', side: 'right', offset: 5 * FT, height: 1536000 }),
  volts: [120, 240],
  rating: 100,
  spaces: 20,
  clearances: { working: { purpose: 'workingSpace', shape: 'box', min: [0, -15 * IN, -1536000], max: [3 * FT, 15 * IN, 1024000] } },
};

/** A test-extension box, `half` on a side around (x, y), from z0 to z1 above the floor. */
const block = (x: number, y: number, z0 = 0, z1 = 1280000, half = 256000, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...thing({ min: [-half, -half, z0], max: [half, half, z1] }, free(x, y)),
  ...extra,
});

function panelRoom(things: Record<string, Record<string, unknown>> = {}): Record<string, unknown> {
  return doc(
    box(W, H, {
      extensionsUsed: { FS_electrical: '0.1.0', ...(Object.keys(things).length && { EXT_test: '1.0.0' }) },
      extensions: {
        FS_electrical: { collections: { panels: { X1: PANEL } } },
        ...(Object.keys(things).length && { EXT_test: { collections: { things } } }),
      },
    }),
  );
}

const WORKING = envelope('X1', 'working');

describe('heights above the floor (7.3)', () => {
  it('are the bottom and top of the fallback box, less the floor', () => {
    const d = panelRoom();
    expect(one(d, element('X1'), 'elementBottomAboveFloor')).toEqual({ type: 'length', value: 1024000, display: "2' 7 1/2\"" });
    expect(one(d, element('X1'), 'elementTopAboveFloor').value).toBe(2048000);
  });
});

describe('envelopes as declared (7.5)', () => {
  it('give the purpose, depth, width, height and bottom of the box the owner declares', () => {
    const r = measures(panelRoom(), [
      { target: WORKING, measure: 'envelopePurpose' },
      { target: WORKING, measure: 'envelopeDepth' },
      { target: WORKING, measure: 'envelopeWidth' },
      { target: WORKING, measure: 'envelopeHeight' },
      { target: WORKING, measure: 'envelopeBottomAboveFloor' },
    ]);
    expect(r.map((x) => x.value)).toEqual(['workingSpace', 3 * FT, 30 * IN, 2560000, 0]);
    expect(r.map((x) => x.display)).toEqual(['workingSpace', "3' 0\"", "2' 6\"", "6' 6 3/4\"", "0' 0\""]);
  });
});

describe('envelopeObstructions (7.6) and clearDepthInFront (7.7)', () => {
  // The panel's near face is the wall's inside face, x = T/2; its strip is 5' ± 15".
  const nearFace = HALF;

  it('an empty room: nothing obstructs, and the depth runs to the opposite wall or the limit', () => {
    const d = panelRoom();
    expect(one(d, WORKING, 'envelopeObstructions')).toEqual({ type: 'count', value: 0, display: '0', involved: [] });
    expect(one(d, WORKING, 'clearDepthInFront', { limit: 3 * FT })).toEqual({ type: 'length', value: 3 * FT, display: "3' 0\"", involved: [] });
    // With a 20' limit, the opposite wall W3 (inside face at W − T/2) stops it. The host wall W1
    // and the walls beside the strip (W2, W4) do not.
    expect(one(d, WORKING, 'clearDepthInFront', { limit: 20 * FT })).toEqual({
      type: 'length',
      value: W - HALF - nearFace,
      display: "11' 8 1/16\"",
      involved: ['W3'],
    });
  });

  it('a box standing in the working space obstructs it, and is how far the space stays clear', () => {
    const d = panelRoom({ Y: block(960000, 5 * FT) });
    expect(one(d, WORKING, 'envelopeObstructions')).toEqual({ type: 'count', value: 1, display: '1', involved: ['Y'] });
    // Its near edge is at x = 960,000 − 256,000 = 704,000: 640,000 from the near face.
    expect(one(d, WORKING, 'clearDepthInFront', { limit: 30 * IN })).toEqual({ type: 'length', value: 704000 - nearFace, display: "1' 7 11/16\"", involved: ['Y'] });
    // Under the limit of 320,000 it is clear to the limit, and names nothing.
    expect(one(d, WORKING, 'clearDepthInFront', { limit: 320000 })).toEqual({ type: 'length', value: 320000, display: "0' 9 13/16\"", involved: [] });
  });

  it('a box above the space, or beside it, does not obstruct it or shorten it', () => {
    const d = panelRoom({
      ABOVE: block(960000, 5 * FT, 2560000, 3000000),
      // Its south edge is exactly the strip's north edge: interiors do not meet.
      BESIDE: block(960000, 5 * FT + 15 * IN + 256000),
    });
    expect(one(d, WORKING, 'envelopeObstructions').value).toBe(0);
    expect(one(d, WORKING, 'clearDepthInFront', { limit: 3 * FT }).value).toBe(3 * FT);
  });

  it('a box past the declared depth does not obstruct, but does shorten the clear depth up to the limit', () => {
    const d = panelRoom({ FAR: block(64000 + 5 * FT + 256000, 5 * FT) });
    expect(one(d, WORKING, 'envelopeObstructions').value).toBe(0);
    expect(one(d, WORKING, 'clearDepthInFront', { limit: 6 * FT })).toMatchObject({ value: 5 * FT, involved: ['FAR'] });
    expect(one(d, WORKING, 'clearDepthInFront', { limit: 4 * FT })).toMatchObject({ value: 4 * FT, involved: [] });
  });

  it('two boxes at the same distance are both named', () => {
    const d = panelRoom({ A: block(960000, 5 * FT - 300000, 0, 1280000, 128000), B: block(960000, 5 * FT + 300000, 0, 1280000, 128000) });
    expect(one(d, WORKING, 'clearDepthInFront', { limit: 3 * FT })).toMatchObject({ value: 960000 - 128000 - nearFace, involved: ['A', 'B'] });
  });

  it('works in the frame of an element turned 90°: its local x runs north', () => {
    // A free-standing unit at (6', 2') facing north (90° = 90,000,000 µ°), its space 3' deep and 2' wide.
    const unit = {
      ...thing({ min: [-128000, -256000, 0], max: [0, 256000, 1280000] }, free(6 * FT, 2 * FT, 90000000)),
      clearances: { front: { purpose: 'access', shape: 'box', min: [0, -FT, 0], max: [3 * FT, FT, 2000000] } },
    };
    const d = doc(
      box(W, H, {
        extensionsUsed: { EXT_test: '1.0.0' },
        extensions: { EXT_test: { collections: { things: { U: unit, Z: block(6 * FT, 2 * FT + 700000 + 256000) } } } },
      }),
    );
    const front = envelope('U', 'front');
    expect(one(d, front, 'clearDepthInFront', { limit: 3 * FT })).toMatchObject({ value: 700000, involved: ['Z'] });
    expect(one(d, front, 'envelopeObstructions')).toMatchObject({ value: 1, involved: ['Z'] });
    expect(one(d, front, 'envelopeWidth').value).toBe(2 * FT);
  });
});

describe('envelopeOverlaps (7.8)', () => {
  it('counts the envelopes of other owners that overlap, of a purpose when given, and names their owners', () => {
    const swinger = block(700000, 5 * FT, 0, IN, IN, {
      clearances: { swing: { purpose: 'swing', shape: 'box', min: [-128000, -128000, 0], max: [128000, 128000, 1280000] } },
    });
    const d = panelRoom({ V: swinger });
    expect(one(d, WORKING, 'envelopeOverlaps')).toEqual({ type: 'count', value: 1, display: '1', involved: ['V'] });
    expect(one(d, WORKING, 'envelopeOverlaps', { purpose: 'swing' }).value).toBe(1);
    expect(one(d, WORKING, 'envelopeOverlaps', { purpose: 'access' })).toEqual({ type: 'count', value: 0, display: '0', involved: [] });
    expect(one(d, envelope('V', 'swing'), 'envelopeOverlaps', { purpose: 'workingSpace' })).toMatchObject({ value: 1, involved: ['X1'] });
  });
});

describe('members, rooms and protection (7.1, 7.2, 7.4) — FS_electrical evaluated', () => {
  const recep = (offset: number, side: 'left' | 'right', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...thing({ min: [0, -51200, -76800], max: [32000, 51200, 76800] }, { mode: 'wallFace', wall: 'W1', side, offset, height: FT }),
    ...extra,
  });
  const s: Spec = box(W, H, {
    rooms: { R1: { anchor: [W / 2, H / 2], function: 'kitchen' } },
    extensionsUsed: { FS_electrical: '0.1.0', FS_lowvoltage: '0.1.0' },
    extensions: {
      FS_electrical: {
        collections: {
          panels: { X1: PANEL },
          receptacles: { X4: recep(2 * FT, 'right'), X5: recep(7 * FT, 'right', { features: ['usb', 'gfci'], amps: 20 }), X6: recep(7 * FT, 'left') },
          alarms: { X7: { ...thing({ min: [-IN, -IN, -IN], max: [IN, IN, 0] }, { mode: 'surface', room: 'R1', surface: 'ceiling', position: [3 * FT, 3 * FT] }), detects: ['smoke'] } },
        },
        circuits: { C1: { panel: 'X1', breaker: 20, volts: 120, protection: ['afci'], loads: ['X4', 'X7'] } },
      },
      FS_lowvoltage: { collections: { security: { S1: { ...thing({ min: [-IN, -IN, 0], max: [IN, IN, IN] }, free(4 * FT, 4 * FT)), device: 'motion' } } } },
    },
  });
  const d = doc(s);
  const mem = (id: string, name: string, type: string, unit?: string): Record<string, unknown> => ({ name, type, ...(unit && { unit }) });

  it('elementMember reads a member with its default, of the type asked, or has no value', () => {
    const r = measures(d, [
      { target: element('X4'), measure: 'elementMember', args: mem('X4', 'amps', 'integer', 'A') },
      { target: element('X5'), measure: 'elementMember', args: mem('X5', 'amps', 'integer', 'A') },
      { target: element('X4'), measure: 'elementMember', args: mem('X4', 'features', 'terms') },
      { target: element('X5'), measure: 'elementMember', args: mem('X5', 'features', 'terms') },
      { target: element('X7'), measure: 'elementMember', args: mem('X7', 'power', 'term') },
      { target: element('X7'), measure: 'elementMember', args: mem('X7', 'interconnect', 'term') },
      { target: element('X4'), measure: 'elementMember', args: mem('X4', 'amps', 'term') },
      { target: element('S1'), measure: 'elementMember', args: mem('S1', 'wireless', 'boolean') },
      { target: element('X4'), measure: 'elementMember', args: mem('X4', 'outlets', 'integer') },
    ]);
    expect(r.map((x) => [x.value, x.display])).toEqual([
      [15, '15 A'],
      [20, '20 A'],
      [[], 'none'],
      [['gfci', 'usb'], 'gfci, usb'],
      ['mainsWithBattery', 'mainsWithBattery'],
      [null, 'not stated'],
      [null, 'not stated'],
      [false, 'no'],
      [2, '2'],
    ]);
    expect(r.map((x) => x.type)).toEqual(['integer', 'integer', 'terms', 'terms', 'term', 'term', 'term', 'boolean', 'integer']);
  });

  it('elementRoomFunction is the function of the room the element is in, or none', () => {
    const r = measures(d, ['X4', 'X6', 'X7', 'S1', 'X1'].map((id) => ({ target: element(id), measure: 'elementRoomFunction' })));
    expect(r.map((x) => x.value)).toEqual(['kitchen', 'none', 'kitchen', 'kitchen', 'kitchen']);
  });

  it('elementProtectedBy: its own features, or a circuit it is a load of — which it names', () => {
    const r = measures(d, [
      { target: element('X4'), measure: 'elementProtectedBy', args: { protection: 'afci' } },
      { target: element('X4'), measure: 'elementProtectedBy', args: { protection: 'gfci' } },
      { target: element('X5'), measure: 'elementProtectedBy', args: { protection: 'gfci' } },
      { target: element('X5'), measure: 'elementProtectedBy', args: { protection: 'afci' } },
      { target: element('X7'), measure: 'elementProtectedBy', args: { protection: 'afci' } },
    ]);
    expect(r).toEqual([
      { type: 'boolean', value: true, display: 'yes', involved: ['C1'] },
      { type: 'boolean', value: false, display: 'no', involved: [] },
      { type: 'boolean', value: true, display: 'yes', involved: [] },
      { type: 'boolean', value: false, display: 'no', involved: [] },
      { type: 'boolean', value: true, display: 'yes', involved: ['C1'] },
    ]);
  });
});
