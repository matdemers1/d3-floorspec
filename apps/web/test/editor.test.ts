import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import type { FixOp } from '@floorspec/engine';
import { formatLen, parseLen, prettyLen, lengthText, unitsOf, formatArea, BASE_PER_FOOT, BASE_PER_INCH } from '../src/editor/units';
import { latticeOnSegment, pointAtLength, snapAngle, snapOpening, snapPoint, unitAt } from '../src/editor/snap';
import { hitTest, roomsBeside, faceAt, signedArea } from '../src/editor/geometry';
import {
  addLevel,
  addOpening,
  addRoom,
  describeFix,
  drawChain,
  fixToOps,
  isClosed,
  namedId,
  nextRoomName,
  removeOps,
  setOrUnset,
  setUnits,
  typeChoices,
  useType,
  type Batch,
  type BatchBuilder,
  type ChainVertex,
} from '../src/editor/ops';
import { readModel, type EditorModel, type LevelView } from '../src/editor/model';
import { keyOf, commandFor, COMMANDS } from '../src/editor/commands';
import { fit, toScreen, toWorld, zoomAt } from '../src/editor/viewport';

/**
 * The editor's pure parts (FLR-T-3.3, 3.4, 3.8): the length grammar as the editor uses it, snapping,
 * hit-testing, and the op builders — the last run through the real applier, @floorspec/ops, so a
 * batch the editor builds is a batch the server commits.
 */

const FT = BASE_PER_FOOT;
const IN = BASE_PER_INCH;

// ─── Units (FLR-T-3.4) ───────────────────────────────────────────────────────────────────────

describe('lengths typed and shown', () => {
  it('parses the reference grammar exactly, as the doneWhen names it', () => {
    expect(parseLen(`12'6-1/2"`, 'imperial')).toEqual({ ok: true, value: 12 * FT + 6 * IN + IN / 2 });
    expect(parseLen('3810mm', 'imperial')).toEqual({ ok: true, value: 3810 * 1280 });
    expect(parseLen('3.81 m', 'metric')).toEqual({ ok: true, value: 3810 * 1280 });
    expect(parseLen(`6 1/2"`, 'imperial')).toEqual({ ok: true, value: 6 * IN + IN / 2 });
    expect(parseLen('30ft', 'imperial')).toEqual({ ok: true, value: 30 * FT });
  });

  it('reads a bare number in the working unit of the display system', () => {
    expect(parseLen('30', 'imperial')).toEqual({ ok: true, value: 30 * IN });
    expect(parseLen('30', 'metric')).toEqual({ ok: true, value: 30 * 1280 });
    expect(lengthText(' 12 ', 'imperial')).toBe('12"');
    expect(lengthText('2 ft', 'metric')).toBe('2 ft');
  });

  it('refuses what is not a length, without throwing', () => {
    expect(parseLen('twelve feet', 'imperial').ok).toBe(false);
    expect(parseLen('1/0"', 'imperial').ok).toBe(false);
    expect(parseLen('', 'imperial').ok).toBe(false);
  });

  it('shows ft-in to 1/16" by default, architecturally, and every shown value parses back', () => {
    expect(formatLen(15 * FT, 'imperial')).toBe(`15'-0"`);
    expect(formatLen(12 * FT + 6 * IN + IN / 2, 'imperial')).toBe(`12'-6 1/2"`);
    expect(formatLen(12 * FT + (13 * IN) / 16, 'imperial')).toBe(`12'-0 13/16"`);
    expect(formatLen(6 * IN, 'imperial')).toBe(`6"`);
    expect(formatLen(-2 * FT, 'imperial')).toBe(`-2'-0"`);
    for (const v of [0, 1, 15 * FT, 12 * FT + (13 * IN) / 16, 7 * IN + IN / 4, -(3 * FT + IN)]) {
      const text = formatLen(v, 'imperial');
      const back = parseLen(text, 'imperial');
      expect(back.ok).toBe(true);
      // Within half a sixteenth: display rounds, the stored integer never does.
      if (back.ok) expect(Math.abs(back.value - v)).toBeLessThanOrEqual(IN / 32);
    }
  });

  it('shows metric in millimetres, exactly when it can', () => {
    expect(formatLen(3810 * 1280, 'metric')).toBe('3810 mm');
    expect(formatLen(3810 * 1280 + 640, 'metric')).toBe('3810.5 mm');
  });

  it('prettifies fractions only for labels', () => {
    expect(prettyLen(12 * FT + 4 * IN + IN / 2, 'imperial')).toBe(`12'-4 ½"`);
  });

  it('reads the per-project preference from extras, defaulting to ft-in', () => {
    expect(unitsOf({ floorspec: '0.1', project: { name: 'x' } } as never)).toBe('imperial');
    expect(unitsOf({ floorspec: '0.1', project: { name: 'x' }, extras: { d3floorspec: { units: 'metric' } } } as never)).toBe('metric');
  });

  it('formats areas from twice the area, exactly rounded', () => {
    const sqft = BigInt(FT) * BigInt(FT);
    expect(formatArea(2n * 225n * sqft, 'imperial')).toBe('225 ft²');
    expect(formatArea(2n * 1_638_400_000_000n * 10n, 'metric')).toBe('10.0 m²');
  });
});

