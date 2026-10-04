import { useMemo } from 'react';
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { formatSquareFeet, twice } from '../projects/model';
import './plan.css';

/**
 * A small plan of one level, drawn straight from what `@floorspec/engine` derived: room polygons,
 * wall outlines, junction fills and openings. It is a picture, not the editor's canvas — no
 * interaction, no dimensions — and every colour is a design-system token, set in plan.css
 * (FLR-REQ-160).
 *
 * Floorspec's y axis points north; SVG's points down. Every y is flipped once, in the component, so
 * text stays upright and nothing is drawn mirrored.
 */

type Point = readonly [number, number];

interface Props {
  document: FloorspecDocument;
  derived: Derived;
  /** The level to draw. Defaults to the lowest. */
  level?: string | undefined;
  /** Room names and areas. Off on a card thumbnail, where they would be unreadable. */
  labels?: boolean;
  /** The accessible name. The plan is an image; its text is the summary beside it. */
  title: string;
  className?: string;
}

/** The long side of the drawing in SVG user units. Base units run to tens of millions, and browsers
 *  cap font sizes far below that, so the plan is drawn in a 1000-unit frame instead. */
const FRAME = 1000;

export function PlanThumbnail({ document, derived, level, labels = false, title, className }: Props) {
  const plan = useMemo(() => layout(document, derived, level), [document, derived, level]);
  if (plan === null) return null;
  const { box, rooms, walls, fills, openings, separators } = plan;
  const scale = Math.max(box.w, box.h) / FRAME;
  // Into the frame: origin at the top-left of the level's extent, y flipped once, here.
  const X = (p: Point) => (p[0] - box.x) / scale;
  const Y = (p: Point) => (box.y + box.h - p[1]) / scale;
  const pts = (ring: readonly Point[]) => ring.map((p) => `${X(p).toFixed(2)},${Y(p).toFixed(2)}`).join(' ');
  const pad = FRAME * 0.04;
  const viewBox = [-pad, -pad, box.w / scale + 2 * pad, box.h / scale + 2 * pad].map((n) => n.toFixed(2)).join(' ');
  const font = FRAME * 0.024;

  return (
    <svg className={['fs-plan', className].filter(Boolean).join(' ')} viewBox={viewBox} role="img" preserveAspectRatio="xMidYMid meet">
      <title>{title}</title>
      <g className="fs-plan__rooms">
        {rooms.map((room) => (
          <path key={room.id} d={[room.outer, ...room.holes].map((ring) => `M${pts(ring)}Z`).join('')} fillRule="evenodd" />
        ))}
      </g>
      <g className="fs-plan__separators">
        {separators.map((sep) => (
          <line key={sep.id} x1={X(sep.start)} y1={Y(sep.start)} x2={X(sep.end)} y2={Y(sep.end)} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      <g className="fs-plan__walls">
        {walls.map((wall) => <polygon key={wall.id} points={pts(wall.ring)} />)}
        {fills.map((fill) => <polygon key={fill.id} points={pts(fill.ring)} />)}
      </g>
      <g className="fs-plan__openings">
        {openings.map((o) => (
          <line
            key={o.id}
            className={o.kind === 'door' ? 'fs-plan__door' : 'fs-plan__window'}
            x1={X(o.start)}
            y1={Y(o.start)}
            x2={X(o.end)}
            y2={Y(o.end)}
            strokeWidth={(o.kind === 'door' ? o.thickness * 1.05 : o.thickness * 0.45) / scale}
          />
        ))}
      </g>
      {labels ? (
        <g className="fs-plan__labels">
          {rooms.map((room) => {
            const at = room.anchor;
            if (at === null) return null;
            return (
              <text key={room.id} x={X(at)} y={Y(at)} textAnchor="middle" style={{ fontSize: font }}>
                <tspan className="fs-plan__name">{room.name}</tspan>
                <tspan className="fs-plan__area" x={X(at)} dy={font * 1.3} style={{ fontSize: font * 0.85 }}>
                  {formatSquareFeet(room.area2)} ft²
                </tspan>
              </text>
            );
          })}
        </g>
      ) : null}
    </svg>
  );
}

interface Layout {
  box: { x: number; y: number; w: number; h: number };
  rooms: { id: string; name: string; outer: Point[]; holes: Point[][]; anchor: Point | null; area2: bigint }[];
  walls: { id: string; ring: Point[] }[];
  fills: { id: string; ring: Point[] }[];
  openings: { id: string; kind: 'door' | 'window'; start: Point; end: Point; thickness: number }[];
  /** Room separators (6.2): a boundary between rooms with no wall, drawn dashed. */
  separators: { id: string; start: Point; end: Point }[];
}

/** The lowest level, by elevation then ID — the one a plan opens on. */
export function firstLevel(document: FloorspecDocument): string | undefined {
  return Object.entries(document.levels ?? {})
    .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined)
    .sort(([a, la], [b, lb]) => la.elevation - lb.elevation || (a < b ? -1 : 1))[0]?.[0];
}

function layout(document: FloorspecDocument, derived: Derived, wanted: string | undefined): Layout | null {
  const level = wanted ?? firstLevel(document);
  if (level === undefined) return null;
  const onLevel = (id: string, collection: Record<string, { level: string } | undefined> | undefined) =>
    collection?.[id]?.level === level;

  const rooms = Object.entries(derived.rooms)
    .filter(([id]) => onLevel(id, document.rooms))
    .map(([id, room]) => {
      const source = document.rooms?.[id];
      return {
        id,
        name: source?.name ?? id,
        outer: room.outer,
        holes: room.holes,
        anchor: source === undefined ? null : source.anchor,
        area2: twice(room.area),
      };
    });
  for (const [i, free] of derived.unanchored.entries()) {
    if (free.level === level) rooms.push({ id: `unanchored-${String(i)}`, name: '', outer: free.outer, holes: free.holes, anchor: null, area2: twice(free.area) });
  }
  const walls = Object.entries(derived.walls)
    .filter(([id]) => onLevel(id, document.walls))
    .map(([id, w]) => ({ id, ring: [w.startRight, w.endRight, w.endLeft, w.startLeft] as Point[] }));
  const fills = Object.entries(derived.junctionFills)
    .filter(([id]) => onLevel(id, document.junctions))
    .map(([id, ring]) => ({ id, ring }));
  const openings = Object.entries(derived.openings)
    .filter(([id]) => {
      const wall = document.openings?.[id]?.wall;
      return wall !== undefined && onLevel(wall, document.walls);
    })
    .map(([id, o]) => {
      const source = document.openings?.[id];
      const fill = source?.fill;
      const kind: 'door' | 'window' = fill !== undefined && document.types?.[fill]?.kind === 'doorType' ? 'door' : 'window';
      const wall = source === undefined ? undefined : derived.walls[source.wall];
      if (wall === undefined || source === undefined) return { id, kind, start: o.start, end: o.end, thickness: 0 };
      const thickness = Math.hypot(wall.startLeft[0] - wall.startRight[0], wall.startLeft[1] - wall.startRight[1]);
      // An opening's points lie on the wall's reference line, which a justified wall need not be
      // centred on. Shift them onto the centre line — the midpoint of any segment between the two
      // faces lies on it — so the opening is drawn inside the wall, not straddling its face.
      const shift = centreOffset(wall, document.walls?.[source.wall], document);
      const move = (p: Point): Point => [p[0] + shift[0], p[1] + shift[1]];
      return { id, kind, start: move(o.start), end: move(o.end), thickness };
    });

  const position = (junction: string): Point | undefined => {
    const j = document.junctions?.[junction];
    return j === undefined ? undefined : j.position;
  };
  const separators = Object.entries(document.separators ?? {}).flatMap(([id, sep]) => {
    if (sep?.level !== level) return [];
    const start = position(sep.start);
    const end = position(sep.end);
    return start === undefined || end === undefined ? [] : [{ id, start, end }];
  });

  const all: Point[] = [...rooms.flatMap((r) => r.outer), ...walls.flatMap((w) => w.ring), ...fills.flatMap((f) => f.ring)];
  if (all.length === 0) return null;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { box: { x, y, w: Math.max(...xs) - x || 1, h: Math.max(...ys) - y || 1 }, rooms, walls, fills, openings, separators };
}

/** From a wall's reference line to its centre line, in base units. Zero if the wall cannot be read. */
function centreOffset(wall: Derived['walls'][string], source: { start: string; end: string } | undefined, document: FloorspecDocument): Point {
  const a = source === undefined ? undefined : document.junctions?.[source.start]?.position;
  const b = source === undefined ? undefined : document.junctions?.[source.end]?.position;
  if (a === undefined || b === undefined) return [0, 0];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return [0, 0];
  const m: Point = [(wall.startRight[0] + wall.startLeft[0]) / 2, (wall.startRight[1] + wall.startLeft[1]) / 2];
  const t = ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / len2;
  return [m[0] - (a[0] + t * dx), m[1] - (a[1] + t * dy)];
}
