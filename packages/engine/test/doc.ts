/** A small builder for test documents: one building, one level, walls by [start, end]. */

export type P = [number, number];

export interface WallSpec {
  start: string;
  end: string;
  /** Thickness of a single core layer, or explicit layers. */
  t?: number;
  layers?: { thickness: number; function: string; material?: string }[];
  justification?: 'center' | 'exteriorFace' | 'interiorFace' | 'coreFace';
  [k: string]: unknown;
}

export interface DocSpec {
  junctions: Record<string, P | { position: P; join?: unknown; level?: string }>;
  walls?: Record<string, WallSpec>;
  separators?: Record<string, { start: string; end: string; level?: string }>;
  rooms?: Record<string, P | Record<string, unknown>>;
  openings?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
  levelHeight?: number;
}

export function doc(spec: DocSpec): Record<string, unknown> {
  const junctions: Record<string, unknown> = {};
  for (const [id, j] of Object.entries(spec.junctions)) {
    if (Array.isArray(j)) junctions[id] = { level: 'L1', position: j };
    else junctions[id] = { level: j.level ?? 'L1', position: j.position, ...(j.join !== undefined && { join: j.join }) };
  }
  const walls: Record<string, unknown> = {};
  for (const [id, w] of Object.entries(spec.walls ?? {})) {
    const { t, layers, ...rest } = w;
    walls[id] = { level: 'L1', ...rest, layers: layers ?? [{ thickness: t ?? 12800, function: 'core' }] };
  }
  const separators: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(spec.separators ?? {})) separators[id] = { level: 'L1', ...s };
  const rooms: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(spec.rooms ?? {})) rooms[id] = Array.isArray(r) ? { level: 'L1', anchor: r } : { level: 'L1', ...r };
  return {
    floorspec: '0.1',
    project: { name: 'Test' },
    buildings: { B1: {} },
    levels: { L1: { building: 'B1', elevation: 0, height: spec.levelHeight ?? 3200000 } },
    junctions,
    walls,
    ...(spec.separators && { separators }),
    ...(spec.rooms && { rooms }),
    ...(spec.openings && { openings: spec.openings }),
    ...spec.extra,
  };
}

/** A rectangle of four walls, drawn clockwise (exterior sides out), from (0,0) to (w,h). */
export function box(w: number, h: number, t = 12800, extra: Partial<DocSpec> = {}): DocSpec {
  return {
    junctions: { J1: [0, 0], J2: [0, h], J3: [w, h], J4: [w, 0] },
    walls: {
      W1: { start: 'J1', end: 'J2', t },
      W2: { start: 'J2', end: 'J3', t },
      W3: { start: 'J3', end: 'J4', t },
      W4: { start: 'J4', end: 'J1', t },
    },
    ...extra,
  };
}

export const codes = (r: { diagnostics: { code: string; elements: string[] }[] }): string[] =>
  r.diagnostics.map((d) => (d.elements.length ? `${d.code} ${d.elements.join(',')}` : d.code));
