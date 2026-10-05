/**
 * Rules 8.5: the measures of a stair (Core 0.3, chapter 17) — its riser height and headroom as Core
 * derives them, and its declared tread, width and handrail height. A document of Core 0.1 or 0.2 has
 * no stair, so a rule about stairs has no subject in it.
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
    // Core's headroom (Core 17.6), or no value when Core derives none (a winder, a spiral, nothing above).
    compute: (m, t) => ({ value: big(own(m.derived.stairs, t.id)!.headroom) }),
  }),
  measure({
    name: 'stairHandrailHeight',
    kinds: ['stair'],
    type: 'length',
    compute: (m, t) => ({ value: big(own(m.doc.stairs, t.id)!.handrail?.height) }),
  }),
];
