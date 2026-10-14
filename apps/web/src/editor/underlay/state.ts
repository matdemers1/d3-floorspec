import { useSyncExternalStore } from 'react';
import type { EditorStore } from '../store';
import type { LevelView, Point } from '../model';
import { sortedLevels } from '../model';
import type { LayerState } from '../modes';
import type { Snap } from '../snap';
import type { Placement } from './transform';

/**
 * Trace and reference (FLR-T-18.12), beside the editor's store as the precision and mode state are.
 *
 * **An underlay is working material, not the house.** A listing PDF or a sketch traced over is how a
 * plan is started; it is not part of what the house is, and two people tracing the same house from
 * two scans are drawing the same design. So the image's bytes are a project asset — uploaded into
 * the content-addressed store like a texture (FLR-T-8.2), kept by the server, readable by whoever may
 * read the project — and where it lies on each level (its placement, opacity, lock and layer
 * state) is view data: kept per project in this browser, as the snap settings, the trade modes and
 * the plan style are, never an Op and never in the document. The document stays the house; an
 * exported package or a shared link carries no tracing paper.
 *
 * The reference toggle draws the level below or above in a ghost colour (Chief's Reference Display,
 * ArchiCAD's Trace & Reference): its junctions and wall corners are snap targets, and nothing of it
 * can be picked or edited — it is drawn under `pointer-events: none` and the tools pick only from
 * the level being drawn.
 */

export type ReferenceSide = 'off' | 'below' | 'above';

export interface Underlay extends Placement {
  sha256: string;
  /** The file's name as it was picked: "listing.pdf". */
  name: string | null;
  mediaType: string;
  /** Pixels. */
  width: number;
  height: number;
  /** 0.05–1. */
  opacity: number;
  /** Locked: no calibrating, moving or turning. */
  locked: boolean;
  /** The Layers drawer's On · Ghost · Off: shown, faint and grey, hidden. */
  state: LayerState;
  /** A PDF's page, rasterised in the browser; absent for an image. */
  page?: number;
}

/** What a click on the plan does while an underlay is being worked. */
export type Interaction =
  | { kind: 'calibrate'; points: readonly Point[]; cursor: Point | null }
  | { kind: 'move'; from: Point | null; cursor: Snap | null };

export interface UnderlayState {
  /** Each level's underlay, by level ID. */
  levels: Readonly<Record<string, Underlay>>;
  reference: ReferenceSide;
  interaction: Interaction | null;
}

export const underlayKey = (projectId: string): string => `floorspec.underlay.${projectId}`;

const SHA = /^[0-9a-f]{64}$/;
const isPoint = (v: unknown): v is Point => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const isState = (v: unknown): v is LayerState => v === 'on' || v === 'ghost' || v === 'off';
const isSide = (v: unknown): v is ReferenceSide => v === 'off' || v === 'below' || v === 'above';

/** A stored underlay, checked field by field: anything else in storage is ignored, never trusted. */
export function isUnderlay(v: unknown): v is Underlay {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  return (
    typeof o['sha256'] === 'string' &&
    SHA.test(o['sha256']) &&
    (o['name'] === null || typeof o['name'] === 'string') &&
    typeof o['mediaType'] === 'string' &&
    positive(o['width']) &&
    positive(o['height']) &&
    isPoint(o['origin']) &&
    positive(o['scale']) &&
    typeof o['rotation'] === 'number' &&
    Number.isFinite(o['rotation']) &&
    typeof o['opacity'] === 'number' &&
    o['opacity'] >= 0.05 &&
    o['opacity'] <= 1 &&
    typeof o['locked'] === 'boolean' &&
    isState(o['state']) &&
    (o['page'] === undefined || (typeof o['page'] === 'number' && Number.isSafeInteger(o['page']) && o['page'] > 0))
  );
}

export function readSaved(projectId: string): Pick<UnderlayState, 'levels' | 'reference'> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(underlayKey(projectId));
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    if (typeof parsed !== 'object' || parsed === null) return { levels: {}, reference: 'off' };
    const o = parsed as Record<string, unknown>;
    const levels = typeof o['levels'] === 'object' && o['levels'] !== null ? Object.fromEntries(Object.entries(o['levels']).filter((e): e is [string, Underlay] => isUnderlay(e[1]))) : {};
    return { levels, reference: isSide(o['reference']) ? o['reference'] : 'off' };
  } catch {
    return { levels: {}, reference: 'off' };
  }
}

