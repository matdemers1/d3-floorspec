/**
 * Tier 4 of chapter 10: the invariants no schema can express, evaluated in the order of 10.3 —
 * reference invariants first (and nothing else if any is reported); graph invariants for every level
 * and wall; join and room invariants only on levels with no graph invariant but FS-INV-112; opening
 * and type invariants for every opening and every door or window type, FS-INV-303 not for an
 * opening whose wall has FS-INV-112, and FS-INV-302 to FS-INV-305 only without FS-INV-301.
 *
 * The document has passed the schema tier, so its shape is known.
 */
import { area2, collinearOverlap, cross, dot, eq, inSegmentInterior, isSimple, locate, properCross, type IPoint } from '../geometry/predicates.js';
import { LevelGeometry, type LevelEdge, type LevelJunction } from '../derive/level.js';
import { isqrt } from '../exact/bigint.js';
import {
  COLLECTIONS,
  adjacencies,
  effectiveClearOpening,
  effectiveLayers,
  entries,
  extElements,
  faceOffsets,
  get,
  ipoint,
  openingDimensions,
  programItems,
  wallElevations,
  type ClearOpening,
  type FaceOffsets,
  type FloorspecDocument,
  type Layer,
  type RegistryEntry,
} from '../model/document.js';
import { entry } from './catalogue.js';
import type { Diagnostic, DiagnosticLocation, FixOp } from './diagnostic.js';
import { extensionInvariants, hostingInvariants, programInvariants, surfaceInvariants } from './invariants02.js';
import { floorInvariants, roomRings } from '../slabs/floors.js';
import { roofInvariants } from '../roofs/roofs.js';

export class Reporter {
  readonly diagnostics: Diagnostic[] = [];
  report(code: string, message: string, elements: string[], location: DiagnosticLocation = {}, fix?: FixOp[]): void {
    this.diagnostics.push({ code, severity: entry(code).severity, message, elements: [...elements].sort(), location, ...(fix && { fix }) });
  }
  has(code: string, element?: string): boolean {
    return this.diagnostics.some((d) => d.code === code && (element === undefined || d.elements.includes(element)));
  }
}

export const ptr = (collection: string, id: string, ...rest: (string | number)[]): string =>
  '/' + [collection, id, ...rest.map(String)].map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

/** What the invariant tier learned about each level, for derivation and lints. */
export interface LevelAnalysis {
  readonly id: string;
  /** Graph invariants other than FS-INV-112 were reported here: no geometry. */
  readonly broken: boolean;
  readonly geometry?: LevelGeometry;
  /** Room ID → the index of its face in geometry.faces, for rooms whose anchor is in a bounded face. */
  readonly roomFaces: Map<string, number>;
}

export interface Analysis {
  readonly levels: Map<string, LevelAnalysis>;
  readonly offsets: Map<string, FaceOffsets>;
  /** The reader implements Core 0.2: its lints and derived values include chapters 11–13. */
  readonly core02: boolean;
  /** The reader implements Core 0.3: its derived values include floors, ceilings and slabs (chapter 15), for a document of any draft. */
  readonly core03: boolean;
}

// ── reference invariants (FS-INV-001 … 009) ──────────────────────────────────

