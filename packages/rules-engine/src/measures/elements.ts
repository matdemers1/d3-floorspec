/**
 * Chapter 7: measures of extension elements — members (7.1), the room an element is in (7.2),
 * heights above the floor (7.3), protection (7.4) — and of clearance envelopes — as declared (7.5),
 * obstructions (7.6), clear depth in front (7.7) and overlapping envelopes (7.8).
 */
import { elementDefaults, member, own, recordDefaults, sortIds, type IPoint, type Model } from '../model.js';
import type { Target } from '../types.js';
import { aPositive, anEnum, isInt, MEMBER_NAME, measure, PURPOSES, type Args, type Measure } from './measure.js';
import { areaSign, bigRing, clip, Local, triangulate, type HalfPlane } from './geometry.js';
import { QR } from '../exact.js';

const ELEC = 'FS_electrical';

const fallback = (m: Model, eid: string): { level: string; bottom: number; top: number; footprint: [number, number][] } => own(m.derived.fallbacks, eid)!;

/** 7.1: a member of `type`, read with its default — or no value. */
function elementMember(m: Model, t: Target, a: Args): { value: bigint | boolean | string | string[] | null } {
  const x = m.ext.get(t.id)!;
  const [present, v] = member(x.element, elementDefaults(x.extension, x.collection), a.name as string);
  if (!present) return { value: null };
  switch (a.type) {
    case 'integer':
      return { value: isInt(v) ? BigInt(v) : null };
    case 'term':
      return { value: typeof v === 'string' ? v : null };
    case 'boolean':
      return { value: typeof v === 'boolean' ? v : null };
    default:
      return { value: Array.isArray(v) && v.every((s) => typeof s === 'string') ? sortIds(v) : null };
  }
}

/** 7.6: an obstacle of an envelope — a wall's outline or a fallback's footprint, and its vertical range. */
interface Obstacle {
  readonly id: string;
  readonly ring: readonly IPoint[];
  readonly bottom: bigint;
  readonly top: bigint;
}

/** 7.6: every wall on the level but the owner's host wall, and every other extension element on it. */
function obstacles(m: Model, owner: string, level: string): Obstacle[] {
  const out: Obstacle[] = [];
  const host = m.hostWall(owner);
  const lv = m.level(level);
  for (const wid of sortIds(Object.keys(m.doc.walls ?? {}))) {
    if (m.wallLevel(wid) !== level || wid === host) continue;
    const w = own(m.derived.walls, wid)!;
    out.push({ id: wid, ring: lv.g.outline(wid), bottom: BigInt(w.baseElevation), top: BigInt(w.topElevation) });
  }
  for (const eid of sortIds(m.ext.keys())) {
    const fb = fallback(m, eid);
    if (eid !== owner && fb.level === level) out.push({ id: eid, ring: bigRing(fb.footprint), bottom: BigInt(fb.bottom), top: BigInt(fb.top) });
  }
  return out;
}

interface EnvelopeGeometry {
  readonly x0: bigint;
  readonly x1: bigint;
  readonly y0: bigint;
  readonly y1: bigint;
  readonly bottom: bigint;
  readonly top: bigint;
  readonly level: string;
  readonly local: Local;
}

function envelopeGeometry(m: Model, t: Target): EnvelopeGeometry {
  const name = (t as { envelope: string }).envelope;
  const box = m.envelopeBox(t.id, name);
  const der = m.clearance(t.id, name);
  return {
    x0: BigInt(box.min[0]!),
    x1: BigInt(box.max[0]!),
    y0: BigInt(box.min[1]!),
    y1: BigInt(box.max[1]!),
    bottom: BigInt(der.bottom),
    top: BigInt(der.top),
    level: der.level,
    local: new Local(m.frameOf(t.id)),
  };
}

const overlapsVertically = (o: Obstacle, e: EnvelopeGeometry): boolean => (o.bottom > e.bottom ? o.bottom : e.bottom) < (o.top < e.top ? o.top : e.top);

/** The obstacle's plan polygon as triangles in the envelope's local coordinates. */
const localTriangles = (e: EnvelopeGeometry, o: Obstacle): (readonly [QR, QR])[][] => triangulate(o.ring).map((tri) => tri.map((p) => e.local.of(p)));

function extent(i: 0 | 1 | 2): Measure['compute'] {
  return (m, t) => {
    const box = m.envelopeBox(t.id, (t as { envelope: string }).envelope);
    return { value: BigInt(box.max[i]!) - BigInt(box.min[i]!) };
  };
}

