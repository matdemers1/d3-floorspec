import { defaultClearances, type FloorspecDocument } from '@floorspec/engine';
import type { Operation } from '@floorspec/ops';
import type { Batch } from '../ops';
import { extensionVersion, membersFor, type DeviceKind, type ReceptacleOptions } from './catalog';
import { compareIds, elementOfExtension, elementsOfExtension, recordsOf, RECORD_COLLECTIONS } from './view';

/**
 * Op builders for the building systems (FLR-T-5.7): placing and moving devices (Ops 0.2 4.10's
 * placeElement and moveElement), the records beside them — circuits, stacks, gas sources — set with
 * setProperty of `$document` under `/extensions/<NAME>/…` (Ops 2.3), and the references between
 * them. Like ../ops.ts these only build JSON; the server applies and judges every batch.
 *
 * Ops 0.2 never declares an extension for you (Ops 2.1): the batch that places the first device of
 * an extension declares it, with setProperty of `$document` `/extensionsUsed/<NAME>`.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A host reference (Ops 0.2 4.10), as the editor sends it: positions as numbers or the grammar's words. */
export type HostRef =
  | { mode: 'wallFace'; wall: string; side?: 'left' | 'right'; toward?: string; at: number | string; height: number | string }
  | { mode: 'surface'; room: string; surface: 'floor' | 'ceiling'; at: [number, number] | string; rotation?: number }
  | { mode: 'free'; level: string; at: [number, number] | string; rotation?: number };

/**
 * What a batch that adds to `extension` needs first: the document at Core 0.2 or later (a 0.1 plan
 * holds no extension elements, Core 1.2.6: it becomes 0.3, the current draft; a 0.2 or 0.3 plan
 * keeps its version) and the extension declared in `extensionsUsed`.
 */
