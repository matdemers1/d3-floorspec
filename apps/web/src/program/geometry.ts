import type { EdgeRow, ItemRow } from './model';

/**
 * The bubble diagram's geometry (FLR-T-4.2). A bubble is a brief item, its area following the
 * item's target area — the radius goes as the square root, so twice the floor area is twice the ink.
 * Where a bubble sits is view state, not model: Core has no member for it (11.1), so positions are
 * kept per project in this browser and never written to the document. Bubbles nobody has placed
 * are laid out by a small, deterministic force relaxation: lines pull, bubbles push apart, and a
 * forbidden line pushes harder.
 */

export type Vec = readonly [number, number];
export type Positions = ReadonlyMap<string, Vec>;

/** The diagram's own frame (SVG user units); the canvas scales it to fit. */
export const FRAME = { width: 1000, height: 760 } as const;

export const R_MIN = 32;
export const R_MAX = 92;
/** A bubble with no target area: between the two, so it still reads as a space. */
export const R_NONE = 42;
const MARGIN = 12;

/** Radius of each item's bubble, from its target area against the largest in the brief. */
export function radii(items: readonly ItemRow[]): Map<string, number> {
  const largest = Math.max(0, ...items.map((i) => i.targetArea ?? 0));
  return new Map(
    items.map((i) => {
      if (i.targetArea === undefined || largest === 0) return [i.id, R_NONE];
      return [i.id, Math.max(R_MIN, R_MAX * Math.sqrt(i.targetArea / largest))];
    }),
  );
}

/** Keep a bubble inside the frame. */
export function clamp(p: Vec, r: number): Vec {
  return [Math.min(FRAME.width - r - MARGIN, Math.max(r + MARGIN, p[0])), Math.min(FRAME.height - r - MARGIN, Math.max(r + MARGIN, p[1]))];
}

/**
 * Where every bubble goes: where it was put (`placed`), or — for one nobody placed — a position
 * from the relaxation, which moves only the unplaced. Deterministic: no randomness, items in ID
 * order, the same brief laid out the same way every time.
 */
