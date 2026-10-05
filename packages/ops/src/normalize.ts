/**
 * Normalization (chapter 5): after the last primitive and before validation, every level is made
 * planar again and what edits made coincide is merged — 5.1, then 5.2, then 5.3 (5.4.1), each
 * over every level, by ID, before the next. It never moves an anchor, never removes a wall or a
 * room, and changes no member but those its steps name.
 *
 * The working copy may be invalid here (validation comes next), so only the well-formed part of a
 * level takes part: junctions with an integer position, and edges whose start and end are such
 * junctions on the edge's own level. Anything else is left for validation to judge.
 */
import { predicates, roundHalfEvenRational, Surd, type Diagnostic } from '@floorspec/engine';
import { opsDiagnostic } from './diagnostics.js';
import { edgesOn, junctionsOn } from './model/faces.js';
import type { WorkingCopy } from './model/working.js';
import { clone, cmpStr, deleteMember, getMember, isObject, setMember, type JsonObject } from './lib/json.js';

type IPoint = readonly [bigint, bigint];
const { collinearOverlap, cross, eq, inSegmentInterior, properCross, sub } = predicates;
const key = (p: IPoint): string => `${p[0]},${p[1]}`;
const cmpPoint = (a: IPoint, b: IPoint): number => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : 0);

/** Normalize the working copy; returns FS-OPS-009 diagnostics when an opening straddles a new junction. */
export function normalize(wc: WorkingCopy): Diagnostic[] {
  const levels = wc.ids('levels');
  for (const l of levels) mergeCoincident(wc, l);
  const straddles: Diagnostic[] = [];
  // 5.2 runs only on a level that, after 5.1, breaks Core §5.3: a level with no crossing, no
  // junction inside an edge and no overlap is left exactly as it is (near misses included).
  for (const l of levels) if (!isPlanar(wc, l)) straddles.push(...planarize(wc, l));
  if (straddles.length) return straddles;
  cleanJoins(wc);
  return [];
}

// ── 5.1 merge coincident junctions ────────────────────────────────────────────

export function mergeCoincident(wc: WorkingCopy, level: string): void {
  const groups = new Map<string, string[]>();
  for (const j of junctionsOn(wc, level)) if (j.pos) groups.set(key(j.pos), [...(groups.get(key(j.pos)) ?? []), j.id]);
  const redirect = new Map<string, string>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const fromA = ids.filter((id) => wc.junctionsInA.has(id));
    const survivor = fromA.length === 1 ? fromA[0]! : [...ids].sort(cmpStr)[0]!;
    for (const id of ids) if (id !== survivor) redirect.set(id, survivor);
  }
  if (redirect.size === 0) return;
  for (const kind of ['walls', 'separators'] as const)
    for (const id of wc.ids(kind)) {
      const e = wc.elementIn(kind, id)!;
      for (const m of ['start', 'end']) {
        const v = getMember(e, m);
        if (typeof v === 'string' && redirect.has(v)) setMember(e, m, redirect.get(v));
      }
    }
  const junctions = wc.collection('junctions')!;
  for (const id of redirect.keys()) deleteMember(junctions, id);
  wc.touch();
}

// ── 5.2 planarize by snap rounding ────────────────────────────────────────────

interface Bound {
  n: bigint;
  d: bigint; // > 0
  open: boolean;
}
const cmpQ = (a: Bound, b: Bound): number => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};

/**
 * The interval of t ∈ [0, 1] for which A + t(B − A) lies in the pixel of c — the points that round
 * to c, ties to even: closed around an even coordinate, open around an odd one — or undefined.
 */
function pixelInterval(A: IPoint, B: IPoint, c: IPoint): { lo: Bound; hi: Bound } | undefined {
  let lo: Bound = { n: 0n, d: 1n, open: false };
  let hi: Bound = { n: 1n, d: 1n, open: false };
  for (const axis of [0, 1] as const) {
    const a = 2n * A[axis];
    const delta = 2n * (B[axis] - A[axis]);
    const open = c[axis] % 2n !== 0n;
    const pLo = 2n * c[axis] - 1n;
    const pHi = 2n * c[axis] + 1n;
    if (delta === 0n) {
      if (!(open ? a > pLo && a < pHi : a >= pLo && a <= pHi)) return undefined;
      continue;
    }
    let t1: Bound = { n: pLo - a, d: delta, open };
    let t2: Bound = { n: pHi - a, d: delta, open };
    if (delta < 0n) {
      t1 = { n: -t1.n, d: -t1.d, open };
      t2 = { n: -t2.n, d: -t2.d, open };
      [t1, t2] = [t2, t1];
    }
    const c1 = cmpQ(t1, lo);
    if (c1 > 0 || (c1 === 0 && t1.open)) lo = t1;
    const c2 = cmpQ(t2, hi);
    if (c2 < 0 || (c2 === 0 && t2.open)) hi = t2;
  }
  const order = cmpQ(lo, hi);
  if (order > 0 || (order === 0 && (lo.open || hi.open))) return undefined;
  return { lo, hi };
}

