/**
 * Procedural models of extension elements (FLR-T-12.21): what an outlet, a light, a toilet, a
 * counter, a sofa look like, drawn from what each element is and the box its author gave it —
 * instead of the plain box (Core 12.6) a reader without the extension draws. A mesh is not
 * normative (Core 0.5): these are this reader's pictures, fitted to the box and never outside it.
 *
 * One element's model may depend on another's in one way: a sink whose bowls lie inside a counter
 * top's outline, at its height, is set into it — the counter is cut for its bowls, the cabinet under
 * it kept clear of them, and the sink's rim taken to the counter's top. A sink whose bowls straddle
 * counters side by side at one height (two base cabinets meeting under a window) is set into them
 * all alike: each top cut where the bowls cross it (FLR-T-12.31).
 */
import { footprintsOverlap, type Derived, type ExtensionElement, type FloorspecDocument } from '@floorspec/engine';
import { scoped, type Kernel } from '../kernel.js';
import { MM, type Cutout, type Json, type Model, type ModelContext, type V2 } from './common.js';
import { alarm, LIGHTS, panel, receptacle, switchModel } from './electrical.js';
import { DECOR, decorFamily, libraryItemOf, seedOf } from './decor.js';
import { APPLIANCES, CASEWORK, PIECES } from './furniture.js';
import { elementKind } from './kinds.js';
import { bed, hardscape, lawn, PLANTS } from './landscape.js';
import { GAS_APPLIANCES } from './mechanical.js';
import { OUTDOOR_MODELS } from './outdoor.js';
import { BASIN_DEPTH, cutoutsOf, FIXTURES, rimIn, SINKS, waterHeater } from './plumbing.js';
import { corners, placer, Sketch, type Piece } from './sketch.js';