function referenceInvariants(doc: FloorspecDocument, r: Reporter): void {
  // 001: an ID in more than one collection.
  // Program items and every extension collection count as collections (3.1.3).
  const where = new Map<string, { name: string; pointer: string }[]>();
  const own = (id: string, name: string, pointer: string): void => {
    where.set(id, [...(where.get(id) ?? []), { name, pointer }]);
  };
  for (const c of COLLECTIONS) for (const [id] of entries(doc[c] as Record<string, unknown> | undefined)) own(id, c, ptr(c, id));
  for (const [id] of programItems(doc)) own(id, 'program items', ptr('program', 'items', id));
  for (const x of extElements(doc)) own(x.id, `${x.extension} ${x.collection}`, ptr('extensions', x.extension, 'collections', x.collection, x.id));
  for (const [id, cs] of [...where].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    if (cs.length > 1)
      r.report('FS-INV-001', `The ID ${id} is used in more than one collection (${cs.map((c) => c.name).join(', ')}).`, [id], { pointer: cs[1]!.pointer });

  const resolves = (collection: (typeof COLLECTIONS)[number], id: string): boolean => get(doc[collection] as Record<string, unknown> | undefined, id) !== undefined;
  const ref = (owner: string, pointer: string, collection: (typeof COLLECTIONS)[number], id: string | undefined, kinds?: string[]): void => {
    if (id === undefined) return;
    if (!resolves(collection, id)) {
      r.report('FS-INV-002', `${owner} refers to ${id}, which is not in \`${collection}\`.`, [owner], { pointer });
      return;
    }
    if (kinds) {
      const t = get(doc.types, id)!;
      if (!kinds.includes(t.kind)) r.report('FS-INV-003', `${owner} refers to ${id}, a ${t.kind}, where a ${kinds.join(' or ')} is required.`, [owner], { pointer });
    }
  };
  const layerRefs = (owner: string, base: string, layers: readonly Layer[] | undefined): void =>
    layers?.forEach((l, i) => {
      ref(owner, `${base}/layers/${i}/material`, 'materials', l.material);
    });

  for (const [id, l] of entries(doc.levels)) ref(id, ptr('levels', id, 'building'), 'buildings', l.building);
  for (const [id, j] of entries(doc.junctions)) {
    ref(id, ptr('junctions', id, 'level'), 'levels', j.level);
    if (j.join?.kind === 'butt')
      j.join.through.forEach((w, i) => {
        ref(id, ptr('junctions', id, 'join', 'through', i), 'walls', w);
      });
  }
  for (const [id, w] of entries(doc.walls)) {
    ref(id, ptr('walls', id, 'level'), 'levels', w.level);
    ref(id, ptr('walls', id, 'start'), 'junctions', w.start);
    ref(id, ptr('walls', id, 'end'), 'junctions', w.end);
    ref(id, ptr('walls', id, 'type'), 'types', w.type, ['wallType']);
    layerRefs(id, ptr('walls', id), w.layers);
    ref(id, ptr('walls', id, 'base', 'level'), 'levels', w.base?.level);
    if (w.top && 'level' in w.top) ref(id, ptr('walls', id, 'top', 'level'), 'levels', w.top.level);
  }
  for (const [id, s] of entries(doc.separators)) {
    ref(id, ptr('separators', id, 'level'), 'levels', s.level);
    ref(id, ptr('separators', id, 'start'), 'junctions', s.start);
    ref(id, ptr('separators', id, 'end'), 'junctions', s.end);
  }
  for (const [id, o] of entries(doc.openings)) {
    ref(id, ptr('openings', id, 'wall'), 'walls', o.wall);
    ref(id, ptr('openings', id, 'fill'), 'types', o.fill, ['doorType', 'windowType']);
  }
  for (const [id, rm] of entries(doc.rooms)) {
    ref(id, ptr('rooms', id, 'level'), 'levels', rm.level);
    ref(id, ptr('rooms', id, 'wallFinish'), 'materials', rm.wallFinish);
    ref(id, ptr('rooms', id, 'floorFinish'), 'materials', rm.floorFinish);
    ref(id, ptr('rooms', id, 'ceilingFinish'), 'materials', rm.ceilingFinish);
  }
  for (const [id, s] of entries(doc.slabs)) {
    ref(id, ptr('slabs', id, 'level'), 'levels', s.level);
    ref(id, ptr('slabs', id, 'material'), 'materials', s.material);
  }
  // Core 0.3: roofs (16.1) and stairs (17.1).
  for (const [id, rf] of entries(doc.roofs)) {
    ref(id, ptr('roofs', id, 'level'), 'levels', rf.level);
    ref(id, ptr('roofs', id, 'material'), 'materials', rf.material);
  }
  for (const [id, t] of entries(doc.types)) if (t.kind === 'wallType') layerRefs(id, ptr('types', id), t.layers);
  for (const [id, m] of entries(doc.materials)) if (m.texture) ref(id, ptr('materials', id, 'texture', 'asset'), 'assets', m.texture.asset);

  // Core 0.2 (3.2): room briefs, the program, and the hosts and fallbacks of extension elements.
  const items = doc.program?.items;
  const refItem = (owner: string[], pointer: string, id: string): void => {
    if (get(items, id) === undefined) r.report('FS-INV-002', `${owner[0] ?? 'An adjacency'} refers to ${id}, which is not a program item.`, owner, { pointer });
  };
  for (const [id, rm] of entries(doc.rooms)) if (rm.brief !== undefined) refItem([id], ptr('rooms', id, 'brief'), rm.brief);
  for (const [id, it] of programItems(doc)) ref(id, ptr('program', 'items', id, 'level'), 'levels', it.level);
  adjacencies(doc).forEach((a, i) => {
    refItem([], `/program/adjacency/${i}/a`, a.a);
    refItem([], `/program/adjacency/${i}/b`, a.b);
  });
  for (const x of extElements(doc)) {
    const base = ptr('extensions', x.extension, 'collections', x.collection, x.id);
    const h = x.element.host;
    if (h?.mode === 'wallFace') ref(x.id, `${base}/host/wall`, 'walls', h.wall);
    if (h?.mode === 'surface') ref(x.id, `${base}/host/room`, 'rooms', h.room);
    if (h?.mode === 'free') ref(x.id, `${base}/host/level`, 'levels', h.level);
    const fb = x.element.fallback;
    ref(x.id, `${base}/fallback/level`, 'levels', fb.level);
    ref(x.id, `${base}/fallback/asset`, 'assets', fb.asset);
    ref(x.id, `${base}/fallback/symbol`, 'assets', fb.symbol);
  }

  // 004, 005, 006: extensions declared in extensionsUsed.
  const used = doc.extensionsUsed ?? {};
  const isUsed = (name: string): boolean => Object.hasOwn(used, name);
  (doc.extensionsRequired ?? []).forEach((name, i) => {
    if (!isUsed(name)) r.report('FS-INV-004', `extensionsRequired names ${name}, which is not in extensionsUsed.`, [], { pointer: `/extensionsRequired/${i}` });
  });
  for (const name of Object.keys(doc.extensions ?? {}).sort())
    if (!isUsed(name)) r.report('FS-INV-005', `The document has data for the extension ${name}, which is not in extensionsUsed.`, [], { pointer: `/extensions/${name}` });
  for (const c of COLLECTIONS)
    for (const [id, el] of entries(doc[c] as Record<string, { extensions?: Record<string, unknown> }> | undefined))
      for (const name of Object.keys(el.extensions ?? {}).sort())
        if (!isUsed(name)) r.report('FS-INV-005', `${id} has data for the extension ${name}, which is not in extensionsUsed.`, [id], { pointer: ptr(c, id, 'extensions', name) });
  for (const [id, it] of programItems(doc))
    for (const name of Object.keys(it.extensions ?? {}).sort())
      if (!isUsed(name)) r.report('FS-INV-005', `${id} has data for the extension ${name}, which is not in extensionsUsed.`, [id], { pointer: ptr('program', 'items', id, 'extensions', name) });
  const functionOwners: [string, string | undefined, string][] = [
    ...entries(doc.rooms).map(([id, rm]): [string, string | undefined, string] => [id, rm.function, ptr('rooms', id, 'function')]),
    ...programItems(doc).map(([id, it]): [string, string | undefined, string] => [id, it.function, ptr('program', 'items', id, 'function')]),
  ];
  for (const [id, f, pointer] of functionOwners)
    if (f?.includes(':') && !isUsed(f.slice(0, f.indexOf(':'))))
      r.report('FS-INV-006', `${id}'s function ${f} names an extension that is not in extensionsUsed.`, [id], { pointer });

  // 007: an edge's junction on another level.
  const edgeLevels = (c: 'walls' | 'separators'): void => {
    for (const [id, e] of entries(doc[c])) {
      for (const jid of [...new Set([e.start, e.end])]) {
        const j = get(doc.junctions, jid);
        if (j && j.level !== e.level) r.report('FS-INV-007', `${id} is on ${e.level}, but its junction ${jid} is on ${j.level}.`, [id, jid], { pointer: ptr(c, id) });
      }
    }
  };
  edgeLevels('walls');
  edgeLevels('separators');

  // 008: a wall's base or top level in another building.
  for (const [id, w] of entries(doc.walls)) {
    const own = get(doc.levels, w.level);
    if (!own) continue;
    const others = [w.base?.level, w.top && 'level' in w.top ? w.top.level : undefined].filter((x): x is string => x !== undefined);
    for (const lid of [...new Set(others)]) {
      const L = get(doc.levels, lid);
      if (L && L.building !== own.building)
        r.report('FS-INV-008', `${id} is on ${w.level} in ${own.building}, but its base or top level ${lid} is in ${L.building}.`, [id, lid], { pointer: ptr('walls', id) });
    }
  }

  // 009: authored polygons simple, with area.
  const polygonOk = (poly: readonly (readonly [number, number])[]): boolean => {
    const pts = poly.map(ipoint);
    return isSimple(pts) && area2(pts) !== 0n;
  };
  if (doc.site?.boundary && !polygonOk(doc.site.boundary))
    r.report('FS-INV-009', 'The site boundary is not a simple polygon with positive area.', [], { pointer: '/site/boundary' });
  for (const [id, s] of entries(doc.slabs))
    if (!polygonOk(s.boundary)) r.report('FS-INV-009', `${id}'s boundary is not a simple polygon with positive area.`, [id], { pointer: ptr('slabs', id, 'boundary') });
  for (const [id, rf] of entries(doc.roofs))
    if (!polygonOk(rf.footprint)) r.report('FS-INV-009', `${id}'s footprint is not a simple polygon with positive area.`, [id], { pointer: ptr('roofs', id, 'footprint') });
}

// ── graph invariants (FS-INV-101 … 108, 111, 112) ────────────────────────────

interface LevelEdgeRef {
  id: string;
  kind: 'wall' | 'separator';
  start: string;
  end: string;
}

function graphInvariants(doc: FloorspecDocument, r: Reporter, levelOf: Map<string, string[]>, offsets: Map<string, FaceOffsets>): void {
  const flag = (level: string, code: string): void => {
    levelOf.set(level, [...(levelOf.get(level) ?? []), code]);
  };
  const levels = entries(doc.levels).map(([id]) => id);
  for (const lid of levels) {
    const junctions = entries(doc.junctions).filter(([, j]) => j.level === lid);
    const pos = new Map(junctions.map(([id, j]) => [id, ipoint(j.position)]));
    const edges: LevelEdgeRef[] = [
      ...entries(doc.walls).filter(([, w]) => w.level === lid).map(([id, w]) => ({ id, kind: 'wall' as const, start: w.start, end: w.end })),
      ...entries(doc.separators).filter(([, s]) => s.level === lid).map(([id, s]) => ({ id, kind: 'separator' as const, start: s.start, end: s.end })),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const lpos = { level: lid };

    // 101
    for (let i = 0; i < junctions.length; i++)
      for (let k = i + 1; k < junctions.length; k++) {
        const [a] = junctions[i]!;
        const [b] = junctions[k]!;
        if (eq(pos.get(a)!, pos.get(b)!)) {
          r.report('FS-INV-101', `Junctions ${a} and ${b} on ${lid} have the same position.`, [a, b], { ...lpos, pointer: ptr('junctions', b, 'position') });
          flag(lid, 'FS-INV-101');
        }
      }
    // 102
    for (const e of edges)
      if (e.start === e.end) {
        r.report('FS-INV-102', `${e.id} starts and ends at the same junction, ${e.start}.`, [e.id], { ...lpos, pointer: ptr(e.kind === 'wall' ? 'walls' : 'separators', e.id) });
        flag(lid, 'FS-INV-102');
      }
    const seg = (e: LevelEdgeRef): [IPoint, IPoint] => [pos.get(e.start)!, pos.get(e.end)!];
    const samePair = (e: LevelEdgeRef, f: LevelEdgeRef): boolean =>
      e.start !== e.end && ((e.start === f.start && e.end === f.end) || (e.start === f.end && e.end === f.start));
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]!;
      const [a, b] = seg(e);
      for (let k = i + 1; k < edges.length; k++) {
        const f = edges[k]!;
        const [c, d] = seg(f);
        if (samePair(e, f)) {
          r.report('FS-INV-103', `${e.id} and ${f.id} connect the same two junctions.`, [e.id, f.id], lpos);
          flag(lid, 'FS-INV-103');
          continue;
        }
        if (properCross(a, b, c, d)) {
          r.report('FS-INV-104', `${e.id} and ${f.id} cross.`, [e.id, f.id], lpos);
          flag(lid, 'FS-INV-104');
        } else if (collinearOverlap(a, b, c, d)) {
          r.report('FS-INV-106', `${e.id} and ${f.id} overlap along a segment.`, [e.id, f.id], lpos);
          flag(lid, 'FS-INV-106');
        }
      }
    }
    // 105
    for (const [jid] of junctions) {
      const p = pos.get(jid)!;
      for (const e of edges) {
        if (e.start === jid || e.end === jid) continue;
        const [a, b] = seg(e);
        if (inSegmentInterior(p, a, b)) {
          r.report('FS-INV-105', `Junction ${jid} lies inside ${e.id}.`, [jid, e.id], { ...lpos, point: [Number(p[0]), Number(p[1])] });
          flag(lid, 'FS-INV-105');
        }
      }
    }
    // 107, 108, 112
    for (const e of edges) {
      if (e.kind !== 'wall') continue;
      const w = get(doc.walls, e.id)!;
      const layers = effectiveLayers(doc, w);
      if (!layers) {
        r.report('FS-INV-107', `${e.id} has no effective layers: neither \`layers\` nor a \`type\`.`, [e.id], { ...lpos, pointer: ptr('walls', e.id) });
        flag(lid, 'FS-INV-107');
      } else {
        const off = faceOffsets(w, layers);
        if (!off) {
          r.report('FS-INV-108', `${e.id} is justified coreFace, but its layers have no core layer or their core layers are not consecutive.`, [e.id], { ...lpos, pointer: ptr('walls', e.id, 'justification') }, [
            { op: 'set', id: e.id, member: '/justification', value: 'center' },
          ]);
          flag(lid, 'FS-INV-108');
        } else offsets.set(e.id, off);
      }
      const el = wallElevations(doc, w)!;
      if (el.top <= el.base) {
        r.report('FS-INV-112', `${e.id}'s top (${el.top}) is not above its base (${el.base}).`, [e.id], { ...lpos, pointer: ptr('walls', e.id) });
        flag(lid, 'FS-INV-112');
      }
    }
    // 111
    for (const [jid, j] of junctions) {
      if (j.join?.kind !== 'butt') continue;
      // 10.3: not evaluated for a junction with a wall that has FS-INV-107 or FS-INV-108.
      if (edges.some((e) => e.kind === 'wall' && (e.start === jid || e.end === jid) && !offsets.has(e.id))) continue;
      if (!joinApplies(jid, j.join.through, edges, pos, offsets)) {
        r.report('FS-INV-111', `The butt join at ${jid} does not apply to its junction.`, [jid], { ...lpos, pointer: ptr('junctions', jid, 'join') }, [
          { op: 'unset', id: jid, member: '/join' },
        ]);
        flag(lid, 'FS-INV-111');
      }
    }
  }
}