// ─── Snapping ────────────────────────────────────────────────────────────────────────────────

function level(partial: Partial<LevelView>): LevelView {
  return {
    id: 'L1', name: 'Level 1', building: 'B1', elevation: 0, height: 3_511_296,
    junctions: [], walls: [], fills: [], separators: [], openings: [], rooms: [], faces: [], bounds: null,
    ...partial,
  };
}

describe('snapping', () => {
  const grid = IN / 2;
  const square = level({
    junctions: [
      { id: 'J1', position: [0, 0], edges: 2 },
      { id: 'J2', position: [10 * FT, 0], edges: 2 },
    ],
    walls: [
      {
        id: 'W1', level: 'L1', start: 'J1', end: 'J2', a: [0, 0], b: [10 * FT, 0],
        ring: [[0, -3 * IN], [10 * FT, -3 * IN], [10 * FT, 3 * IN], [0, 3 * IN]],
        thickness: 6 * IN, left: 3 * IN, right: 3 * IN, type: undefined, justification: 'center',
      },
    ],
  });

  it('prefers a junction within tolerance, and reports it', () => {
    const s = snapPoint(square, [10 * FT + 1000, 2000], { tol: 5 * IN, grid });
    expect(s).toMatchObject({ point: [10 * FT, 0], kind: 'junction', ref: 'J2' });
  });

  it('snaps onto a wall’s location line from anywhere on its body, at an exact lattice point', () => {
    const s = snapPoint(square, [4 * FT + 100, 2 * IN], { tol: 2 * IN, grid });
    expect(s.kind).toBe('wall');
    expect(s.ref).toBe('W1');
    expect(s.point[1]).toBe(0);
    expect(s.point[0] % grid).toBe(0);
  });

  it('meets a wall where the constrained ray crosses it', () => {
    const s = snapPoint(square, [4 * FT + 2000, 1000], { from: [4 * FT, 8 * FT], tol: 3 * IN, grid });
    expect(s).toMatchObject({ point: [4 * FT, 0], kind: 'wall' });
  });

  it('constrains direction to orthogonal and keeps length on the grid', () => {
    const s = snapPoint(level({}), [3 * FT + 777, 1500], { from: [0, 0], tol: 1000, grid });
    expect(s.kind).toBe('angle');
    expect(s.angle).toBe(0);
    expect(s.point[1]).toBe(0);
    expect(s.point[0] % grid).toBe(0);
  });

  it('steps angles by 15°, orthogonal first, and 45° when locked', () => {
    expect(snapAngle(Math.PI / 2 + 0.05, false)).toBe(90);
    expect(snapAngle((31 * Math.PI) / 180, false)).toBe(30);
    expect(snapAngle((38 * Math.PI) / 180, false)).toBeNull();
    expect(snapAngle((38 * Math.PI) / 180, true)).toBe(45);
    expect(unitAt(270)).toEqual([0, -1]);
  });

  it('places typed lengths exactly on orthogonal directions', () => {
    expect(pointAtLength([5, 7], 90, 12 * FT)).toEqual([5, 7 + 12 * FT]);
    expect(pointAtLength([0, 0], 180, 1)).toEqual([-1, 0]);
  });

  it('finds lattice points only strictly inside a segment', () => {
    expect(latticeOnSegment([0, 0], [10, 10], [4.2, 3.9], 1)).toEqual([4, 4]);
    expect(latticeOnSegment([0, 0], [10, 10], [0.1, 0.1], 1)).toBeNull();
    // An awkward angle has no lattice point near the pointer: no snap rather than a hairline gap.
    expect(latticeOnSegment([0, 0], [1_000_003, 999_999], [500_000, 499_998], 50)).toBeNull();
  });

  it('centres an opening near the middle, clamps it inside, and knows the side', () => {
    const L = 10 * FT;
    const w = 3 * FT;
    expect(snapOpening([0, 0], [L, 0], L, w, [5 * FT + 300, 2000], { tol: 2 * IN, grid })).toMatchObject({ offset: Math.round((L - w) / 2), centered: true, side: 'left' });
    expect(snapOpening([0, 0], [L, 0], L, w, [0, -2000], { tol: 2 * IN, grid })).toMatchObject({ offset: 0, side: 'right', nearer: 'start' });
    expect(snapOpening([0, 0], [L, 0], L, 11 * FT, [5 * FT, 0], { tol: 2 * IN, grid }).fits).toBe(false);
  });
});

