/**
 * Rules 8.5: the measures of a stair (Core 0.3, chapter 17) — its riser height and headroom as Core
 * derives them, and its declared tread, width and handrail height; and, from Rules 0.2, its form and
 * the least goings of its tapered treads at the walkline and at their narrow ends, as Core 0.4
 * derives them (17.7). A document of Core 0.1 or 0.2 has no stair, so a rule about stairs has no
 * subject in it.
 */
import { own } from '../model.js';
import { measure, type Measure } from './measure.js';

const big = (n: number | undefined): bigint | null => (n === undefined ? null : BigInt(n));

export const STAIR_MEASURES: readonly Measure[] = [
  measure({
    name: 'stairRiserHeight',
    kinds: ['stair'],
    type: 'length',
    // Core's riser height, rounded once as Core reports it (Core 17.4).
    compute: (m, t) => ({ value: BigInt(own(m.derived.stairs, t.id)!.riserHeight) }),
  }),
  measure({
    name: 'stairTreadDepth',
    kinds: ['stair'],
    type: 'length',
    compute: (m, t) => ({ value: BigInt(own(m.doc.stairs, t.id)!.tread) }),
  }),
  measure({
    name: 'stairWidth',
    kinds: ['stair'],
    type: 'length',
    compute: (m, t) => ({ value: BigInt(own(m.doc.stairs, t.id)!.width) }),
  }),
  measure({
    name: 'stairHeadroom',
    kinds: ['stair'],
    type: 'length',
    // Core's headroom (Core 17.6), or no value when Core derives none: nothing above it — or, read as
    // Core 0.3 reads a document (Rules 0.1), a winder or a spiral stair.
    compute: (m, t) => ({ value: big(own(m.derived.stairs, t.id)!.headroom) }),
  }),
  measure({
    name: 'stairHandrailHeight',
    kinds: ['stair'],
    type: 'length',
    compute: (m, t) => ({ value: big(own(m.doc.stairs, t.id)!.handrail?.height) }),
  }),
  measure({
    name: 'stairForm',
    kinds: ['stair'],
    type: 'term',
    since: '0.2',
    // 8.5 (0.2): the kind of its form (Core 17.2), "straight" when it declares none.
    compute: (m, t) => ({ value: own(m.doc.stairs, t.id)!.form?.kind ?? 'straight' }),
  }),
  measure({
    name: 'stairWalklineGoing',
    kinds: ['stair'],
    type: 'length',
    since: '0.2',
    // 8.5 (0.2): Core 0.4's walklineGoing (17.7), or no value for a stair with no tapered tread.
    compute: (m, t) => ({ value: big(own(m.derived.stairs, t.id)!.walklineGoing) }),
  }),
  measure({
    name: 'stairNarrowGoing',
    kinds: ['stair'],
    type: 'length',
    since: '0.2',
    // 8.5 (0.2): Core 0.4's narrowGoing (17.7), or no value for a stair with no tapered tread.
    compute: (m, t) => ({ value: big(own(m.derived.stairs, t.id)!.narrowGoing) }),
  }),
];
