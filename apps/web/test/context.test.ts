/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
/**
 * FLR-T-15.3: context as the editor writes it — generated from the lot's street edge and setbacks as one
 * batch the applier commits, regenerated keeping what was drawn by hand and the street's name; a tree,
 * a neighbour and a street drawn by hand; a record moved and removed; what is under a plan point — and
 * never part of the design: every schedule is the same with the context and without it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_READER } from '@floorspec/engine';
import { apply as applyLocally } from '@floorspec/ops';
import { readModel, type EditorModel } from '../src/editor/model';
import { addNeighbour, addStreet, addTree, contextAt, contextDataOf, contextDrawingOf, FT, generateOps, generateOptions, moveContext, removeContext } from '../src/editor/context/ops';
import { schedules } from '../src/schedules/derive';
import type { Batch } from '../src/editor/ops';

const LOT = readFileSync(new URL('../../worker/test/fixtures/courtyard-house-outdoor.json', import.meta.url), 'utf8');
const STREET = readFileSync(new URL('../../worker/test/fixtures/courtyard-house-on-its-street.json', import.meta.url), 'utf8');
const SETTINGS = { side: null, width: 30, sidewalk: 5, strip: 4, neighbours: true, trees: 'some' as const, seed: 14 };

function applied(model: EditorModel, batch: Batch | ((n: number) => Batch)): EditorModel {
  const b = typeof batch === 'function' ? batch(0) : batch;
  const r = applyLocally(model.document, { batch: b }, OFFICIAL_READER);
  expect(r.status, JSON.stringify(r.status === 'committed' ? [] : r.diagnostics)).toBe('committed');
  if (r.status !== 'committed') throw new Error('rejected');
  return readModel(r.hash, r.document);
}
type Ctx = { streets?: Record<string, { name?: string; points: number[][] }>; neighbours?: Record<string, { roof?: string; boundary: number[][] }>; trees?: Record<string, { at: number[] }> };
const data = (m: EditorModel) => contextDataOf(m.document) as Ctx;

describe('context in the editor', () => {
  it('generates the Courtyard House\'s street, neighbours and trees from its street edge: the fixture, op for op', () => {
    let m = readModel('h', LOT);
    const r = generateOps(m, generateOptions(SETTINGS, 'Laurel Ridge Drive'));
    expect(r.reason).toBeUndefined();
    expect(r.counts.neighbours).toBe(2);
    m = applied(m, r.batch);
    const want = (JSON.parse(STREET) as { extensions: { FS_context: unknown } }).extensions.FS_context;
    expect(m.document.extensions?.['FS_context']).toEqual(want);
    expect(m.document.extensionsUsed?.['FS_context']).toBe('0.1.0');
  });

  it('regenerates: what was generated is replaced, what was drawn by hand stays, and the street keeps its name', () => {
    let m = readModel('h', STREET);
    m = applied(m, addTree(m, [-120 * FT, 120 * FT], 'evergreen'));
    const hand = Object.keys(data(m).trees!).find((id) => !(data(m).trees![id] as { extras?: unknown }).extras)!;
    m = applied(m, generateOps(m, generateOptions({ ...SETTINGS, seed: 15 })).batch);
    expect(data(m).trees![hand]).toBeDefined();
    expect(Object.values(data(m).streets!)[0]!.name).toBe('Laurel Ridge Drive');
    expect(Object.keys(data(m).neighbours!)).toHaveLength(2);
  });

  it('draws by hand: a square neighbour gets an exact rectangle and a gable, a street its settings, and each moves and goes', () => {
    let m = readModel('h', LOT);
    m = applied(m, addNeighbour(m, [[-80 * FT, 0], [-50 * FT, 100], [-50 * FT, 40 * FT], [-80 * FT, 40 * FT]]));
    const nb = Object.entries(data(m).neighbours!)[0]!;
    expect(nb[1].roof).toBe('gable');
    m = applied(m, addNeighbour(m, [[-80 * FT, 60 * FT], [-50 * FT, 60 * FT], [-65 * FT, 80 * FT]]));
    expect(Object.values(data(m).neighbours!)[1]!.roof).toBeUndefined();
    m = applied(m, addStreet(m, [[-100 * FT, -40 * FT], [-100 * FT, -40 * FT], [-100 * FT, 120 * FT]], { width: 24, sidewalk: 4, strip: 0 }));
    const st = Object.entries(data(m).streets!)[0]!;
    expect(st[1]).toMatchObject({ points: [[-100 * FT, -40 * FT], [-100 * FT, 120 * FT]], width: 24 * FT, sidewalk: 4 * FT });
    expect(contextDrawingOf(m).streets[0]!.overall).toBe((24 + 1 + 8) * FT);
    // what is under a point: inside the neighbour, on the street
    expect(contextAt(m, [-60 * FT, 20 * FT], 0)).toEqual({ member: 'neighbours', id: nb[0] });
    expect(contextAt(m, [-104 * FT, 0], 0)).toEqual({ member: 'streets', id: st[0] });
    expect(contextAt(m, [0, 0], 0)).toBeNull();
    m = applied(m, moveContext(m, 'neighbours', nb[0], -10 * FT, 0));
    expect(data(m).neighbours![nb[0]]!.boundary[0]![0]).toBe(nb[1].boundary[0]![0]! - 10 * FT);
    m = applied(m, removeContext('streets', st[0]));
    expect(data(m).streets?.[st[0]]).toBeUndefined();
  });

  it('is never part of the design: every schedule is the same with the context and without it', () => {
    const a = schedules(readModel('a', STREET), 'imperial');
    const b = schedules(readModel('b', LOT), 'imperial');
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toMatch(/Laurel Ridge|Neighbour|NB\d|TR\d/);
  });

  it('says why when there is no lot', () => {
    const doc = JSON.parse(LOT) as { site?: unknown };
    delete doc.site;
    const r = generateOps(readModel('n', JSON.stringify(doc)), generateOptions(SETTINGS));
    expect(r.reason).toMatch(/lot/);
    expect(r.batch).toEqual([]);
  });
});
