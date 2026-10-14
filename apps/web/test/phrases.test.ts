/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import { readModel, type EditorModel, type LevelView } from '../src/editor/model';
import { extentAcross } from '../src/editor/rooms/edit';
import type { Batch } from '../src/editor/ops';
import { carryRiders } from '../src/editor/arrange/carry';
import { extractLengths, lengthOf, normalize, parsePhrase, type Intent } from '../src/phrases/grammar';
import { interpret, lenText, selectWalls, type Outcome, type PhraseContext } from '../src/phrases/resolve';

/**
 * Say it on the plan (FLR-T-18.15): the grammar — lengths as people write them, the verbs, the
 * phrases it does not read — and the resolver on the Courtyard House: each phrase becomes the Ops
 * batch the editor's own builders make, which the real applier commits; a reference that fits
 * several elements asks which, and a pick answers it; nothing is guessed.
 */

const TEXT = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const MODEL: EditorModel = readModel('h', TEXT);
const IN = 32_512;
const FT = 12 * IN;
const MM = 1_280;

const ctx = (o: Partial<PhraseContext> = {}): PhraseContext => ({
  model: MODEL,
  level: 'L1',
  selected: [],
  units: 'imperial',
  nudgeStep: IN,
  pickable: (l: LevelView) => l,
  at: [18_000_000, 12_000_000],
  ...o,
});

const intent = (s: string, units: 'imperial' | 'metric' = 'imperial'): Intent => {
  const p = parsePhrase(s, units);
  if (!p.ok) throw new Error(`${s}: ${p.reason}`);
  return p.intent;
};

const ready = (o: Outcome): Extract<Outcome, { status: 'ready' }> => {
  if (o.status !== 'ready') throw new Error(`not ready: ${JSON.stringify(o).slice(0, 400)}`);
  return o;
};
const batchOf = (o: Outcome): Batch => {
  const b = ready(o).batch!;
  return typeof b === 'function' ? b(0) : b;
};

function commit(batch: Batch): { status: string; diagnostics: { code: string; message: string }[]; document?: Record<string, unknown> } {
  const r = apply(TEXT, { batch }, OFFICIAL_READER);
  return r.status === 'committed' ? { status: r.status, diagnostics: [], document: JSON.parse(r.document) as Record<string, unknown> } : { status: r.status, diagnostics: r.diagnostics };
}

describe('lengths as people write them', () => {
  it.each([
    ['6 inches', 6 * IN],
    ['6 inch', 6 * IN],
    ['6in', 6 * IN],
    ['6"', 6 * IN],
    ['6″', 6 * IN],
    ['36-inch', 36 * IN],
    ["3'6\"", 42 * IN],
    ["3' 6\"", 42 * IN],
    ['3 feet 6 inches', 42 * IN],
    ['3 ft 6 in', 42 * IN],
    ['3 feet and 6 inches', 42 * IN],
    ["3'6", 42 * IN],
    ['10 feet', 10 * FT],
    ['10 ft', 10 * FT],
    ['a foot', FT],
    ['one foot', FT],
    ['two feet', 2 * FT],
    ['half an inch', IN / 2],
    ['1/2"', IN / 2],
    ['1 1/2 inches', IN + IN / 2],
    ['6-1/2"', 6 * IN + IN / 2],
    ['900 mm', 900 * MM],
    ['90 cm', 900 * MM],
    ['2.4 m', 2400 * MM],
    ['2.4 metres', 2400 * MM],
    ['1 meter', 1000 * MM],
    ['750 millimetres', 750 * MM],
  ])('%s', (written, value) => {
    expect(lengthOf(written)).toBe(value);
  });

  it('reads them out of a phrase and leaves everything else', () => {
    expect(extractLengths('push the island 6 inches north')).toEqual({ text: 'push the island ⟦0⟧ north', lengths: [6 * IN] });
    expect(extractLengths('add a 36-inch door to the pantry')).toEqual({ text: 'add a ⟦0⟧ door to the pantry', lengths: [36 * IN] });
    // "in" the preposition is not inches; a name with a number is not a length.
    expect(extractLengths('place a sofa in the den').lengths).toEqual([]);
    expect(extractLengths('rename room 1 to living').lengths).toEqual([]);
    expect(extractLengths('add a mirror in the hall').lengths).toEqual([]);
  });

  it('tidies curly quotes, primes, “please” and a full stop', () => {
    expect(normalize('  Please push the island 6″ north.  ')).toBe('push the island 6" north');
    expect(normalize('can you move it 2′ east please')).toBe("move it 2' east");
  });
});

