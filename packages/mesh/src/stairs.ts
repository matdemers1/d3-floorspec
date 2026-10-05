/**
 * Stairs (Core 0.3 and 0.4, chapter 17), from their derived steps (17.5, 17.7).
 *
 * Every tread and landing, in the order they are walked up, is a block of its outline from the top
 * of the piece two before it (the stair's bottom for the first two) up to its own top: two risers
 * deep, so consecutive pieces overlap by one riser along the edge they share and a flight is one
 * solid with a stepped soffit under it, never pieces that touch only along an edge. A flight's
 * treads are unioned by manifold-3d into one part; each landing is a part of its own.
 *
 * A winder stair's winders are treads like any other, so its two flights and the winders between
 * them are one solid; a spiral stair's treads are one solid too, wound round its centre column — a
 * cylinder of its column's radius, the space its treads leave (Core 17.7), or a slender pole where
 * they meet at the centre — from its bottom to its top. A winder or spiral stair whose steps are not
 * derived (read as a Core 0.3 reader reads it) is a placeholder: its box (17.4) as a block.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { get } from './own.js';
import { MeshBuilder, type P2 } from './builder.js';
import { scoped, type Kernel } from './kernel.js';
import type { RawPart } from './part.js';
import type { Box3 } from './types.js';

/** How many sides a spiral stair's column is drawn with: a mesh is not normative (Core 0.5), and 32 reads as round. */
const COLUMN_SIDES = 32;
/** The radius of the pole a spiral stair whose treads meet at its centre is drawn round: 1 in. */
const POLE = 32_512;

interface Piece {
  outline: P2[];
  lo: number;
  top: number;
}

function boxOf(pieces: readonly Piece[]): Box3 {
  const xs = pieces.flatMap((p) => p.outline.map((q) => q[0]));
  const ys = pieces.flatMap((p) => p.outline.map((q) => q[1]));
  return {
    min: [Math.min(...xs), Math.min(...ys), Math.min(...pieces.map((p) => p.lo))],
    max: [Math.max(...xs), Math.max(...ys), Math.max(...pieces.map((p) => p.top))],
  };
}

/**
 * An outline counter-clockwise, as extrusion wants it. Core gives a step's outline its vertices in
 * order but not a winding: a stair turning right, whose treads are mirrored (17.7), winds the other way.
 */
function counterClockwise(outline: readonly P2[]): P2[] {
  let twice = 0;
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]!;
    const [x1, y1] = outline[(i + 1) % outline.length]!;
    twice += x0 * y1 - x1 * y0;
  }
  return twice < 0 ? [...outline].reverse() : [...outline];
}

/**
 * A tread's outline with the point tapered treads meet at (sharedCentre) cut back by POLE along each
 * of the two edges that meet there — a spiral without a column is drawn round a pole there. Treads
 * that share that vertex touch along its vertical alone, and the boolean union does not join them
 * there. Each cut point is rounded from its own edge's far end,
 * so two treads that share an edge share the point. An outline without the centre is unchanged.
 */
export function clearOfPole(outline: readonly P2[], centre: P2): P2[] {
  const out: P2[] = [];
  const toward = (q: P2): P2 => {
    const dx = q[0] - centre[0];
    const dy = q[1] - centre[1];
    const len = Math.hypot(dx, dy);
    return [centre[0] + Math.round((POLE * dx) / len), centre[1] + Math.round((POLE * dy) / len)];
  };
  outline.forEach((v, i) => {
    if (v[0] !== centre[0] || v[1] !== centre[1]) {
      out.push(v);
      return;
    }
    out.push(toward(outline[(i + outline.length - 1) % outline.length]!), toward(outline[(i + 1) % outline.length]!));
  });
  return out;
}

/**
 * The point a stair's tapered treads all meet at, which the mesh cuts them back from (clearOfPole):
 * a spiral's centre when its treads reach it (no column), or the pivot of a winder stair without a
 * newel — the vertex its winders share, when it has two or more. Undefined for every other stair.
 */
export function sharedCentre(st: { width: number; form?: { kind: string; diameter?: number } | undefined }, s: NonNullable<Derived['stairs']>[string] | undefined): P2 | undefined {
  if (s?.steps === undefined) return undefined;
  if (st.form?.kind === 'spiral') return s.centre !== undefined && (st.form.diameter ?? 0) / 2 - st.width <= 0 ? s.centre : undefined;
  if (st.form?.kind !== 'winder') return undefined;
  const winders = s.steps.filter((x) => x.winder === true);
  if (winders.length < 2) return undefined;
  const key = (p: readonly number[]): string => `${String(p[0])},${String(p[1])}`;
  let common = new Set(winders[0]!.outline.map(key));
  for (const w of winders.slice(1)) common = new Set(w.outline.map(key).filter((k) => common.has(k)));
  const [only] = [...common];
  if (common.size !== 1 || only === undefined) return undefined;
  const [x, y] = only.split(',').map(Number) as [number, number];
  return [x, y];
}

