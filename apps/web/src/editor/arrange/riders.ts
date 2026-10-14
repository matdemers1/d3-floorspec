import type { LevelView, Point, Ring } from '../model';
import { centroid, inRing, signedArea } from '../geometry';
import type { DeviceView } from '../systems/view';

/**
 * What sits on an item (FLR-T-18.18): the things a move, a turn, a resize or a copy of it must take
 * along, or they are left floating where it was — the Courtyard House's cooktop left behind when its
 * island was dragged. One item carries another when
 *
 * - it is grouped with it: FS_furniture's `with` (4.3) — a cooktop set into an island, the nightstands
 *   by a bed. A grouped item on a wall face goes with an item on the same face only, as resizeElement
 *   moves its group (Ops 0.4, 4.11): a picture over a bed stays on its wall when the bed moves;
 * - it stands on its top: on the same floor (or free), the middle of its footprint inside the item's,
 *   and its bottom above the item's bottom and no higher than its top — a gas cooktop of FS_mechanical
 *   on the island, a sink set into a counter, a lamp on a nightstand;
 * - it is the same thing told twice: another extension's element at the same host point, turned the
 *   same way, with the same box — a dishwasher and its FS_plumbing fixture.
 *
 * Carrying is transitive (the lamp on the nightstand by the bed goes with the bed), and only ever
 * carries smaller things: what an item stands on (a rug) is never carried by it.
 */

/** How far above an item's top a thing may begin and still stand on it: 1 mm. */
const ON_TOP = 1_280;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const withOf = (d: DeviceView): string | null => (typeof d.element['with'] === 'string' ? d.element['with'] : null);
const modeOf = (d: DeviceView): string | null => (isObject(d.host) && typeof d.host['mode'] === 'string' ? d.host['mode'] : null);
const onFloor = (d: DeviceView): boolean => {
  const mode = modeOf(d);
  return mode === 'free' || (mode === 'surface' && d.host?.['surface'] !== 'ceiling');
};
const area = (r: Ring): number => Math.abs(signedArea(r));
const samePoint = (a: unknown, b: unknown): boolean => Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
const sameRing = (a: Ring, b: Ring): boolean => a.length === b.length && a.every((p, i) => Math.abs(p[0] - (b[i] as Point)[0]) <= 1 && Math.abs(p[1] - (b[i] as Point)[1]) <= 1);

/** Whether `d` goes with `carrier` when the carrier moves (see above). */
export function ridesOn(d: DeviceView, carrier: DeviceView): boolean {
  if (d.id === carrier.id || d.level !== carrier.level) return false;
  if (withOf(d) === carrier.id) {
    if (modeOf(d) !== 'wallFace') return true;
    const h = carrier.host;
    return modeOf(carrier) === 'wallFace' && h !== null && d.host?.['wall'] === h['wall'] && d.host?.['side'] === h['side'];
  }
  if (!onFloor(d) || !onFloor(carrier) || carrier.footprint.length < 3 || d.footprint.length < 3) return false;
  const twin =
    d.extension !== carrier.extension &&
    samePoint(d.host?.['position'], carrier.host?.['position']) &&
    (d.host?.['rotation'] ?? 0) === (carrier.host?.['rotation'] ?? 0) &&
    d.bottom === carrier.bottom &&
    d.top === carrier.top &&
    sameRing(d.footprint, carrier.footprint);
  if (twin) return true;
  if (!(d.bottom > carrier.bottom && d.bottom <= carrier.top + ON_TOP)) return false;
  if (area(d.footprint) >= area(carrier.footprint)) return false;
  return inRing(centroid(d.footprint), carrier.footprint);
}

/**
 * Everything that rides on `ids` on `level`, transitively, in level order — not `ids` themselves.
 * `except` are left where they are (moved some other way by the same edit).
 */
export function ridersOf(level: LevelView, ids: readonly string[], except: ReadonlySet<string> = new Set()): string[] {
  const byId = new Map(level.devices.map((d) => [d.id, d]));
  const taken = new Set<string>([...ids, ...except]);
  let frontier = ids.map((id) => byId.get(id)).filter((d): d is DeviceView => d !== undefined);
  const out: string[] = [];
  while (frontier.length > 0) {
    const next: DeviceView[] = [];
    for (const d of level.devices) {
      if (taken.has(d.id)) continue;
      if (frontier.some((c) => ridesOn(d, c))) {
        taken.add(d.id);
        out.push(d.id);
        next.push(d);
      }
    }
    frontier = next;
  }
  return out;
}

/** `ids` and everything riding on them: what a move, a turn or a copy of `ids` takes. */
export function withRiders(level: LevelView, ids: readonly string[], except: ReadonlySet<string> = new Set()): string[] {
  return [...ids, ...ridersOf(level, ids, except)];
}
