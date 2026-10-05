/**
 * The invariants Core 0.2 adds (10.3, 10.4), evaluated after the reference invariants held:
 *
 * - program invariants (FS-INV-401 … 403, 11.2), for every adjacency;
 * - extension invariants (FS-INV-601 … 605, 12.3, 12.4), for every extension the document uses
 *   at a version at which it is known (12.2);
 * - hosting invariants (FS-INV-501, 502, 504 … 506, 12.6, 13.2, 13.3), for every extension element
 *   and every type — FS-INV-502 not for a host wall that has FS-INV-112;
 * - FS-INV-503 (13.3.4), only for a `surface` host whose room is on a level where room invariants
 *   were evaluated and has none of FS-INV-201 … 204.
 */
import { get, entries, extElements, adjacencies, declaredVersion, programItems, ipoint, wallElevations, type FloorspecDocument, type RegistryEntry } from '../model/document.js';
import { extentsOk } from '../derive/frames.js';
import { knownEntry, satisfies } from './registry.js';
import { ptr, strictlyInside, type Analysis, type Reporter } from './invariants.js';

const GLTF = new Set(['model/gltf-binary', 'model/gltf+json']);
const SYMBOL = new Set(['image/svg+xml', 'image/png']);

// ── program (FS-INV-401 … 403) ───────────────────────────────────────────────

export function programInvariants(doc: FloorspecDocument, r: Reporter): void {
  const key = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const seen = new Set<string>();
  const kinds = new Map<string, { a: string; b: string; kinds: Set<string> }>();
  adjacencies(doc).forEach((adj, i) => {
    const pointer = `/program/adjacency/${i}`;
    if (adj.a === adj.b) {
      r.report('FS-INV-401', `Adjacency ${i} relates ${adj.a} to itself.`, [adj.a], { pointer });
      return;
    }
    const pair = key(adj.a, adj.b);
    if (seen.has(`${pair}\u0000${adj.kind}`))
      r.report('FS-INV-402', `Adjacency ${i} repeats a ${adj.kind} adjacency of ${adj.a} and ${adj.b}.`, [adj.a, adj.b], { pointer });
    seen.add(`${pair}\u0000${adj.kind}`);
    const k = kinds.get(pair) ?? { a: adj.a, b: adj.b, kinds: new Set<string>() };
    k.kinds.add(adj.kind);
    kinds.set(pair, k);
  });
  for (const { a, b, kinds: ks } of kinds.values())
    if (ks.has('forbidden') && (ks.has('required') || ks.has('preferred')))
      r.report('FS-INV-403', `The program both forbids and wants ${a} next to ${b}.`, [a, b], { pointer: '/program/adjacency' });
}

// ── extensions known to the validator (FS-INV-601 … 605) ─────────────────────

export function extensionInvariants(doc: FloorspecDocument, known: readonly RegistryEntry[] | undefined, r: Reporter): void {
  if (!known?.length) return;
  const used = doc.extensionsUsed ?? {};
  const elements = extElements(doc);
  for (const [x, decl] of entries(used)) {
    const e = knownEntry(known, x, declaredVersion(decl));
    if (!e) continue;
    for (const [y, range] of entries(e.requires)) {
      const dep = used[y];
      if (dep === undefined)
        r.report('FS-INV-601', `${x} ${e.version} requires ${y}, which the document does not use.`, [], { pointer: `/extensionsUsed/${x}` });
      else if (!satisfies(declaredVersion(dep), range))
        r.report('FS-INV-602', `${x} ${e.version} requires ${y} ${range}, but the document uses ${y} ${declaredVersion(dep)}.`, [], { pointer: `/extensionsUsed/${y}` });
    }
    const kinds = e.kinds ?? {};
    const data = get(doc.extensions as Record<string, unknown> | undefined, x);
    if (doc.floorspec === '0.2' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const cs = (data as { collections?: unknown }).collections;
      if (typeof cs === 'object' && cs !== null && !Array.isArray(cs))
        for (const c of Object.keys(cs).sort())
          if (!Object.hasOwn(kinds, c))
            r.report('FS-INV-604', `${x}'s data has a collection ${c}, which its registry entry does not name.`, [], { pointer: ptr('extensions', x, 'collections', c) });
    }
    for (const el of elements) {
      if (el.extension !== x) continue;
      const kind = get(kinds, el.collection);
      if (!kind) continue;
      for (const part of ['asset', 'symbol'] as const)
        if (kind.fallback?.[part] && el.element.fallback[part] === undefined)
          r.report('FS-INV-603', `${el.id} has no fallback ${part}, which every element of ${x}'s ${el.collection} carries.`, [el.id], {
            pointer: ptr('extensions', x, 'collections', el.collection, el.id, 'fallback'),
          });
    }
    const terms = new Set(e.terms?.roomFunctions ?? []);
    const owners: [string, string | undefined, string][] = [
      ...entries(doc.rooms).map(([id, rm]): [string, string | undefined, string] => [id, rm.function, ptr('rooms', id, 'function')]),
      ...programItems(doc).map(([id, it]): [string, string | undefined, string] => [id, it.function, ptr('program', 'items', id, 'function')]),
    ];
    for (const [id, f, pointer] of owners) {
      if (!f?.includes(':')) continue;
      const i = f.indexOf(':');
      if (f.slice(0, i) === x && !terms.has(f.slice(i + 1)))
        r.report('FS-INV-605', `${id}'s function ${f} uses a term that ${x} ${e.version} does not list.`, [id], { pointer });
    }
  }
}

