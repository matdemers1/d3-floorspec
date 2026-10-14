/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import { readModel, type EditorModel, type LevelView } from '../src/editor/model';
import type { Batch } from '../src/editor/ops';
import { alignBatch, distributeBatch, middleOf, mirror, quarterTurn, transformBatch, translation } from '../src/editor/arrange/transform';
import { marqueeHits, rectOf, selectableShapes } from '../src/editor/arrange/shapes';
import { copyClip, pasteBatch, readClip } from '../src/editor/arrange/clipboard';
import { wallsOfRoom } from '../src/editor/arrange/rooms';
import { arrayBatch, defaultSpec, planArray } from '../src/editor/arrange/array';

/**
 * FLR-T-18.8: arranging many elements of the Courtyard House at once, through the real applier as
 * the server applies it — every gesture one batch that commits.
 */

const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const LAYERS = { walls: true, openings: true, rooms: true, dimensions: true, findings: true, electrical: true, plumbing: true, mechanical: true, lowvoltage: true, clearances: false, coreOnly: false, roof: false };

function commit(doc: string, batch: Batch): string {
  const r = apply(doc, { batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}
const house = (): EditorModel => readModel('h', HOUSE);
const L1 = (m: EditorModel): LevelView => m.levels.find((l) => l.id === 'L1')!;
const host = (doc: string, id: string) => readModel('h', doc).levels.flatMap((l) => l.devices).find((d) => d.id === id)!.host!;

describe('moving many at once', () => {
  it('moves the three west dining chairs 1 ft east as one batch', () => {
    const m = house();
    const ids = ['GR-CW0', 'GR-CW1', 'GR-CW2'];
    const t = transformBatch(m, L1(m), ids, translation([390_144, 0]));
    expect(t.moved).toEqual(ids);
    const doc = commit(HOUSE, t.batch);
    expect(host(doc, 'GR-CW1')['position']).toEqual([16336192 + 390_144, 15800832]);
    expect(host(doc, 'GR-CW1')['room']).toBe('R7');
  });

  it('moves a room with its walls, its openings and devices following', () => {
    const m = house();
    const level = L1(m);
    expect(wallsOfRoom(level, 'R4').map((s) => s.wall.id).sort()).toEqual(['W13', 'W14', 'W30', 'W8']);
    const t = transformBatch(m, level, ['R4'], translation([0, 32_512]));
    expect(t.skipped).toEqual([]);
    expect(t.batch.filter((op) => op.op === 'moveJunction').length).toBe(4);
    // Its toilet goes with it.
    expect(t.batch.some((op) => op.op === 'moveElement' && (op as { element: string }).element === 'PWD-WC')).toBe(true);
    // The guest bath next door shares a wall with it, and its toilet is backed onto that wall: the
    // server refuses what would put it inside the wall, as it refuses any other edit that would.
    const r = apply(HOUSE, { batch: t.batch }, OFFICIAL_READER);
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.diagnostics.map((d) => d.elements).flat()).toContain('GBA-WC');
  });

  it('turns and mirrors a group of furniture about its middle', () => {
    const m = house();
    const ids = ['GR-CW0', 'GR-CW1', 'GR-CW2', 'GR-TABLE', 'GR-CE0', 'GR-CE1', 'GR-CE2'];
    const c = middleOf(L1(m), ids)!;
    const turned = commit(HOUSE, transformBatch(m, L1(m), ids, quarterTurn(c, -1)).batch);
    expect(host(turned, 'GR-TABLE')['rotation']).toBe(-90_000_000);
    const flipped = commit(HOUSE, transformBatch(m, L1(m), ids, mirror(c, 'h')).batch);
    // The west chairs face east (0°); mirrored left ↔ right they face west.
    expect(host(flipped, 'GR-CW0')['rotation']).toBe(180_000_000);
  });

  it('mirrors a room standing on its own without turning its exterior inside', () => {
    // A copy of the powder room out on the lawn, then mirrored north ↔ south about its middle.
    const m = house();
    const clip = copyClip(m, L1(m), ['R4'], 'p')!;
    const pasted = pasteBatch(m, L1(m), clip, { offsets: [[0, -8 * 390_144]], attempt: 0, sameProject: true });
    const doc = commit(HOUSE, pasted.batch);
    const m2 = readModel('m2', doc);
    const level = L1(m2);
    const ids = pasted.ids.filter((id) => m2.index.has(id));
    const t = transformBatch(m2, level, ids, mirror(middleOf(level, ids)!, 'v'));
    expect(t.batch.some((op) => op.op === 'setProperty' && op.path === '/start')).toBe(true);
    const after = readModel('m3', commit(doc, t.batch));
    // The exterior wall's exterior was south (its left, Core 5.4); mirrored, it is north.
    const ext = L1(after).walls.find((w) => w.id === 'W30-2')!;
    expect(ext.a[1]).toBeGreaterThan(-8 * 390_144);
    expect(after.valid).toBe(true);
  });

  it('aligns and distributes', () => {
    const m = house();
    const ids = ['GR-CW0', 'GR-CHAIR1', 'GR-CE0'];
    commit(HOUSE, alignBatch(m, L1(m), ids, 'top').batch);
    const d = distributeBatch(m, L1(m), ['GR-CW0', 'GR-CW1', 'GR-CW2', 'GR-CHAIR1'], 'y');
    commit(HOUSE, d.batch);
  });
});

describe('the marquee', () => {
  it('a window takes what is wholly inside; a crossing takes what it touches, but not the room', () => {
    const m = house();
    const shapes = selectableShapes(L1(m), LAYERS);
    // Around the west chairs, whose seats tuck under the table.
    const window = marqueeHits(shapes, rectOf([16_300_000, 14_850_000], [17_000_000, 16_750_000]), false);
    expect(window.filter((id) => id.startsWith('GR-'))).toEqual(['GR-CW0', 'GR-CW1', 'GR-CW2']);
    expect(window).not.toContain('R7');
    // A crossing over their backs catches the three west chairs and not the table (the board's frame).
    const crossing = marqueeHits(shapes, rectOf([16_500_000, 14_900_000], [16_300_000, 16_700_000]), true);
    expect(crossing.filter((id) => id.startsWith('GR-'))).toEqual(['GR-CW0', 'GR-CW1', 'GR-CW2']);
    expect(crossing).not.toContain('R7');
    // Wider, the crossing touches the table too.
    expect(marqueeHits(shapes, rectOf([16_300_000, 14_900_000], [16_900_000, 16_700_000]), true)).toContain('GR-TABLE');
  });
});

describe('copy, paste, duplicate and array', () => {
  const pasteInto = (doc: string, from: EditorModel, ids: string[], level: string, offsets: [number, number][], sameProject = true) => {
    const clip = copyClip(from, from.levels.find((l) => l.id === (from.levels.find((l) => ids.some((id) => l.devices.some((d) => d.id === id) || l.walls.some((w) => w.id === id) || l.rooms.some((x) => x.id === id)))?.id ?? 'L1'))!, ids, 'p')!;
    const target = readModel('t', doc);
    const p = pasteBatch(target, target.levels.find((l) => l.id === level)!, clip, { offsets, attempt: 0, sameProject });
    return { ...p, doc: commit(doc, p.batch), clip };
  };

  it('duplicates the west chairs beside themselves, named after them', () => {
    const r = pasteInto(HOUSE, house(), ['GR-CW0', 'GR-CW1', 'GR-CW2'], 'L1', [[-390_144, 0]]);
    expect(r.ids).toEqual(['GR-CW0-2', 'GR-CW1-2', 'GR-CW2-2']);
    expect(host(r.doc, 'GR-CW0-2')).toMatchObject({ mode: 'surface', room: 'R7', position: [16336192 - 390_144, 15160832] });
  });

  it('copies a room with its walls and its door, and the copy is a room of its own', () => {
    const r = pasteInto(HOUSE, house(), ['R4'], 'L1', [[0, -8 * 390_144]]);
    expect(r.ids.some((id) => id.startsWith('R4-'))).toBe(true);
    const m = readModel('x', r.doc);
    expect(m.valid).toBe(true);
    const copy = m.levels.find((l) => l.id === 'L1')!.rooms.find((x) => x.id === 'R4-2');
    expect(copy?.name).toBe('Powder 2');
  });

  it('copies the entry light to the upper floor, ceiling to ceiling, into the room above', () => {
    const r = pasteInto(HOUSE, house(), ['X95'], 'L2', [[0, 0]]);
    const h = host(r.doc, 'X95-2');
    expect(h).toMatchObject({ mode: 'surface', surface: 'ceiling', room: 'R13', position: [15768320, 4779264] });
  });

  it('leaves behind a ceiling light with no room above it', () => {
    const m = house();
    const clip = copyClip(m, L1(m), ['L-GR-R1'], 'p')!;
    const up = m.levels.find((l) => l.id === 'L2')!;
    const p = pasteBatch(m, up, clip, { offsets: [[0, 0]], attempt: 0, sameProject: true });
    expect(p.skipped).toEqual(['L-GR-R1']);
  });

  it('arrays a recessed light along a line, keeping the copies on its circuit', () => {
    const m = house();
    const r = pasteInto(HOUSE, m, ['L-GR-R1'], 'L1', [[0, -1 * 6 * 390_144 / 2], [0, -2 * 6 * 390_144 / 2]]);
    expect(r.ids).toEqual(['L-GR-R1-2', 'L-GR-R1-3']);
    const circuit = Object.entries((JSON.parse(r.doc) as { extensions: { FS_electrical: { circuits: Record<string, { loads?: string[] }> } } }).extensions.FS_electrical.circuits).find(([, c]) => c.loads?.includes('L-GR-R1'));
    if (circuit !== undefined) expect(circuit[1].loads).toEqual(expect.arrayContaining(['L-GR-R1-2', 'L-GR-R1-3']));
  });

  it('pastes outlets along their own wall', () => {
    const m = house();
    const outlet = L1(m).devices.find((d) => d.collection === 'receptacles' && d.host?.['mode'] === 'wallFace')!;
    const r = pasteInto(HOUSE, m, [outlet.id], 'L1', [[32_512 * 12, 0]]);
    expect(r.skipped).toEqual([]);
    expect(host(r.doc, r.ids[0]!)['wall']).toBe(outlet.host!['wall']);
  });

  it('pastes into another project: its types, materials and assets come along, foreign references go', () => {
    const other = readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8');
    const target = readModel('o', other);
    const r = pasteInto(other, house(), ['GR-CW0', 'GR-TABLE', 'KIT-ISLAND'], target.levels[0]!.id, [[0, 0]], false);
    expect(readModel('y', r.doc).valid).toBe(true);
    expect(r.clip.dependencies.length).toBeGreaterThan(0);
  });

  it('the clip survives the clipboard as text', () => {
    const clip = copyClip(house(), L1(house()), ['GR-CW0'], 'p')!;
    expect(readClip(JSON.stringify(clip))).toEqual(clip);
    expect(readClip('hello')).toBeNull();
  });
});

describe('array and copy along a wall', () => {
  it('lays recessed lights along the wall nearest them, every 6 ft, on the original circuit', () => {
    const m = house();
    const level = L1(m);
    const spec = defaultSpec(level, ['L-GR-R1'], false);
    expect(spec.mode).toBe('wall');
    expect(planArray(level, ['L-GR-R1'], spec)!.offsets).toHaveLength(3);
    // The great room is 20 ft across: three in the row fit, a fourth would land outside it and stays out.
    expect(arrayBatch(m, level, ['L-GR-R1'], spec, { attempt: 0, project: 'p' }).ids).toHaveLength(2);
    const three = { ...spec, count: 3 };
    const plan = planArray(level, ['L-GR-R1'], three)!;
    expect(Math.round(Math.hypot(...(plan.offsets[0] as [number, number])))).toBe(6 * 390_144);
    const out = arrayBatch(m, level, ['L-GR-R1'], three, { attempt: 0, project: 'p' });
    expect(out.ids).toEqual(['L-GR-R1-2', 'L-GR-R1-3']);
    const doc = commit(HOUSE, out.batch);
    expect(readModel('a', doc).valid).toBe(true);
  });

  it('sets the row a distance off the wall and fits it between the room’s ends', () => {
    const m = house();
    const level = L1(m);
    const spec = { ...defaultSpec(level, ['L-GR-R1'], false), offset: 2 * 390_144, fit: true, count: 4 };
    const plan = planArray(level, ['L-GR-R1'], spec)!;
    const ref = plan.wall!;
    const [a, b] = ref.span;
    expect(plan.spacing).toBe(Math.round((b - a) / 4));
    commit(HOUSE, arrayBatch(m, level, ['L-GR-R1'], spec, { attempt: 0, project: 'p' }).batch);
  });

  it('runs outlets along their own wall, and a line and a grid of chairs', () => {
    const m = house();
    const level = L1(m);
    const outlet = level.devices.find((d) => d.collection === 'receptacles' && d.host?.['mode'] === 'wallFace' && Number(d.host['offset']) < 600_000)!;
    const spec = { ...defaultSpec(level, [outlet.id], false), count: 2, spacing: 390_144 };
    const r = arrayBatch(m, level, [outlet.id], spec, { attempt: 0, project: 'p' });
    const doc = commit(HOUSE, r.batch);
    expect(host(doc, r.ids[0]!)['wall']).toBe(outlet.host!['wall']);
    expect(Number(host(doc, r.ids[0]!)['offset']) - Number(outlet.host!['offset'])).toBe(390_144);
    const line = arrayBatch(m, level, ['GR-CW0'], { ...spec, mode: 'line', count: 3, direction: 270, spacing: 640_000 }, { attempt: 0, project: 'p' });
    expect(line.ids).toHaveLength(2);
    const grid = arrayBatch(m, level, ['BT-CHAIR1'], { ...spec, mode: 'grid', count: 2, rows: 2, spacing: 1_200_000 }, { attempt: 0, project: 'p' });
    expect(grid.ids).toHaveLength(3);
  });
});
