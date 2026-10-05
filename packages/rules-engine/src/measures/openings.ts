/**
 * Chapter 6: measures of openings — kind (6.1), size as drawn (6.2), heights above the floor (6.3)
 * and whether the opening's wall faces the outside (6.4).
 *
 * The net clear opening and a door's clear width (`openingNetClearArea`, `…Width`, `…Height`,
 * `doorClearWidth`) are deferred in Rules 0.1 (4.8): Core 0.2 describes no sash, frame, leaf or
 * stop. When a later Rules draft defines them over the net-clear data a later Core draft adds, each
 * becomes one more entry of OPENING_MEASURES and leaves DEFERRED (library.ts); nothing else moves.
 */
import { own, type Model } from '../model.js';
import { measure, type Measure } from './measure.js';

/** 6.4: does a wall have a half-edge on its level's unbounded face — does it face the outside? */
export function wallToOutside(model: Model, wid: string): boolean {
  const lv = model.level(model.wallLevel(wid));
  return lv.halfEdges(wid).some((h) => lv.faceOf(h) === undefined);
}

const derivedOpening = (m: Model, oid: string): { sillElevation: number; headElevation: number } => own(m.derived.openings, oid)!;
const floorOf = (m: Model, oid: string): bigint => m.floor(m.wallLevel(m.opening(oid).wall));

export const OPENING_MEASURES: readonly Measure[] = [
  measure({
    name: 'openingKind',
    kinds: ['opening'],
    type: 'term',
    compute: (m, t) => {
      const fill = m.opening(t.id).fill;
      if (fill === undefined) return { value: 'empty' };
      return { value: own(m.doc.types, fill)!.kind === 'doorType' ? 'door' : 'window' };
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
];
