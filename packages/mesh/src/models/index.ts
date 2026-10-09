/**
 * Procedural models of extension elements (FLR-T-12.21): what an outlet, a light, a toilet, a
 * counter, a sofa look like, drawn from what each element is and the box its author gave it —
 * instead of the plain box (Core 12.6) a reader without the extension draws. A mesh is not
 * normative (Core 0.5): these are this reader's pictures, fitted to the box and never outside it.
 *
 * One element's model may depend on another's in one way: a sink whose bowls lie inside a counter
 * top's outline, at its height, is set into it — the counter is cut for its bowls, the cabinet under
 * it kept clear of them, and the sink's rim taken to the counter's top.
 */
import { footprintsOverlap, type Derived, type ExtensionElement, type FloorspecDocument } from '@floorspec/engine';
import type { Kernel } from '../kernel.js';
import { MM, type Cutout, type Json, type Model, type ModelContext, type V2 } from './common.js';
import { alarm, LIGHTS, panel, receptacle, switchModel } from './electrical.js';
import { APPLIANCES, CASEWORK, PIECES } from './furniture.js';
import { elementKind } from './kinds.js';
import { GAS_APPLIANCES } from './mechanical.js';
import { BASIN_DEPTH, cutoutsOf, FIXTURES, rimIn, SINKS, waterHeater } from './plumbing.js';
import { corners, placer, Sketch, type Piece } from './sketch.js';

/** Extension → collection → its model, or a model for each kind of element in it. */
const MODELS: Readonly<Record<string, Readonly<Record<string, Model | Readonly<Record<string, Model>>>>>> = {
  FS_electrical: { receptacles: receptacle, switches: switchModel, panels: panel, alarms: alarm, lights: LIGHTS },
  FS_plumbing: { fixtures: FIXTURES, waterHeaters: waterHeater },
  FS_furniture: { pieces: PIECES, appliances: APPLIANCES, casework: CASEWORK },
  FS_mechanical: { gasAppliances: GAS_APPLIANCES },
};

/** The model an element of a collection is drawn with, or undefined: its fallback box then. */
export function modelOf(extension: string, collection: string, kind: string): Model | undefined {
  const c = Object.hasOwn(MODELS, extension) ? MODELS[extension]! : undefined;
  const m = c !== undefined && Object.hasOwn(c, collection) ? c[collection] : undefined;
  if (typeof m === 'function') return m;
  return m !== undefined && Object.hasOwn(m, kind) ? m[kind] : undefined;
}

/** The counters a sink can be set into. */
const COUNTERS: ReadonlySet<string> = new Set(['baseCabinet', 'island', 'vanity']);

interface Plan {
  kind: string;
  model: Model;
  element: Json;
  X: number;
  Y: number;
  Z: number;
  bottom: number;
  level: string;
  corners: ReturnType<typeof corners>;
  ctx: ModelContext;
  cutouts: Cutout[];
}

/**
 * Every modelled element's model, by ID, with what it needs to be drawn: its frame (corners of its
 * footprint), its box's extents, and — for counters and sinks — what each is set into or cut for.
 */
function plan(doc: FloorspecDocument, derived: Derived, elements: ReadonlyMap<string, { extension: string; collection: string; element: ExtensionElement }>): Map<string, Plan> {
  const out = new Map<string, Plan>();
  for (const id of Object.keys(derived.fallbacks ?? {}).sort()) {
    const f = derived.fallbacks![id]!;
    const e = elements.get(id);
    if (e === undefined || f.top <= f.bottom) continue;
    const element = e.element as unknown as Json;
    const kind = elementKind(e.extension, e.collection, element);
    const model = modelOf(e.extension, e.collection, kind);
    if (model === undefined) continue;
    const box = e.element.fallback.box;
    const X = box.max[0] - box.min[0];
    const Y = box.max[1] - box.min[1];
    const Z = box.max[2] - box.min[2];
    const originZ = -box.min[2] > 0 && -box.min[2] <= Z ? -box.min[2] : undefined;
    const cutouts: Cutout[] = [];
    out.set(id, { kind, model, element, X, Y, Z, bottom: f.bottom, level: f.level, corners: corners(f, derived.placements?.[id]?.facing), ctx: { kind, originZ, cutouts }, cutouts });
  }
  // Sinks into counters: a sink's bowls all inside a counter top's outline, the top within the sink's height.
  const counters = [...out.entries()].filter(([id, p]) => elements.get(id)!.collection === 'casework' && COUNTERS.has(p.kind));
  const holes = new Map<string, (readonly (readonly [number, number])[])[]>();
  for (const [id, sink] of out) {
    if (elements.get(id)!.extension !== 'FS_plumbing' || !SINKS.has(sink.kind)) continue;
    const at = placer(sink.corners, sink.bottom, sink.X, sink.Y, sink.Z);
    const outlines = cutoutsOf(sink.kind, sink.X, sink.Y).map((o) => o.map((p) => at(p[0], p[1], 0)).map((q): [number, number] => [q[0], q[1]]));
    for (const [cid, c] of counters) {
      if (c.level !== sink.level) continue;
      const top = c.bottom + c.Z;
      if (top <= sink.bottom || top > sink.bottom + sink.Z) continue;
      const [c00, c10, , c01] = c.corners;
      const ex = [c10[0] - c00[0], c10[1] - c00[1]];
      const ey = [c01[0] - c00[0], c01[1] - c00[1]];
      const lx = Math.hypot(ex[0]!, ex[1]!);
      const ly = Math.hypot(ey[0]!, ey[1]!);
      const local = (p: readonly [number, number]): V2 => [((p[0] - c00[0]) * ex[0]! + (p[1] - c00[1]) * ex[1]!) / lx, ((p[0] - c00[0]) * ey[0]! + (p[1] - c00[1]) * ey[1]!) / ly];
      const m = 5 * MM;
      const inside = outlines.every((o) => o.every((p) => {
        const [x, y] = local(p);
        return x >= m && x <= c.X - m && y >= m && y <= c.Y - m;
      }));
      const taken = holes.get(cid) ?? [];
      if (!inside || outlines.some((o) => taken.some((t) => footprintsOverlap(o, t)))) continue;
      const counter = top - sink.bottom;
      sink.ctx.counter = counter;
      const rim = rimIn(sink.Z, counter);
      const basin = sink.bottom + rim - Math.min(BASIN_DEPTH[sink.kind]!, rim);
      for (const o of outlines) c.cutouts.push({ outline: o.map(local), bottom: basin - c.bottom });
      holes.set(cid, [...taken, ...outlines]);
      break;
    }
  }
  return out;
}

export interface ElementModel {
  kind: string;
  pieces: Piece[];
}

/** Draw every modelled element's pieces, by ID. An element whose model draws nothing is left out (its box stands in). */
export function drawModels(kernel: Kernel, doc: FloorspecDocument, derived: Derived, elements: ReadonlyMap<string, { extension: string; collection: string; element: ExtensionElement }>): Map<string, ElementModel> {
  const out = new Map<string, ElementModel>();
  for (const [id, p] of plan(doc, derived, elements)) {
    const s = new Sketch(kernel, placer(p.corners, p.bottom, p.X, p.Y, p.Z), p.X, p.Y, p.Z);
    p.model(s, p.element, p.ctx);
    const pieces = s.pieces.filter((x) => x.b.tris.length > 0);
    if (pieces.length > 0) out.set(id, { kind: p.kind, pieces });
  }
  return out;
}