/** 5.8.1–5.8.3: does a butt join's `through` apply at its junction? */
function joinApplies(
  jid: string,
  through: readonly string[],
  levelEdges: LevelEdgeRef[],
  pos: Map<string, IPoint>,
  offsets: Map<string, FaceOffsets>,
): boolean {
  const at = levelEdges.filter((e) => e.start === jid || e.end === jid);
  // 5.8.1: every wall named is one of the junction's edges (references already resolve to walls).
  if (!through.every((w) => at.some((e) => e.id === w && e.kind === 'wall'))) return false;
  const J = pos.get(jid)!;
  const out = (e: LevelEdgeRef): IPoint => {
    const other = pos.get(e.start === jid ? e.end : e.start)!;
    return [other[0] - J[0], other[1] - J[1]];
  };
  if (through.length === 1) {
    // 5.8.2: exactly two edges, not collinear.
    if (at.length !== 2) return false;
    return cross(out(at[0]!), out(at[1]!)) !== 0n;
  }
  // 5.8.3: two distinct walls leaving in exactly opposite directions, with coincident face lines, and
  // at most one other edge on each side of the line they form.
  const [w1, w2] = through as [string, string];
  if (w1 === w2) return false;
  const e1 = at.find((e) => e.id === w1)!;
  const e2 = at.find((e) => e.id === w2)!;
  const d1 = out(e1);
  const d2 = out(e2);
  if (cross(d1, d2) !== 0n || dot(d1, d2) >= 0n) return false;
  const o1 = offsets.get(w1);
  const o2 = offsets.get(w2);
  if (!o1 || !o2) return false;
  // Outgoing offsets (λ, ρ): (a, b) leaving from the start, (b, a) from the end.
  const lr = (e: LevelEdgeRef, o: FaceOffsets): [bigint, bigint] => (e.start === jid ? [o.a2, o.b2] : [o.b2, o.a2]);
  const [l1, r1] = lr(e1, o1);
  const [l2, r2] = lr(e2, o2);
  if (l1 !== r2 || r1 !== l2) return false;
  let left = 0;
  let right = 0;
  for (const e of at) {
    if (e === e1 || e === e2) continue;
    const c = cross(d1, out(e));
    if (c > 0n) left++;
    else if (c < 0n) right++;
  }
  return left <= 1 && right <= 1;
}