export class UnderlayStore {
  private state: UnderlayState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly editor: EditorStore) {
    this.state = { ...readSaved(editor.projectId), interaction: null };
    // A calibration or a move belongs to its level: going to another level ends it.
    let level = editor.get().level;
    editor.subscribe(() => {
      const now = editor.get().level;
      if (now === level) return;
      level = now;
      if (this.state.interaction !== null) this.set({ interaction: null });
    });
  }

  get = (): UnderlayState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<UnderlayState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private save(): void {
    try {
      localStorage.setItem(underlayKey(this.editor.projectId), JSON.stringify({ levels: this.state.levels, reference: this.state.reference }));
    } catch {
      // Storage refused (a private window): the underlay lasts for this session.
    }
  }

  /** The underlay of a level, if it has one. */
  of(level: string | null): Underlay | undefined {
    return level === null ? undefined : this.state.levels[level];
  }

  /** Put an underlay on a level, or replace the one there. */
  put(level: string, underlay: Underlay): void {
    this.set({ levels: { ...this.state.levels, [level]: underlay } });
    this.save();
  }

  /** Change a level's underlay. Its placement does not change while it is locked. */
  update(level: string, patch: Partial<Underlay>): void {
    const current = this.state.levels[level];
    if (current === undefined) return;
    const placement = patch.origin !== undefined || patch.scale !== undefined || patch.rotation !== undefined;
    if (current.locked && placement) return;
    this.put(level, { ...current, ...patch });
  }

  /** Take a level's underlay away. Its file stays in the project's assets. */
  remove(level: string): void {
    const levels = Object.fromEntries(Object.entries(this.state.levels).filter(([id]) => id !== level));
    this.set({ levels, interaction: null });
    this.save();
  }

  setReference(reference: ReferenceSide): void {
    this.set({ reference });
    this.save();
  }

  /** Begin calibrating or moving the current level's underlay; null ends it. */
  begin(kind: Interaction['kind'] | null): void {
    this.set({ interaction: kind === null ? null : kind === 'calibrate' ? { kind, points: [], cursor: null } : { kind, from: null, cursor: null } });
  }
}

const stores = new WeakMap<EditorStore, UnderlayStore>();

export function underlayOf(store: EditorStore): UnderlayStore {
  let u = stores.get(store);
  if (u === undefined) {
    u = new UnderlayStore(store);
    stores.set(store, u);
  }
  return u;
}

export function useUnderlay<T>(store: EditorStore, selector: (s: UnderlayState) => T): T {
  const u = underlayOf(store);
  return useSyncExternalStore(u.subscribe, () => selector(u.get()), () => selector(u.get()));
}

// ─── The reference level ────────────────────────────────────────────────────────────────────

/** The level next to `level` on that side, in elevation order: what the reference draws. */
export function neighbourLevel(store: EditorStore, level: string | null, side: ReferenceSide): LevelView | null {
  const { model } = store.get();
  if (model === null || level === null || side === 'off') return null;
  const order = sortedLevels(model.document).map((l) => l.id);
  const i = order.indexOf(level);
  if (i < 0) return null;
  const id = order[side === 'below' ? i - 1 : i + 1];
  return id === undefined ? null : (model.levels.find((l) => l.id === id) ?? null);
}

/** The level the reference draws now, if it is on and there is one. */
export const referenceLevel = (store: EditorStore): LevelView | null => neighbourLevel(store, store.get().level, underlayOf(store).get().reference);

/**
 * What the reference offers to snap to: its junctions, and the corners of its walls' faces (so a
 * wall can be drawn to the face of the bearing wall below it, not only to its location line).
 */
export function referencePoints(store: EditorStore): { point: Point; label: string }[] {
  const ref = referenceLevel(store);
  if (ref === null) return [];
  const out: { point: Point; label: string }[] = [];
  const seen = new Set<string>();
  const add = (p: Point, label: string) => {
    const q: Point = [Math.round(p[0]), Math.round(p[1])];
    const key = `${String(q[0])},${String(q[1])}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ point: q, label });
  };
  for (const j of ref.junctions) add(j.position, `Junction on ${ref.name}`);
  for (const w of ref.walls) for (const p of w.ring) add(p, `Wall corner on ${ref.name}`);
  return out;
}
