/**
 * Tier 5 of chapter 10: lints, evaluated only for a valid document (10.3). They never make a
 * document invalid.
 */
import { Surd } from '../exact/surd.js';
import { cross, dot, type IPoint } from '../geometry/predicates.js';
import { entries, get, ipoint, openingDimensions, programItems, type FloorspecDocument } from '../model/document.js';
import { analyseProgram } from '../derive/program.js';
import { circulationLints } from '../circulation/circulation.js';
import type { Analysis, Reporter } from './invariants.js';
import { surfaceDerived } from '../roofs/roofs.js';
import { stepsDerived } from '../stairs/stairs.js';
import { references } from './references.js';

const ptr = (collection: string, id: string): string => `/${collection}/${id.replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** d · (P − S): the distance of P along a wall from its start, times |d|. */
function along(S: IPoint, d: IPoint, P: IPoint): Surd {
  return Surd.of(d[0] * (P[0] - S[0]) + d[1] * (P[1] - S[1]));
}

/**
 * The lints of one design (19.5): every lint but FS-LINT-006, FS-LINT-007 and FS-LINT-017, which
 * are of the document as a whole (`documentLints`).
 */
export function lints(doc: FloorspecDocument, analysis: Analysis, r: Reporter): void {
  // 001: acute joins — consecutive walls at a junction whose wedge is narrower than 30° (5.10).
  for (const [, la] of analysis.levels) {
    const g = la.geometry;
    if (!g) continue;
    for (const jid of [...g.junctions.keys()].sort()) {
      const ds = g.directions(jid);
      if (ds.length < 2) continue;
      for (let i = 0; i < ds.length; i++) {
        const a = ds[i]!;
        const b = ds[(i + 1) % ds.length]!;
        if (a.edge.kind !== 'wall' || b.edge.kind !== 'wall') continue;
        if (cross(a.d, b.d) <= 0n) continue; // the wedge from a to b is not narrower than 180°
        const p = dot(a.d, b.d);
        if (p > 0n && 4n * p * p > 3n * dot(a.d, a.d) * dot(b.d, b.d))
          r.report('FS-LINT-001', `${a.edge.id} and ${b.edge.id} meet at ${jid} at less than 30°; their mitre runs far out to a point.`, [jid, a.edge.id, b.edge.id], {
            level: la.id,
            pointer: ptr('junctions', jid),
          });
      }
    }
  }

  // 002: unused junctions.
  const usedJunctions = new Set<string>();
  for (const [, w] of entries(doc.walls)) usedJunctions.add(w.start).add(w.end);
  for (const [, s] of entries(doc.separators)) usedJunctions.add(s.start).add(s.end);
  for (const [id, j] of entries(doc.junctions))
    if (!usedJunctions.has(id))
      r.report('FS-LINT-002', `Junction ${id} is not used by any wall or separator.`, [id], { level: j.level, pointer: ptr('junctions', id) }, [{ op: 'remove', id }]);

  // 003, 004: unanchored faces.
  for (const [lid, la] of analysis.levels) {
    const g = la.geometry;
    if (!g) continue;
    const anchored = new Set(la.roomFaces.values());
    g.faces.forEach((f, i) => {
      if (anchored.has(i)) return;
      const poly = g.roomPolygon(f);
      const first = poly.outer[0] ?? g.graph.positions.get(f.outer.vertices[0]!)!;
      r.report('FS-LINT-003', `A bounded face on ${lid} has no room anchored in it.`, [], { level: lid, point: [Number(first[0]), Number(first[1])] });
      if (poly.degenerate) r.report('FS-LINT-004', `A bounded face on ${lid} with no anchor has a degenerate room polygon: two walls are drawn too close together.`, [], { level: lid });
    });
  }

  // 005: openings that reach into a join (7.5), measured along the location line to the rounded
  // face ends of 5.7, strictly.
  for (const [id, o] of entries(doc.openings)) {
    const w = get(doc.walls, o.wall)!;
    const g = analysis.levels.get(w.level)?.geometry;
    if (!g?.faceEnds.has(o.wall)) continue;
    const fe = g.roundedFaceEnds(o.wall);
    const S = ipoint(get(doc.junctions, w.start)!.position);
    const E = ipoint(get(doc.junctions, w.end)!.position);
    const d: IPoint = [E[0] - S[0], E[1] - S[1]];
    const len = Surd.sqrt(d[0] * d[0] + d[1] * d[1]);
    const dim = openingDimensions(doc, o);
    const start = len.mulInt(BigInt(o.offset));
    const end = len.mulInt(BigInt(o.offset) + BigInt(dim.width!));
    const farStart = [along(S, d, fe.startLeft), along(S, d, fe.startRight)];
    const farEnd = [along(S, d, fe.endLeft), along(S, d, fe.endRight)];
    const reachesStart = farStart.some((t) => start.cmp(t) < 0);
    const reachesEnd = farEnd.some((t) => end.cmp(t) > 0);
    if (reachesStart || reachesEnd)
      r.report('FS-LINT-005', `${id} reaches into the join at the ${reachesStart ? 'start' : 'end'} of ${o.wall}.`, [id], { pointer: ptr('openings', id) });
  }

  // 008 … 011: the program; 012 … 014: circulation (Core 0.2).
  if (analysis.core02) {
    programLints(doc, analysis, r);
    circulationLints(doc, analysis, r);
  }

  // 015: roofs whose surface this draft does not derive (16.4.4); 016: winder and spiral stairs (17.7).
  for (const [id, roof] of entries(doc.roofs))
    if (!surfaceDerived(roof))
      r.report('FS-LINT-015', `${id}'s surface is not derived by this draft: its pitches differ, its outline has an oblique edge, or a gable is not at the end of a wing.`, [id], { pointer: ptr('roofs', id) });
  for (const [id, st] of entries(doc.stairs))
    if (!stepsDerived(st))
      r.report('FS-LINT-016', `${id} is a ${st.form?.kind} stair, whose steps, run, walkline and headroom this draft does not derive.`, [id], { pointer: ptr('stairs', id) });
}

