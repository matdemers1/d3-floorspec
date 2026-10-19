/**
 * The clear floor at a stair's foot and head (FLR-T-12.11, moved here from @floorspec/mcp by
 * FLR-T-12.16 so the layout solver measures it as the MCP summary does). An application measure
 * of D3 Floorspec, like z765.ts: no chapter of Core defines it, and it is never a conformance value.
 *
 * From the stair's derived foot and head (Core 17.4) it walks its own level's floor, along the
 * walkline's first and last directions (17.5), to the first wall outline (the derived faces of
 * 5.4): backwards from the foot on the stair's `level`, onwards from the head on its `to` level.
 * Separators are not walls, so an open plan's floor runs on through them. Rounded once, to a base
 * unit; absent where no wall is met.
 */
import { deriveFrom, type Derived } from '../derive/derive.js';
import { OFFICIAL_READER } from '../extensions/reader.js';
import type { FloorspecDocument } from '../model/document.js';
import { evaluate, type ValidateOptions } from '../validate/validate.js';

type Pt = readonly [number, number];

/** A clear distance at a stair's foot or head: how far its own level's floor runs before a wall. */
export interface Landing {
  readonly stair: string;
  /** Clear floor beyond the head on the `to` level, and before the foot on the stair's level, along the way it is walked; absent where no wall is met. */
  readonly head?: number;
  readonly foot?: number;
}

const cross = (a: Pt, b: Pt): number => a[0] * b[1] - a[1] * b[0];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];

/** The distance along a ray from `o` in direction `u` to the first wall outline of a level; Infinity when none is met. */
function toWall(doc: FloorspecDocument, derived: Derived, level: string, o: Pt, u: Pt): number {
  let best = Infinity;
  for (const [id, w] of Object.entries(doc.walls ?? {})) {
    if (w === undefined || w.level !== level) continue;
    const d = derived.walls[id];
    if (d === undefined) continue;
    const ring: Pt[] = [d.startRight, ...(d.right ?? []), d.endRight, d.endLeft, ...[...(d.left ?? [])].reverse(), d.startLeft].map(([x, y]): Pt => [x, y]);
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]!;
      const b = ring[i]!;
      const e = sub(b, a);
      const den = cross(u, e);
      if (Math.abs(den) < 1e-12) continue;
      const ao = sub(a, o);
      const t = cross(ao, e) / den;
      const s = cross(ao, u) / den;
      if (t > 1 && s >= 0 && s <= 1) best = Math.min(best, t);
    }
  }
  return best;
}

/** The clear floor at each stair's foot and head, along its walkline's first and last directions; none for a document that is not valid. */
export function landings(input: string | Uint8Array | object, options: ValidateOptions = OFFICIAL_READER): Landing[] {
  const ev = evaluate(input, options);
  if (!ev.valid || !ev.analysis) return [];
  const doc = (ev.view ?? ev.document)!;
  const derived = deriveFrom(doc, ev.analysis);
  const out: Landing[] = [];
  for (const [id, st] of Object.entries(doc.stairs ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const d = derived.stairs?.[id];
    if (st === undefined || d === undefined) continue;
    const path: Pt[] = (d.walkline?.points ?? [d.foot, d.head]).map(([x, y]): Pt => [x, y]);
    if (path.length < 2) continue;
    const unit = (a: Pt, b: Pt): Pt => {
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    };
    const up = unit(path.at(-2)!, path.at(-1)!);
    const first = unit(path[0]!, path[1]!);
    const head = toWall(doc, derived, st.to, [d.head[0], d.head[1]], up);
    const foot = toWall(doc, derived, st.level, [d.foot[0], d.foot[1]], [-first[0], -first[1]]);
    out.push({ stair: id, ...(Number.isFinite(head) && { head: Math.round(head) }), ...(Number.isFinite(foot) && { foot: Math.round(foot) }) });
  }
  return out;
}
