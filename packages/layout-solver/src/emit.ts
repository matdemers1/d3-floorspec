/**
 * Writing a layout as a Floorspec Ops batch (FLR-REQ-075: the solver emits only operations).
 *
 * The batch adds the types it uses, draws every segment of the plane graph as a wall (exterior
 * walls clockwise, located on their exterior face, so the footprint is the outside of the house)
 * or a separator, names each face with addRoom, and hosts the doors, cased openings and windows.
 * Junctions are not named: drawWall reuses the junction at a point or mints one (Ops 4.1). Walls,
 * rooms and types are named, with IDs minted the way Ops 1.5 mints them, so later operations in
 * the batch can refer to them.
 */
import type { Operation } from '@floorspec/ops';
import { DOOR_WIDTH, fits, marginAt, type Access, type DoorKind } from './access.js';
import { isExterior, insideOf, rw, rh, type Layout, type Seg, type Space } from './layout.js';
import { gBu, inBu } from './units.js';

/** IDs minted as Ops 1.5 mints them: the prefix and one more than the largest number in use. */
export class Ids {
  private readonly next = new Map<string, number>();
  constructor(private readonly used: ReadonlySet<string>) {}
  mint(prefix: string): string {
    let n = this.next.get(prefix);
    if (n === undefined) {
      n = 0;
      const re = new RegExp(`^${prefix}([0-9]+)$`);
      for (const id of this.used) {
        const m = re.exec(id);
        if (m) n = Math.max(n, Number(m[1]));
      }
    }
    n++;
    this.next.set(prefix, n);
    return `${prefix}${String(n)}`;
  }
}

export interface Target {
  /** The level drawn on: an existing one, or the ID the batch creates. */
  readonly level: string;
  /** Operations that create the building and level, when the document has none to draw on. */
  readonly prelude: readonly Operation[];
}

export interface Emitted {
  readonly batch: Operation[];
  /** Room ID of each space. */
  readonly roomIds: ReadonlyMap<string, string>;
  /** Wall ID of each walled segment. */
  readonly wallIds: ReadonlyMap<Seg, string>;
}

const LAYER = (inches: number, fn: string): Record<string, unknown> => ({ thickness: inBu(inches), function: fn });

const TYPES = {
  exterior: { kind: 'wallType', name: 'Exterior wall, 2x6 (7 1/4")', layers: [LAYER(0.75, 'finish'), LAYER(0.5, 'substrate'), LAYER(5.5, 'core'), LAYER(0.5, 'finish')] },
  interior: { kind: 'wallType', name: 'Interior partition, 2x4 (4 1/2")', layers: [LAYER(0.5, 'finish'), LAYER(3.5, 'core'), LAYER(0.5, 'finish')] },
  entry: { kind: 'doorType', name: "Entry door 3'-0\" x 6'-8\"", width: inBu(DOOR_WIDTH.entry), height: inBu(80) },
  passage: { kind: 'doorType', name: "Passage door 2'-8\" x 6'-8\"", width: inBu(DOOR_WIDTH.passage), height: inBu(80) },
  closet: { kind: 'doorType', name: "Closet door 2'-0\" x 6'-8\"", width: inBu(DOOR_WIDTH.closet), height: inBu(80) },
  garage: { kind: 'doorType', name: "Garage door 16'-0\" x 7'-0\"", width: inBu(DOOR_WIDTH.garage), height: inBu(84) },
  window: { kind: 'windowType', name: "Window 3'-0\" x 4'-0\"", width: inBu(36), height: inBu(48), sill: inBu(36) },
  wideWindow: { kind: 'windowType', name: "Window 5'-0\" x 4'-0\"", width: inBu(60), height: inBu(48), sill: inBu(36) },
} as const satisfies Record<string, Record<string, unknown>>;

type TypeName = keyof typeof TYPES;

const WINDOWED = new Set(['sleeping', 'living', 'dining', 'kitchen', 'office']);

/** A point of the grid, in base units. */
const P = (p: readonly [number, number]): [number, number] => [gBu(p[0]), gBu(p[1])];

/** The direction a segment's wall is drawn: exterior walls clockwise (outside on the left, Core §5.4). */
function oriented(seg: Seg): { from: readonly [number, number]; to: readonly [number, number] } {
  // `left` is above a horizontal segment and west of a vertical one, walking a → b.
  if (isExterior(seg) && seg.right === undefined) return { from: seg.b, to: seg.a };
  return { from: seg.a, to: seg.b };
}

/** Which side of a wall drawn from→to the centre of `space` is on. */
function sideOf(from: readonly [number, number], to: readonly [number, number], space: Space): 'left' | 'right' {
  const cx = (space.rect.x0 + space.rect.x1) / 2;
  const cy = (space.rect.y0 + space.rect.y1) / 2;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  return dx * (cy - from[1]) - dy * (cx - from[0]) > 0 ? 'left' : 'right';
}

const centred = (seg: Seg, widthBu: number): number => Math.floor((gBu(seg.length) - widthBu) / 2);

export interface EmitOptions {
  readonly windows: boolean;
  /** Set each room's `brief` (Core 0.2, 11.3) in the batch — for an Ops 0.2 applier. */
  readonly brief: boolean;
}

