/**
 * Locks (chapter 6): decisions the person editing has made about a document, checked against the
 * result after normalization. Every comparison is exact: lengths by their squares, distances by
 * squared cross products.
 */
import { jsonEqual, predicates, type Diagnostic } from '@floorspec/engine';
import { opsDiagnostic } from './diagnostics.js';
import { asPoint, LevelFaces } from './model/faces.js';
import { WorkingCopy, type CollectionName } from './model/working.js';
import type { Lock } from './types.js';
import { getMember, isObject, type JsonObject } from './lib/json.js';

type IPoint = readonly [bigint, bigint];

const lockElements = (l: Lock): string[] => ('element' in l ? [l.element] : 'length' in l ? [l.length] : [...l.distance]);

/** A wall's location line in a document: start position and direction. */
function line(doc: WorkingCopy, wall: string): { S: IPoint; d: IPoint } | undefined {
  const w = doc.elementIn('walls', wall);
  const s = getMember(w, 'start');
  const e = getMember(w, 'end');
  const S = typeof s === 'string' ? asPoint(getMember(doc.elementIn('junctions', s), 'position')) : undefined;
  const E = typeof e === 'string' ? asPoint(getMember(doc.elementIn('junctions', e), 'position')) : undefined;
  if (!S || !E) return undefined;
  return { S, d: [E[0] - S[0], E[1] - S[1]] };
}

const len2 = (d: IPoint): bigint => d[0] * d[0] + d[1] * d[1];

/** 6.1.1: every lock names elements of A, and a distance lock walls parallel in A. */
export function invalidLocks(a: WorkingCopy, locks: readonly Lock[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  locks.forEach((l, i) => {
    const ptr = `/context/locks/${i}`;
    const els = lockElements(l);
    if ('element' in l) {
      if (!a.exists(l.element)) out.push(opsDiagnostic('FS-OPS-010', `the lock names ${l.element}, which is not in the document`, els, ptr));
    } else if ('length' in l) {
      if (!a.elementIn('walls', l.length)) out.push(opsDiagnostic('FS-OPS-010', `the length lock names ${l.length}, which is not a wall of the document`, els, ptr));
    } else {
      const [p, q] = l.distance;
      const lp = a.elementIn('walls', p) ? line(a, p) : undefined;
      const lq = a.elementIn('walls', q) ? line(a, q) : undefined;
      if (!lp || !lq) out.push(opsDiagnostic('FS-OPS-010', `the distance lock names ${[p, q].filter((w) => !a.elementIn('walls', w)).join(' and ')}, not walls of the document`, els, ptr));
      else if (predicates.cross(lp.d, lq.d) !== 0n) out.push(opsDiagnostic('FS-OPS-010', `the distance lock names ${p} and ${q}, which are not parallel`, els, ptr));
    }
  });
  return out;
}

/** The junctions on the outer cycle of a room's face in a (valid) document. */
function roomCycle(doc: WorkingCopy, room: string): string[] {
  const r = doc.elementIn('rooms', room);
  const level = getMember(r, 'level');
  const anchor = asPoint(getMember(r, 'anchor'));
  if (typeof level !== 'string' || !anchor) return [];
  const faces = new LevelFaces(doc, level);
  const place = faces.place(anchor);
  return place.kind === 'face' ? [...faces.faces[place.face]!.outer.vertices] : [];
}

/** 6.1.2: the locks the result B breaks, compared with A; `aCanon`/`bCanon` are their canonical contents (Core §9.2 step 1). */
export function brokenLocks(a: WorkingCopy, b: WorkingCopy, aCanon: JsonObject, bCanon: JsonObject, locks: readonly Lock[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const unmoved = (j: string): boolean => {
    const pa = asPoint(getMember(a.elementIn('junctions', j), 'position'));
    const pb = asPoint(getMember(b.elementIn('junctions', j), 'position'));
    return pa !== undefined && pb !== undefined && pa[0] === pb[0] && pa[1] === pb[1];
  };
  const canonElement = (doc: JsonObject, c: CollectionName, id: string): unknown => {
    const coll = getMember(doc, c);
    return isObject(coll) && Object.hasOwn(coll, id) ? coll[id] : undefined;
  };
  locks.forEach((l, i) => {
    const ptr = `/context/locks/${i}`;
    const els = lockElements(l);
    let held: boolean;
    let why: string;
    if ('element' in l) {
      const c = a.collectionOf(l.element)!;
      const ea = canonElement(aCanon, c, l.element);
      const eb = canonElement(bCanon, c, l.element);
      held = eb !== undefined && jsonEqual(ea, eb);
      why = held ? '' : eb === undefined ? `${l.element} is gone` : `${l.element} changed`;
      if (held && (c === 'walls' || c === 'separators')) {
        const ends = ['start', 'end'].map((m) => getMember(a.element(l.element), m)).filter((j): j is string => typeof j === 'string');
        held = ends.every(unmoved);
        if (!held) why = `an end of ${l.element} moved`;
      }
      if (held && c === 'rooms') {
        held = roomCycle(a, l.element).every(unmoved);
        if (!held) why = `a corner of ${l.element} moved`;
      }
    } else if ('length' in l) {
      const la = line(a, l.length);
      const lb = b.elementIn('walls', l.length) ? line(b, l.length) : undefined;
      held = la !== undefined && lb !== undefined && len2(la.d) === len2(lb.d);
      why = `the length of ${l.length} changed`;
    } else {
      const [p, q] = l.distance;
      const ap = line(a, p);
      const aq = line(a, q);
      const bp = b.elementIn('walls', p) ? line(b, p) : undefined;
      const bq = b.elementIn('walls', q) ? line(b, q) : undefined;
      if (!ap || !aq || !bp || !bq || predicates.cross(bp.d, bq.d) !== 0n) {
        held = false;
        why = `${p} and ${q} are no longer two parallel walls`;
      } else {
        // distance² = cross(d_p, Q − P)² / |d_p|², compared without division.
        const ca = predicates.cross(ap.d, predicates.sub(aq.S, ap.S));
        const cb = predicates.cross(bp.d, predicates.sub(bq.S, bp.S));
        held = ca * ca * len2(bp.d) === cb * cb * len2(ap.d);
        why = `the distance between ${p} and ${q} changed`;
      }
    }
    if (!held) out.push(opsDiagnostic('FS-OPS-011', `the result breaks the lock on ${els.join(' and ')}: ${why}`, els, ptr));
  });
  return out;
}
