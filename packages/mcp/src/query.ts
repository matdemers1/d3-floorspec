import { z } from 'zod';
import { COLLECTIONS, Collection } from './ops-schema.js';
import { collection, findRoom, read, type Read } from './model.js';
import { length, squareFeet } from './units.js';

/**
 * `floorspec_query`: elements by ID, kind, level, room or relationship, each with its geometry
 * resolved in feet-inches and in base units — so an agent reads "the east wall of the Kitchen is
 * W7, 12' 6" long" instead of computing it from junction coordinates.
 */

export const Relationship = z.enum(['boundary', 'openings', 'adjacent', 'hosted', 'sides']);

export const QueryInput = {
  ids: z.array(z.string().min(1).max(64)).max(200).optional().describe('Exactly these element IDs.'),
  kind: Collection.optional().describe('Only elements of this collection.'),
  level: z.string().min(1).max(64).optional().describe('Only elements on this level.'),
  room: z.string().min(1).max(200).optional().describe('A room ID or name; with relationship, what relates to it.'),
  wall: z.string().min(1).max(64).optional().describe('A wall ID; with relationship, what relates to it.'),
  relationship: Relationship.optional().describe(
    'With room: "boundary" (its walls and separators, the default), "openings" (in its boundary walls), "adjacent" (rooms across a boundary). ' +
      'With wall: "hosted" (its openings, the default) or "sides" (the rooms on either side).',
  ),
  limit: z.int().min(1).max(500).optional().describe('At most this many elements (default 100).'),
};

export type QueryArgs = { [K in keyof typeof QueryInput]?: z.infer<(typeof QueryInput)[K]> };

type Pt = [number, number];

function point(p: Pt) {
  return { units: p, ftIn: [length(p[0]).ftIn, length(p[1]).ftIn] };
}

interface Topology {
  /** Element IDs of the edges bounding each anchored room (outer cycle and holes). */
  readonly boundary: Map<string, Set<string>>;
  /** Room IDs on either side of each edge. */
  readonly sides: Map<string, Set<string>>;
}

/** Rooms and the edges between them, from the engine's half-edge graph of each level. */
function topology(model: Read): Topology {
  const boundary = new Map<string, Set<string>>();
  const sides = new Map<string, Set<string>>();
  if (model.analysis === null) return { boundary, sides };
  for (const level of model.analysis.levels.values()) {
    const geometry = level.geometry;
    if (geometry === undefined) continue;
    const graph = geometry.graph;
    const roomOfFace = new Map<number, string>();
    for (const [room, face] of level.roomFaces) roomOfFace.set(face, room);
    for (const [index, face] of graph.faces.entries()) {
      const room = roomOfFace.get(index);
      if (room === undefined) continue;
      const edges = new Set<string>();
      for (const cycle of [face.outer, ...face.inner]) {
        for (const h of cycle.halfEdges) {
          const edge = graph.edges[h >> 1];
          if (edge === undefined) continue;
          edges.add(edge.id);
          const on = sides.get(edge.id) ?? new Set<string>();
          on.add(room);
          sides.set(edge.id, on);
        }
      }
      boundary.set(room, edges);
    }
  }
  return { boundary, sides };
}

function kindOf(doc: Record<string, unknown>, id: string): string | null {
  for (const name of COLLECTIONS) {
    const c = doc[name];
    if (typeof c === 'object' && c !== null && Object.hasOwn(c, id)) return name;
  }
  return null;
}

