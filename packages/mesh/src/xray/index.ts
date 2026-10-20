/**
 * X-ray (FLR-T-14.5): inside the walls — framing, insulation, plumbing, wiring and ducts — derived
 * deterministically from a valid document and what the engine derived from it.
 *
 * `xrayPlan(doc, derived)` is the derivation: every piece (in base units), every wall's layers and
 * framing and what runs in it, every run, the counts. It needs no WASM and is cheap enough to run
 * whenever the model changes. `xrayMeshes(plan, origin)` turns its pieces into a handful of
 * flat-shaded triangle lists — one per system, level and style — in Float32 metres about `origin`,
 * the same origin a HouseMesh is built about, so the two stand in the same place.
 *
 * The rules are each module's: framing.ts (walls), plumbing.ts, electrical.ts, ducts.ts. None is in
 * the standard: FS_plumbing, FS_electrical and FS_mechanical say what connects to what, not where it
 * runs, and Core's wall types carry no stud spacing. X-ray is a view, never a normative output
 * (FLR-ADR-056).
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import type { Vec3 } from '../types.js';
import { ductRuns } from './ducts.js';
import { electricalRuns } from './electrical.js';
import { wallFrames } from './frames.js';
import { frameWall } from './framing.js';
import { meshPieces } from './geometry.js';
import { plumbingRuns } from './plumbing.js';
import { byLevel } from './routes.js';
import type { XrayMesh, XrayPiece, XrayPlan, XrayWall } from './types.js';

export { XRAY_SYSTEMS, type FrameBox, type P3, type XrayFraming, type XrayMesh, type XrayPiece, type XrayPlan, type XrayRun, type XrayStyle, type XraySystem, type XrayWall } from './types.js';
export { DEFAULT_HEADER_DEPTH, DEFAULT_STUD_SPACING, DEFAULT_STUD_WIDTH, studLayout } from './framing.js';
export { RUN_HEIGHT } from './electrical.js';
export { DASH } from './geometry.js';

export function xrayPlan(doc: FloorspecDocument, derived: Derived): XrayPlan {
  const frames = wallFrames(doc, derived);
  const walls = byLevel(frames);
  const pieces: XrayPiece[] = [];
  const out: Record<string, XrayWall> = {};
  const lists = new Map<string, { supply: string[]; drain: string[]; vent: string[]; circuits: string[]; ducts: string[] }>();
  let studs = 0;
  let batts = 0;
  for (const f of frames.values()) {
    const w = frameWall(doc, derived, f);
    pieces.push(...w.pieces);
    studs += w.studs + w.kings + w.jacks + w.cripples;
    batts += w.batts;
    lists.set(f.id, { supply: [], drain: [], vent: [], circuits: [], ducts: [] });
    out[f.id] = {
      id: f.id,
      level: f.level,
      layers: f.layers.map((l) => ({ function: l.function, thickness: l.thickness, ...(l.material === undefined ? {} : { material: l.material }) })),
      thickness: f.layers.reduce((s, l) => s + l.thickness, 0),
      framing: w.framing,
      insulated: w.insulated,
      studs: w.studs,
      kings: w.kings,
      jacks: w.jacks,
      cripples: w.cripples,
      headers: w.headers,
      batts: w.batts,
      openings: w.openings,
      supply: [],
      drain: [],
      vent: [],
      circuits: [],
      ducts: [],
      devices: [],
    };
  }
  const plumbing = plumbingRuns(doc, derived, frames, walls);
  const electrical = electricalRuns(doc, derived, frames, walls);
  const ducts = ductRuns(doc, derived);
  const runs = [...plumbing.runs, ...electrical.runs, ...ducts.runs];
  pieces.push(...plumbing.pieces, ...electrical.pieces, ...ducts.pieces);
  for (const r of runs) {
    for (const w of r.walls) {
      const l = lists.get(w);
      if (l === undefined) continue;
      if (r.system === 'supply') l.supply.push(r.id);
      else if (r.kind === 'vent') l.vent.push(r.id);
      else if (r.system === 'drain') l.drain.push(r.id);
      else if (r.system === 'electrical') l.circuits.push(r.id);
      else l.ducts.push(r.id);
    }
  }
  for (const [id, l] of lists) {
    const w = out[id]!;
    out[id] = { ...w, supply: l.supply.sort(), drain: l.drain.sort(), vent: l.vent.sort(), circuits: l.circuits.sort(), ducts: l.ducts.sort(), devices: electrical.devices.get(id) ?? [] };
  }
  const count = (system: string, kind?: string) => runs.filter((r) => r.system === system && (kind === undefined || r.kind === kind)).length;
  return {
    pieces,
    walls: out,
    runs,
    counts: {
      studs,
      batts,
      supply: count('supply'),
      drain: count('drain', 'drain'),
      vents: count('drain', 'vent'),
      stacks: count('drain', 'stack'),
      circuits: count('electrical'),
      ducts: count('ducts'),
    },
  };
}

/** A plan's pieces as meshes, Float32 metres about `origin` (base units). */
export function xrayMeshes(plan: XrayPlan, origin: Vec3 = [0, 0, 0]): XrayMesh[] {
  return meshPieces(plan.pieces, origin);
}