describe('the grammar', () => {
  it('moves by a distance and a direction, either way round, compass or plan words', () => {
    expect(intent('push the island 6 inches north')).toEqual({ verb: 'move', ref: 'the island', by: { distance: 6 * IN, dir: 'north' }, nudge: false });
    expect(intent('move the island north by 6 inches')).toMatchObject({ by: { distance: 6 * IN, dir: 'north' } });
    expect(intent('shift the sofa 2 feet to the east')).toMatchObject({ ref: 'the sofa', by: { distance: 2 * FT, dir: 'east' } });
    expect(intent('slide it 3 inches left')).toMatchObject({ ref: 'it', by: { dir: 'west' } });
    expect(intent('move the bed up 1 foot')).toMatchObject({ by: { dir: 'north', distance: FT } });
    expect(intent('move the desk 300mm down')).toMatchObject({ by: { dir: 'south', distance: 300 * MM } });
    expect(intent('move the bed 12 westwards')).toMatchObject({ by: { dir: 'west', distance: 12 * IN } });
  });

  it('reads a bare number in the project’s working unit', () => {
    expect(intent('push the island 6 north')).toMatchObject({ by: { distance: 6 * IN } });
    expect(intent('push the island 150 north', 'metric')).toMatchObject({ by: { distance: 150 * MM } });
  });

  it('nudges one step with no distance; anything else asks how far', () => {
    expect(intent('nudge the island north')).toMatchObject({ by: { distance: null, dir: 'north' }, nudge: true });
    const p = parsePhrase('move the island north', 'imperial');
    expect(p.ok).toBe(false);
    expect(p.ok ? '' : p.reason).toMatch(/How far/);
  });

  it('moves against a wall, to the middle, to a point', () => {
    expect(intent('move the sofa to the north wall')).toMatchObject({ to: { kind: 'wall', side: 'north' } });
    expect(intent('push the bed against the east wall')).toMatchObject({ to: { kind: 'wall', side: 'east' } });
    expect(intent('move the table to the middle of the room')).toMatchObject({ to: { kind: 'centre' } });
    expect(intent("move J3 to 12', 8'6\"")).toMatchObject({ to: { kind: 'point', point: [12 * FT, 8 * FT + 6 * IN] } });
  });

  it('resizes to a size, by a difference, to two sizes', () => {
    expect(intent('make the island 10 feet long')).toEqual({ verb: 'resize', ref: 'the island', changes: [{ axis: 'length', mode: 'to', value: 10 * FT }] });
    expect(intent('widen the door to 36 inches')).toEqual({ verb: 'resize', ref: 'the door', changes: [{ axis: 'width', mode: 'to', value: 36 * IN }] });
    expect(intent('make the island 6 inches longer')).toMatchObject({ changes: [{ axis: 'length', mode: 'by', value: 6 * IN }] });
    expect(intent('shorten the sofa by 1 foot')).toMatchObject({ changes: [{ axis: 'length', mode: 'by', value: -FT }] });
    expect(intent('make the sofa 84 by 36')).toMatchObject({ changes: [{ axis: 'width', value: 84 * IN }, { axis: 'depth', value: 36 * IN }] });
    expect(intent('set the island depth to 42"')).toMatchObject({ changes: [{ axis: 'depth', mode: 'to', value: 42 * IN }] });
    expect(intent('extend the pantry 2 feet east')).toMatchObject({ ref: 'the pantry', side: 'east', changes: [{ mode: 'by', value: 2 * FT }] });
    expect(intent('make the pantry a foot wider to the east')).toMatchObject({ side: 'east', changes: [{ axis: 'width', mode: 'by', value: FT }] });
  });

  it('adds an opening: its width, kind, where, and where along the wall', () => {
    expect(intent('add a 36-inch door to the pantry')).toEqual({ verb: 'addOpening', kind: 'door', width: 36 * IN, where: 'the pantry' });
    expect(intent('add a window to the north wall of the den')).toEqual({ verb: 'addOpening', kind: 'window', where: 'the north wall of the den' });
    expect(intent('put a door 32 inches wide in W12')).toMatchObject({ kind: 'door', width: 32 * IN, where: 'W12' });
    expect(intent('add a 3\' x 6\'8" door to W12, 2 feet from the start')).toMatchObject({ width: 36 * IN, height: 80 * IN, where: 'W12', at: { distance: 2 * FT, from: 'start' } });
    expect(intent('cut a doorway between the kitchen and the pantry')).toMatchObject({ kind: 'opening', where: 'between the kitchen and the pantry' });
    expect(parsePhrase('add a door', 'imperial').ok).toBe(false);
  });

  it('places from the library in a room, next to an item, against a wall, or here', () => {
    expect(intent('place a sofa in the great room')).toEqual({ verb: 'place', what: 'sofa', relation: 'in', where: 'great room' });
    expect(intent('put a chair next to the desk')).toMatchObject({ relation: 'next', where: 'desk' });
    expect(intent('add a bookcase against the north wall of the den')).toMatchObject({ relation: 'against', where: 'north wall of the den' });
    expect(intent('place a floor lamp')).toEqual({ verb: 'place', what: 'floor lamp', relation: 'here' });
    // A chair by a window is a placement, not a window.
    expect(intent('place a chair by the window')).toMatchObject({ verb: 'place', what: 'chair', relation: 'next' });
  });

  it('renames as written, quotes and numbers kept', () => {
    expect(intent('rename room 1 to Living')).toEqual({ verb: 'rename', ref: 'room 1', name: 'Living' });
    expect(intent('Rename the den to “Study 2”')).toEqual({ verb: 'rename', ref: 'the den', name: 'Study 2' });
    expect(intent('change the name of W3 to North party wall')).toMatchObject({ ref: 'W3', name: 'North party wall' });
    expect(intent('call the den "Library"')).toMatchObject({ ref: 'the den', name: 'Library' });
  });

  it('sets a finish: a surface of a room, painted or not', () => {
    expect(intent('make the kitchen floor oak')).toEqual({ verb: 'finish', surface: 'floor', splits: [{ room: 'kitchen', material: 'oak' }], paint: false });
    expect(intent('paint the bedroom walls sage')).toEqual({ verb: 'finish', surface: 'wall', splits: [{ room: 'bedroom', material: 'sage' }], paint: true });
    expect(intent('set the floor of the den to terrazzo')).toMatchObject({ surface: 'floor', splits: [{ room: 'den', material: 'terrazzo' }] });
    expect(intent('use porcelain tile for the mudroom floor')).toMatchObject({ surface: 'floor', splits: [{ room: 'mudroom', material: 'porcelain tile' }] });
    expect(intent('paint the guest bedroom sage')).toMatchObject({ surface: 'wall', splits: [{ room: 'guest bedroom', material: 'sage' }, { room: 'guest', material: 'bedroom sage' }] });
  });

  it('answers a phrase it does not read with what it can do', () => {
    for (const s of ['fly to the moon', '', 'hello', 'delete the island', 'rotate the bed']) {
      const p = parsePhrase(s, 'imperial');
      expect(p.ok, s).toBe(false);
      expect(p.ok ? '' : p.reason, s).toMatch(/I can do/);
    }
  });
});