// ── join and room invariants (FS-INV-109, 110, 201 … 204) ────────────────────

export function buildLevelGeometry(doc: FloorspecDocument, lid: string, offsets: Map<string, FaceOffsets>): LevelGeometry {
  const junctions: LevelJunction[] = entries(doc.junctions)
    .filter(([, j]) => j.level === lid)
    .map(([id, j]) => ({ id, pos: ipoint(j.position), join: j.join }));
  const edges: LevelEdge[] = [
    ...entries(doc.walls)
      .filter(([, w]) => w.level === lid)
      .map(([id, w]) => {
        const o = offsets.get(id)!;
        return { id, kind: 'wall' as const, start: w.start, end: w.end, a2: o.a2, b2: o.b2 };
      }),
    ...entries(doc.separators)
      .filter(([, s]) => s.level === lid)
      .map(([id, s]) => ({ id, kind: 'separator' as const, start: s.start, end: s.end, a2: 0n, b2: 0n })),
  ];
  return new LevelGeometry(junctions, edges);
}

function levelInvariants(doc: FloorspecDocument, r: Reporter, lid: string, g: LevelGeometry): Map<string, number> {
  const lpos = { level: lid };
  for (const [id, w] of entries(doc.walls))
    if (w.level === lid && !g.outlineOk(id))
      r.report('FS-INV-109', `${id}'s outline is not a simple counter-clockwise polygon with positive area: it is too short for the joins at its ends.`, [id], {
        ...lpos,
        pointer: ptr('walls', id),
      });
  for (const [id, j] of entries(doc.junctions)) {
    if (j.level !== lid) continue;
    const f = g.fill(id);
    if (f && !f.ok) r.report('FS-INV-110', `The junction fill at ${id} is not simple or is clockwise.`, [id], { ...lpos, pointer: ptr('junctions', id) });
  }

  // Rooms.
  const rooms = entries(doc.rooms).filter(([, rm]) => rm.level === lid);
  const roomFaces = new Map<string, number>();
  const byFace = new Map<number, string[]>();
  for (const [id, rm] of rooms) {
    const loc = g.locateAnchor(ipoint(rm.anchor));
    if (loc.kind !== 'face') {
      r.report('FS-INV-201', `${id}'s anchor is ${loc.kind === 'onEdge' ? 'on a location line' : 'in the unbounded face'}, not in a bounded face.`, [id], {
        ...lpos,
        point: rm.anchor,
        pointer: ptr('rooms', id, 'anchor'),
      });
      continue;
    }
    roomFaces.set(id, loc.face);
    byFace.set(loc.face, [...(byFace.get(loc.face) ?? []), id]);
  }
  const shared = new Set<string>();
  for (const [, ids] of [...byFace].sort(([a], [b]) => a - b))
    if (ids.length > 1) {
      const sorted = [...ids].sort();
      r.report('FS-INV-202', `Rooms ${sorted.join(', ')} have their anchors in the same face.`, sorted, lpos,
        sorted.slice(1).map((id) => ({ op: 'remove' as const, id })));
      for (const id of ids) shared.add(id);
    }
  for (const [id, face] of roomFaces) {
    if (shared.has(id)) continue;
    const poly = g.roomPolygon(g.faces[face]!);
    if (poly.degenerate) {
      r.report('FS-INV-203', `${id}'s face has a degenerate room polygon.`, [id], { ...lpos, pointer: ptr('rooms', id) });
      continue;
    }
    const rm = get(doc.rooms, id)!;
    if (!strictlyInside(ipoint(rm.anchor), poly.outer, poly.holes))
      r.report('FS-INV-204', `${id}'s anchor is not strictly inside its room polygon.`, [id], { ...lpos, point: rm.anchor, pointer: ptr('rooms', id, 'anchor') });
  }
  return roomFaces;
}