// ─── The op builders, through the real applier ───────────────────────────────────────────────

/** Apply a batch (or a builder) locally with @floorspec/ops, as the server would. */
function commit(model: EditorModel, batch: Batch | BatchBuilder): EditorModel {
  const sent = typeof batch === 'function' ? batch(0) : batch;
  const result = apply(model.document, { batch: sent });
  if (result.status !== 'committed') throw new Error(`rejected: ${result.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return readModel(result.hash, result.document);
}

const blank = (): EditorModel => readModel('blank', { floorspec: '0.1', project: { name: 'Test house' } });
const v = (x: number, y: number, junction?: string): ChainVertex => ({ point: [x * FT, y * FT], junction });

/** Draw the small house the editor is verified with: a 30×20 box, a wall at 12 ft, a door, two windows, two rooms. */
function smallHouse(): EditorModel {
  let m = blank();
  m = commit(m, addLevel(m.document, { name: 'Level 1', elevation: 0, height: 3_511_296 }));
  const L = m.levels[0]?.id as string;
  const ext = typeChoices(m.document, 'wallType').find((c) => c.id === 'EXT26');
  // Drawn counter-clockwise on purpose: the builder reverses a closed loop so exteriors face out.
  m = commit(m, drawChain(m.document, L, [v(0, 0), v(30, 0), v(30, 20), v(0, 20), v(0, 0)], { kind: 'wall', type: ext }));
  const int = typeChoices(m.document, 'wallType').find((c) => c.id === 'INT24');
  m = commit(m, drawChain(m.document, L, [v(12, 0), v(12, 20)], { kind: 'wall', type: int }));
  return m;
}

describe('op builders', () => {
  it('adds a building with the first level, in one batch', () => {
    const m = blank();
    const batch = addLevel(m.document, { name: 'Level 1', elevation: 0, height: 1000 })(0);
    expect(batch.map((o) => o.op)).toEqual(['addElement', 'addElement']);
    const after = commit(m, batch);
    expect(after.levels).toHaveLength(1);
    expect(Object.keys(after.document.buildings ?? {})).toEqual(['B1']);
  });

  it('closes a counter-clockwise loop clockwise, so the exterior layers face out', () => {
    const chain = [v(0, 0), v(30, 0), v(30, 20), v(0, 20), v(0, 0)];
    expect(isClosed(chain)).toBe(true);
    expect(signedArea(chain.slice(0, -1).map((c) => c.point))).toBeGreaterThan(0);
    const m = smallHouse();
    const lvl = m.levels[0] as LevelView;
    // Every exterior wall has Outside on its left (exterior) side.
    for (const w of lvl.walls.filter((x) => x.type === 'EXT26')) expect(roomsBeside(lvl, w.id).left).toBeNull();
  });

  it('splits the exterior walls where the interior wall meets them (normalization, Ops 5.2)', () => {
    const lvl = smallHouse().levels[0] as LevelView;
    expect(lvl.walls).toHaveLength(7);
    expect(lvl.junctions).toHaveLength(6);
    expect(lvl.faces.filter((f) => f.room === null)).toHaveLength(2);
  });

  it('adds the starter type with the first element that uses it, and only then', () => {
    const m = smallHouse();
    expect(Object.keys(m.document.types ?? {}).sort()).toEqual(['EXT26', 'INT24']);
    const wall = (m.levels[0] as LevelView).walls.find((w) => w.type === 'EXT26' && w.a[1] === 0 && w.b[1] === 0 && Math.min(w.a[0], w.b[0]) === 0);
    const door = typeChoices(m.document, 'doorType').find((c) => c.id === 'D36');
    const batch = addOpening(m.document, { wall: wall?.id ?? '', at: 'centered', fill: door, hinge: 'end', swing: 'left' })(0);
    expect(batch[0]).toMatchObject({ op: 'addElement', collection: 'types', id: 'D36' });
    const after = commit(m, batch);
    const opening = Object.values(after.document.openings ?? {})[0];
    expect(opening).toMatchObject({ fill: 'D36', hinge: 'end', swing: 'left' });
    // Used now: no longer offered as a starter.
    expect(typeChoices(after.document, 'doorType').find((c) => c.id === 'D36')?.starter).toBe(false);
  });

  it('accepts an offset in the grammar: “3’ from end”', () => {
    const m = smallHouse();
    const lvl = m.levels[0] as LevelView;
    const top = lvl.walls.find((w) => w.a[1] === 20 * FT && w.b[1] === 20 * FT && Math.max(w.a[0], w.b[0]) === 30 * FT);
    const win = typeChoices(m.document, 'windowType')[0];
    const after = commit(m, addOpening(m.document, { wall: top?.id ?? '', at: `3' from end`, fill: win }));
    const o = (after.levels[0] as LevelView).openings[0];
    expect(o?.kind).toBe('window');
  });

  it('names rooms by their anchors, and finds which rooms a wall divides', () => {
    let m = smallHouse();
    const L = m.levels[0]?.id as string;
    m = commit(m, addRoom({ level: L, at: [6 * FT, 10 * FT], name: nextRoomName(m.document), function: 'living' }));
    m = commit(m, addRoom({ level: L, at: [20 * FT, 10 * FT], name: nextRoomName(m.document) }));
    const lvl = m.levels[0] as LevelView;
    expect(lvl.rooms.map((r) => r.name).sort()).toEqual(['Room 1', 'Room 2']);
    const interior = lvl.walls.find((w) => w.type === 'INT24');
    const sides = roomsBeside(lvl, interior?.id ?? '');
    expect([sides.left, sides.right].sort()).toEqual(['R1', 'R2']);
    expect(faceAt(lvl, [6 * FT, 10 * FT])?.room).toBe('R1');
  });

  it('removes a wall between two rooms with keep (Ops 4.7), and a plain element with removeElement', () => {
    expect(removeOps('W5', 'wall', 'R1')).toEqual([{ op: 'removeWall', wall: 'W5', keep: 'R1' }]);
    expect(removeOps('J3', 'junction')).toEqual([{ op: 'removeElement', id: 'J3', cascade: true }]);
    expect(removeOps('O1', 'opening')).toEqual([{ op: 'removeElement', id: 'O1' }]);
    expect(removeOps('S1', 'separator')).toEqual([{ op: 'removeElement', id: 'S1' }]);
  });

  it('sets or unsets, and stores the unit preference in extras', () => {
    expect(setOrUnset('W1', '/name', '', true)).toEqual([{ op: 'unsetProperty', id: 'W1', path: '/name' }]);
    expect(setOrUnset('W1', '/name', '', false)).toEqual([]);
    expect(setOrUnset('W1', '/name', 'North', false)).toEqual([{ op: 'setProperty', id: 'W1', path: '/name', value: 'North' }]);
    const after = commit(blank(), setUnits('metric'));
    expect(unitsOf(after.document)).toBe('metric');
  });

  it('picks a fresh ID when a starter’s is taken', () => {
    const doc = { floorspec: '0.1', project: { name: 'x' }, types: { D36: { kind: 'doorType', width: 1, height: 1 } } } as never;
    expect(namedId(doc, 'D36', 0)).toBe('D36-2');
    expect(namedId(doc, 'W3636', 1)).toBe('W3636-2');
    expect(useType(doc, undefined, 0)).toEqual({ id: undefined, ops: [] });
  });
});

