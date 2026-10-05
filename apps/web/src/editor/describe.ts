import { formatLen, type UnitSystem } from './units';

/**
 * Operations in words (FLR-T-3.5, FLR-T-3.6): the changeset panel's list of what an agent sent, and
 * the history's one-line summary of each op. Read from the batch as it was sent — its references
 * ("the north wall of the Kitchen") are what the author meant — with the resolved primitives and
 * the created/removed IDs for what it came to.
 */

type Json = Record<string, unknown>;

/** How to name an element: its label in the model, or its ID when the model no longer has it. */
export type Namer = (id: string) => string;

const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number');

function ref(v: unknown, name: Namer): string {
  if (typeof v === 'string') return /^[A-Za-z][A-Za-z0-9_-]*$/.test(v) || v.startsWith('$') ? name(v) : `“${v}”`;
  if (isPoint(v)) return `(${String(v[0])}, ${String(v[1])})`;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function point(v: unknown, units: UnitSystem, name: Namer): string {
  if (isPoint(v)) return `${formatLen(v[0], units)}, ${formatLen(v[1], units)}`;
  return ref(v, name);
}

function length(v: unknown, units: UnitSystem): string {
  if (typeof v === 'number') return `${v >= 0 ? '+' : ''}${formatLen(v, units)}`;
  return String(v);
}

const SINGULAR: Record<string, string> = {
  buildings: 'building', levels: 'level', junctions: 'junction', walls: 'wall', separators: 'separator', openings: 'opening',
  rooms: 'room', slabs: 'slab', types: 'type', materials: 'material', assets: 'asset',
};

/** One operation as `[name, what]`: `['moveWall', 'W14 · +6"']`. */
export function describeOp(op: Json, units: UnitSystem, name: Namer): [string, string] {
  const kind = String(op['op']);
  const n = (v: unknown) => ref(v, name);
  switch (kind) {
    case 'drawWall':
    case 'drawSeparator':
      return [kind, `${point(op['from'], units, name)} → ${point(op['to'], units, name)}`];
    case 'moveWall':
      return [kind, `${n(op['wall'])} · ${length(op['by'], units)}${op['toward'] === undefined ? '' : ` toward ${n(op['toward'])}`}`];
    case 'moveRoom': {
      const by = op['by'];
      return [kind, `${n(op['room'])} · ${isPoint(by) ? `${length(by[0], units)}, ${length(by[1], units)}` : String(by)}`];
    }
    case 'resizeRoom':
      return [kind, `${n(op['room'])} · ${String(op['side'])} ${length(op['by'], units)}`];
    case 'addOpening':
      return [kind, `${n(op['wall'])} · ${typeof op['at'] === 'number' ? formatLen(op['at'], units) : String(op['at'])}${typeof op['fill'] === 'string' ? ` · ${op['fill']}` : ''}`];
    case 'moveOpening':
      return [kind, `${n(op['opening'])} → ${typeof op['at'] === 'number' ? formatLen(op['at'], units) : String(op['at'])}`];
    case 'addRoom':
      return [kind, `${typeof op['name'] === 'string' ? `“${op['name']}”` : 'a room'} at ${point(op['at'], units, name)}`];
    case 'setRoomFinish':
      return [kind, `${n(op['room'])} · ${String(op['surface'])} ${String(op['material'])}`];
    case 'removeWall':
      return [kind, `${n(op['wall'])}${op['keep'] === undefined ? '' : ` · keep ${n(op['keep'])}`}`];
    case 'removeElement':
      return [kind, `${n(op['id'])}${op['cascade'] === true ? ' and what is on it' : ''}`];
    case 'setProperty':
      return [kind, `${n(op['id'])} ${String(op['path'])} = ${typeof op['value'] === 'string' ? `“${op['value']}”` : JSON.stringify(op['value'])}`];
    case 'unsetProperty':
      return [kind, `${n(op['id'])} ${String(op['path'])}`];
    case 'moveJunction':
      return [kind, `${n(op['id'])} → ${point(op['to'], units, name)}`];
    case 'addElement': {
      const element = (op['element'] ?? {}) as Json;
      const what = SINGULAR[String(op['collection'])] ?? String(op['collection']);
      const label = typeof element['name'] === 'string' ? `“${element['name']}”` : typeof op['id'] === 'string' ? op['id'] : '';
      return [kind, `${what} ${label}`.trim()];
    }
    case 'addJunction':
      return [kind, `${typeof op['id'] === 'string' ? `${op['id']} ` : ''}at ${point(op['position'], units, name)}`];
    case 'addWall':
    case 'addSeparator':
      return [kind, `${typeof op['id'] === 'string' ? `${op['id']} ` : ''}${n(op['start'])} → ${n(op['end'])}`];
    default:
      return [kind, ''];
  }
}

const VERBS: Record<string, [string, string]> = {
  drawWall: ['Drew a wall', 'Drew {n} walls'],
  drawSeparator: ['Drew a separator', 'Drew {n} separators'],
  addWall: ['Added a wall', 'Added {n} walls'],
  addSeparator: ['Added a separator', 'Added {n} separators'],
  addJunction: ['Added a junction', 'Added {n} junctions'],
  moveWall: ['Moved a wall', 'Moved {n} walls'],
  moveJunction: ['Moved a junction', 'Moved {n} junctions'],
  moveRoom: ['Moved a room', 'Moved {n} rooms'],
  resizeRoom: ['Resized a room', 'Resized {n} rooms'],
  addOpening: ['Added an opening', 'Added {n} openings'],
  moveOpening: ['Moved an opening', 'Moved {n} openings'],
  addRoom: ['Named a room', 'Named {n} rooms'],
  setRoomFinish: ['Set a finish', 'Set {n} finishes'],
  removeWall: ['Removed a wall', 'Removed {n} walls'],
  removeElement: ['Removed an element', 'Removed {n} elements'],
  setProperty: ['Changed a property', 'Changed {n} properties'],
  unsetProperty: ['Reset a property', 'Reset {n} properties'],
  addElement: ['Added an element', 'Added {n} elements'],
};

/** A single op, in a sentence where one reads better than a verb and a count. */
function sentence(op: Json, units: UnitSystem, name: Namer): string | null {
  switch (op['op']) {
    case 'moveWall':
      return `Moved ${ref(op['wall'], name)} ${length(op['by'], units)}`;
    case 'moveJunction':
      return `Moved ${ref(op['id'], name)}`;
    case 'moveOpening':
      return `Moved ${ref(op['opening'], name)}`;
    case 'resizeRoom':
      return `Resized ${ref(op['room'], name)} ${String(op['side'])} ${length(op['by'], units)}`;
    case 'removeWall':
      return `Removed ${ref(op['wall'], name)}`;
    case 'removeElement':
      return `Removed ${ref(op['id'], name)}`;
    case 'addOpening':
      return `Added ${typeof op['fill'] === 'string' && /^D/.test(op['fill']) ? 'a door' : typeof op['fill'] === 'string' && /^W/.test(op['fill']) ? 'a window' : 'an opening'} to ${ref(op['wall'], name)}`;
    case 'addRoom':
      return typeof op['name'] === 'string' ? `Named a room “${op['name']}”` : null;
    case 'setProperty':
      if (op['path'] === '/name') return `Renamed ${ref(op['id'], name)} “${String(op['value'])}”`;
      if (op['path'] === '/extras/d3floorspec/units') return op['value'] === 'metric' ? 'Showed metric units' : 'Showed feet and inches';
      return `Set ${String(op['path']).replace(/^\//, '')} of ${ref(op['id'], name)}`;
    case 'addElement': {
      const element = (op['element'] ?? {}) as Json;
      const what = SINGULAR[String(op['collection'])] ?? 'element';
      return `Added ${what}${typeof element['name'] === 'string' ? ` “${element['name']}”` : ''}`;
    }
    default:
      return null;
  }
}

/**
 * A batch in a line: "Drew 4 walls", "Moved W3 +1\"", "Added level “Level 1” and 1 more". Types a
 * batch adds for the elements that use them are left out — they are the means, not the edit.
 */
export function summarizeBatch(batch: readonly Json[], units: UnitSystem, name: Namer): string {
  const meaningful = batch.filter((op) => !(op['op'] === 'addElement' && op['collection'] === 'types' && batch.length > 1));
  const ops = meaningful.length > 0 ? meaningful : batch;
  if (ops.length === 0) return 'Nothing';
  if (ops.length === 1 && ops[0]?.['op'] === 'createProject') return 'Created the project';
  const groups = new Map<string, Json[]>();
  for (const op of ops) {
    const k = String(op['op']);
    groups.set(k, [...(groups.get(k) ?? []), op]);
  }
  const parts: string[] = [];
  for (const [k, list] of groups) {
    const first = list[0] as Json;
    if (list.length === 1) {
      parts.push(sentence(first, units, name) ?? VERBS[k]?.[0] ?? k);
    } else {
      parts.push(VERBS[k]?.[1].replace('{n}', String(list.length)) ?? `${k} ×${String(list.length)}`);
    }
  }
  const [head, ...rest] = parts;
  return rest.length === 0 ? (head as string) : rest.length === 1 ? `${head as string}, ${(rest[0] as string).charAt(0).toLowerCase()}${(rest[0] as string).slice(1)}` : `${head as string} and ${String(rest.length)} more`;
}