export function strictlyInside(p: IPoint, outer: IPoint[], holes: IPoint[][]): boolean {
  return locate(p, outer) === 'inside' && holes.every((h) => locate(p, h) === 'outside');
}

// ── opening and type invariants (FS-INV-301 … 308) ───────────────────────────

/** 8.4.4: a declared area is no more than the clear width times the clear height. */
const areaFits = (c: ClearOpening): boolean => c.area === undefined || BigInt(c.area) <= BigInt(c.width) * BigInt(c.height);

/** The clear opening invariants of door and window types (Core 0.3: FS-INV-306, FS-INV-307), used or not. */
function typeInvariants(doc: FloorspecDocument, r: Reporter): void {
  for (const [id, t] of entries(doc.types)) {
    if (t.kind === 'wallType' || !t.clearOpening) continue;
    const c: ClearOpening = t.clearOpening;
    if (!areaFits(c))
      r.report('FS-INV-306', `${id}'s clear opening declares an area larger than its clear width times its clear height.`, [id], { pointer: ptr('types', id, 'clearOpening', 'area') });
    if ((t.width !== undefined && c.width > t.width) || (t.height !== undefined && c.height > t.height))
      r.report('FS-INV-307', `${id}'s clear opening is ${t.width !== undefined && c.width > t.width ? 'wider' : 'taller'} than the type.`, [id], { pointer: ptr('types', id, 'clearOpening') });
  }
}

