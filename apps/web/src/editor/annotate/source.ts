import { exteriorStrings, openingMarks, type AnnoSource, type DimString, type LabelClear, type AnnoRoom } from '@floorspec/render2d';
import type { EditorModel, LevelView } from '../model';
import { centroid, inFace } from '../geometry';

/**
 * The editor's level as render2d's dimensioning reads it (FLR-T-18.11): the same walls, fills,
 * openings and rooms the canvas draws, its rooms labelled where StyledRoomLabels labels them — so the
 * strings the canvas draws are the ones the PDF and the plan render draw.
 */

type Json = Record<string, unknown>;

const sources = new WeakMap<LevelView, AnnoSource>();

/** Where a room's label is: its polygon's centre when that is in the room, else its anchor (StyledRoomLabels). */
export function labelAt(room: LevelView['rooms'][number]): readonly [number, number] {
  const c = centroid(room.outer);
  return inFace(c, room) ? c : room.anchor;
}

export function annoSourceOfLevel(level: LevelView, document: EditorModel['document']): AnnoSource {
  const known = sources.get(level);
  if (known !== undefined) return known;
  const rooms = (document.rooms ?? {}) as Record<string, Json | undefined>;
  const src: AnnoSource = {
    walls: level.walls.map((w) => ({ id: w.id, outline: w.ring, start: w.a, end: w.b, a: w.left, b: w.right, arc: w.arc !== undefined })),
    fills: level.fills.map((f) => f.ring),
    openings: level.openings.map((o) => ({ id: o.id, wall: o.wall, kind: o.kind, start: o.start, end: o.end, swing: o.swing })),
    rooms: level.rooms.map((r) => {
      const name = rooms[r.id]?.['name'];
      return { id: r.id, title: typeof name === 'string' ? name : r.id, outer: r.outer, holes: r.holes, label: labelAt(r) };
    }),
  };
  sources.set(level, src);
  return src;
}

/** How much of the plan a room's label covers, screen pixels, as StyledRoomLabels draws it. */
export function labelClear(room: AnnoRoom, caps: boolean): LabelClear {
  const name = caps ? room.title.toUpperCase() : room.title;
  return { halfW: (name.length * (caps ? 7.4 : 6.9) + 16) / 2, halfH: 17 };
}

const exteriors = new WeakMap<LevelView, DimString[]>();

/** What the plan draws round a level, door swings and furniture outside included: the strings go beyond it. */
function extentOf(level: LevelView): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let b = level.bounds === null ? null : { ...level.bounds };
  const grow = (x: number, y: number): void => {
    if (b === null) b = { minX: x, minY: y, maxX: x, maxY: y };
    else b = { minX: Math.min(b.minX, x), minY: Math.min(b.minY, y), maxX: Math.max(b.maxX, x), maxY: Math.max(b.maxY, y) };
  };
  for (const d of level.devices) if (d.extension !== 'FS_landscape') for (const [x, y] of d.footprint) grow(x, y);
  // A door swinging out: its leaf's reach, a square of its width off the face.
  for (const o of level.openings) {
    if (o.kind !== 'door') continue;
    const w = Math.hypot(o.end[0] - o.start[0], o.end[1] - o.start[1]);
    for (const p of [o.start, o.end]) {
      grow(p[0] - w, p[1] - w);
      grow(p[0] + w, p[1] + w);
    }
  }
  return b;
}

/** A level's exterior strings, kept with the level (it is a new object whenever the model changes). */
export function exteriorOf(level: LevelView, document: EditorModel['document']): DimString[] {
  const known = exteriors.get(level);
  if (known !== undefined) return known;
  const extent = extentOf(level);
  const strings = extent === null ? [] : exteriorStrings(annoSourceOfLevel(level, document), extent);
  exteriors.set(level, strings);
  return strings;
}

const marksOf = new WeakMap<EditorModel, Map<string, string>>();

/** D1…, W1… over the whole model, levels by elevation (the drawings' marks). */
export function marks(model: EditorModel): Map<string, string> {
  const known = marksOf.get(model);
  if (known !== undefined) return known;
  const m = openingMarks([...model.levels].sort((a, b) => a.elevation - b.elevation || (a.id < b.id ? -1 : 1)).map((l) => ({ openings: l.openings })));
  marksOf.set(model, m);
  return m;
}
