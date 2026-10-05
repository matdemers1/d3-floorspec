/**
 * Every reference of a document (3.2), as one list: what refers, to which ID, in which collection.
 * The reference tier reports with its own pointers and messages; this listing serves what is
 * defined over all references at once — the option invariant FS-INV-1102 (19.4.1), which pairs a
 * referring element with what it refers to, and FS-LINT-006, which asks whether anything refers to
 * a type, material or asset at all (8.7).
 *
 * The document has passed the schema tier.
 */
import { adjacencies, entries, extElements, programItems, type FloorspecDocument } from '../model/document.js';

/** 19.2: the collections whose elements may be in an option; extension elements may be too. */
export const IN_OPTIONS = ['junctions', 'walls', 'separators', 'openings', 'rooms', 'slabs', 'roofs', 'stairs'] as const;
/** 18.2: a texture's maps. */
export const MAPS = ['asset', 'normal', 'metallicRoughness', 'occlusion'] as const;
/** 18.5: a wall's two sides. */
export const SIDES = ['left', 'right'] as const;

export interface Reference {
  /** The referring element or program item; undefined for an adjacency (10.4: FS-INV-002 names none). */
  readonly owner: string | undefined;
  readonly target: string;
  /** The collection the target must be in: a collection of 1.1, or `items` (the program's). */
  readonly collection: string;
}

export function references(doc: FloorspecDocument): Reference[] {
  const out: Reference[] = [];
  const add = (owner: string | undefined, target: string | undefined, collection: string): void => {
    if (target !== undefined) out.push({ owner, target, collection });
  };
  for (const [id, l] of entries(doc.levels)) add(id, l.building, 'buildings');
  for (const [id, j] of entries(doc.junctions)) {
    add(id, j.level, 'levels');
    if (j.join?.kind === 'butt') for (const w of j.join.through) add(id, w, 'walls');
  }
  for (const [id, w] of entries(doc.walls)) {
    add(id, w.level, 'levels');
    add(id, w.start, 'junctions');
    add(id, w.end, 'junctions');
    add(id, w.type, 'types');
    add(id, w.base?.level, 'levels');
    if (w.top && 'level' in w.top) add(id, w.top.level, 'levels');
    for (const l of w.layers ?? []) add(id, l.material, 'materials');
    for (const side of SIDES) {
      const face = w.finishes?.[side];
      if (!face) continue;
      add(id, face.material, 'materials');
      for (const r of face.regions ?? []) add(id, r.material, 'materials');
    }
  }
  for (const [id, s] of entries(doc.separators)) {
    add(id, s.level, 'levels');
    add(id, s.start, 'junctions');
    add(id, s.end, 'junctions');
  }
  for (const [id, o] of entries(doc.openings)) {
    add(id, o.wall, 'walls');
    add(id, o.fill, 'types');
  }
  for (const [id, r] of entries(doc.rooms)) {
    add(id, r.level, 'levels');
    add(id, r.wallFinish, 'materials');
    add(id, r.floorFinish, 'materials');
    add(id, r.ceilingFinish, 'materials');
    add(id, r.brief, 'items');
  }
  for (const [id, s] of entries(doc.slabs)) {
    add(id, s.level, 'levels');
    add(id, s.material, 'materials');
  }
  for (const [id, r] of entries(doc.roofs)) {
    add(id, r.level, 'levels');
    add(id, r.material, 'materials');
  }
  for (const [id, s] of entries(doc.stairs)) {
    add(id, s.level, 'levels');
    add(id, s.to, 'levels');
  }
  for (const [id, t] of entries(doc.types)) if (t.kind === 'wallType') for (const l of t.layers) add(id, l.material, 'materials');
  for (const [id, m] of entries(doc.materials)) for (const k of MAPS) add(id, m.texture?.[k], 'assets');
  for (const [id, o] of entries(doc.options)) add(id, o.set, 'optionSets');
  for (const [id, s] of entries(doc.optionSets)) add(id, s.primary, 'options');
  for (const c of IN_OPTIONS) for (const [id, e] of entries(doc[c] as Record<string, { option?: string }> | undefined)) add(id, e.option, 'options');
  for (const [id, it] of programItems(doc)) add(id, it.level, 'levels');
  for (const a of adjacencies(doc)) {
    add(undefined, a.a, 'items');
    add(undefined, a.b, 'items');
  }
  for (const x of extElements(doc)) {
    const h = x.element.host;
    if (h?.mode === 'wallFace') add(x.id, h.wall, 'walls');
    if (h?.mode === 'surface') add(x.id, h.room, 'rooms');
    if (h?.mode === 'free') add(x.id, h.level, 'levels');
    const fb = x.element.fallback;
    add(x.id, fb.level, 'levels');
    add(x.id, x.element.option, 'options');
    add(x.id, fb.asset, 'assets');
    add(x.id, fb.symbol, 'assets');
  }
  return out;
}