export function declarationOps(document: FloorspecDocument, extension: string): Batch {
  const ops: Batch = [];
  if (document.floorspec === '0.1') ops.push({ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' });
  const used = (document as { extensionsUsed?: Record<string, unknown> }).extensionsUsed;
  if (used === undefined || !Object.hasOwn(used, extension)) ops.push({ op: 'setProperty', id: '$document', path: `/extensionsUsed/${extension}`, value: extensionVersion(extension) });
  return ops;
}

/** The new element's members: its fallback box, the kind's members, the default envelopes (each spec's 2.x). */
export function newElement(kind: DeviceKind, options: { receptacle?: ReceptacleOptions; height?: number; name?: string } = {}): Json {
  const members = membersFor(kind, options.receptacle);
  const fallback = { box: structuredClone(kind.box) };
  // A panel's envelope runs down to the floor, so it needs the height its frame stands at.
  const host = kind.mount === 'wall' ? { mode: 'wallFace' as const, wall: '', side: 'left' as const, offset: 0, height: options.height ?? 0 } : undefined;
  const clearances = defaultClearances(kind.extension, kind.collection, { ...members, fallback: { level: '', box: fallback.box }, ...(host === undefined ? {} : { host }) });
  return {
    fallback,
    ...members,
    ...(Object.keys(clearances).length > 0 ? { clearances } : {}),
    ...(options.name === undefined || options.name === '' ? {} : { name: options.name }),
  };
}

/** Place a new device: the declaration if this is its extension's first, then placeElement. */
export function placeDevice(document: FloorspecDocument, kind: DeviceKind, host: HostRef, options: { receptacle?: ReceptacleOptions; name?: string } = {}): Batch {
  const height = host.mode === 'wallFace' && typeof host.height === 'number' ? host.height : undefined;
  // A panel is called by a panel schedule's name for it: P1, P2 …
  if (kind.collection === 'panels' && options.name === undefined) options = { ...options, name: nextPanelName(document) };
  return [
    ...declarationOps(document, kind.extension),
    {
      op: 'placeElement',
      extension: kind.extension,
      collection: kind.collection,
      host: hostOp(host),
      element: newElement(kind, { ...options, ...(height === undefined ? {} : { height }) }),
    } as Operation,
  ];
}

/** The next free panel name: P1, P2 … */
export function nextPanelName(document: FloorspecDocument): string {
  const names = new Set(elementsOfExtension(document, 'FS_electrical', 'panels').map(([, p]) => p['name']));
  for (let n = 1; ; n++) if (!names.has(`P${String(n)}`)) return `P${String(n)}`;
}

function hostOp(host: HostRef): Json {
  switch (host.mode) {
    case 'wallFace':
      return { mode: 'wallFace', wall: host.wall, ...(host.toward !== undefined ? { toward: host.toward } : { side: host.side ?? 'right' }), at: host.at, height: host.height };
    case 'surface':
      return { mode: 'surface', room: host.room, surface: host.surface, at: host.at, ...(host.rotation === undefined || host.rotation === 0 ? {} : { rotation: host.rotation }) };
    case 'free':
      return { mode: 'free', level: host.level, at: host.at, ...(host.rotation === undefined || host.rotation === 0 ? {} : { rotation: host.rotation }) };
  }
}

/** Re-host a device (Ops 0.2 4.10): another wall, the other face, a new offset or height, another spot. */
export function moveDevice(id: string, host: HostRef): Batch {
  return [{ op: 'moveElement', element: id, host: hostOp(host) } as Operation];
}

/** Turn a floor or ceiling device, or one standing free: its host's rotation, in microdegrees. */
export function rotateDevice(id: string, rotation: number): Batch {
  const normal = ((Math.round(rotation) % 360_000_000) + 540_000_000) % 360_000_000 - 180_000_000;
  const value = normal === -180_000_000 ? 180_000_000 : normal;
  return value === 0 ? [{ op: 'unsetProperty', id, path: '/host/rotation' }] : [{ op: 'setProperty', id, path: '/host/rotation', value }];
}

// ─── Records ─────────────────────────────────────────────────────────────────────────────────

/** Every ID the document uses, in its one space of IDs (Core 3.1.3), records included. */
export function usedIds(document: FloorspecDocument): Set<string> {
  const used = new Set<string>();
  const doc = document as unknown as Json;
  for (const [key, c] of Object.entries(doc)) {
    if (key === 'extensions' || key === 'program' || !isObject(c)) continue;
    for (const k of Object.keys(c)) used.add(k);
  }
  const items = (document.program as Json | undefined)?.['items'];
  if (isObject(items)) for (const k of Object.keys(items)) used.add(k);
  for (const data of Object.values((document.extensions ?? {}) as Json)) {
    if (!isObject(data)) continue;
    const collections = data['collections'];
    if (isObject(collections)) for (const coll of Object.values(collections)) if (isObject(coll)) for (const k of Object.keys(coll)) used.add(k);
    for (const r of RECORD_COLLECTIONS) {
      const recs = data[r.collection];
      if (isObject(recs)) for (const k of Object.keys(recs)) used.add(k);
    }
  }
  return used;
}

/** The next free record ID with a prefix Ops never mints (C, K, G: each spec's 1.3). */
export function nextRecordId(document: FloorspecDocument, prefix: string, taken: ReadonlySet<string> = new Set()): string {
  const used = usedIds(document);
  for (let n = 1; ; n++) {
    const id = `${prefix}${String(n)}`;
    if (!used.has(id) && !taken.has(id)) return id;
  }
}

const recordPath = (extension: string, collection: string, id: string, member?: string) => `/extensions/${extension}/${collection}/${id}${member === undefined ? '' : `/${member}`}`;

export interface NewCircuit {
  panel: string;
  breaker: number;
  volts: number;
  poles?: 1 | 2 | 3;
  name?: string;
  protection?: ('gfci' | 'afci')[];
  loads?: string[];
  rating?: number;
}

/** The first run of `poles` free spaces on a panel, or undefined when none is left. */
export function freeSpace(document: FloorspecDocument, panel: string, poles: number): number | undefined {
  const spaces = Number(elementOfExtension(document, 'FS_electrical', 'panels', panel)?.['spaces'] ?? 0);
  const taken = new Set<number>();
  for (const [, c] of recordsOf(document, 'FS_electrical', 'circuits')) {
    if (c['panel'] !== panel || typeof c['space'] !== 'number') continue;
    const p = typeof c['poles'] === 'number' ? c['poles'] : 1;
    for (let s = c['space']; s < c['space'] + p; s++) taken.add(s);
  }
  for (let s = 1; s + poles - 1 <= spaces; s++) {
    let free = true;
    for (let k = s; k < s + poles; k++) if (taken.has(k)) free = false;
    if (free) return s;
  }
  return undefined;
}

/** Add a circuit to a panel, in the first free spaces, under the next free `C` ID. */
export function addCircuit(document: FloorspecDocument, c: NewCircuit, id = nextRecordId(document, 'C')): { id: string; ops: Batch } {
  const poles = c.poles ?? 1;
  const space = freeSpace(document, c.panel, poles);
  const value: Json = {
    panel: c.panel,
    breaker: c.breaker,
    volts: c.volts,
    ...(poles === 1 ? {} : { poles }),
    ...(c.rating === undefined ? {} : { rating: c.rating }),
    ...(c.protection === undefined || c.protection.length === 0 ? {} : { protection: c.protection }),
    ...(space === undefined ? {} : { space }),
    ...(c.loads === undefined || c.loads.length === 0 ? {} : { loads: c.loads }),
    ...(c.name === undefined || c.name === '' ? {} : { name: c.name }),
  };
  return { id, ops: [{ op: 'setProperty', id: '$document', path: recordPath('FS_electrical', 'circuits', id), value }] };
}

/** Set (or, with undefined, unset) one member of a record. */
export function setRecordMember(extension: string, collection: string, id: string, member: string, value: unknown): Batch {
  const path = recordPath(extension, collection, id, member);
  return value === undefined ? [{ op: 'unsetProperty', id: '$document', path }] : [{ op: 'setProperty', id: '$document', path, value }];
}

/**
 * Put an element on a circuit, or on none: off every other circuit that lists it, onto the chosen
 * one's `loads` (FS_electrical 3.2). A load stays on one panel (3.2.3), so moving it is one batch.
 */
export function assignCircuit(document: FloorspecDocument, element: string, circuit: string | null): Batch {
  const ops: Batch = [];
  for (const [cid, c] of recordsOf(document, 'FS_electrical', 'circuits')) {
    const loads = Array.isArray(c['loads']) ? (c['loads'] as string[]) : [];
    if (cid === circuit) {
      if (!loads.includes(element)) ops.push(...setRecordMember('FS_electrical', 'circuits', cid, 'loads', [...loads, element]));
    } else if (loads.includes(element)) {
      const rest = loads.filter((l) => l !== element);
      ops.push(...setRecordMember('FS_electrical', 'circuits', cid, 'loads', rest.length === 0 ? undefined : rest));
    }
  }
  return ops;
}

/** Add a stack on a level (FS_plumbing 3.1), under the next free `K` ID. */
export function addStack(document: FloorspecDocument, levels: string[], name?: string): { id: string; ops: Batch } {
  const id = nextRecordId(document, 'K');
  return { id, ops: [{ op: 'setProperty', id: '$document', path: recordPath('FS_plumbing', 'stacks', id), value: { levels, ...(name === undefined ? {} : { name }) } }] };
}

/** Add a gas source (FS_mechanical 3.1), under the next free `G` ID. */
export function addGasSource(document: FloorspecDocument, fuel: 'naturalGas' | 'propane', name?: string): { id: string; ops: Batch } {
  const id = nextRecordId(document, 'G');
  return { id, ops: [{ op: 'setProperty', id: '$document', path: recordPath('FS_mechanical', 'gasSources', id), value: { fuel, ...(name === undefined ? {} : { name }) } }] };
}

/** Set or unset a member of an extension element (Ops 2.3: a path relative to the element). */
export function setMember(id: string, member: string, value: unknown, present: boolean): Batch {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return present ? [{ op: 'unsetProperty', id, path: `/${member}` }] : [];
  return [{ op: 'setProperty', id, path: `/${member}`, value }];
}

// ─── Removal ─────────────────────────────────────────────────────────────────────────────────

/** Members of one extension element that name another element or a record. */
const REFERENCES: readonly { extension: string; member: string; list?: boolean; required?: boolean }[] = [
  { extension: 'FS_electrical', member: 'controls', list: true },
  { extension: 'FS_electrical', member: 'fedBy' },
  { extension: 'FS_plumbing', member: 'hotFrom' },
  { extension: 'FS_plumbing', member: 'drain' },
  { extension: 'FS_plumbing', member: 'stack', required: true },
  { extension: 'FS_mechanical', member: 'equipment' },
  { extension: 'FS_mechanical', member: 'gasFrom' },
  { extension: 'FS_lowvoltage', member: 'headEnd' },
  { extension: 'FS_lowvoltage', member: 'chime' },
];

/**
 * What else must change in the batch that removes `ids` (elements or records): Ops 0.2 does not
 * follow references inside an extension's members (Ops 0.5), and an applier that implements the
 * extension rejects a batch that leaves one dangling (FS_electrical 3.2 note, FS_plumbing 3.2
 * note). So every circuit's `loads`, every switch's `controls` and every `drain`, `hotFrom`,
 * `gasFrom`, `headEnd`, `chime`, `equipment` and `fedBy` that names one of them is cleared, a
 * panel's circuits go with it, and an element that cannot exist without the target (a cleanout
 * without its stack) is removed too.
 */
export function referenceCleanup(document: FloorspecDocument, ids: ReadonlySet<string>): { ops: Batch; alsoRemove: string[]; alsoRecords: string[] } {
  const ops: Batch = [];
  const alsoRemove: string[] = [];
  const gone = new Set(ids);
  // A panel takes its circuits with it.
  const circuits = recordsOf(document, 'FS_electrical', 'circuits');
  const alsoRecords = circuits.filter(([cid, c]) => !gone.has(cid) && typeof c['panel'] === 'string' && gone.has(c['panel'])).map(([cid]) => cid);
  for (const cid of alsoRecords) gone.add(cid);
  for (const [cid, c] of circuits) {
    if (gone.has(cid)) continue;
    const loads = Array.isArray(c['loads']) ? (c['loads'] as string[]) : [];
    if (loads.some((l) => gone.has(l))) {
      const rest = loads.filter((l) => !gone.has(l));
      ops.push(...setRecordMember('FS_electrical', 'circuits', cid, 'loads', rest.length === 0 ? undefined : rest));
    }
  }
  for (const [extension, data] of Object.entries((document.extensions ?? {}) as Json)) {
    const collections = isObject(data) ? data['collections'] : undefined;
    if (!isObject(collections)) continue;
    for (const coll of Object.values(collections)) {
      if (!isObject(coll)) continue;
      for (const [eid, el] of Object.entries(coll).sort(([a], [b]) => compareIds(a, b))) {
        if (gone.has(eid) || !isObject(el)) continue;
        for (const ref of REFERENCES) {
          if (ref.extension !== extension || el[ref.member] === undefined) continue;
          const value = el[ref.member];
          if (ref.list === true && Array.isArray(value)) {
            if (value.some((v) => gone.has(String(v)))) ops.push(...setMember(eid, ref.member, value.filter((v) => !gone.has(String(v))), true));
          } else if (typeof value === 'string' && gone.has(value)) {
            if (ref.required === true) alsoRemove.push(eid);
            else ops.push({ op: 'unsetProperty', id: eid, path: `/${ref.member}` });
          }
        }
      }
    }
  }
  return { ops, alsoRemove, alsoRecords };
}

/** Remove a device, and every reference to it, in one batch. */
export function removeDevice(document: FloorspecDocument, id: string): Batch {
  const cleanup = referenceCleanup(document, new Set([id]));
  return [
    ...cleanup.ops,
    ...cleanup.alsoRecords.map((cid) => ({ op: 'unsetProperty' as const, id: '$document', path: recordPath('FS_electrical', 'circuits', cid) })),
    ...cleanup.alsoRemove.map((eid) => ({ op: 'removeElement' as const, id: eid })),
    { op: 'removeElement', id },
  ];
}

/** Remove a record — a circuit, a stack, a gas source — and every reference to it. */
export function removeRecord(document: FloorspecDocument, extension: string, collection: string, id: string): Batch {
  const cleanup = referenceCleanup(document, new Set([id]));
  return [
    ...cleanup.ops,
    ...cleanup.alsoRemove.map((eid) => ({ op: 'removeElement' as const, id: eid })),
    { op: 'unsetProperty', id: '$document', path: recordPath(extension, collection, id) },
  ];
}