// ─── Diagnostics' fixes (FLR-T-3.8) ──────────────────────────────────────────────────────────

describe('fixes', () => {
  const fix: FixOp[] = [
    { op: 'remove', id: 'J9' },
    { op: 'set', id: 'O1', member: '/offset', value: 12 },
    { op: 'unset', id: 'J2', member: '/join' },
  ];

  it('translate the Core fix shape into Ops primitives', () => {
    expect(fixToOps(fix)).toEqual([
      { op: 'removeElement', id: 'J9' },
      { op: 'setProperty', id: 'O1', path: '/offset', value: 12 },
      { op: 'unsetProperty', id: 'J2', path: '/join' },
    ]);
  });

  it('describe themselves for the button', () => {
    expect(describeFix([fix[1] as FixOp], (id) => `Door ${id}`)).toBe('Set offset of Door O1');
    expect(describeFix(fix, (id) => id)).toBe('Remove J9 and 2 more');
  });

  it('repair a rejected move when sent with it: the server’s 422 fix, applied with the batch', () => {
    // Move the interior wall far enough that the door no longer fits its wall: FS-INV-302 with a fix.
    let m = smallHouse();
    const lvl = m.levels[0] as LevelView;
    const bottomLeft = lvl.walls.find((w) => w.type === 'EXT26' && w.a[1] === 0 && w.b[1] === 0 && Math.min(w.a[0], w.b[0]) === 0);
    const door = typeChoices(m.document, 'doorType').find((c) => c.id === 'D36');
    m = commit(m, addOpening(m.document, { wall: bottomLeft?.id ?? '', at: `8' from start`, fill: door }));
    const interior = (m.levels[0] as LevelView).walls.find((w) => w.type === 'INT24');
    const move: Batch = [{ op: 'moveWall', wall: interior?.id ?? '', by: interior !== undefined && interior.a[1] < interior.b[1] ? `5'` : `-5'` }];
    const rejected = apply(m.document, { batch: move });
    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') return;
    const d = rejected.diagnostics.find((x) => x.code === 'FS-INV-302');
    expect(d?.fix).toBeDefined();
    const fixed = apply(m.document, { batch: [...move, ...fixToOps(d?.fix ?? [])] });
    expect(fixed.status).toBe('committed');
  });
});

