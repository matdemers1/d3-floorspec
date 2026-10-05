import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER, type FloorspecDocument } from '@floorspec/engine';
import { readModel, type EditorModel, type LevelView, type WallView } from '../src/editor/model';
import { kindById, kindOfElement, membersFor, NO_OPTIONS, type DeviceKind } from '../src/editor/systems/catalog';
import {
  addCircuit,
  assignCircuit,
  declarationOps,
  freeSpace,
  moveDevice,
  nextRecordId,
  placeDevice,
  removeDevice,
  removeRecord,
  rotateDevice,
} from '../src/editor/systems/ops';
import { angleOf, hoverFor, nearestFace, roomSide } from '../src/editor/systems/placement';
import { parsePlacement } from '../src/editor/systems/typed';
import { memberSpecs } from '../src/editor/systems/schema';
import { homeRuns } from '../src/editor/systems/Symbols';
import { circuitsOf, switchesOf } from '../src/editor/systems/view';
import type { Batch } from '../src/editor/ops';

/**
 * The building systems in the editor (FLR-T-5.7): the op builders run through the real applier,
 * configured as the server runs it — implementing and knowing the four official extensions — so a
 * batch the editor builds is a batch the server commits, and one that would leave a circuit naming
 * a removed receptacle is refused, as FS_electrical says.
 */

const IN = 32_512;
const FT = 12 * IN;
const TEMPLATE = readFileSync(new URL('../src/projects/templates/three-room-house.floorspec.json', import.meta.url), 'utf8');
/**
 * The template house as a Core 0.2 plan: the official extensions at 0.1.0 are evaluated only for
 * documents that declare "0.2" (each one's 1.2; `officialExtensionsEvaluatedFor`), and these tests
 * are about what they check and derive. When the extensions take Core 0.3, use TEMPLATE as it is.
 */
const HOUSE = TEMPLATE.replace('"floorspec": "0.3"', '"floorspec": "0.2"');