function openingInvariants(doc: FloorspecDocument, r: Reporter): void {
  const ok: { id: string; wall: string; offset: bigint; width: bigint; sill: bigint; height: bigint }[] = [];
  for (const [id, o] of entries(doc.openings)) {
    // Core 0.3: an opening's own clear opening (FS-INV-306, FS-INV-308) — for every opening.
    if (o.clearOpening) {
      if (!areaFits(o.clearOpening))
        r.report('FS-INV-306', `${id}'s clear opening declares an area larger than its clear width times its clear height.`, [id], { pointer: ptr('openings', id, 'clearOpening', 'area') });
      const fill = o.fill === undefined ? undefined : get(doc.types, o.fill);
      if (o.clearOpening.area !== undefined && fill?.kind !== 'windowType')
        r.report('FS-INV-308', `${id}'s clear opening has an area, but ${fill ? `its fill ${o.fill} is a door type` : 'it is an empty opening'}: only a window's clear opening has one.`, [id], {
          pointer: ptr('openings', id, 'clearOpening', 'area'),
        });
    }
    const dim = openingDimensions(doc, o);
    if (dim.width === undefined || dim.height === undefined) {
      r.report('FS-INV-301', `${id}'s ${dim.width === undefined ? 'width' : 'height'} does not resolve: neither the opening nor its fill gives it.`, [id], {
        pointer: ptr('openings', id),
      });
      continue;
    }
    const w = get(doc.walls, o.wall)!;
    const S = ipoint(get(doc.junctions, w.start)!.position);
    const E = ipoint(get(doc.junctions, w.end)!.position);
    const m = (E[0] - S[0]) ** 2n + (E[1] - S[1]) ** 2n;
    const offset = BigInt(o.offset);
    const width = BigInt(dim.width);
    const height = BigInt(dim.height);
    const sill = BigInt(dim.sill);
    if ((offset + width) ** 2n > m) {
      const fixOffset = isqrt(m) - width;
      r.report('FS-INV-302', `${id} extends beyond the length of ${o.wall}.`, [id], { pointer: ptr('openings', id, 'offset') },
        fixOffset >= 0n ? [{ op: 'set', id, member: '/offset', value: Number(fixOffset) }] : undefined);
    }
    if (!r.has('FS-INV-112', o.wall)) {
      const el = wallElevations(doc, w)!;
      if (sill + height > el.top - el.base) r.report('FS-INV-303', `${id} extends above the height of ${o.wall}.`, [id], { pointer: ptr('openings', id) });
    }
    // Core 0.3: the effective clear opening fits the opening (FS-INV-305).
    const clear = effectiveClearOpening(doc, o);
    if (clear && (BigInt(clear.width) > width || BigInt(clear.height) > height))
      r.report('FS-INV-305', `${id}'s clear opening is ${BigInt(clear.width) > width ? 'wider' : 'taller'} than the opening${o.clearOpening ? '' : ` (it is ${o.fill}'s)`}.`, [id], {
        pointer: ptr('openings', id, ...(o.clearOpening ? ['clearOpening'] : [])),
      });
    ok.push({ id, wall: o.wall, offset, width, sill, height });
  }
  for (let i = 0; i < ok.length; i++)
    for (let k = i + 1; k < ok.length; k++) {
      const a = ok[i]!;
      const b = ok[k]!;
      if (a.wall !== b.wall) continue;
      const along = maxB(a.offset, b.offset) < minB(a.offset + a.width, b.offset + b.width);
      const up = maxB(a.sill, b.sill) < minB(a.sill + a.height, b.sill + b.height);
      if (along && up) r.report('FS-INV-304', `${a.id} and ${b.id} overlap on ${a.wall}.`, [a.id, b.id], { pointer: ptr('openings', b.id) });
    }
}