export const ELEMENT_MEASURES: readonly Measure[] = [
  measure({
    name: 'elementMember',
    kinds: ['element'],
    type: null,
    args: {
      name: (v) => typeof v === 'string' && MEMBER_NAME.test(v),
      type: anEnum('integer', 'term', 'terms', 'boolean'),
      unit: anEnum('V', 'A', 'W'),
    },
    required: ['name', 'type'],
    check: (a) => a.unit === undefined || a.type === 'integer',
    // It reads the extension the rule names for its targets (3.9), which typing adds.
    compute: elementMember,
  }),
  measure({
    name: 'elementRoomFunction',
    kinds: ['element'],
    type: 'term',
    compute: (m, t) => {
      const rid = m.roomOf(t.id);
      return { value: rid === undefined ? 'none' : m.roomFunction(rid) };
    },
  }),
  measure({
    name: 'elementBottomAboveFloor',
    kinds: ['element'],
    type: 'length',
    compute: (m, t) => {
      const fb = fallback(m, t.id);
      return { value: BigInt(fb.bottom) - m.floor(fb.level) };
    },
  }),
  measure({
    name: 'elementTopAboveFloor',
    kinds: ['element'],
    type: 'length',
    compute: (m, t) => {
      const fb = fallback(m, t.id);
      return { value: BigInt(fb.top) - m.floor(fb.level) };
    },
  }),
  measure({
    name: 'elementProtectedBy',
    kinds: ['element'],
    type: 'boolean',
    args: { protection: anEnum('gfci', 'afci') },
    required: ['protection'],
    involved: true,
    reads: () => [ELEC],
    compute: (m, t, a) => {
      const x = m.ext.get(t.id)!;
      let mine = false;
      if (x.extension === ELEC) {
        const [present, features] = member(x.element, elementDefaults(x.extension, x.collection), 'features');
        mine = present && Array.isArray(features) && features.includes(a.protection);
      }
      const cdef = recordDefaults(ELEC, 'circuits');
      const by = m
        .circuits()
        .filter(([, c]) => {
          const loads = member(c, cdef, 'loads')[1];
          const prot = member(c, cdef, 'protection')[1];
          return Array.isArray(loads) && loads.includes(t.id) && Array.isArray(prot) && prot.includes(a.protection);
        })
        .map(([cid]) => cid);
      return { value: mine || by.length > 0, involved: by };
    },
  }),

  // ── 7.5 envelopes as declared ──
  measure({
    name: 'envelopePurpose',
    kinds: ['envelope'],
    type: 'term',
    compute: (m, t) => ({ value: m.envelopeBox(t.id, (t as { envelope: string }).envelope).purpose! }),
  }),
  measure({ name: 'envelopeDepth', kinds: ['envelope'], type: 'length', compute: extent(0) }),
  measure({ name: 'envelopeWidth', kinds: ['envelope'], type: 'length', compute: extent(1) }),
  measure({ name: 'envelopeHeight', kinds: ['envelope'], type: 'length', compute: extent(2) }),
  measure({
    name: 'envelopeBottomAboveFloor',
    kinds: ['envelope'],
    type: 'length',
    compute: (m, t) => {
      const der = m.clearance(t.id, (t as { envelope: string }).envelope);
      return { value: BigInt(der.bottom) - m.floor(der.level) };
    },
  }),

  // ── 7.6 obstructions ──
  measure({
    name: 'envelopeObstructions',
    kinds: ['envelope'],
    type: 'count',
    involved: true,
    compute: (m, t) => {
      const e = envelopeGeometry(m, t);
      const keep: HalfPlane[] = [
        [0, e.x0, 1],
        [0, e.x1, -1],
        [1, e.y0, 1],
        [1, e.y1, -1],
      ];
      const found: string[] = [];
      for (const o of obstacles(m, t.id, e.level)) {
        if (!overlapsVertically(o, e)) continue;
        if (localTriangles(e, o).some((tri) => areaSign(clip(tri, keep)) > 0)) found.push(o.id);
      }
      return { value: BigInt(found.length), involved: found };
    },
  }),

  // ── 7.7 clear depth in front ──
  measure({
    name: 'clearDepthInFront',
    kinds: ['envelope'],
    type: 'length',
    args: { limit: aPositive },
    required: ['limit'],
    involved: true,
    compute: (m, t, a) => {
      const limit = BigInt(a.limit as number);
      const e = envelopeGeometry(m, t);
      // The strip in front: p > x0, y0 < q < y1 — clipped closed, kept only with an interior.
      const keep: HalfPlane[] = [
        [0, e.x0, 1],
        [1, e.y0, 1],
        [1, e.y1, -1],
      ];
      const dist = new Map<string, QR>();
      for (const o of obstacles(m, t.id, e.level)) {
        if (!overlapsVertically(o, e)) continue;
        let best: QR | undefined;
        for (const tri of localTriangles(e, o)) {
          const poly = clip(tri, keep);
          if (areaSign(poly) <= 0) continue;
          let lo = poly[0]![0];
          for (const p of poly) if (p[0].cmp(lo) < 0) lo = p[0];
          // The distance from the near face: p − x0.
          const d = lo.sub(QR.int(e.x0));
          if (best === undefined || d.cmp(best) < 0) best = d;
        }
        if (best !== undefined) dist.set(o.id, best);
      }
      if (dist.size === 0) return { value: limit, involved: [] };
      let D: QR | undefined;
      for (const v of dist.values()) if (D === undefined || v.cmp(D) < 0) D = v;
      const exact = D!;
      const r = exact.round();
      if (r >= limit) return { value: limit, involved: [] };
      return { value: r, involved: [...dist].filter(([, v]) => v.cmp(exact) === 0).map(([id]) => id) };
    },
  }),

  // ── 7.8 overlapping envelopes ──
  measure({
    name: 'envelopeOverlaps',
    kinds: ['envelope'],
    type: 'count',
    args: { purpose: anEnum(...PURPOSES) },
    involved: true,
    compute: (m, t, a) => {
      const name = (t as { envelope: string }).envelope;
      let count = 0n;
      const owners = new Set<string>();
      for (const [p, q] of m.derived.clearanceOverlaps ?? []) {
        const mine = p[0] === t.id && p[1] === name ? q : q[0] === t.id && q[1] === name ? p : undefined;
        if (mine === undefined) continue;
        if (a.purpose !== undefined && m.clearance(mine[0], mine[1]).purpose !== a.purpose) continue;
        count++;
        owners.add(mine[0]);
      }
      return { value: count, involved: [...owners] };
    },
  }),
];