function commit(doc: string, batch: Batch): string {
  const r = apply(doc, { batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}

const model = (doc: string): EditorModel => readModel('h', doc);
const json = (doc: string) => JSON.parse(doc) as FloorspecDocument;
const kind = (id: string): DeviceKind => kindById(id) as DeviceKind;
const device = (m: EditorModel, id: string) => m.levels.flatMap((l) => l.devices).find((d) => d.id === id);

/** The P5 demo, built the way the editor builds it: a panel, two 20 A kitchen circuits, a toilet and a water heater. */
function demo(): string {
  let doc = HOUSE;
  doc = commit(doc, placeDevice(json(doc), kind('panel'), { mode: 'wallFace', wall: 'WW', side: 'right', at: 4 * FT, height: 60 * IN }));
  for (const at of [3 * FT, 6 * FT, 9 * FT, 12 * FT])
    doc = commit(doc, placeDevice(json(doc), kind('receptacle'), { mode: 'wallFace', wall: 'WN2', toward: 'Kitchen', at, height: 42 * IN }, { receptacle: { ...NO_OPTIONS, gfci: true } }));
  doc = commit(doc, placeDevice(json(doc), kind('toilet'), { mode: 'surface', room: 'BED', surface: 'floor', at: [30 * FT, 6 * FT] }));
  doc = commit(doc, placeDevice(json(doc), kind('waterHeater'), { mode: 'surface', room: 'LIV', surface: 'floor', at: [2 * FT, 2 * FT] }));
  const panel = 'X1';
  const one = addCircuit(json(doc), { panel, breaker: 20, volts: 120, rating: 20, name: 'Kitchen counter 1' });
  doc = commit(doc, [...one.ops]);
  const two = addCircuit(json(doc), { panel, breaker: 20, volts: 120, rating: 20, name: 'Kitchen counter 2' });
  doc = commit(doc, [...two.ops]);
  doc = commit(doc, assignCircuit(json(doc), 'X2', one.id));
  doc = commit(doc, assignCircuit(json(doc), 'X3', one.id));
  doc = commit(doc, assignCircuit(json(doc), 'X4', two.id));
  doc = commit(doc, assignCircuit(json(doc), 'X5', two.id));
  return doc;
}

describe('placing devices', () => {
  it('declares the extension with the first device, and only then', () => {
    const first = placeDevice(json(HOUSE), kind('receptacle'), { mode: 'wallFace', wall: 'WN2', side: 'right', at: 3 * FT, height: 12 * IN });
    expect(first[0]).toEqual({ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' });
    const doc = commit(HOUSE, first);
    expect(json(doc).extensionsUsed).toEqual({ FS_electrical: '0.1.0' });
    expect(declarationOps(json(doc), 'FS_electrical')).toEqual([]);
    expect(declarationOps(json(doc), 'FS_plumbing')).toHaveLength(1);
    // A Core 0.1 plan is moved to 0.2 first: extension elements are 0.2's (Core 1.2.6).
    expect(declarationOps({ ...json(HOUSE), floorspec: '0.1' }, 'FS_plumbing')[0]).toEqual({ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.2' });
    // A Core 0.3 plan keeps its version: nothing is ever declared back to an earlier draft.
    expect(declarationOps(json(TEMPLATE), 'FS_plumbing')).toEqual([{ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_plumbing', value: '0.1.0' }]);
  });

  it('places devices in a Core 0.3 plan, which Core places and draws but the extensions at 0.1.0 do not yet check', () => {
    const doc = commit(TEMPLATE, placeDevice(json(TEMPLATE), kind('receptacle'), { mode: 'wallFace', wall: 'WN2', toward: 'Kitchen', at: 3 * FT, height: 12 * IN }));
    const m = model(doc);
    expect(json(doc).floorspec).toBe('0.3');
    expect(m.valid).toBe(true);
    expect(device(m, 'X1')).toBeDefined();
    expect(m.derived?.extensions).toEqual({});
  });

  it('gives a new element its fallback box, its members and the default envelopes', () => {
    const batch = placeDevice(json(HOUSE), kind('panel'), { mode: 'wallFace', wall: 'WW', side: 'right', at: 4 * FT, height: 60 * IN });
    const op = batch.find((o) => o.op === 'placeElement') as unknown as { element: Record<string, unknown>; collection: string };
    expect(op.collection).toBe('panels');
    expect(op.element).toMatchObject({ volts: [120, 240], rating: 200, spaces: 40, name: 'P1' });
    expect(Object.keys(op.element['clearances'] as object)).toEqual(['working']);
    expect(membersFor(kind('receptacle'), { ...NO_OPTIONS, gfci: true, v240: true })).toEqual({ features: ['gfci'], volts: 240, amps: 30, outlets: 1 });
  });

  it('builds the P5 demo, and the engine derives its circuits, loads and rooms', () => {
    const m = model(demo());
    expect(m.valid).toBe(true);
    const e = m.derived?.extensions?.FS_electrical;
    expect(e?.circuits['C5']).toMatchObject({ panel: 'X1', loads: ['X2', 'X3'] });
    expect(e?.circuits['C6']).toMatchObject({ panel: 'X1', loads: ['X4', 'X5'] });
    expect(e?.panels['X1']?.circuits).toEqual(['C5', 'C6']);
    expect(e?.rooms['KIT']).toEqual(['X2', 'X3', 'X4', 'X5']);
    expect(m.derived?.extensions?.FS_plumbing?.rooms).toEqual({ BED: ['X6'], LIV: ['X7'] });
    expect(m.records.get('C5')).toEqual({ extension: 'FS_electrical', collection: 'circuits' });
    expect(device(m, 'X6')?.kind?.id).toBe('toilet');
    expect(circuitsOf(m.document, 'X4')).toEqual(['C6']);
  });

  it('mints circuit IDs no element has: the template’s junctions are C1–C4', () => {
    expect(nextRecordId(json(HOUSE), 'C')).toBe('C5');
    const doc = demo();
    expect(nextRecordId(json(doc), 'C')).toBe('C7');
    expect(freeSpace(json(doc), 'X1', 1)).toBe(3);
    expect(freeSpace(json(doc), 'X1', 2)).toBe(3);
  });
});

describe('hosted elements follow their hosts (Ops 2.7)', () => {
  it('moves the receptacles with the kitchen wall, and leaves the toilet where it stands', () => {
    const before = model(demo());
    const after = model(commit(demo(), [{ op: 'resizeRoom', room: 'Kitchen', side: 'north', by: "1'" }]));
    for (const id of ['X2', 'X3', 'X4', 'X5']) {
      const a = device(before, id)?.placement?.point;
      const b = device(after, id)?.placement?.point;
      expect(b?.[0]).toBe(a?.[0]);
      expect((b?.[1] ?? 0) - (a?.[1] ?? 0)).toBe(FT);
    }
    expect(device(after, 'X6')?.placement).toEqual(device(before, 'X6')?.placement);
    // Not a byte of the receptacles changed: they hold an offset and a height, nothing absolute.
    expect(after.ext.get('X2')).toEqual(before.ext.get('X2'));
  });

  it('re-hosts with moveElement, and turns a floor fixture with its rotation', () => {
    let doc = commit(demo(), moveDevice('X2', { mode: 'wallFace', wall: 'WE1', side: 'right', at: 2 * FT, height: 42 * IN }));
    expect(model(doc).derived?.extensions?.FS_electrical?.rooms['KIT']).toContain('X2');
    doc = commit(doc, rotateDevice('X6', 90_000_000));
    expect(device(model(doc), 'X6')?.placement?.facing).toBe(90_000_000);
    expect(rotateDevice('X6', 360_000_000)).toEqual([{ op: 'unsetProperty', id: 'X6', path: '/host/rotation' }]);
    expect(rotateDevice('X6', -180_000_000)).toEqual([{ op: 'setProperty', id: 'X6', path: '/host/rotation', value: 180_000_000 }]);
  });
});

describe('removing', () => {
  it('a load goes with its references; without them the applier refuses it', () => {
    const doc = demo();
    expect(apply(doc, { batch: [{ op: 'removeElement', id: 'X2' }] }, OFFICIAL_READER)).toMatchObject({ status: 'rejected', diagnostics: [{ code: 'FS-ELEC-INV-003' }] });
    const after = model(commit(doc, removeDevice(json(doc), 'X2')));
    expect(after.derived?.extensions?.FS_electrical?.circuits['C5']?.loads).toEqual(['X3']);
  });

  it('a panel takes its circuits, and a circuit its references', () => {
    const doc = demo();
    const noPanel = model(commit(doc, removeDevice(json(doc), 'X1')));
    expect(noPanel.records.size).toBe(0);
    const noCircuit = model(commit(doc, removeRecord(json(doc), 'FS_electrical', 'circuits', 'C5')));
    expect([...noCircuit.records.keys()]).toEqual(['C6']);
  });

  it('a switch’s controls drop what is removed', () => {
    let doc = commit(demo(), placeDevice(json(demo()), kind('switch'), { mode: 'wallFace', wall: 'WE1', side: 'right', at: 1 * FT, height: 48 * IN }));
    doc = commit(doc, placeDevice(json(doc), kind('light'), { mode: 'surface', room: 'KIT', surface: 'ceiling', at: [28 * FT, 18 * FT] }));
    doc = commit(doc, [{ op: 'setProperty', id: 'X8', path: '/controls', value: ['X9'] }]);
    expect(switchesOf(json(doc), 'X9')).toEqual(['X8']);
    const after = json(commit(doc, removeDevice(json(doc), 'X9')));
    expect(switchesOf(after, 'X9')).toEqual([]);
  });
});

describe('where the pointer puts a device', () => {
  const m = model(HOUSE);
  const level = m.levels[0] as LevelView;

  it('snaps a wall mount to the nearer face of the nearest wall, on the grid', () => {
    const hover = hoverFor(level, 'wall', [25 * FT + 3 * IN, 23 * FT + 6 * IN], { grid: IN, tol: 6 * IN, height: 12 * IN });
    expect(hover?.host).toEqual({ mode: 'wallFace', wall: 'WN2', side: 'right', at: 5 * FT + 3 * IN, height: 12 * IN });
    expect(hover?.nearer).toBe('start');
    expect(nearestFace(level, [10 * FT, 12 * FT], 6 * IN)).toBeNull();
  });

  it('backs a floor fixture onto a wall face, facing into the room', () => {
    const hover = hoverFor(level, 'floorWall', [35 * FT, 6 * FT], { grid: IN, tol: 6 * IN, height: 0 });
    expect(hover?.host).toMatchObject({ mode: 'surface', room: 'BED', surface: 'floor', rotation: 180_000_000 });
    expect(angleOf([0, 1])).toBe(90_000_000);
    expect(angleOf([-1, 0])).toBe(180_000_000);
  });

  it('puts a ceiling device in its room, and refuses one outside every room', () => {
    expect(hoverFor(level, 'ceiling', [5 * FT, 5 * FT], { grid: IN, tol: IN, height: 0 })?.host).toEqual({ mode: 'surface', room: 'LIV', surface: 'ceiling', at: [5 * FT, 5 * FT] });
    expect(hoverFor(level, 'ceiling', [-5 * FT, -5 * FT], { grid: IN, tol: IN, height: 0 })?.problem).toMatch(/goes in a room/);
    expect(hoverFor(level, 'floor', [-5 * FT, -5 * FT], { grid: IN, tol: IN, height: 0 })?.host.mode).toBe('free');
  });

  it('centres on a wall’s room side', () => {
    const wall = level.walls.find((w) => w.id === 'WW') as WallView;
    expect(roomSide(level, wall)).toBe('right');
  });
});

describe('placing by typing', () => {
  const m = model(HOUSE);

  it('reads a kind, its options, a wall, a position and a height', () => {
    const p = parsePlacement('gfci receptacle on WN2 at 3\' from start, 42" high', m, 'MAIN', 'imperial');
    expect(p).toMatchObject({ ok: true, kind: { id: 'receptacle' }, receptacle: { gfci: true }, host: { mode: 'wallFace', wall: 'WN2', side: 'right', at: "3' from start", height: 42 * IN } });
    const bare = parsePlacement("switch on north wall of Kitchen at 2'", m, 'MAIN', 'imperial');
    expect(bare).toMatchObject({ ok: true, host: { wall: 'north wall of Kitchen', toward: 'Kitchen', at: 2 * FT, height: 48 * IN } });
  });

  it('puts a floor or ceiling device in a named room', () => {
    expect(parsePlacement('light in kitchen', m, 'MAIN', 'imperial')).toMatchObject({ ok: true, host: { mode: 'surface', room: 'KIT', surface: 'ceiling' } });
    expect(parsePlacement("toilet in Bedroom at 30', 6'", m, 'MAIN', 'imperial')).toMatchObject({ ok: true, host: { at: [30 * FT, 6 * FT] } });
  });

  it('says what is wrong', () => {
    expect(parsePlacement('sofa in Living room', m, 'MAIN', 'imperial')).toMatchObject({ ok: false });
    expect(parsePlacement('light on WN2 at 3\'', m, 'MAIN', 'imperial')).toMatchObject({ ok: false, reason: expect.stringMatching(/ceiling/) as string });
    expect(parsePlacement('receptacle in Kitchen', m, 'MAIN', 'imperial')).toMatchObject({ ok: false, reason: expect.stringMatching(/on a wall/) as string });
  });

  it('builds a batch the applier commits', () => {
    const p = parsePlacement('receptacle on north wall of Kitchen at 2\' from end, 12" high', m, 'MAIN', 'imperial');
    if (!p.ok) throw new Error(p.reason);
    expect(model(commit(HOUSE, placeDevice(json(HOUSE), p.kind, p.host))).derived?.extensions?.FS_electrical?.rooms['KIT']).toEqual(['X1']);
  });
});

describe('the inspector’s fields come from the extension schemas', () => {
  it('reads a kind’s members, types, units and defaults', () => {
    const specs = memberSpecs('FS_electrical', 'receptacles');
    expect(specs.map((s) => [s.name, s.type])).toEqual([['volts', 'int'], ['amps', 'int'], ['outlets', 'int'], ['features', 'enumSet'], ['watts', 'int']]);
    expect(specs[0]).toMatchObject({ unit: 'V', default: 120 });
    const circuit = memberSpecs('FS_electrical', 'circuits', true);
    expect(circuit.find((s) => s.name === 'panel')).toMatchObject({ type: 'ref', required: true });
    expect(circuit.find((s) => s.name === 'loads')?.type).toBe('refList');
    expect(memberSpecs('FS_plumbing', 'stacks', true).find((s) => s.name === 'size')?.type).toBe('length');
    expect(memberSpecs('FS_unknown', 'things')).toEqual([]);
  });

  it('knows which catalogue kind an element is', () => {
    expect(kindOfElement('FS_plumbing', 'fixtures', { fixture: 'lavatory' })?.id).toBe('lavatory');
    expect(kindOfElement('FS_plumbing', 'fixtures', { fixture: 'bidet' })?.collection).toBe('fixtures');
    expect(kindOfElement('FS_lowvoltage', 'outlets', { media: ['coax', 'data'] })?.id).toBe('dataOutlet');
    expect(kindOfElement('EXT_x', 'things', {})).toBeNull();
  });
});

describe('home runs', () => {
  it('runs from each circuit’s panel through its loads, nearest next', () => {
    const m = model(demo());
    const runs = homeRuns(m.document, m.levels[0] as LevelView);
    expect(runs.map((r) => [r.circuit, r.points.length])).toEqual([['C5', 3], ['C6', 3]]);
    expect(runs[0]?.points[0]).toEqual(device(m, 'X1')?.placement?.point);
  });
});