/** The batch that draws `layout` on the target level. */
export function emit(layout: Layout, segs: readonly Seg[], access: Access, target: Target, ids: Ids, options: EmitOptions): Emitted {
  const level = target.level;
  const byKey = new Map(layout.spaces.map((s) => [s.key, s]));
  const used = new Set<TypeName>(['exterior']);
  if (segs.some((s) => !isExterior(s) && !access.separators.has(s))) used.add('interior');
  used.add('entry');
  for (const c of access.conns) if (c.kind === 'door') used.add(c.door === 'closet' ? 'closet' : 'passage');
  if (access.garageDoor !== undefined) used.add('garage');

  // Windows: one per outside wall of a habitable room long enough to take it, away from the doors.
  const doorSegs = new Set<Seg>([access.entry.seg, ...(access.garageDoor ? [access.garageDoor.seg] : [])]);
  const windows: { seg: Seg; type: 'window' | 'wideWindow' }[] = [];
  if (options.windows)
    for (const seg of segs) {
      if (!isExterior(seg) || doorSegs.has(seg)) continue;
      const space = byKey.get(insideOf(seg))!;
      if (!WINDOWED.has(space.fn)) continue;
      const wide = (space.fn === 'living' || space.fn === 'dining') && fits(seg, 60 + 24);
      if (!wide && !fits(seg, 36 + 12)) continue;
      windows.push({ seg, type: wide ? 'wideWindow' : 'window' });
      used.add(wide ? 'wideWindow' : 'window');
    }

  const batch: Operation[] = [...target.prelude];
  const typeId = new Map<TypeName, string>();
  for (const name of Object.keys(TYPES) as TypeName[]) {
    if (!used.has(name)) continue;
    const id = ids.mint('T');
    typeId.set(name, id);
    batch.push({ op: 'addElement', collection: 'types', id, element: { ...TYPES[name] } });
  }

  const wallIds = new Map<Seg, string>();
  for (const seg of segs) {
    if (access.separators.has(seg)) continue;
    const { from, to } = oriented(seg);
    const id = ids.mint('W');
    wallIds.set(seg, id);
    const exterior = isExterior(seg);
    batch.push({
      op: 'drawWall',
      id,
      level,
      from: P(from),
      to: P(to),
      type: typeId.get(exterior ? 'exterior' : 'interior')!,
      ...(exterior ? { justification: 'exteriorFace' as const } : {}),
    });
  }
  for (const seg of segs) if (access.separators.has(seg)) batch.push({ op: 'drawSeparator', level, from: P(seg.a), to: P(seg.b) });

  const roomIds = new Map<string, string>();
  for (const s of layout.spaces) {
    const id = ids.mint('R');
    roomIds.set(s.key, id);
    const r = s.rect;
    batch.push({ op: 'addRoom', id, level, at: [gBu(r.x0 + r.x1) / 2, gBu(r.y0 + r.y1) / 2], name: access.names.get(s.key) ?? s.name, function: s.fn });
  }

  const door = (seg: Seg, kind: DoorKind, into: Space | undefined, centre: boolean, widthBu?: number): Operation => {
    const { from, to } = oriented(seg);
    const w = widthBu ?? inBu(DOOR_WIDTH[kind]);
    const at = centre ? centred(seg, w) : inBu(marginAt(from === seg.a ? seg.aOut : seg.bOut));
    const swing = into === undefined ? 'left' : sideOf(from, to, into);
    return {
      op: 'addOpening',
      wall: wallIds.get(seg)!,
      at,
      fill: typeId.get(kind === 'garage' ? 'garage' : kind)!,
      ...(widthBu === undefined ? {} : { width: widthBu }),
      ...(kind === 'garage' ? {} : { hinge: 'start' as const, swing }),
    };
  };
  // The front door swings in; on an exterior wall drawn clockwise, inside is the right.
  batch.push(door(access.entry.seg, 'entry', byKey.get(access.entry.space), true));
  if (access.garageDoor !== undefined) {
    const seg = access.garageDoor.seg;
    const w = Math.min(DOOR_WIDTH.garage, Math.floor((seg.length * 6 - 24) / 12) * 12);
    batch.push(door(seg, 'garage', undefined, true, inBu(w)));
  }
  for (const c of access.conns) {
    if (c.kind === 'open') continue;
    const seg = c.seg!;
    if (c.kind === 'cased') {
      const w = inBu(c.width!);
      batch.push({ op: 'addOpening', wall: wallIds.get(seg)!, at: centred(seg, w), width: w, height: inBu(80) });
      continue;
    }
    // A closet's door swings out into the room it opens off; every other door into its room.
    const into = byKey.get(c.into!)!;
    const swingInto = into.kind === 'closet' ? byKey.get(c.a) : into;
    batch.push(door(seg, c.door!, swingInto, false));
  }
  for (const w of windows) {
    const width = inBu(w.type === 'wideWindow' ? 60 : 36);
    batch.push({ op: 'addOpening', wall: wallIds.get(w.seg)!, at: centred(w.seg, width), fill: typeId.get(w.type)! });
  }
  if (options.brief)
    for (const s of layout.spaces)
      if (s.req !== undefined) batch.push({ op: 'setProperty', id: roomIds.get(s.key)!, path: '/brief', value: s.req.item });
  return { batch, roomIds, wallIds };
}

/** A room's plan dimensions, in feet, rounded to the half foot (for explanations). */
export const dims = (s: Space): string => `${String(rw(s.rect) / 2)}' x ${String(rh(s.rect) / 2)}'`;
