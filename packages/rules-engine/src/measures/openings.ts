/**
 * Chapter 6: measures of openings — kind and operation (6.1), size as drawn (6.2), heights above
 * the floor (6.3), whether the opening's wall faces the outside (6.4) and the net clear opening
 * (6.5).
 *
 * The net clear measures read only what Core 0.3 derives — the opening's effective clear opening,
 * exactly as its door or window type declares it or the opening overrides it (Core §7.2, §7.4) —
 * and have no value where nothing is declared: never a figure computed from the opening's own size
 * (FS-RULES-6.5.1). A Core 0.1 or 0.2 document declares none.
 */
import { own, type Model } from '../model.js';
import { measure, type Measure } from './measure.js';

/** 6.4: does a wall have a half-edge on its level's unbounded face — does it face the outside? */
export function wallToOutside(model: Model, wid: string): boolean {
  const lv = model.level(model.wallLevel(wid));
  return lv.halfEdges(wid).some((h) => lv.faceOf(h) === undefined);
}

const derivedOpening = (m: Model, oid: string): { sillElevation: number; headElevation: number; clearOpening?: { width: number; height: number; area?: number } } =>
  own(m.derived.openings, oid)!;

/** 6.1: the kind of an opening — what fills it. */
const kindOf = (m: Model, oid: string): 'door' | 'window' | 'empty' => {
  const fill = m.opening(oid).fill;
  if (fill === undefined) return 'empty';
  return own(m.doc.types, fill)!.kind === 'doorType' ? 'door' : 'window';
};

/** 6.5: the opening's clear opening as Core derives it (Core §7.4), or undefined when none is declared. */
const clearOf = (m: Model, oid: string): { width: number; height: number; area?: number } | undefined => derivedOpening(m, oid).clearOpening;
const floorOf = (m: Model, oid: string): bigint => m.floor(m.wallLevel(m.opening(oid).wall));

export const OPENING_MEASURES: readonly Measure[] = [
  measure({
    name: 'openingKind',
    kinds: ['opening'],
    type: 'term',
    compute: (m, t) => ({ value: kindOf(m, t.id) }),
  }),
  measure({
    name: 'openingOperation',
    kinds: ['opening'],
    type: 'term',
    compute: (m, t) => {
      // 6.1: the operation of the door or window type that fills it; no value for an empty opening
      // or a type that declares none (Core §8.4: an absent operation is not declared).
      const fill = m.opening(t.id).fill;
      const type = fill === undefined ? undefined : own(m.doc.types, fill);
      const op = type && type.kind !== 'wallType' ? type.operation : undefined;
      return { value: op ?? null };
    },
  }),
  measure({
    name: 'openingWidth',
    kinds: ['opening'],
    type: 'length',
    compute: (m, t) => ({ value: m.openingDims(t.id).width }),
  }),
  measure({
    name: 'openingHeight',
    kinds: ['opening'],
    type: 'length',
    compute: (m, t) => ({ value: m.openingDims(t.id).height }),
  }),
  measure({
    name: 'openingArea',
    kinds: ['opening'],
    type: 'area',
    compute: (m, t) => {
      const d = m.openingDims(t.id);
      return { value: 2n * d.width * d.height };
    },
  }),
  measure({
    name: 'openingSillHeight',
    kinds: ['opening'],
    type: 'length',
    compute: (m, t) => ({ value: BigInt(derivedOpening(m, t.id).sillElevation) - floorOf(m, t.id) }),
  }),
  measure({
    name: 'openingHeadHeight',
    kinds: ['opening'],
    type: 'length',
    compute: (m, t) => ({ value: BigInt(derivedOpening(m, t.id).headElevation) - floorOf(m, t.id) }),
  }),
  measure({
    name: 'openingToOutside',
    kinds: ['opening'],
    type: 'boolean',
    compute: (m, t) => ({ value: wallToOutside(m, m.opening(t.id).wall) }),
  }),
  // 6.5: the net clear opening, as declared.
  measure({
    name: 'openingNetClearWidth',
    kinds: ['opening'],
    type: 'length',
    compute: (m, t) => {
      const c = clearOf(m, t.id);
      return { value: c ? BigInt(c.width) : null };
    },
  }),
  measure({
    name: 'openingNetClearHeight',
    kinds: ['opening'],
    type: 'length',
    compute: (m, t) => {
      const c = clearOf(m, t.id);
      return { value: c ? BigInt(c.height) : null };
    },
  }),
  measure({
    name: 'openingNetClearArea',
    kinds: ['opening'],
    type: 'area',
    compute: (m, t) => {
      // The declared area — never the clear width times the clear height. An area is held doubled (4.2).
      const area = clearOf(m, t.id)?.area;
      return { value: area === undefined ? null : 2n * BigInt(area) };
    },
  }),
  measure({
    name: 'doorClearWidth',
    kinds: ['opening'],
    type: 'length',
    compute: (m, t) => {
      // For a door, the clear width of the whole opening, every leaf open, as declared; no value
      // for a door without one, a window or an empty opening.
      const c = kindOf(m, t.id) === 'door' ? clearOf(m, t.id) : undefined;
      return { value: c ? BigInt(c.width) : null };
    },
  }),
];