/** One element with its geometry spelled out. */
function view(model: Read, topo: Topology, kind: string, id: string, element: Record<string, unknown>) {
  const doc = model.document;
  const junction = (ref: unknown): Pt | null => {
    if (typeof ref !== 'string') return null;
    const j = collection(doc, 'junctions').find(([jid]) => jid === ref)?.[1];
    const p = j?.['position'];
    return Array.isArray(p) && p.length === 2 ? [Number(p[0]), Number(p[1])] : null;
  };
  const out: Record<string, unknown> = { id, kind, element };
  switch (kind) {
    case 'junctions': {
      const p = element['position'];
      if (Array.isArray(p) && p.length === 2) out['position'] = point([Number(p[0]), Number(p[1])]);
      break;
    }
    case 'walls':
    case 'separators': {
      const s = junction(element['start']);
      const e = junction(element['end']);
      if (s !== null && e !== null) {
        out['start'] = { junction: element['start'], ...point(s) };
        out['end'] = { junction: element['end'], ...point(e) };
        // Display only: the location line's length, rounded to a base unit.
        out['length'] = length(Math.round(Math.hypot(e[0] - s[0], e[1] - s[1])));
        const dx = e[0] - s[0];
        const dy = e[1] - s[1];
        out['direction'] = dx === 0 ? (dy > 0 ? 'north' : 'south') : dy === 0 ? (dx > 0 ? 'east' : 'west') : 'oblique';
      }
      out['rooms'] = [...(topo.sides.get(id) ?? [])].sort();
      if (kind === 'walls') {
        const faces = model.derived?.walls[id];
        if (faces !== undefined) out['faces'] = faces;
        out['openings'] = collection(doc, 'openings').filter(([, o]) => o['wall'] === id).map(([oid]) => oid);
      }
      break;
    }
    case 'openings': {
      if (typeof element['offset'] === 'number') out['offset'] = length(element['offset']);
      if (typeof element['width'] === 'number') out['width'] = length(element['width']);
      if (typeof element['height'] === 'number') out['height'] = length(element['height']);
      const derived = model.derived?.openings[id];
      if (derived !== undefined) {
        out['start'] = point(derived.start);
        out['end'] = point(derived.end);
        out['sillElevation'] = length(derived.sillElevation);
        out['headElevation'] = length(derived.headElevation);
      }
      break;
    }
    case 'rooms': {
      const derived = model.derived?.rooms[id];
      if (derived !== undefined) {
        out['netArea'] = { sqft: squareFeet(derived.area), units: derived.area };
        out['outline'] = (derived.outer as Pt[]).map(point);
      }
      const anchor = element['anchor'];
      if (Array.isArray(anchor) && anchor.length === 2) out['anchor'] = point([Number(anchor[0]), Number(anchor[1])]);
      out['boundary'] = [...(topo.boundary.get(id) ?? [])].sort();
      break;
    }
    case 'levels': {
      if (typeof element['elevation'] === 'number') out['elevation'] = length(element['elevation']);
      if (typeof element['height'] === 'number') out['height'] = length(element['height']);
      break;
    }
  }
  return out;
}

export function query(document: unknown, args: QueryArgs) {
  const model = read(document);
  const doc = model.document;
  const topo = topology(model);
  const limit = args.limit ?? 100;
  let ids: Set<string> | null = args.ids === undefined ? null : new Set(args.ids);
  const notes: string[] = [];

  if (args.room !== undefined) {
    const found = findRoom(doc, args.room);
    if (found === null) {
      return { valid: model.valid, count: 0, elements: [], notes: [`No room is called "${args.room}", or more than one is: use its ID.`] };
    }
    const [roomId] = found;
    const relationship = args.relationship ?? 'boundary';
    const boundary = topo.boundary.get(roomId);
    if (boundary === undefined) notes.push(`${roomId} has no derived outline: its level is not valid, or its anchor is in no bounded face.`);
    let related: string[];
    switch (relationship) {
      case 'boundary':
        related = [...(boundary ?? [])];
        break;
      case 'openings':
        related = collection(doc, 'openings').filter(([, o]) => boundary?.has(String(o['wall'])) === true).map(([id]) => id);
        break;
      case 'adjacent':
        related = [...new Set([...(boundary ?? [])].flatMap((edge) => [...(topo.sides.get(edge) ?? [])]))].filter((r) => r !== roomId);
        break;
      default:
        return { valid: model.valid, count: 0, elements: [], notes: [`"${relationship}" relates to a wall, not a room.`] };
    }
    ids = new Set(ids === null ? related : related.filter((id) => ids?.has(id)));
  } else if (args.wall !== undefined) {
    const relationship = args.relationship ?? 'hosted';
    let related: string[];
    if (relationship === 'hosted') related = collection(doc, 'openings').filter(([, o]) => o['wall'] === args.wall).map(([id]) => id);
    else if (relationship === 'sides') related = [...(topo.sides.get(args.wall) ?? [])];
    else return { valid: model.valid, count: 0, elements: [], notes: [`"${relationship}" relates to a room, not a wall.`] };
    ids = new Set(ids === null ? related : related.filter((id) => ids?.has(id)));
  }

  const kinds = args.kind === undefined ? COLLECTIONS : [args.kind];
  const elements: Record<string, unknown>[] = [];
  let matched = 0;
  for (const kind of kinds) {
    for (const [id, element] of collection(doc, kind)) {
      if (ids !== null && !ids.has(id)) continue;
      if (args.level !== undefined && element['level'] !== args.level && !(kind === 'levels' && id === args.level)) continue;
      matched += 1;
      if (elements.length < limit) elements.push(view(model, topo, kind, id, element));
    }
  }
  if (ids !== null) {
    for (const id of ids) if (kindOf(doc, id) === null) notes.push(`${id} is not in the model.`);
  }
  if (!model.valid) notes.push('The model has validation errors, so derived geometry (faces, outlines, areas) is missing: run floorspec_validate.');
  return { valid: model.valid, count: matched, truncated: matched > elements.length, elements, notes };
}