const maxB = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const minB = (a: bigint, b: bigint): bigint => (a < b ? a : b);

// ── floor and ceiling invariants (FS-INV-701 … 703) ──────────────────────────

/**
 * Core 0.3, 10.3: for every room on a level where room invariants were evaluated and with none of
 * FS-INV-201 to FS-INV-204, tested on its room polygon. A document of an earlier draft has no
 * `floor`, `ceiling` or `ceilingHeight`, so none of them can be reported for it.
 */
function floorAndCeilingInvariants(doc: FloorspecDocument, r: Reporter, levels: Map<string, LevelAnalysis>): void {
  const roomCodes = ['FS-INV-201', 'FS-INV-202', 'FS-INV-203', 'FS-INV-204'];
  for (const [id, room] of entries(doc.rooms)) {
    const la = levels.get(room.level);
    if (!la || la.broken || !la.geometry) continue;
    const face = la.roomFaces.get(id);
    if (face === undefined || roomCodes.some((c) => r.has(c, id))) continue;
    for (const d of floorInvariants(doc, id, room, roomRings(la.geometry, face))) {
      const message =
        d.code === 'FS-INV-701'
          ? `${id}'s ceiling is not above its floor.`
          : d.code === 'FS-INV-702'
            ? `${id}'s vaulted ceiling has its two ridge points at the same point.`
            : `${id}'s tray ceiling border does not fit the room.`;
      r.report(d.code, message, [id], { pointer: ptr('rooms', id, d.code === 'FS-INV-701' ? 'ceiling' : 'ceiling') });
    }
  }
}

