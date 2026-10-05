import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { readModel, type EditorModel } from '../src/editor/model';
import { diffModels } from '../src/editor/diff';
import { describeOp, summarizeBatch } from '../src/editor/describe';
import {
  addItem,
  edgeKey,
  edgeState,
  formatArea,
  parseAreaInput,
  readProgram,
  relate,
  relateRefusal,
  removeEdge,
  removeItem,
  setItem,
  setKind,
  setWeight,
  SQ_FT,
  SQ_M,
  upgrade,
  type ProgramView,
} from '../src/program/model';
import { bubbleAt, clamp, FRAME, layout, R_MAX, R_MIN, R_NONE, radii, segment } from '../src/program/geometry';
import { candidateSets, letter, parseLayoutName } from '../src/program/candidates';
import type { ChangesetRow } from '../src/editor/api';
import type { Batch } from '../src/editor/ops';

/**
 * The brief's pure parts (FLR-T-4.2, 4.3): reading a program with the engine's verdict, the op
 * builders — each run through the real applier, @floorspec/ops, so what the brief editor sends is
 * what the server commits — the bubble geometry, and the layout candidates read back from their
 * changesets.
 */

const template = JSON.parse(readFileSync(new URL('../src/projects/templates/three-room-house.floorspec.json', import.meta.url), 'utf8')) as Record<string, unknown>;

/** Apply a batch and read the result the way the editor does; fail loudly if it does not commit. */
function commit(document: object, batch: Batch): EditorModel {
  const r = apply(document, { batch });
  if (r.status !== 'committed') throw new Error(`refused: ${JSON.stringify(r.diagnostics.slice(0, 3))}`);
  return readModel(r.hash, r.document);
}
const doc = (m: EditorModel) => m.document as unknown as Record<string, unknown>;
const view = (m: EditorModel): ProgramView => readProgram(m);

/** The three-room house with a brief: living and kitchen linked to their rooms, two bedrooms asked for, a bath unmet. */
function briefed(): EditorModel {
  return commit(template, [
    { op: 'addProgramItem', id: 'P1', function: 'living', name: 'Living', targetArea: '100 sq ft' },
    { op: 'addProgramItem', id: 'P2', function: 'kitchen', name: 'Kitchen', targetArea: '5000 sq ft' },
    { op: 'addProgramItem', id: 'P3', function: 'sleeping', name: 'Bedroom', count: 2 },
    { op: 'addProgramItem', id: 'P4', function: 'bath', name: 'Bath', minArea: '40 sq ft' },
    { op: 'addProgramItem', id: 'P10', function: 'office' },
    { op: 'setRoomBrief', room: 'LIV', item: 'P1' },
    { op: 'setRoomBrief', room: 'KIT', item: 'P2' },
    { op: 'setRoomBrief', room: 'BED', item: 'P3' },
    { op: 'setAdjacency', a: 'P1', b: 'P2', kind: 'required', weight: 8 },
    { op: 'setAdjacency', a: 'P3', b: 'P4', kind: 'preferred' },
    { op: 'setAdjacency', a: 'P2', b: 'P3', kind: 'forbidden' },
  ]);
}

