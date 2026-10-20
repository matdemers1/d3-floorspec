import type { FrameBox, Vec3, XrayPlan, XrayRun } from '@floorspec/mesh';
import type { FloorspecDocument } from '@floorspec/engine';
import { prettyLen, type UnitSystem } from '../../units';

/**
 * X-ray's callouts on the selected wall (FLR-T-14.5, the board's leader labels over the kitchen wall):
 * its framing ("2×6 @ 1′-4″"), each fixture's supply ("½″ supply · cold · hot") and drain ("2″ drain ·
 * 1½″ vent"), and each circuit with a device on it ("Circuit C7 · 20 A" and its name) — pinned to
 * where each is, in metres about the mesh's origin.
 */

export interface XrayLabel {
  readonly key: string;
  readonly title: string;
  readonly sub: string;
  /** Metres about the mesh's origin. */
  readonly at: Vec3;
}

const INCH = 32_512;
/** A 2x's trade name from its actual depth: 3½″ is a 2×4, 5½″ a 2×6, 7¼″ a 2×8 … */
const TRADE: ReadonlyMap<number, string> = new Map([
  [3.5 * INCH, '2×4'],
  [5.5 * INCH, '2×6'],
  [7.25 * INCH, '2×8'],
  [9.25 * INCH, '2×10'],
  [11.25 * INCH, '2×12'],
]);

/** The middle of a frame box's top, base units. */
function topOf(b: FrameBox): Vec3 {
  const a = (b.a[0] + b.a[1]) / 2;
  const v = (b.b[0] + b.b[1]) / 2;
  return [b.o[0] + a * b.u[0] - v * b.u[1], b.o[1] + a * b.u[1] + v * b.u[0], b.z[1]];
}
const centreOf = (b: FrameBox): Vec3 => {
  const t = topOf(b);
  return [t[0], t[1], (b.z[0] + b.z[1]) / 2];
};

export function wallLabels(plan: XrayPlan, doc: FloorspecDocument, wall: string, origin: Vec3, units: UnitSystem, name: (id: string) => string): XrayLabel[] {
  const w = plan.walls[wall];
  if (w === undefined) return [];
  const m = ([x, y, z]: readonly [number, number, number]): Vec3 => [(x - origin[0]) / 1_280_000, (y - origin[1]) / 1_280_000, (z - origin[2]) / 1_280_000];
  const out: XrayLabel[] = [];
  // The framing, over the middle of its top plate.
  const plate = plan.pieces.filter((p) => p.wall === wall && p.part === 'plate' && p.shape === 'box').map((p) => (p.shape === 'box' ? p.box : null)).filter((b): b is FrameBox => b !== null).sort((a, b) => b.z[1] - a.z[1] || (b.a[1] - b.a[0]) - (a.a[1] - a.a[0]))[0];
  const f = w.framing;
  if (plate !== undefined && f.system === 'studs' && f.member !== undefined && f.spacing !== undefined) {
    const member = f.member.designation ?? TRADE.get(f.member.depth) ?? prettyLen(f.member.depth, units);
    out.push({ key: `framing:${wall}`, title: `${member} @ ${prettyLen(f.spacing, units)}`, sub: `${name(wall)} · ${String(w.studs + w.kings + w.jacks + w.cripples)} studs`, at: m(topOf(plate)) });
  }
  // Each fixture's supply and drain in it.
  const runs = new Map(plan.runs.map((r) => [r.id, r]));
  const owners = [...new Set([...w.supply, ...w.drain].map((id) => runs.get(id)?.owner).filter((o): o is string => o !== undefined))].sort();
  for (const owner of owners) {
    const supply = w.supply.map((id) => runs.get(id)).filter((r): r is XrayRun => r?.owner === owner);
    const first = supply[0];
    const end = first?.points[first.points.length - 1];
    if (first !== undefined && end !== undefined) out.push({ key: `supply:${owner}`, title: `${prettyLen(first.size, units)} supply`, sub: supply.map((r) => r.kind).sort().join(' · '), at: m(end) });
    const drain = runs.get(`${owner}:drain`);
    const start = drain?.points[0];
    if (drain !== undefined && start !== undefined && w.drain.includes(drain.id)) {
      const vent = runs.get(`${owner}:vent`);
      out.push({ key: `drain:${owner}`, title: `${prettyLen(drain.size, units)} drain${vent === undefined ? '' : ` · ${prettyLen(vent.size, units)} vent`}`, sub: name(owner), at: m(start) });
    }
  }
  // Each circuit with a device on it, at its first device's box.
  const circuits = (doc.extensions as Record<string, { circuits?: Record<string, { name?: string }> }> | undefined)?.['FS_electrical']?.circuits ?? {};
  for (const cid of w.circuits) {
    const box = plan.pieces.find((p) => p.shape === 'box' && p.part === 'box' && p.owner === cid && p.wall === wall);
    if (box === undefined || box.shape !== 'box') continue;
    const r = runs.get(cid);
    out.push({ key: `circuit:${cid}`, title: `Circuit ${cid}${r?.amps === undefined ? '' : ` · ${String(r.amps)} A`}`, sub: circuits[cid]?.name ?? '', at: m(centreOf(box.box)) });
  }
  return out;
}
