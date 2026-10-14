/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
/**
 * FLR-T-18.13: renovation plans in the editor — the filter kept per project, the model each filter
 * draws, what a click can pick, new work marked as it is drawn, the status field's batch for one
 * element or many, and the remodel's schedules — on the courtyard house's kitchen remodel.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readModel } from '../src/editor/model';
import { filteredModel, markNew, pickableUnder, statusBatch, statusIn, stylesFor } from '../src/editor/renovation';
import { renovationAreasSchedule, renovationQuantitiesSchedule, schedules } from '../src/schedules/derive';

const REMODEL = readFileSync(new URL('../../worker/test/fixtures/courtyard-remodel.json', import.meta.url), 'utf8');
const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');

describe('renovation plans in the editor', () => {
  const model = readModel('r', REMODEL);

  it('reads the remodel as valid, with what FS_renovation derives', () => {
    expect(model.valid).toBe(true);
    expect(statusIn(model, 'W17')).toBe('demolish');
    expect(statusIn(model, 'KIT-ISLAND-N')).toBe('new');
    expect(statusIn(model, 'W24')).toBe('existing');
    expect(statusIn(model, 'J24')).toBeNull();
  });

  it('draws each filter from its state: the pantry stands in the existing plan and is gone in the proposed one', () => {
    const existing = filteredModel(model, 'existing');
    const proposed = filteredModel(model, 'proposed');
    expect(filteredModel(model, 'combined')).toBe(model);
    expect(filteredModel(model, 'existing')).toBe(existing);
    const l1 = (m: typeof model) => m.levels.find((l) => l.id === 'L1')!;
    expect(l1(existing).walls.some((w) => w.id === 'W17')).toBe(true);
    expect(l1(existing).walls.some((w) => w.id === 'W90')).toBe(false);
    expect(l1(proposed).walls.some((w) => w.id === 'W17')).toBe(false);
    expect(l1(proposed).rooms.some((r) => r.id === 'R9')).toBe(false);
    // The Kitchen takes the pantry's floor.
    const kitchen = (m: typeof model) => l1(m).rooms.find((r) => r.id === 'R8')!.area2;
    expect(kitchen(proposed) > kitchen(existing)).toBe(true);
  });

  it('picks nothing a filter hides', () => {
    const level = model.levels.find((l) => l.id === 'L1')!;
    const picked = pickableUnder(level, stylesFor(model, 'proposed'));
    expect(picked.walls.some((w) => w.id === 'W17')).toBe(false);
    expect(picked.walls.some((w) => w.id === 'W90')).toBe(true);
    expect(pickableUnder(level, null)).toBe(level);
  });

  it('marks what is drawn as new: walls, openings, rooms and core elements added', () => {
    const batch = markNew([
      { op: 'drawWall', level: 'L1', from: [0, 0], to: [10, 0] },
      { op: 'addOpening', wall: 'W1', at: 0 },
      { op: 'addElement', collection: 'rooms', element: { level: 'L1', anchor: [1, 1] } },
      { op: 'setProperty', id: 'W1', path: '/name', value: 'x' },
    ] as never);
    const ops = batch as unknown as Record<string, Record<string, unknown>>[];
    expect(ops[0]!['extensions']).toEqual({ FS_renovation: { status: 'new' } });
    expect(ops[1]!['extensions']).toEqual({ FS_renovation: { status: 'new' } });
    expect((ops[2]!['element'] as Record<string, unknown>)['extensions']).toEqual({ FS_renovation: { status: 'new' } });
    expect(ops[3]).toEqual({ op: 'setProperty', id: 'W1', path: '/name', value: 'x' });
  });

  it('marks a wall and what is in it as one batch, and extension elements in the document', () => {
    const batch = statusBatch(model, ['W15'], 'demolish') as unknown as { op: string; id: string; path: string }[];
    // W15 is the kitchen's wall to the mudroom: its door O13 goes with it.
    expect(batch.map((o) => o.id)).toContain('W15');
    expect(batch.map((o) => o.id)).toContain('O13');
    const ext = statusBatch(model, ['KIT-B0', 'KIT-B1'], 'demolish') as unknown as { id: string; path: string }[];
    expect(ext.map((o) => [o.id, o.path])).toEqual([['$document', '/extensions/FS_renovation/elements/KIT-B0'], ['$document', '/extensions/FS_renovation/elements/KIT-B1']]);
    const back = statusBatch(model, ['W17'], 'existing') as unknown as { op: string; path: string }[];
    expect(back[0]).toMatchObject({ op: 'unsetProperty', path: '/extensions/FS_renovation' });
    // A house that is not a remodel yet starts one in the same batch.
    const house = readModel('h', HOUSE);
    expect((statusBatch(house, ['W1'], 'new') as unknown as { path: string }[])[0]!.path).toBe('/extensionsUsed/FS_renovation');
  });

  it('reports the remodel: areas before and after, and the take-off by status', () => {
    const areas = renovationAreasSchedule(model, 'imperial')!;
    const pantry = areas.rows.find((r) => r.key === 'R9')!;
    expect(pantry.cells['status']!.text).toBe('To demolish');
    expect(pantry.cells['proposed']!.text).toBe('—');
    const kitchen = areas.rows.find((r) => r.key === 'R8')!;
    expect(kitchen.cells['change']!.text.startsWith('+')).toBe(true);
    const q = renovationQuantitiesSchedule(model, 'imperial')!;
    expect(q.rows.find((r) => r.key === 'walls')!.cells['demolish']!.text).toBe('2');
    expect(q.rows.find((r) => r.key === 'walls')!.cells['new']!.text).toBe('1');
    expect(schedules(model, 'imperial').map((s) => s.id)).toContain('renovation-quantities');
    expect(schedules(readModel('h', HOUSE), 'imperial').map((s) => s.id)).not.toContain('renovation-areas');
  });
});
