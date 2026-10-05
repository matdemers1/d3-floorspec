/**
 * Stairs (Core 0.3, chapter 17), from their derived steps (17.5).
 *
 * Every tread and landing, in the order they are walked up, is a block of its outline from the top
 * of the piece two before it (the stair's bottom for the first two) up to its own top: two risers
 * deep, so consecutive pieces overlap by one riser along the edge they share and a flight is one
 * solid with a stepped soffit under it, never pieces that touch only along an edge. A flight's
 * treads are unioned by manifold-3d into one part; each landing is a part of its own.
 *
 * A winder or spiral stair, whose steps this draft does not derive (17.7), is a placeholder: its
 * box (17.4) as a block.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { get } from './own.js';
import { MeshBuilder, type P2 } from './builder.js';
import { scoped, type Kernel } from './kernel.js';
import type { RawPart } from './part.js';
import type { Box3 } from './types.js';

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
    const pieces = steps.map((st, k): Piece & { landing: boolean } => ({
      outline: st.outline,
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