/** The intersection of two properly crossing segments, each coordinate rounded ties to even. */
function roundedCrossing(a: IPoint, b: IPoint, c: IPoint, d: IPoint): IPoint {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  const t = cross(sub(c, a), s);
  return [roundHalfEvenRational(a[0] * den + r[0] * t, den), roundHalfEvenRational(a[1] * den + r[1] * t, den)];
}

interface Seg {
  id: string;
  kind: 'walls' | 'separators';
  a: IPoint;
  b: IPoint;
}

/** The well-formed part of a level (chapter 5): junctions with integer positions, and the edges between them. */
function wellFormed(wc: WorkingCopy, level: string): { atPos: Map<string, string>; positions: IPoint[]; segs: Seg[] } {
  const atPos = new Map<string, string>();
  const pos = new Map<string, IPoint>();
  for (const j of junctionsOn(wc, level))
    if (j.pos) {
      pos.set(j.id, j.pos);
      if (!atPos.has(key(j.pos))) atPos.set(key(j.pos), j.id);
    }
  const segs: Seg[] = [];
  for (const e of edgesOn(wc, level)) {
    const a = pos.get(e.start);
    const b = pos.get(e.end);
    if (!a || !b || eq(a, b)) continue;
    segs.push({ id: e.id, kind: e.kind, a, b });
  }
  return { atPos, positions: [...pos.values()], segs };
}

/** Does the well-formed part of a level satisfy Core §5.3 — no crossing, no junction inside an edge, no overlap? */
function isPlanar(wc: WorkingCopy, level: string): boolean {
  const { positions, segs } = wellFormed(wc, level);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (positions.some((p) => inSegmentInterior(p, s.a, s.b))) return false;
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j]!;
      if (properCross(s.a, s.b, t.a, t.b) || collinearOverlap(s.a, s.b, t.a, t.b)) return false;
    }
  }
  return true;
}

/** 5.2 on one level. Returns FS-OPS-009 for every opening that straddles an inserted junction. */
function planarize(wc: WorkingCopy, level: string): Diagnostic[] {
  const { atPos, segs } = wellFormed(wc, level);

  // 1. Hot pixels: junction positions, and the rounded points where two edges meet at a point
  //    interior to at least one of them. An end of one edge inside another is a junction position
  //    already; so the only new ones are proper crossings.
  const hot = new Map<string, IPoint>();
  for (const k of atPos.keys()) {
    const [x, y] = k.split(',');
    hot.set(k, [BigInt(x!), BigInt(y!)]);
  }
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (properCross(s.a, s.b, t.a, t.b)) {
        const p = roundedCrossing(s.a, s.b, t.a, t.b);
        hot.set(key(p), p);
      }
    }
  const pixels = [...hot.values()];

  // 2. Routing: each edge through the centre of every hot pixel it passes through, in order.
  const routes = new Map<string, IPoint[]>();
  for (const s of segs) {
    const minX = s.a[0] < s.b[0] ? s.a[0] : s.b[0];
    const maxX = s.a[0] < s.b[0] ? s.b[0] : s.a[0];
    const minY = s.a[1] < s.b[1] ? s.a[1] : s.b[1];
    const maxY = s.a[1] < s.b[1] ? s.b[1] : s.a[1];
    const hits: { c: IPoint; lo: Bound }[] = [];
    for (const c of pixels) {
      if (c[0] < minX - 1n || c[0] > maxX + 1n || c[1] < minY - 1n || c[1] > maxY + 1n) continue;
      const iv = pixelInterval(s.a, s.b, c);
      if (iv) hits.push({ c, lo: iv.lo });
    }
    hits.sort((x, y) => cmpQ(x.lo, y.lo));
    routes.set(s.id, hits.map((h) => h.c));
  }

  // 3. Junctions at hot pixels that have none, minted in order of x, then y.
  const fresh = pixels.filter((p) => !atPos.has(key(p))).sort(cmpPoint);
  for (const p of fresh) {
    const id = wc.mint('junctions');
    setMember(wc.ensureCollection('junctions'), id, { level, position: [Number(p[0]), Number(p[1])] });
    atPos.set(key(p), id);
  }
  if (fresh.length) wc.touch();

  // 4. Splitting, and 5. re-hosting openings on split walls.
  const diagnostics: Diagnostic[] = [];
  for (const kind of ['walls', 'separators'] as const)
    for (const s of segs.filter((x) => x.kind === kind)) {
      const route = routes.get(s.id)!;
      if (route.length <= 2) continue;
      const coll = wc.collection(kind)!;
      const original = coll[s.id] as JsonObject;
      const ids = [s.id];
      for (let i = 1; i < route.length - 1; i++) ids.push(wc.mint(kind));
      const startId = getMember(original, 'start');
      const endId = getMember(original, 'end');
      for (let i = 0; i < ids.length; i++) {
        const start = i === 0 ? startId : atPos.get(key(route[i]!))!;
        const end = i === ids.length - 1 ? endId : atPos.get(key(route[i + 1]!))!;
        if (i === 0) setMember(original, 'end', end);
        else {
          const piece: JsonObject = {};
          for (const k of Object.keys(original)) if (k !== 'start' && k !== 'end') setMember(piece, k, clone(original[k]));
          setMember(piece, 'start', start);
          setMember(piece, 'end', end);
          setMember(coll, ids[i]!, piece);
        }
      }
      wc.touch();
      if (kind === 'walls') {
        diagnostics.push(...rehost(wc, s, route, ids));
        rehostHosted(wc, s, route, ids);
      }
    }
  return diagnostics;
}