describe('on the Courtyard House', () => {
  it('push the island 6 inches north: one moveElement, the cooktop and what else stands on it riding along', () => {
    const o = ready(interpret('push the island 6 inches north', ctx()));
    expect(o.summary).toBe('Move Kitchen island 6″ north');
    const batch = batchOf(o);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ op: 'moveElement', element: 'KIT-ISLAND', host: { mode: 'surface', room: 'R8', at: [18_726_912, 19_702_272 + 6 * IN] } });
    expect(o.notes.join(' ')).toMatch(/Cooktop/);
    expect(o.targets).toContain('KIT-COOKTOP');
    const carried = carryRiders(MODEL, batch);
    expect(carried.some((op) => (op as { element?: string }).element === 'KIT-COOKTOP')).toBe(true);
    expect(commit(carried).status).toBe('committed');
  });

  it('add a 36-inch door to the pantry: asks which of its four walls, and a pick makes an addOpening with an Ops selector', () => {
    const o = interpret('add a 36-inch door to the pantry', ctx());
    expect(o.status).toBe('choose');
    if (o.status !== 'choose') return;
    expect(o.key).toBe('wall');
    expect(o.options.map((c) => c.value).sort()).toEqual(['W17', 'W18', 'W25', 'W6']);
    expect(o.options.find((c) => c.value === 'W25')!.label).toBe('North wall');
    const picked = ready(interpret('add a 36-inch door to the pantry', ctx(), { wall: 'W25' }));
    expect(picked.summary).toBe('Add a 3′-0″ door to the north wall of Pantry (W25), centred');
    const batch = batchOf(picked);
    const add = batch.find((op) => op.op === 'addOpening') as unknown as Record<string, unknown>;
    expect(add).toMatchObject({ wall: 'north wall of R9', at: 'centered' });
    const done = commit(batch);
    expect(done.status, JSON.stringify(done.diagnostics)).toBe('committed');
    const openings = Object.values(done.document!['openings'] as Record<string, { wall: string }>).filter((x) => x.wall === 'W25');
    expect(openings.length).toBe(1);
  });

  it('resolves the Ops selectors by the reference applier: one wall, several, none', () => {
    expect(selectWalls(MODEL.document, 'north wall of R9')).toEqual(['W25']);
    expect(selectWalls(MODEL.document, 'wall between R8 and R9').sort()).toEqual(['W17', 'W18']);
    expect(selectWalls(MODEL.document, 'north wall of Nowhere')).toEqual([]);
  });

  it('a wall named by its side or between two rooms', () => {
    const o = ready(interpret('add a window to the north wall of the den', ctx()));
    expect(batchOf(o).at(-1)).toMatchObject({ op: 'addOpening', wall: 'north wall of R6' });
    expect(commit(batchOf(o)).status).toBe('committed');
    const between = interpret('add a door between the kitchen and the pantry', ctx());
    expect(between.status === 'choose' ? between.options.map((c) => c.value).sort() : []).toEqual(['W17', 'W18']);
  });

  it('a door that does not fit says so, and a wall that has no room is not offered', () => {
    const o = interpret('add a 20-foot door to the pantry', ctx());
    expect(o.status).toBe('fail');
    expect(o.status === 'fail' ? o.message : '').toMatch(/None of Pantry’s walls has room/);
  });

  it('make the island 10 feet long: one resizeElement on its long side, within its limits', () => {
    const o = ready(interpret('make the island 10 feet long', ctx()));
    expect(batchOf(o)).toEqual([expect.objectContaining({ op: 'resizeElement', element: 'KIT-ISLAND', anchor: 'center', width: 10 * FT })]);
    expect(commit(carryRiders(MODEL, batchOf(o))).status).toBe('committed');
    const tooBig = interpret('make the island 30 feet long', ctx());
    expect(tooBig.status === 'fail' ? tooBig.message : '').toMatch(/comes from/);
  });

  it('widen the door to 36 inches: asks which door; a door in the Pantry wall named; the middle kept', () => {
    const o = interpret('widen the door to 36 inches', ctx());
    expect(o.status).toBe('choose');
    const pantry = ready(interpret('widen the pantry door to 36 inches', ctx()));
    const batch = batchOf(pantry);
    expect(batch[0]).toMatchObject({ op: 'setProperty', id: 'O14', path: '/width', value: 36 * IN });
    expect(commit(batch).status).toBe('committed');
  });

  it('“it” is the selection; several selected asks which; nothing selected says so', () => {
    expect(batchOf(interpret('push it 1 foot east', ctx({ selected: ['KIT-ISLAND'] })))[0]).toMatchObject({ element: 'KIT-ISLAND' });
    expect(interpret('push it 1 foot east', ctx({ selected: ['KIT-ISLAND', 'DEN-SOFA'] })).status).toBe('choose');
    const none = interpret('push it 1 foot east', ctx());
    expect(none.status === 'fail' ? none.message : '').toMatch(/Nothing is selected/);
  });

  it('several of a kind ask which, each lit on the plan; a room or an ordinal narrows it; a pick answers it', () => {
    const o = interpret('move the sofa 1 foot north', ctx());
    expect(o.status).toBe('choose');
    if (o.status !== 'choose') return;
    expect(o.options.map((c) => c.value)).toEqual(['BT-SOFA', 'CY-SOFA', 'DEN-SOFA', 'GR-SOFA']);
    expect(o.options.every((c) => c.highlight.length === 1)).toBe(true);
    expect(batchOf(interpret('move the sofa in the den 1 foot north', ctx()))[0]).toMatchObject({ element: 'DEN-SOFA' });
    expect(batchOf(interpret('move the sofa 1 foot north', ctx(), { target: 'GR-SOFA' }))[0]).toMatchObject({ element: 'GR-SOFA' });
    expect(batchOf(interpret('move the second sofa 1 foot north', ctx()))[0]).toMatchObject({ element: 'CY-SOFA' });
    expect(batchOf(interpret('move the last sofa 1 foot north', ctx()))[0]).toMatchObject({ element: 'GR-SOFA' });
  });

  it('a mode’s ghosts are not found while anything else is', () => {
    const noFurniture = (l: LevelView): LevelView => ({ ...l, devices: l.devices.filter((d) => d.extension !== 'FS_furniture') });
    // The sofa is a ghost in this mode: named, it is still found on the level (nothing else fits).
    expect(ready(interpret('move the den sofa 1 foot north', ctx({ pickable: noFurniture }))).targets).toContain('DEN-SOFA');
    // The walls of the plan are picked as ever.
    expect(batchOf(interpret('move W12 6" east', ctx({ pickable: noFurniture })))[0]).toMatchObject({ op: 'moveWall', wall: 'W12' });
  });

  it('moves a wall across itself and says so when asked to push it along', () => {
    expect(batchOf(interpret('move W12 6" east', ctx()))).toEqual([{ op: 'moveWall', wall: 'W12', by: -6 * IN }]);
    const along = interpret('move W12 6" north', ctx());
    expect(along.status === 'fail' ? along.message : '').toMatch(/sideways/);
  });

  it('moves an item flush against a wall of its room, and to its middle', () => {
    const o = ready(interpret('push the den sofa against the south wall', ctx()));
    expect(o.summary).toMatch(/south, against the south wall of Den/);
    expect(commit(carryRiders(MODEL, batchOf(o))).status).toBe('committed');
    expect(ready(interpret('move the den sofa to the middle of the room', ctx())).summary).toBe('Move Three-seat sofa to the middle of Den');
  });

  it('nudge: one nudge step', () => {
    expect(batchOf(interpret('nudge the island north', ctx({ nudgeStep: 2 * IN })))[0]).toMatchObject({ host: { at: [18_726_912, 19_702_272 + 2 * IN] } });
  });

  it('resizes a room on a side, and asks which side when none is said', () => {
    expect(batchOf(interpret('extend the pantry 2 feet east', ctx()))).toEqual([{ op: 'resizeRoom', room: 'R9', side: 'east', by: 2 * FT }]);
    const o = interpret('make the pantry 9 feet wide', ctx());
    expect(o.status === 'choose' ? o.options.map((c) => c.value) : []).toEqual(['east', 'west']);
    const east = batchOf(interpret('make the pantry 9 feet wide', ctx(), { side: 'east' }));
    const across = extentAcross(MODEL.levels.find((l) => l.id === 'L1')!, 'R9', 'east');
    expect(east).toEqual([{ op: 'resizeRoom', room: 'R9', side: 'east', by: 9 * FT - across }]);
    expect(commit(east).status).toBe('committed');
  });

  it('places from the library as the quick-add bar does: a ghost, by the room’s words or its function', () => {
    const o = ready(interpret('place a sofa in the living room', ctx()));
    expect(o.summary).toBe('Place Three-seat sofa in Great room');
    expect(o.place!.ghost.host).toMatchObject({ mode: 'surface', room: 'R7' });
    expect(ready(interpret('put a chair next to the den desk', ctx())).place!.entry.name).toMatch(/chair/i);
    const none = interpret('place a spaceship in the den', ctx());
    expect(none.status === 'fail' ? none.message : '').toMatch(/Nothing in the library matches/);
  });

  it('renames a room, an item, a level', () => {
    expect(batchOf(interpret('rename the den to Study', ctx()))).toEqual([{ op: 'setProperty', id: 'R6', path: '/name', value: 'Study' }]);
    expect(batchOf(interpret('rename the island to Prep island', ctx()))).toEqual([{ op: 'setProperty', id: 'KIT-ISLAND', path: '/name', value: 'Prep island' }]);
    const level = MODEL.levels.find((l) => l.id === 'L1')!;
    expect(batchOf(interpret(`rename ${level.name} to Ground floor`, ctx()))).toEqual([{ op: 'setProperty', id: 'L1', path: '/name', value: 'Ground floor' }]);
    expect(commit(batchOf(interpret('rename the island to Prep island', ctx()))).status).toBe('committed');
    const missing = interpret('rename room 1 to Living', ctx());
    expect(missing.status === 'fail' ? missing.message : '').toMatch(/can’t find “room 1”/);
  });

  it('sets a finish from the project’s materials; painting prefers paint; a material it lacks is said', () => {
    const floor = batchOf(interpret('make the kitchen floor oak', ctx()));
    expect(floor).toEqual([{ op: 'setRoomFinish', room: 'R8', surface: 'floor', material: 'white-oak-floor' }]);
    expect(commit(floor).status).toBe('committed');
    expect(batchOf(interpret('paint the bedroom walls sage', ctx()))).toEqual([{ op: 'setRoomFinish', room: 'R1', surface: 'wall', material: 'paint-sage' }]);
    expect(batchOf(interpret('paint the guest bedroom navy', ctx()))).toEqual([{ op: 'setRoomFinish', room: 'R1', surface: 'wall', material: 'paint-navy' }]);
    const white = interpret('make the den walls white', ctx());
    expect(white.status).toBe('choose');
    const walnut = interpret('make the den floor walnut', ctx());
    expect(walnut.status === 'fail' ? walnut.message : '').toMatch(/no material called “walnut”/);
  });

  it('looks on the other levels when the one being edited has none', () => {
    const o = ready(interpret('rename the primary bedroom to Main suite', ctx()));
    expect(o.level).toBe('L2');
    expect(batchOf(o)).toEqual([{ op: 'setProperty', id: 'R17', path: '/name', value: 'Main suite' }]);
  });

  it('says why when nothing is named that it can find', () => {
    const o = interpret('push the hot tub 6 inches north', ctx());
    expect(o.status === 'fail' ? o.message : '').toMatch(/can’t find “the hot tub”/);
  });

  it('formats lengths as the card reads them', () => {
    expect(lenText(6 * IN, 'imperial')).toBe('6″');
    expect(lenText(42 * IN, 'imperial')).toBe('3′-6″');
    expect(lenText(900 * MM, 'metric')).toBe('900 mm');
  });
});
