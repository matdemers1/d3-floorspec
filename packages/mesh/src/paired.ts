/**
 * Appliances described twice (FLR-T-12.34). FS_furniture draws an appliance — a washer, a
 * dishwasher, a cooktop — and the other extensions describe what serves it: its water and drain an
 * FS_plumbing fixture (`clothesWasher`, `dishwasher`), its gas an FS_mechanical gas appliance
 * (`cooktop`, `range`). A writer that follows FS_furniture 4.4 places that element where the
 * appliance is, in the same box, and names it in the appliance's `connections`; or it places the gas
 * cooktop in the furniture cooktop's box and names neither. Drawn each as its own model, the two
 * fill one box twice and fight for every pixel of it.
 *
 * The rule, which every view of this reader keeps (the worker's raster, its path tracer, the glTF
 * export and the editor's 3D view all draw what @floorspec/mesh makes): an element of another
 * extension is **paired** with an FS_furniture appliance — and draws nothing of its own, the
 * appliance standing for both — when
 *
 * - it is one of the elements that describe an appliance rather than a thing of their own (SERVICES:
 *   an FS_plumbing fixture that is an appliance's connection, an FS_mechanical gas appliance that is
 *   a range, a cooktop, an oven or a dryer — never a sink, a receptacle, a grill or a fireplace);
 * - the two are on one level and overlap by Core 13.6's test, as their fallbacks are derived: the
 *   interiors of their footprints meet and their vertical ranges overlap by a positive length; and
 * - the appliance's `connections` name it, or the appliance's category is one it is the same thing
 *   as (a `clothesWasher` fixture and a `washer`, a gas `cooktop` and a `cooktop`).
 *
 * An element connected to an appliance that stands elsewhere, or one that overlaps an appliance of
 * another kind without being named by it, still draws. Of several appliances that would stand for
 * one element, one that names it wins, then the first by ID. The element stays in the document and
 * in every list; only its geometry is the appliance's (its parts carry `standsFor`).
 */
import { extElements, footprintsOverlap, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { elementKind } from './models/kinds.js';

/** Extension → collection → kind → the FS_furniture appliance categories an element of that kind is the same thing as. */
const SERVICES: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>>> = {
  FS_plumbing: {
    fixtures: { clothesWasher: ['washer'], dishwasher: ['dishwasher'], iceMaker: ['refrigerator', 'freezer'] },
  },
  FS_mechanical: {
    gasAppliances: { range: ['range'], cooktop: ['cooktop', 'range'], oven: ['wallOven', 'range'], dryer: ['dryer'] },
  },
};

type Json = Record<string, unknown>;

/** The FS_furniture categories an element is the same appliance as, or undefined when it is a thing of its own. */
function servesAs(extension: string, collection: string, element: Json): readonly string[] | undefined {
  const c = Object.hasOwn(SERVICES, extension) ? SERVICES[extension]! : undefined;
  const k = c !== undefined && Object.hasOwn(c, collection) ? c[collection]! : undefined;
  if (k === undefined) return undefined;
  const kind = elementKind(extension, collection, element);
  return Object.hasOwn(k, kind) ? k[kind] : undefined;
}

/**
 * Every paired element (see above), by ID, with the ID of the FS_furniture appliance that stands for
 * it. Only elements with a fallback box the engine derived take part: what is not drawn pairs with nothing.
 */
export function pairedElements(doc: FloorspecDocument, derived: Derived): Map<string, string> {
  const out = new Map<string, string>();
  const fallbacks = derived.fallbacks ?? {};
  const drawn = (id: string) => {
    const f = Object.hasOwn(fallbacks, id) ? fallbacks[id] : undefined;
    return f !== undefined && f.top > f.bottom ? f : undefined;
  };
  // By ID (extElements sorts them): "the first by ID" is the first met.
  const elements = extElements(doc);
  const appliances = elements.filter((e) => e.extension === 'FS_furniture' && e.collection === 'appliances' && drawn(e.id) !== undefined);
  if (appliances.length === 0) return out;
  for (const s of elements) {
    if (s.extension === 'FS_furniture') continue;
    const as = servesAs(s.extension, s.collection, s.element);
    const f = as === undefined ? undefined : drawn(s.id);
    if (as === undefined || f === undefined) continue;
    let pick: { id: string; named: boolean } | undefined;
    for (const a of appliances) {
      const g = drawn(a.id)!;
      if (g.level !== f.level || Math.max(f.bottom, g.bottom) >= Math.min(f.top, g.top) || !footprintsOverlap(f.footprint, g.footprint)) continue;
      const el = a.element as unknown as Json;
      const connections = el['connections'];
      const named = Array.isArray(connections) && connections.includes(s.id);
      const category = el['category'];
      if (!named && !(typeof category === 'string' && as.includes(category))) continue;
      if (pick === undefined || (named && !pick.named)) pick = { id: a.id, named };
      if (named) break;
    }
    if (pick !== undefined) out.set(s.id, pick.id);
  }
  return out;
}