/** The effective width of an opening (Core §7.2), when it resolves to an integer. */
function openingWidth(wc: WorkingCopy, o: JsonObject): bigint | undefined {
  const own = getMember(o, 'width');
  if (typeof own === 'number' && Number.isSafeInteger(own)) return BigInt(own);
  const fill = getMember(o, 'fill');
  const t = typeof fill === 'string' ? wc.elementIn('types', fill) : undefined;
  const w = getMember(t, 'width');
  const kind = getMember(t, 'kind');
  return (kind === 'doorType' || kind === 'windowType') && typeof w === 'number' && Number.isSafeInteger(w) ? BigInt(w) : undefined;
}

/**
 * 5.2 step 5: each opening of a split wall moves to the piece whose interval along the original
 * location line contains its whole interval [offset, offset + width]; its offset becomes its
 * distance from that piece's start along that line, exact and rounded once.
 */
function rehost(wc: WorkingCopy, s: Seg, route: IPoint[], ids: string[]): Diagnostic[] {
  const d = sub(s.b, s.a);
  const m = d[0] * d[0] + d[1] * d[1];
  const rootM = Surd.sqrt(m);
  // The distance along the original line from its start to the projection of each route point:
  // ((c − S)·d) / |d| = ((c − S)·d)·√m / m.
  const t = route.map((c) => rootM.mulInt(predicates.dot(sub(c, s.a), d)).divInt(m));
  const out: Diagnostic[] = [];
  for (const oid of wc.ids('openings')) {
    const o = wc.elementIn('openings', oid);
    if (!o || getMember(o, 'wall') !== s.id) continue;
    const off = getMember(o, 'offset');
    if (typeof off !== 'number' || !Number.isSafeInteger(off)) continue;
    const lo = Surd.of(BigInt(off));
    const hi = lo.addInt(openingWidth(wc, o) ?? 0n);
    let placed = false;
    for (let i = 0; i + 1 < route.length; i++) {
      if (lo.cmp(t[i]!) >= 0 && hi.cmp(t[i + 1]!) <= 0) {
        setMember(o, 'wall', ids[i]!);
        setMember(o, 'offset', Number(lo.sub(t[i]!).round()));
        placed = true;
        break;
      }
    }
    if (!placed) out.push(opsDiagnostic('FS-OPS-009', `opening ${oid} straddles a junction that planarization inserts in ${s.id}`, [oid]));
  }
  wc.touch();
  return out;
}

/**
 * 5.2 step 6 (Ops 0.2): an extension element on a face of a split wall, with an integer offset,
 * moves to the piece whose interval [s, e) along the original location line contains its offset —
 * the last piece's interval includes its end — and its offset becomes offset − s, exact and
 * rounded once. Its side and height do not change. One that no piece contains stays on the first
 * piece, unchanged, for validation to judge.
 */
function rehostHosted(wc: WorkingCopy, s: Seg, route: IPoint[], ids: string[]): void {
  const d = sub(s.b, s.a);
  const m = d[0] * d[0] + d[1] * d[1];
  const rootM = Surd.sqrt(m);
  const t = route.map((c) => rootM.mulInt(predicates.dot(sub(c, s.a), d)).divInt(m));
  const last = ids.length - 1;
  let changed = false;
  for (const x of wc.extElements()) {
    const h = getMember(x.element, 'host');
    if (!isObject(h) || getMember(h, 'mode') !== 'wallFace' || getMember(h, 'wall') !== s.id) continue;
    const off = getMember(h, 'offset');
    if (typeof off !== 'number' || !Number.isSafeInteger(off)) continue;
    const o = Surd.of(BigInt(off));
    for (let i = 0; i <= last; i++) {
      if (o.cmp(t[i]!) >= 0 && (o.cmp(t[i + 1]!) < 0 || (i === last && o.cmp(t[i + 1]!) <= 0))) {
        if (i > 0) {
          setMember(h, 'wall', ids[i]!);
          setMember(h, 'offset', Number(o.sub(t[i]!).round()));
          changed = true;
        }
        break;
      }
    }
  }
  if (changed) wc.touch();
}

// ── 5.3 join cleanup ──────────────────────────────────────────────────────────

export function cleanJoins(wc: WorkingCopy): void {
  for (const j of wc.ids('junctions')) {
    const e = wc.elementIn('junctions', j);
    const join = getMember(e, 'join');
    const through = getMember(join, 'through');
    if (!e || !isObject(join) || !Array.isArray(through)) continue;
    const stale = through.some((w) => {
      if (typeof w !== 'string') return false;
      const wall = wc.elementIn('walls', w);
      return !wall || (getMember(wall, 'start') !== j && getMember(wall, 'end') !== j);
    });
    if (stale) {
      deleteMember(e, 'join');
      wc.touch();
    }
  }
}

