/**
 * Chapter 5: measures of rooms — function (5.1), net area (5.2), least width (5.3), circulation
 * (5.4), neighbours (5.5) and the elements in a room (5.6, and of a level, 8.4).
 */
import { own, sortIds, type Model } from '../model.js';
import { matches, elementDefaults } from '../model.js';
import { roundDivSqrt } from '../exact.js';
import { aCollection, aExtension, aFunction, aMatch, measure, type Args, type Measure } from './measure.js';
import { bigRing, leastWidth } from './geometry.js';

/** Twice a derived area, from its decimal string (Core 6.4: an integer, or an integer and a half). */
export function area2(s: string): bigint {
  const neg = s.startsWith('-');
  const t = neg ? s.slice(1) : s;
  const v = t.endsWith('.5') ? 2n * BigInt(t.slice(0, -2)) + 1n : 2n * BigInt(t);
  return neg ? -v : v;
}

function derivedRoom(model: Model, rid: string): { outer: [number, number][]; holes: [number, number][][]; area: string } {
  return own(model.derived.rooms, rid)!;
}

function circulation(model: Model, rid: string): { entry: boolean; reachable: boolean; throughSleeping?: boolean } {
  return own(model.derived.circulation, rid)!;
}

/**
 * Core 11.4: every room's adjacent and connected rooms. Two rooms are adjacent when an edge lies
 * between their faces; connected when that edge is a separator, or a wall hosting a door or an
 * empty opening. Read off each level's faces, as the engine's program derivation reads them.
 */
export function relations(model: Model): { adjacent: Map<string, Set<string>>; connected: Map<string, Set<string>> } {
  const hit = model.memo.get('relations') as ReturnType<typeof relations> | undefined;
  if (hit) return hit;
  const adjacent = new Map<string, Set<string>>();
  const connected = new Map<string, Set<string>>();
  const link = (m: Map<string, Set<string>>, a: string, b: string): void => {
    m.set(a, (m.get(a) ?? new Set()).add(b));
    m.set(b, (m.get(b) ?? new Set()).add(a));
  };
  const doors = new Set<string>();
  for (const oid of Object.keys(model.doc.openings ?? {})) {
    const o = model.opening(oid);
    if (o.fill === undefined || own(model.doc.types, o.fill)?.kind === 'doorType') doors.add(o.wall);
  }
  for (const lid of sortIds(model.analysis.levels.keys())) {
    const la = model.analysis.levels.get(lid)!;
    if (!la.geometry) continue;
    const lv = model.level(lid);
    lv.g.edges.forEach((e, i) => {
      const fa = lv.faceOf(2 * i);
      const fb = lv.faceOf(2 * i + 1);
      if (fa === undefined || fb === undefined || fa === fb) return;
      const ra = lv.faceRoom.get(fa);
      const rb = lv.faceRoom.get(fb);
      if (ra === undefined || rb === undefined) return;
      link(adjacent, ra, rb);
      if (e.kind === 'separator' || doors.has(e.id)) link(connected, ra, rb);
    });
  }
  const out = { adjacent, connected };
  model.memo.set('relations', out);
  return out;
}

const neighbour = (model: Model, rid: string, pairs: Map<string, Set<string>>, fn: string): boolean =>
  [...(pairs.get(rid) ?? [])].some((other) => other !== rid && model.roomFunction(other) === fn);

/** 5.6, 8.4: does an element belong to the counted extension and collection, and match? */
export function elementCounts(model: Model, eid: string, a: Args): boolean {
  const x = model.ext.get(eid)!;
  if (x.extension !== a.extension) return false;
  if (a.collection !== undefined && x.collection !== a.collection) return false;
  return a.match === undefined || matches(x.element, elementDefaults(x.extension, x.collection), a.match as Record<string, unknown>);
}

const COUNT_ARGS = { extension: aExtension, collection: aCollection, match: aMatch };
const readsMatch = (a: Args): string[] => (a.match !== undefined ? [a.extension as string] : []);

export const ROOM_MEASURES: readonly Measure[] = [
  measure({
    name: 'roomFunction',
    kinds: ['room'],
    type: 'term',
    compute: (m, t) => ({ value: m.roomFunction(t.id) }),
  }),
  measure({
    name: 'roomNetArea',
    kinds: ['room'],
    type: 'area',
    compute: (m, t) => ({ value: area2(derivedRoom(m, t.id).area) }),
  }),
  measure({
    name: 'roomLeastWidth',
    kinds: ['room'],
    type: 'length',
    compute: (m, t) => {
      const { c, l } = leastWidth(bigRing(derivedRoom(m, t.id).outer));
      return { value: roundDivSqrt(c, l) };
    },
  }),
  measure({
    name: 'roomIsEntry',
    kinds: ['room'],
    type: 'boolean',
    compute: (m, t) => ({ value: circulation(m, t.id).entry }),
  }),
  measure({
    name: 'roomIsReachable',
    kinds: ['room'],
    type: 'boolean',
    compute: (m, t) => ({ value: circulation(m, t.id).reachable }),
  }),
  measure({
    name: 'roomThroughSleeping',
    kinds: ['room'],
    type: 'boolean',
    compute: (m, t) => ({ value: circulation(m, t.id).throughSleeping ?? false }),
  }),
  measure({
    name: 'roomAdjacentTo',
    kinds: ['room'],
    type: 'boolean',
    args: { function: aFunction },
    required: ['function'],
    compute: (m, t, a) => ({ value: neighbour(m, t.id, relations(m).adjacent, a.function as string) }),
  }),
  measure({
    name: 'roomConnectedTo',
    kinds: ['room'],
    type: 'boolean',
    args: { function: aFunction },
    required: ['function'],
    compute: (m, t, a) => ({ value: neighbour(m, t.id, relations(m).connected, a.function as string) }),
  }),
  // 5.6 of a room; 8.4 of a level. With a match it reads the extension (4.6).
  measure({
    name: 'elementCount',
    kinds: ['room', 'level'],
    type: 'count',
    args: COUNT_ARGS,
    required: ['extension'],
    reads: readsMatch,
    compute: (m, t, a) => {
      let n = 0n;
      for (const [eid, x] of m.ext) {
        const inside = t.kind === 'room' ? m.roomOf(eid) === t.id : x.element.fallback.level === t.id;
        if (inside && elementCounts(m, eid, a)) n++;
      }
      return { value: n };
    },
  }),
  // 5.7: the least height of the room's ceiling above its floor — its ceiling's low minus its
  // floor's top, both as Core derives them (Core §15.1, §15.5): integers, so no rounding.
  measure({
    name: 'ceilingHeight',
    kinds: ['room'],
    type: 'length',
    compute: (m, t) => ({ value: BigInt(own(m.derived.ceilings, t.id)!.low) - BigInt(own(m.derived.floors, t.id)!.top) }),
  }),
];