/** Extension → collection → its model, or a model for each kind of element in it. */
const MODELS: Readonly<Record<string, Readonly<Record<string, Model | Readonly<Record<string, Model>>>>>> = {
  FS_electrical: { receptacles: receptacle, switches: switchModel, panels: panel, alarms: alarm, lights: LIGHTS },
  FS_plumbing: { fixtures: FIXTURES, waterHeaters: waterHeater },
  FS_furniture: { pieces: PIECES, appliances: APPLIANCES, casework: CASEWORK },
  FS_mechanical: { gasAppliances: GAS_APPLIANCES },
  FS_landscape: { plants: PLANTS, beds: bed, lawns: lawn, hardscape: { path: hardscape, steppingStones: hardscape, curb: hardscape, wall: hardscape } },
  FS_outdoor: OUTDOOR_MODELS,
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

/** How far inside a counter top's edge a sink's bowls stay. */
const MARGIN = 5 * MM;

/** The widest gap between two counter tops side by side that a sink is still set across: 10 mm. */
const GAP = 10 * MM;

/** How much of a sink's bowls may lie outside the counters it is set into, base units squared: 1 mm². */
const SLIVER = MM * MM;

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

/** A plan point in a counter's own frame: across its depth from its back, along its width from its right. */
function local(c: Plan, p: V2): V2 {
  const [c00, c10, , c01] = c.corners;
  const ex = [c10[0] - c00[0], c10[1] - c00[1]] as const;
  const ey = [c01[0] - c00[0], c01[1] - c00[1]] as const;
  const lx = Math.hypot(ex[0], ex[1]);
  const ly = Math.hypot(ey[0], ey[1]);
  return [((p[0] - c00[0]) * ex[0] + (p[1] - c00[1]) * ex[1]) / lx, ((p[0] - c00[0]) * ey[0] + (p[1] - c00[1]) * ey[1]) / ly];
}

/** Whether a plan point is on a counter's top, at least MARGIN inside its edge. */
function within(c: Plan, p: V2): boolean {
  const [x, y] = local(c, p);
  return x >= MARGIN && x <= c.X - MARGIN && y >= MARGIN && y <= c.Y - MARGIN;
}

/**
 * The counters a sink straddles: of those whose tops stand at one height, side by side — touching,
 * or no more than GAP apart — the ones its bowls cross, when the bowls lie within their tops taken
 * together (MARGIN inside the run's outer edge, wherever two tops meet). None when no run holds them:
 * a sink partly over no counter keeps its own deck.
 */
function across(kernel: Kernel, under: readonly (readonly [string, Plan])[], outlines: readonly V2[][]): (readonly [string, Plan])[] {
  const heights = [...new Set(under.map(([, c]) => c.bottom + c.Z))];
  const ring = (c: Plan): [number, number][] => {
    const r = c.corners.map((p): [number, number] => [p[0], p[1]]);
    const a = r.reduce((s, p, i) => s + p[0] * r[(i + 1) % 4]![1] - r[(i + 1) % 4]![0] * p[1], 0);
    return a < 0 ? r.reverse() : r;
  };
  for (const h of heights) {
    const run = under.filter(([, c]) => c.bottom + c.Z === h);
    const crossed = scoped((keep) => {
      const tops = run.map(([, c]) => keep(new kernel.CrossSection([ring(c)])));
      // Each top grown by half the gap, so neighbours join, then the whole shrunk past that by MARGIN.
      const joined = keep(kernel.CrossSection.union(tops.map((t) => keep(t.offset(GAP / 2, 'Miter')))));
      const inner = keep(joined.offset(-(GAP / 2 + MARGIN), 'Miter'));
      const bowls = keep(new kernel.CrossSection(outlines.map((o) => o.map((p): [number, number] => [p[0], p[1]])), 'NonZero'));
      if (keep(bowls.subtract(inner)).area() > SLIVER) return undefined;
      return run.filter((_, i) => keep(bowls.intersect(tops[i]!)).area() > SLIVER);
    });
    if (crossed !== undefined && crossed.length > 0) return crossed;
  }
  return [];
}

/**
 * Every modelled element's model, by ID, with what it needs to be drawn: its frame (corners of its
 * footprint), its box's extents, and — for counters and sinks — what each is set into or cut for.
 */
function plan(kernel: Kernel, doc: FloorspecDocument, derived: Derived, elements: ReadonlyMap<string, { extension: string; collection: string; element: ExtensionElement }>): Map<string, Plan> {
  const out = new Map<string, Plan>();
  for (const id of Object.keys(derived.fallbacks ?? {}).sort()) {
    const f = derived.fallbacks![id]!;
    const e = elements.get(id);
    if (e === undefined || f.top <= f.bottom) continue;
    const element = e.element as unknown as Json;
    // Decor (FLR-T-13.11): an `other` piece placed from the starter library is drawn as its item's family.
    const decor = e.extension === 'FS_furniture' && element['category'] === 'other' ? decorFamily(libraryItemOf(doc, element)) : undefined;
    const kind = decor ?? elementKind(e.extension, e.collection, element);
    const model = decor !== undefined ? DECOR[decor] : modelOf(e.extension, e.collection, kind);
    if (model === undefined) continue;
    const box = e.element.fallback.box;
    const X = box.max[0] - box.min[0];
    const Y = box.max[1] - box.min[1];
    const Z = box.max[2] - box.min[2];
    const originZ = -box.min[2] > 0 && -box.min[2] <= Z ? -box.min[2] : undefined;
    const cutouts: Cutout[] = [];
    out.set(id, { kind, model, element, X, Y, Z, bottom: f.bottom, level: f.level, corners: corners(f, derived.placements?.[id]?.facing), ctx: { kind, originZ, cutouts, seed: seedOf(typeof element['with'] === 'string' ? element['with'] : id) }, cutouts });
  }
  // Sinks into counters: a sink's bowls all inside one counter top's outline, the top within the
  // sink's height — or, failing that, inside the counter tops side by side at that one height.
  const counters = [...out.entries()].filter(([id, p]) => elements.get(id)!.collection === 'casework' && COUNTERS.has(p.kind));
  const holes = new Map<string, V2[][]>();
  for (const [id, sink] of out) {
    if (elements.get(id)!.extension !== 'FS_plumbing' || !SINKS.has(sink.kind)) continue;
    const at = placer(sink.corners, sink.bottom, sink.X, sink.Y, sink.Z);
    const outlines = cutoutsOf(sink.kind, sink.X, sink.Y).map((o) => o.map((p) => at(p[0], p[1], 0)).map((q): V2 => [q[0], q[1]]));
    const free = ([cid]: readonly [string, Plan]): boolean => !outlines.some((o) => (holes.get(cid) ?? []).some((t) => footprintsOverlap(o, t)));
    const under = counters.filter(([, c]) => c.level === sink.level && c.bottom + c.Z > sink.bottom && c.bottom + c.Z <= sink.bottom + sink.Z);
    const one = under.find((c) => free(c) && outlines.every((o) => o.every((p) => within(c[1], p))));
    const into = one !== undefined ? [one] : across(kernel, under.filter(free), outlines);
    if (into.length === 0) continue;
    const top = into[0]![1].bottom + into[0]![1].Z;
    const counter = top - sink.bottom;
    sink.ctx.counter = counter;
    const rim = rimIn(sink.Z, counter);
    const basin = sink.bottom + rim - Math.min(BASIN_DEPTH[sink.kind]!, rim);
    for (const [cid, c] of into) {
      for (const o of outlines) c.cutouts.push({ outline: o.map((p) => local(c, p)), bottom: basin - c.bottom });
      holes.set(cid, [...(holes.get(cid) ?? []), ...outlines]);
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
  for (const [id, p] of plan(kernel, doc, derived, elements)) {
    const s = new Sketch(kernel, placer(p.corners, p.bottom, p.X, p.Y, p.Z), p.X, p.Y, p.Z);
    p.model(s, p.element, p.ctx);
    const pieces = s.pieces.filter((x) => x.b.tris.length > 0);
    if (pieces.length > 0) out.set(id, { kind: p.kind, pieces });
  }
  return out;
}