// ─── Hit-testing and the camera ──────────────────────────────────────────────────────────────

describe('hit-testing', () => {
  it('finds junctions first, then openings, walls and rooms', () => {
    let m = smallHouse();
    const L = m.levels[0]?.id as string;
    m = commit(m, addRoom({ level: L, at: [6 * FT, 10 * FT], name: 'Living' }));
    const lvl = m.levels[0] as LevelView;
    const tol = 2 * IN;
    expect(hitTest(lvl, [30 * FT + 100, 100], tol)?.kind).toBe('junction');
    expect(hitTest(lvl, [20 * FT, 20 * FT + IN], tol)?.kind).toBe('wall');
    expect(hitTest(lvl, [6 * FT, 10 * FT], tol)).toEqual({ kind: 'room', id: 'R1' });
    expect(hitTest(lvl, [20 * FT, 10 * FT], tol)).toBeNull();
    expect(hitTest(lvl, [-10 * FT, -10 * FT], tol)).toBeNull();
  });
});

describe('the camera', () => {
  it('maps world to screen and back, with north up', () => {
    const view = fit({ minX: 0, minY: 0, maxX: 30 * FT, maxY: 20 * FT }, 800, 600);
    const p: [number, number] = [12 * FT, 3 * FT];
    const back = toWorld(view, toScreen(view, p));
    expect(back[0]).toBeCloseTo(p[0], 3);
    expect(back[1]).toBeCloseTo(p[1], 3);
    expect(toScreen(view, [0, 20 * FT])[1]).toBeLessThan(toScreen(view, [0, 0])[1]);
  });

  it('zooms about a point, keeping it where it is', () => {
    const view = fit(null, 800, 600);
    const at: [number, number] = [200, 150];
    const before = toWorld(view, at);
    const after = toWorld(zoomAt(view, 2, at), at);
    expect(after[0]).toBeCloseTo(before[0], 3);
    expect(after[1]).toBeCloseTo(before[1], 3);
  });
});

describe('the command registry', () => {
  it('names keys the way the registry spells them', () => {
    const k = (key: string, o: Partial<KeyboardEvent> = {}) => keyOf({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o }, true);
    expect(k('z', { metaKey: true })).toBe('Mod+z');
    expect(k('Z', { metaKey: true, shiftKey: true })).toBe('Mod+Shift+z');
    expect(k('W', { shiftKey: true })).toBe('w');
    expect(commandFor('Mod+z')?.id).toBe('edit.undo');
    expect(commandFor('Mod+Shift+z')?.id).toBe('edit.redo');
    expect(commandFor('w')?.id).toBe('tool.wall');
  });

  it('has one id per command and no key bound twice', () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
    const keys = COMMANDS.flatMap((c) => c.keys ?? []);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
