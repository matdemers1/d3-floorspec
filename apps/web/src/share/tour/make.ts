import { analyseProgram, deriveEvaluation, evaluate, OFFICIAL_READER, type Evaluation } from '@floorspec/engine';
import { savedViewsOf, tourRoomsByDefault } from '@floorspec/mesh';

/**
 * What the "Make a virtual tour" dialog (FLR-T-14.2, the board's "14.2 · Make a virtual tour") reads
 * from the model: every room — those a tour visits by default first, in the tour's order, then the
 * garages, closets and outdoors it leaves out — each with its level and the saved views standing in
 * it; and how many doorways a choice of rooms links (the engine's connected rooms, Core 11.4: a door,
 * an empty opening or a separator between them — where the worker puts the hotspots).
 */

export interface TourRoomRow {
  readonly id: string;
  readonly name: string;
  readonly level: string;
  readonly levelName: string;
  /** Toured unless a person says otherwise. */
  readonly byDefault: boolean;
  /** Saved views whose eye stands in the room: what it may be seen from instead of its centre. */
  readonly views: readonly { readonly id: string; readonly name: string }[];
}

export interface TourPlan {
  readonly rooms: readonly TourRoomRow[];
  /** Pairs of rooms that open into each other, each sorted. */
  readonly connected: readonly (readonly [string, string])[];
}

type Pt = readonly [number, number];

function inside(p: Pt, ring: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    const [xi, yi] = a;
    const [xj, yj] = b;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The tour's rooms of a document (its canonical JSON), in the design given; null when it cannot be read. */
export function tourPlanOf(text: string, design?: Record<string, string>): TourPlan | null {
  let ev: Evaluation;
  try {
    ev = evaluate(text, design === undefined || Object.keys(design).length === 0 ? OFFICIAL_READER : { ...OFFICIAL_READER, design });
  } catch {
    return null;
  }
  const doc = ev.view ?? ev.document;
  if (!ev.valid || doc === undefined) return null;
  let outlines = new Map<string, readonly Pt[]>();
  let connected: (readonly [string, string])[] = [];
  try {
    const derived = deriveEvaluation(ev);
    outlines = new Map(Object.entries(derived.rooms).map(([id, r]) => [id, r.outer as readonly Pt[]] as const));
    if (ev.analysis !== undefined) connected = analyseProgram(doc, ev.analysis).connected.map(([a, b]) => [a, b] as const);
  } catch {
    // A model with nothing derived still lists its rooms.
  }
  const views = savedViewsOf(ev.document ?? doc);
  const levels = doc.levels ?? {};
  // The level a view's eye is on: the highest whose floor is at or below it.
  const levelOfEye = (z: number): string | undefined =>
    Object.entries(levels)
      .filter(([, l]) => (l?.elevation ?? 0) <= z)
      .sort(([, a], [, b]) => (b?.elevation ?? 0) - (a?.elevation ?? 0))[0]?.[0];
  const toured = tourRoomsByDefault(doc);
  const order = new Map(Object.entries(levels).sort(([a, x], [b, y]) => (x?.elevation ?? 0) - (y?.elevation ?? 0) || (a < b ? -1 : 1)).map(([id], i) => [id, i]));
  const rest = Object.keys(doc.rooms ?? {})
    .filter((id) => !toured.includes(id))
    .sort((a, b) => (order.get(doc.rooms?.[a]?.level ?? '') ?? 0) - (order.get(doc.rooms?.[b]?.level ?? '') ?? 0) || (a < b ? -1 : 1));
  const rooms = [...toured, ...rest].flatMap((id): TourRoomRow[] => {
    const r = doc.rooms?.[id];
    if (r === undefined) return [];
    const ring = outlines.get(id);
    const level = levels[r.level];
    return [
      {
        id,
        name: r.name ?? id,
        level: r.level,
        levelName: level?.name ?? r.level,
        byDefault: toured.includes(id),
        views: ring === undefined ? [] : views.filter((v) => (v.level ?? levelOfEye(v.eye[2])) === r.level && inside([v.eye[0], v.eye[1]], ring)).map((v) => ({ id: v.id, name: v.name })),
      },
    ];
  });
  return { rooms, connected };
}

/** How many doorways join the rooms chosen: each pair of chosen rooms that open into each other, once. */
export function doorwaysLinked(plan: Pick<TourPlan, 'connected'>, chosen: ReadonlySet<string>): number {
  return plan.connected.filter(([a, b]) => chosen.has(a) && chosen.has(b)).length;
}

/** Base units an inch (FLR-ADR-004). */
const INCH = 32_512;

/** The eye heights the dialog offers, base units, by their words. */
export const EYE_HEIGHTS = [
  { value: 60 * INCH, label: `5′-0″` },
  { value: 63 * INCH, label: `5′-3″` },
  { value: 66 * INCH, label: `5′-6″` },
  { value: 69 * INCH, label: `5′-9″` },
  { value: 48 * INCH, label: `4′-0″ · seated` },
] as const;

/** What a panorama is made at, by its words. */
export const PANORAMAS = [
  { value: 'large:standard', label: '4096 × 2048 · path-traced' },
  { value: 'large:high', label: '4096 × 2048 · path-traced, finer' },
  { value: 'medium:standard', label: '2048 × 1024 · path-traced' },
  { value: 'small:draft', label: '1024 × 512 · draft' },
] as const;