/**
 * FS-LINT-006 and FS-LINT-007 (8.7), of the document as a whole whatever its design (19.5): a type
 * that an element of any option refers to is used.
 */
export function documentLints(doc: FloorspecDocument, r: Reporter): void {
  const referred = new Set<string>();
  for (const ref of references(doc)) if (ref.collection === 'types' || ref.collection === 'materials' || ref.collection === 'assets') referred.add(ref.target);
  for (const c of ['types', 'materials', 'assets'] as const)
    for (const [id] of entries(doc[c] as Record<string, unknown> | undefined))
      if (!referred.has(id)) r.report('FS-LINT-006', `${id} is not referred to by anything.`, [id], { pointer: ptr(c, id) }, [{ op: 'remove', id }]);
  for (const [id, a] of entries(doc.assets))
    if (a.uri !== undefined) r.report('FS-LINT-007', `${id} is located by uri, so the document depends on someone else's server.`, [id], { pointer: ptr('assets', id) });
}

/** 11.5: an unmet program is a warning, never an error (FS-CORE-11.5.2). */
function programLints(doc: FloorspecDocument, analysis: Analysis, r: Reporter): void {
  const { derived, area2, roomsOf } = analyseProgram(doc, analysis);
  for (const [iid, item] of programItems(doc)) {
    const ptrItem = `/program/items/${iid}`;
    if (!derived.items[iid]!.countMet)
      r.report('FS-LINT-008', `${iid} asks for ${item.count ?? 1} room${(item.count ?? 1) === 1 ? '' : 's'} and has ${roomsOf.get(iid)!.length}.`, [iid], { pointer: ptrItem });
    if (item.minArea !== undefined)
      for (const rid of roomsOf.get(iid)!)
        if (area2.get(rid)! < 2n * BigInt(item.minArea))
          r.report('FS-LINT-009', `${rid} is smaller than ${iid}'s minimum area.`, [iid, rid], { pointer: ptr('rooms', rid) });
  }
  derived.adjacency.forEach((a, i) => {
    if (a.kind === 'required' && !a.adjacent)
      r.report('FS-LINT-010', `No room of ${a.a} is next to a room of ${a.b}, which the program requires.`, [a.a, a.b], { pointer: `/program/adjacency/${i}` });
    if (a.kind === 'forbidden' && a.adjacent)
      r.report('FS-LINT-011', `A room of ${a.a} is next to a room of ${a.b}, which the program forbids.`, [a.a, a.b], { pointer: `/program/adjacency/${i}` });
  });
}