export function layout(items: readonly ItemRow[], edges: readonly EdgeRow[], placed: Positions, iterations = 240): Map<string, Vec> {
  const r = radii(items);
  const ids = items.map((i) => i.id);
  const pos = new Map<string, [number, number]>();
  const free = new Set<string>();
  const cx = FRAME.width / 2;
  const cy = FRAME.height / 2;
  const spread = Math.min(FRAME.width, FRAME.height) * 0.34;
  ids.forEach((id, i) => {
    const p = placed.get(id);
    if (p !== undefined) {
      pos.set(id, [p[0], p[1]]);
      return;
    }
    // A sunflower spiral: evenly spread, the same every time.
    const angle = i * 2.399963229728653;
    const d = spread * Math.sqrt((i + 0.5) / Math.max(ids.length, 1));
    pos.set(id, [cx + d * Math.cos(angle), cy + d * Math.sin(angle)]);
    free.add(id);
  });
  if (free.size > 0) {
    const links = edges.filter((e) => pos.has(e.a) && pos.has(e.b));
    for (let step = 0; step < iterations; step++) {
      const cool = 1 - step / iterations;
      const force = new Map<string, [number, number]>(ids.map((id) => [id, [0, 0]]));
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i] as string;
          const b = ids[j] as string;
          const pa = pos.get(a) as [number, number];
          const pb = pos.get(b) as [number, number];
          let dx = pb[0] - pa[0];
          let dy = pb[1] - pa[1];
          let d = Math.hypot(dx, dy);
          if (d < 0.01) {
            dx = 1;
            dy = 0;
            d = 1;
          }
          const want = (r.get(a) ?? R_NONE) + (r.get(b) ?? R_NONE) + 40;
          if (d < want * 1.6) {
            const push = ((want * 1.6 - d) / d) * 0.5;
            (force.get(a) as [number, number])[0] -= dx * push;
            (force.get(a) as [number, number])[1] -= dy * push;
            (force.get(b) as [number, number])[0] += dx * push;
            (force.get(b) as [number, number])[1] += dy * push;
          }
        }
      for (const e of links) {
        const pa = pos.get(e.a) as [number, number];
        const pb = pos.get(e.b) as [number, number];
        const dx = pb[0] - pa[0];
        const dy = pb[1] - pa[1];
        const d = Math.max(Math.hypot(dx, dy), 0.01);
        const rest = (r.get(e.a) ?? R_NONE) + (r.get(e.b) ?? R_NONE) + (e.kind === 'forbidden' ? 260 : 60);
        const k = e.kind === 'forbidden' ? (d < rest ? 0.08 : 0) : 0.05;
        const pull = ((d - rest) / d) * k;
        (force.get(e.a) as [number, number])[0] += dx * pull;
        (force.get(e.a) as [number, number])[1] += dy * pull;
        (force.get(e.b) as [number, number])[0] -= dx * pull;
        (force.get(e.b) as [number, number])[1] -= dy * pull;
      }
      for (const id of free) {
        const p = pos.get(id) as [number, number];
        const f = force.get(id) as [number, number];
        // A gentle pull to the middle keeps a brief with no lines from drifting to the walls.
        f[0] += (cx - p[0]) * 0.01;
        f[1] += (cy - p[1]) * 0.01;
        const step = 12 * cool + 1;
        const len = Math.hypot(f[0], f[1]);
        const scale = len > step ? step / len : 1;
        const next = clamp([p[0] + f[0] * scale, p[1] + f[1] * scale], r.get(id) ?? R_NONE);
        pos.set(id, [next[0], next[1]]);
      }
    }
  }
  const out = new Map<string, Vec>();
  for (const [id, p] of pos) out.set(id, [Math.round(p[0]), Math.round(p[1])]);
  return out;
}

/** A line between two bubbles, from rim to rim; null when they overlap. */
export function segment(pa: Vec, ra: number, pb: Vec, rb: number): { from: Vec; to: Vec; mid: Vec } | null {
  const dx = pb[0] - pa[0];
  const dy = pb[1] - pa[1];
  const d = Math.hypot(dx, dy);
  if (d <= ra + rb) return null;
  const ux = dx / d;
  const uy = dy / d;
  const from: Vec = [pa[0] + ux * ra, pa[1] + uy * ra];
  const to: Vec = [pb[0] - ux * rb, pb[1] - uy * rb];
  return { from, to, mid: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2] };
}

/** The bubble under a point, the smallest first (it is drawn on top). */
export function bubbleAt(p: Vec, positions: Positions, r: ReadonlyMap<string, number>, except?: string): string | null {
  let best: { id: string; r: number } | null = null;
  for (const [id, c] of positions) {
    if (id === except) continue;
    const radius = r.get(id) ?? R_NONE;
    if (Math.hypot(p[0] - c[0], p[1] - c[1]) <= radius && (best === null || radius < best.r)) best = { id, r: radius };
  }
  return best?.id ?? null;
}

// ─── Kept per project, in this browser ───────────────────────────────────────────────────────

const key = (projectId: string) => `floorspec.bubbles.${projectId}`;

export function loadPositions(projectId: string): Map<string, Vec> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key(projectId));
    if (raw === null) return new Map();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = new Map<string, Vec>();
    for (const [id, v] of Object.entries(parsed)) {
      if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) out.set(id, [v[0] as number, v[1] as number]);
    }
    return out;
  } catch {
    return new Map();
  }
}

export function savePositions(projectId: string, positions: Positions): void {
  try {
    localStorage.setItem(key(projectId), JSON.stringify(Object.fromEntries(positions)));
  } catch {
    // Storage refused (a private window): the arrangement lasts for this visit.
  }
}
