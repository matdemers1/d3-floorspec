import type { Derived, FloorspecDocument } from '@floorspec/engine';
import type { EditorModel, LevelView, Point } from './model';
import type { Batch } from './ops';
import type { DeviceView } from './systems/view';
import { frameMotion, frameOf, hostAfterOps } from './arrange/carry';
import { halfOpen, type Xform } from './arrange/transform';

/**
 * The drag preview without a derive (FLR-T-18.18). Applying a batch and deriving the whole house
 * from it costs two full evaluations of the document — on the Courtyard House more than a frame at
 * 60 fps, every pointer move — yet a batch that only moves and turns devices changes nothing but
 * where they are: each one's footprint, envelopes and placement are its old ones taken by the rigid
 * motion of its host frame (Core 13.4, 13.5: a fallback box and its clearance envelopes are in that
 * frame). So such a batch is previewed by moving those, and only those, in a copy of the model that
 * shares everything else; the store runs the full apply once the pointer rests, for the findings.
 *
 * Null when the batch does anything else — moves a wall, resizes, adds — or a device's new frame
 * cannot be told from its host alone: the store then previews it the full way.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const MOVES = new Set(['moveElement', 'setProperty', 'unsetProperty']);

/** The rigid preview of `batch` on `model`, or null when the batch is not only devices moved on their level. */
export function rigidPreview(model: EditorModel, batch: Batch): EditorModel | null {
  if (batch.length === 0) return null;
  const where = new Map<string, { d: DeviceView; level: LevelView }>();
  for (const level of model.levels) for (const d of level.devices) where.set(d.id, { d, level });
  const byDevice = new Map<string, Batch>();
  for (const op of batch) {
    const o = op as unknown as Json;
    if (!MOVES.has(String(o['op']))) return null;
    const id = o['op'] === 'moveElement' ? o['element'] : o['id'];
    if (typeof id !== 'string' || !where.has(id)) return null;
    if (o['op'] !== 'moveElement') {
      const path = o['path'];
      if (typeof path !== 'string' || (path !== '/host' && !path.startsWith('/host/'))) return null;
    }
    byDevice.set(id, [...(byDevice.get(id) ?? []), op]);
  }
  const moved = new Map<string, { d: DeviceView; xf: Xform; host: Json; dz: number }>();
  for (const [id, ops] of byDevice) {
    const { d, level } = where.get(id) as { d: DeviceView; level: LevelView };
    const host = hostAfterOps(d.host, ops);
    if (host === 'unknown' || host === null || host['mode'] !== d.host?.['mode']) return null;
    if (host['mode'] === 'surface' && (host['surface'] !== d.host?.['surface'] || !level.rooms.some((r) => r.id === host['room']))) return null;
    if (host['mode'] === 'free' && host['level'] !== level.id) return null;
    const a = frameOf(level, d.host);
    const b = frameOf(level, host);
    if (a === null || b === null) return null;
    // A wall mount raised or lowered: its z, not its plan.
    const h0 = d.host?.['height'];
    const h1 = host['height'];
    const dz = host['mode'] === 'wallFace' && typeof h0 === 'number' && typeof h1 === 'number' ? h1 - h0 : 0;
    moved.set(id, { d, xf: frameMotion(a, b), host, dz });
  }
  return {
    ...model,
    hash: `${model.hash}~rigid`,
    document: withHosts(model, moved),
    derived: model.derived === null ? null : movedDerived(model.derived, moved),
    levels: model.levels.map((level) => (level.devices.some((d) => moved.has(d.id)) ? { ...level, devices: level.devices.map((d) => movedDevice(d, moved.get(d.id))) } : level)),
  };
}

const mapRing = (ring: readonly Point[], xf: Xform): [number, number][] => ring.map((p) => {
  const q = xf.map(p);
  return [q[0], q[1]];
});

function movedDevice(d: DeviceView, m: { xf: Xform; host: Json; dz: number } | undefined): DeviceView {
  if (m === undefined) return d;
  const { xf, host, dz } = m;
  return {
    ...d,
    element: { ...d.element, host },
    host,
    footprint: mapRing(d.footprint, xf),
    bottom: d.bottom + dz,
    top: d.top + dz,
    placement: d.placement === null ? null : { point: xf.map(d.placement.point), z: d.placement.z + dz, facing: halfOpen(d.placement.facing + xf.turn) },
    clearances: d.clearances.map((c) => ({ ...c, ring: mapRing(c.ring, xf) })),
  };
}

function movedDerived(derived: Derived, moved: ReadonlyMap<string, { xf: Xform; dz: number }>): Derived {
  const fallbacks = { ...derived.fallbacks };
  const placements = { ...derived.placements };
  const clearances = { ...derived.clearances };
  for (const [id, { xf, dz }] of moved) {
    const fb = fallbacks[id];
    if (fb !== undefined) fallbacks[id] = { ...fb, footprint: mapRing(fb.footprint, xf), bottom: fb.bottom + dz, top: fb.top + dz };
    const pl = placements[id];
    if (pl !== undefined) {
      const p = xf.map([pl.point[0], pl.point[1]]);
      placements[id] = { ...pl, point: [p[0], p[1], pl.point[2] + dz], facing: halfOpen(pl.facing + xf.turn) };
    }
    const cl = clearances[id];
    if (cl !== undefined) clearances[id] = Object.fromEntries(Object.entries(cl).map(([name, c]) => [name, { ...c, footprint: mapRing(c.footprint, xf), bottom: c.bottom + dz, top: c.top + dz }]));
  }
  return { ...derived, fallbacks, placements, clearances };
}

/** The document with each moved element's host replaced, sharing everything it does not touch. */
function withHosts(model: EditorModel, moved: ReadonlyMap<string, { host: Json }>): FloorspecDocument {
  const doc = model.document as unknown as Json;
  const extensions = isObject(doc['extensions']) ? { ...doc['extensions'] } : {};
  for (const [id, { host }] of moved) {
    const at = model.ext.get(id);
    if (at === undefined) continue;
    const data = extensions[at.extension];
    if (!isObject(data)) continue;
    const nested = isObject(data['collections']) && isObject(data['collections'][at.collection]) && Object.hasOwn(data['collections'][at.collection] as Json, id);
    const holder = nested ? (data['collections'] as Json)[at.collection] : data[at.collection];
    if (!isObject(holder) || !isObject(holder[id])) continue;
    const coll = { ...holder, [id]: { ...holder[id], host } };
    extensions[at.extension] = nested ? { ...data, collections: { ...(data['collections'] as Json), [at.collection]: coll } } : { ...data, [at.collection]: coll };
  }
  return { ...doc, extensions } as unknown as FloorspecDocument;
}