// ── hosting (FS-INV-501, 502, 504 … 506) ─────────────────────────────────────

export function hostingInvariants(doc: FloorspecDocument, r: Reporter): void {
  for (const [tid, t] of entries(doc.types)) {
    if (t.kind === 'wallType') continue;
    for (const [name, env] of entries(t.clearances))
      if (!extentsOk(env)) r.report('FS-INV-505', `${tid}'s clearance envelope ${name} has an extent of less than 1,280.`, [tid], { pointer: ptr('types', tid, 'clearances', name) });
  }
  for (const x of extElements(doc)) {
    const base = ptr('extensions', x.extension, 'collections', x.collection, x.id);
    const fb = x.element.fallback;
    if (!extentsOk(fb.box)) r.report('FS-INV-505', `${x.id}'s fallback box has an extent of less than 1,280.`, [x.id], { pointer: `${base}/fallback/box` });
    for (const [name, env] of entries(x.element.clearances))
      if (!extentsOk(env)) r.report('FS-INV-505', `${x.id}'s clearance envelope ${name} has an extent of less than 1,280.`, [x.id], { pointer: `${base}/clearances/${name}` });
    if (fb.asset !== undefined && !GLTF.has(get(doc.assets, fb.asset)!.mediaType))
      r.report('FS-INV-506', `${x.id}'s fallback asset ${fb.asset} is not a glTF model.`, [x.id], { pointer: `${base}/fallback/asset` });
    if (fb.symbol !== undefined && !SYMBOL.has(get(doc.assets, fb.symbol)!.mediaType))
      r.report('FS-INV-506', `${x.id}'s fallback symbol ${fb.symbol} is not an SVG or PNG image.`, [x.id], { pointer: `${base}/fallback/symbol` });
    const h = x.element.host;
    if (!h) continue;
    const level = h.mode === 'wallFace' ? get(doc.walls, h.wall)!.level : h.mode === 'surface' ? get(doc.rooms, h.room)!.level : h.level;
    if (level !== fb.level)
      r.report('FS-INV-504', `${x.id}'s fallback is on ${fb.level}, but its host is on ${level}.`, [x.id], { pointer: `${base}/fallback/level` });
    if (h.mode === 'wallFace') {
      const w = get(doc.walls, h.wall)!;
      const S = ipoint(get(doc.junctions, w.start)!.position);
      const E = ipoint(get(doc.junctions, w.end)!.position);
      const offset = BigInt(h.offset);
      if (offset * offset > (E[0] - S[0]) ** 2n + (E[1] - S[1]) ** 2n)
        r.report('FS-INV-501', `${x.id}'s offset along ${h.wall} exceeds the wall's length.`, [x.id], { pointer: `${base}/host/offset` });
      if (!r.has('FS-INV-112', h.wall)) {
        const el = wallElevations(doc, w)!;
        if (BigInt(h.height) > el.top - el.base)
          r.report('FS-INV-502', `${x.id}'s height on ${h.wall} exceeds the wall's height.`, [x.id], { pointer: `${base}/host/height` });
      }
    }
  }
}

// ── FS-INV-503 ───────────────────────────────────────────────────────────────

export function surfaceInvariants(doc: FloorspecDocument, analysis: Analysis, r: Reporter): void {
  const badRooms = new Set(
    r.diagnostics.filter((d) => /^FS-INV-20[1-4]$/.test(d.code)).flatMap((d) => d.elements),
  );
  for (const x of extElements(doc)) {
    const h = x.element.host;
    if (h?.mode !== 'surface') continue;
    const room = get(doc.rooms, h.room)!;
    const la = analysis.levels.get(room.level);
    if (!la?.geometry || badRooms.has(h.room)) continue;
    const face = la.roomFaces.get(h.room);
    if (face === undefined) continue;
    const poly = la.geometry.roomPolygon(la.geometry.faces[face]!);
    if (!strictlyInside(ipoint(h.position), poly.outer, poly.holes))
      r.report('FS-INV-503', `${x.id}'s position is not strictly inside the room polygon of ${h.room}.`, [x.id], {
        level: room.level,
        point: h.position,
        pointer: `${ptr('extensions', x.extension, 'collections', x.collection, x.id)}/host/position`,
      });
  }
}