/**
 * Tapered treads' outlines with their T-junctions healed: where a vertex of one tread lies on — or,
 * its coordinates rounded (Core 17.7), within a base unit of — an edge of the tread before or after
 * it, the vertex is inserted into that edge too, so that the two blocks share the face between them
 * exactly. Rounding a winder's ends on a rotated stair leaves them a fraction of a unit off their
 * neighbour's nosing line, and the boolean union does not join faces that do not meet.
 */
export function healTJunctions(outlines: readonly (readonly P2[])[]): P2[][] {
  const out = outlines.map((o) => [...o]);
  const insert = (into: P2[], from: readonly P2[]): void => {
    for (const v of from) {
      if (into.some((q) => q[0] === v[0] && q[1] === v[1])) continue;
      for (let i = 0; i < into.length; i++) {
        const a = into[i]!;
        const b = into[(i + 1) % into.length]!;
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const len2 = ex * ex + ey * ey;
        const t = (v[0] - a[0]) * ex + (v[1] - a[1]) * ey;
        if (len2 === 0 || t <= 0 || t >= len2) continue;
        const cross = ex * (v[1] - a[1]) - ey * (v[0] - a[0]);
        if (cross * cross >= len2) continue; // a base unit or more from the edge
        into.splice(i + 1, 0, [v[0], v[1]]);
        break;
      }
    }
  };
  for (let k = 0; k + 1 < out.length; k++) {
    insert(out[k]!, out[k + 1]!);
    insert(out[k + 1]!, out[k]!);
  }
  return out;
}

/**
 * The outline each of a stair's steps is extruded from, counter-clockwise: its derived outline, and
 * for a winder or spiral stair, cut back from the point its treads meet at (clearOfPole) and with its
 * T-junctions healed (healTJunctions).
 */
export function treadOutlines(st: { width: number; form?: { kind: string; diameter?: number } | undefined }, s: NonNullable<Derived['stairs']>[string]): P2[][] {
  const steps = s.steps ?? [];
  const tapered = st.form?.kind === 'winder' || st.form?.kind === 'spiral';
  if (!tapered) return steps.map((x) => counterClockwise(x.outline));
  const pole = sharedCentre(st, s);
  return healTJunctions(steps.map((x) => counterClockwise(pole === undefined ? x.outline : clearOfPole(x.outline, pole))));
}

export function stairParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean): RawPart[] {
  const out: RawPart[] = [];
  const { Manifold } = kernel;
  for (const id of Object.keys(derived.stairs ?? {}).sort()) {
    const s = derived.stairs![id]!;
    const level = get(doc.stairs, id)!.level;
    if (!s.steps) {
      if (!want('stairBlock')) continue;
      const { min, max } = s.box;
      const b = new MeshBuilder(kernel);
      b.prism([[[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]]], min[2], max[2]);
      out.push({ kind: 'stairBlock', id, level, closed: true, placeholder: true, exact: b });
      continue;
    }
    const steps = s.steps;
    const outlines = treadOutlines(get(doc.stairs, id)!, s);
    const pieces = steps.map((st, k): Piece & { landing: boolean } => ({
      outline: outlines[k]!,
      lo: k >= 2 ? steps[k - 2]!.top : s.bottom,
      top: st.top,
      landing: st.landing === true,
    }));
    let flight: Piece[] = [];
    let flights = 0;
    let landings = 0;
    const flush = (): void => {
      if (!flight.length) return;
      flights++;
      if (want('stairFlight')) {
        const o = flight[0]!.outline[0]!;
        const origin = [o[0], o[1], s.bottom] as const;
        const manifold = scoped((keep) =>
          Manifold.union(
            flight.map((p) =>
              keep(keep(Manifold.extrude([p.outline.map((q): [number, number] => [q[0] - o[0], q[1] - o[1]])], p.top - p.lo)).translate(0, 0, p.lo - s.bottom)),
            ),
          ),
        );
        out.push({ kind: 'stairFlight', id, level, piece: `flight${flights}`, closed: true, manifold, origin, box: boxOf(flight) });
      }
      flight = [];
    };
    const st = get(doc.stairs, id)!;
    if (st.form?.kind === 'spiral' && s.centre !== undefined && want('stairColumn')) {
      const r = st.form.diameter / 2 - st.width;
      const radius = r > 0 ? r : POLE;
      const [cx, cy] = s.centre;
      const ring: P2[] = Array.from({ length: COLUMN_SIDES }, (_, i) => {
        const a = (2 * Math.PI * i) / COLUMN_SIDES;
        return [Math.round(cx + radius * Math.cos(a)), Math.round(cy + radius * Math.sin(a))];
      });
      const b = new MeshBuilder(kernel);
      b.prism([ring], s.bottom, s.top);
      out.push({ kind: 'stairColumn', id, level, piece: 'column', closed: true, exact: b });
    }
    for (const p of pieces) {
      if (!p.landing) {
        flight.push(p);
        continue;
      }
      flush();
      landings++;
      if (want('stairLanding')) {
        const b = new MeshBuilder(kernel);
        b.prism([p.outline], p.lo, p.top);
        out.push({ kind: 'stairLanding', id, level, piece: `landing${landings}`, closed: true, exact: b });
      }
    }
    flush();
  }
  return out;
}