// ── roof invariants (FS-INV-801 … 805) ─────────────────────────────────────────

const ROOF_MESSAGES: Record<string, string> = {
  'FS-INV-801': 'names an edge its footprint does not have in `edges`',
  'FS-INV-802': 'has both level edges and edges that are not level: a roof is all flat or all sloped',
  'FS-INV-803': 'has a gable on every edge, so nothing slopes',
  'FS-INV-804': 'has two consecutive footprint edges that are collinear',
  'FS-INV-805': "has an eave outline that does not fit its footprint: an overhang is too wide for an edge or closes a notch",
};

function roofInvariantsOf(doc: FloorspecDocument, r: Reporter): void {
  for (const [id, roof] of entries(doc.roofs))
    for (const code of roofInvariants(roof)) r.report(code, `${id} ${ROOF_MESSAGES[code]}.`, [id], { pointer: ptr('roofs', id) });
}

// ── tier 4 ───────────────────────────────────────────────────────────────────

export interface InvariantOptions {
  /** Evaluate the invariants Core 0.2 adds (a 0.2 reader, for documents of either draft). */
  readonly core02: boolean;
  /** Derive what Core 0.3 adds for every document: floors, ceilings and slabs (chapter 15). */
  readonly core03?: boolean;
  /** The validator's known extensions (12.2), already checked. */
  readonly known?: readonly RegistryEntry[];
}

export function invariants(doc: FloorspecDocument, r: Reporter, options: InvariantOptions = { core02: false }): Analysis | undefined {
  const before = r.diagnostics.length;
  referenceInvariants(doc, r);
  if (r.diagnostics.length > before) return undefined;

  const levelCodes = new Map<string, string[]>();
  const offsets = new Map<string, FaceOffsets>();
  graphInvariants(doc, r, levelCodes, offsets);

  const levels = new Map<string, LevelAnalysis>();
  for (const [lid] of entries(doc.levels)) {
    const broken = (levelCodes.get(lid) ?? []).some((c) => c !== 'FS-INV-112');
    if (broken) {
      levels.set(lid, { id: lid, broken, roomFaces: new Map() });
      continue;
    }
    const geometry = buildLevelGeometry(doc, lid, offsets);
    const roomFaces = levelInvariants(doc, r, lid, geometry);
    levels.set(lid, { id: lid, broken, geometry, roomFaces });
  }
  openingInvariants(doc, r);
  typeInvariants(doc, r);
  floorAndCeilingInvariants(doc, r, levels);
  roofInvariantsOf(doc, r);
  const analysis: Analysis = { levels, offsets, core02: options.core02, core03: options.core03 ?? false };
  if (options.core02) {
    programInvariants(doc, r);
    extensionInvariants(doc, options.known, r);
    hostingInvariants(doc, r);
    surfaceInvariants(doc, analysis, r);
  }
  return analysis;
}