describe('reading a brief', () => {
  it('lists items in reading order with what the engine derived for each', () => {
    const v = view(briefed());
    expect(v.version).toBe('0.3');
    expect(v.derived).toBe(true);
    expect(v.items.map((i) => i.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P10']);
    const by = Object.fromEntries(v.items.map((i) => [i.id, i]));
    expect(by['P1']).toMatchObject({ label: 'Living', rooms: ['LIV'], need: { label: 'Met', met: true, tone: 'neutral' } });
    expect(by['P2']).toMatchObject({ rooms: ['KIT'], need: { label: 'Under target', tone: 'warning', met: false } });
    expect(by['P3']).toMatchObject({ count: 2, rooms: ['BED'], need: { label: '1 of 2', tone: 'attention' } });
    expect(by['P4']).toMatchObject({ rooms: [], need: { label: 'Needs a room', tone: 'attention' } });
    expect(by['P10']).toMatchObject({ label: 'Item P10', function: 'office' });
    expect(v.target).toBe(100 * SQ_FT + 5000 * SQ_FT);
  });

  it('reads each line with its verdict: adjacent, met, and the kind\'s meaning', () => {
    const v = view(briefed());
    const by = Object.fromEntries(v.edges.map((e) => [e.key, e]));
    // The template's living room and kitchen share a wall; its bedroom is off the living room.
    expect(by['P1|P2|required']).toMatchObject({ weight: 8, adjacent: true, met: true });
    expect(by['P3|P4|preferred']).toMatchObject({ weight: 5, adjacent: false, met: false });
    const forbidden = by['P2|P3|forbidden'];
    expect(forbidden?.met).toBe(forbidden?.adjacent === false);
    expect(edgeState(by['P1|P2|required'] ?? (undefined as never))).toMatch(/^Met/);
    expect(v.unmet.edges).toBe(v.edges.filter((e) => e.met === false).length);
  });

  it('has nothing to say of a Core 0.1 plan but that it needs upgrading, which one op does', () => {
    const old = readModel('x', { floorspec: '0.1', project: { name: 'Old' } });
    expect(view(old)).toMatchObject({ version: '0.1', items: [], edges: [] });
    const r = apply(old.document, { batch: [...upgrade(old.document), ...addItem({ function: 'kitchen' })] });
    expect(r.status).toBe('committed');
  });
});

describe('editing a brief, as operations the applier commits', () => {
  it('adds an item with its areas, and sets and clears its members', () => {
    const blank = readModel('blank', { floorspec: '0.2', project: { name: 'x' } });
    const added = commit(blank.document, addItem({ function: 'sleeping', name: 'Bedroom', count: 3, targetArea: 130 * SQ_FT, minArea: 110 * SQ_FT }));
    const [item] = view(added).items;
    expect(item).toMatchObject({ id: 'P1', name: 'Bedroom', count: 3, targetArea: 130 * SQ_FT, minArea: 110 * SQ_FT });
    if (item === undefined) return;
    const renamed = commit(added.document, [...setItem(item, 'name', 'Guest room'), ...setItem(item, 'count', 1), ...setItem(item, 'minArea', undefined)]);
    expect((doc(renamed)['program'] as { items: Record<string, unknown> }).items['P1']).toEqual({ function: 'sleeping', name: 'Guest room', targetArea: 130 * SQ_FT });
    // Nothing to change is no op at all.
    expect(setItem(view(renamed).items[0] as never, 'count', 1)).toEqual([]);
    expect(addItem({ function: 'bath', name: '', count: 1 })).toEqual([{ op: 'addProgramItem', function: 'bath' }]);
  });

  it('relates two items with the default kind, changes the kind keeping the weight, reweighs and removes', () => {
    let m = commit(briefed().document, relate('P1', 'P10'));
    let v = view(m);
    const line = v.edges.find((e) => e.key === edgeKey('P10', 'P1', 'preferred'));
    expect(line).toMatchObject({ kind: 'preferred', weight: 5 });
    if (line === undefined) return;
    m = commit(m.document, setWeight(line, 9));
    v = view(m);
    const heavy = v.edges.find((e) => e.key === line.key);
    expect(heavy?.weight).toBe(9);
    m = commit(m.document, setKind(v, heavy as never, 'required'));
    v = view(m);
    expect(v.edges.filter((e) => (e.a === 'P1' && e.b === 'P10') || (e.a === 'P10' && e.b === 'P1'))).toEqual([expect.objectContaining({ kind: 'required', weight: 9 })]);
    m = commit(m.document, removeEdge(v.edges.find((e) => e.key === edgeKey('P1', 'P10', 'required')) as never));
    expect(view(m).edges.some((e) => e.b === 'P10' || e.a === 'P10')).toBe(false);
  });

  it('turns a wanted pair into a forbidden one in one batch, dropping the wanted lines it would contradict', () => {
    const m = commit(briefed().document, relate('P1', 'P2', 'preferred'));
    const v = view(m);
    const required = v.edges.find((e) => e.key === 'P1|P2|required');
    if (required === undefined) throw new Error('no line');
    const after = view(commit(m.document, setKind(v, required, 'forbidden')));
    expect(after.edges.filter((e) => e.key.startsWith('P1|P2|')).map((e) => e.kind)).toEqual(['forbidden']);
  });

  it('refuses what Core does not allow, before anything is sent', () => {
    const v = view(briefed());
    expect(relateRefusal(v, 'P1', 'P1', 'preferred')).toMatch(/itself/);
    expect(relateRefusal(v, 'P2', 'P3', 'preferred')).toMatch(/forbidden/);
    expect(relateRefusal(v, 'P1', 'P2', 'forbidden')).toMatch(/already wanted/);
    expect(relateRefusal(v, 'P1', 'P10', 'preferred')).toBeNull();
  });

  it('removes an item a room fulfils by unlinking the room in the same batch', () => {
    const m = briefed();
    const living = view(m).items.find((i) => i.id === 'P1');
    if (living === undefined) throw new Error('no item');
    expect(apply(m.document, { batch: [{ op: 'removeElement', id: 'P1' }] }).status).toBe('rejected');
    const after = commit(m.document, removeItem(living));
    expect(view(after).items.map((i) => i.id)).not.toContain('P1');
    expect((doc(after)['rooms'] as Record<string, Record<string, unknown>>)['LIV']?.['brief']).toBeUndefined();
    expect(view(after).edges.some((e) => e.a === 'P1' || e.b === 'P1')).toBe(false);
  });
});

describe('areas', () => {
  it('parse in the Ops area grammar, a bare number in the display unit', () => {
    expect(parseAreaInput('140', 'imperial')).toEqual({ ok: true, value: 140 * SQ_FT });
    expect(parseAreaInput('140 sq ft', 'metric')).toEqual({ ok: true, value: 140 * SQ_FT });
    expect(parseAreaInput('140 ft²', 'imperial')).toEqual({ ok: true, value: 140 * SQ_FT });
    expect(parseAreaInput('12', 'metric')).toEqual({ ok: true, value: 12 * SQ_M });
    expect(parseAreaInput('11 m2', 'imperial')).toEqual({ ok: true, value: 11 * SQ_M });
    expect(parseAreaInput('a lot', 'imperial').ok).toBe(false);
    expect(parseAreaInput('0', 'imperial').ok).toBe(false);
    expect(parseAreaInput('', 'imperial').ok).toBe(false);
  });

  it('format in whole ft² or tenths of a m²', () => {
    expect(formatArea(140 * SQ_FT, 'imperial')).toBe('140 ft²');
    expect(formatArea(2410 * SQ_FT, 'imperial')).toBe('2,410 ft²');
    expect(formatArea(12 * SQ_M, 'metric')).toBe('12.0 m²');
  });
});

describe('bubble geometry', () => {
  const v = view(briefed());

  it('sizes bubbles by the square root of their target area, with a floor and a stand-in', () => {
    const r = radii(v.items);
    expect(r.get('P2')).toBe(R_MAX);
    expect(r.get('P1')).toBe(Math.max(R_MIN, R_MAX * Math.sqrt(100 / 5000)));
    expect(r.get('P3')).toBe(R_NONE);
  });

  it('lays out deterministically, inside the frame, keeping a bubble where it was put', () => {
    const a = layout(v.items, v.edges, new Map());
    const b = layout(v.items, v.edges, new Map());
    expect([...a]).toEqual([...b]);
    const r = radii(v.items);
    for (const [id, p] of a) {
      const radius = r.get(id) ?? 0;
      expect(p[0]).toBeGreaterThanOrEqual(radius);
      expect(p[0]).toBeLessThanOrEqual(FRAME.width - radius);
      expect(p[1]).toBeGreaterThanOrEqual(radius);
      expect(p[1]).toBeLessThanOrEqual(FRAME.height - radius);
    }
    const pinned = layout(v.items, v.edges, new Map([['P1', [100, 120] as const]]));
    expect(pinned.get('P1')).toEqual([100, 120]);
    // No two bubbles left on top of each other.
    const ids = [...a.keys()];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const p = a.get(ids[i] as string) as readonly [number, number];
        const q = a.get(ids[j] as string) as readonly [number, number];
        expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeGreaterThan(Math.max(r.get(ids[i] as string) ?? 0, r.get(ids[j] as string) ?? 0));
      }
  });

  it('draws a line rim to rim, finds the bubble under a point, and keeps one in the frame', () => {
    expect(segment([0, 0], 10, [100, 0], 20)).toEqual({ from: [10, 0], to: [80, 0], mid: [45, 0] });
    expect(segment([0, 0], 60, [100, 0], 50)).toBeNull();
    const at = new Map<string, readonly [number, number]>([['big', [100, 100]], ['small', [110, 100]]]);
    const r = new Map([['big', 80], ['small', 20]]);
    expect(bubbleAt([112, 100], at, r)).toBe('small');
    expect(bubbleAt([40, 100], at, r)).toBe('big');
    expect(bubbleAt([112, 100], at, r, 'small')).toBe('big');
    expect(bubbleAt([900, 700], at, r)).toBeNull();
    expect(clamp([-50, 2000], 30)).toEqual([42, FRAME.height - 42]);
  });
});

describe('layout candidates among the changesets', () => {
  const row = (id: string, name: string, base: string, status: ChangesetRow['status'] = 'pending', createdAt = '2026-10-04T12:00:00Z'): ChangesetRow => ({
    id, name, status, base, head: 'h', ops: 1, createdBy: null, createdAt, fastForward: null,
  });

  it('reads a candidate\'s name back: rank, of, total and label, a reopened one\'s suffix dropped', () => {
    expect(parseLayoutName('Layout 2 of 3 (97.2): Compact: no hall')).toEqual({ rank: 2, of: 3, total: 97.2, label: 'Compact: no hall' });
    expect(parseLayoutName('Layout 1 of 3 (97.6): Bedroom wing (2)')).toEqual({ rank: 1, of: 3, total: 97.6, label: 'Bedroom wing' });
    expect(parseLayoutName('Widen the kitchen')).toBeNull();
    expect(letter(1)).toBe('A');
    expect(letter(3)).toBe('C');
  });

  it('sorts them into this main\'s, earlier ones, and those an accepted candidate superseded', () => {
    const rows = [
      row('a1', 'Layout 1 of 2 (90.0): A', 'm1', 'accepted', '2026-10-04T10:00:00Z'),
      row('a2', 'Layout 2 of 2 (80.0): B', 'm1'),
      row('b2', 'Layout 2 of 2 (85.0): D', 'm3'),
      row('b1', 'Layout 1 of 2 (95.0): C', 'm3'),
      row('c1', 'Layout 1 of 1 (70.0): E', 'm2'),
      row('x', 'Rename the kitchen', 'm3'),
    ];
    const sets = candidateSets(rows, 'm3');
    expect(sets.current.map((c) => c.row.id)).toEqual(['b1', 'b2']);
    expect(sets.stale.map((c) => c.row.id)).toEqual(['c1']);
    expect(sets.accepted?.row.id).toBe('a1');
    expect(sets.accepted?.superseded.map((c) => c.row.id)).toEqual(['a2']);
    expect(candidateSets(rows.filter((r) => r.id !== 'a2'), 'm3').accepted?.superseded).toEqual([]);
    expect(candidateSets(rows.filter((r) => r.id !== 'a1'), 'm3').accepted).toBeNull();
  });
});

describe('the history and the diff name the brief', () => {
  it('lists added items and lines, and a reweighted line', () => {
    const before = briefed();
    const after = commit(before.document, [...addItem({ function: 'garage', name: 'Garage' }), ...relate('P1', 'P10', 'required'), { op: 'setAdjacency', a: 'P3', b: 'P4', kind: 'preferred', weight: 2 }]);
    const d = diffModels(before, after, 'imperial');
    const brief = d.changes.filter((c) => c.collection === 'items' || c.collection === 'adjacency');
    expect(brief.map((c) => `${c.kind} ${c.collection} ${c.label}${c.detail === undefined ? '' : ` (${c.detail})`}`)).toEqual([
      'added items Garage',
      'added adjacency Living ↔ Item P10 (required)',
      'changed adjacency Bedroom ↔ Bath (preferred) (weight 5 → 2)',
    ]);
    const upgraded = diffModels(readModel('a', { floorspec: '0.1', project: { name: 'x' } }), readModel('b', { floorspec: '0.2', project: { name: 'x' } }), 'imperial');
    expect(upgraded.changes).toEqual([expect.objectContaining({ collection: 'project', detail: 'Floorspec 0.1 → 0.2' })]);
  });

  it('describes the brief\'s operations in words', () => {
    const name = (id: string) => ({ P1: 'Living', P2: 'Kitchen', R1: 'Kitchen room' })[id] ?? id;
    expect(describeOp({ op: 'setAdjacency', a: 'P1', b: 'P2', kind: 'required', weight: 8 }, 'imperial', name)).toEqual(['setAdjacency', 'Living ↔ Kitchen · required · weight 8']);
    expect(describeOp({ op: 'addProgramItem', function: 'sleeping', name: 'Bedroom', count: 2, targetArea: '130 sq ft' }, 'imperial', name)).toEqual(['addProgramItem', '“Bedroom” ×2 · 130 sq ft']);
    expect(summarizeBatch([{ op: 'addProgramItem', function: 'kitchen', name: 'Kitchen' }], 'imperial', name)).toBe('Added “Kitchen” to the brief');
    expect(summarizeBatch([{ op: 'removeAdjacency', a: 'P1', b: 'P2', kind: 'required' }], 'imperial', name)).toBe('Unrelated Living and Kitchen');
    expect(summarizeBatch([{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' }], 'imperial', name)).toBe('Upgraded the plan to Floorspec 0.3');
    expect(summarizeBatch([{ op: 'setProperty', id: 'R1', path: '/brief', value: 'P2' }], 'imperial', name)).toBe('Linked Kitchen room to Kitchen');
  });

  it('upgrades a 0.1 plan by its migration (Core chapter 20), which a version bump alone cannot do here', () => {
    // A 0.1 plan whose extension data has a "collections" member, opaque in 0.1 and malformed as 0.3's.
    const old = {
      floorspec: '0.1',
      project: { name: 'Old' },
      extensionsUsed: { EXT_notes: '1.0' },
      extensions: { EXT_notes: { collections: { pinned: 'not an element' } } },
    };
    expect(apply(old, { batch: [{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' }] }).status).toBe('rejected');
    const batch = upgrade(old);
    const r = apply(old, { batch: [...batch, ...addItem({ function: 'kitchen' })] });
    expect(r.status).toBe('committed');
    if (r.status !== 'committed') return;
    const doc = JSON.parse(r.document) as { floorspec: string; extras: Record<string, unknown> };
    // To the current draft, 0.4: the steps from 0.2 to 0.3 and from 0.3 to 0.4 move nothing (20.6, 20.7).
    expect(doc.floorspec).toBe('0.4');
    expect(doc.extras['floorspec:migration']).toEqual([{ from: '0.1', to: '0.2', moved: [{ pointer: '/extensions/EXT_notes/collections', value: { pinned: 'not an element' } }] }]);
    expect(summarizeBatch(batch as unknown as Record<string, unknown>[], 'imperial', (id) => id)).toBe('Upgraded the plan to Floorspec 0.4');
  });
});
