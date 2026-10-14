import { useSyncExternalStore } from 'react';
import type { ModeId } from '@floorspec/render2d';
import type { EditorStore } from '../store';
import type { LevelView, Point } from '../model';
import { labelOf, sortedLevels } from '../model';
import { modesOf } from '../modes';
import { BASE_PER_FOOT, BASE_PER_INCH, BASE_PER_MM, gridStep, prettyLen, type UnitSystem } from '../units';
import { SNAP_DEFAULTS, snapPoint, type Snap, type SnapOptions, type SnapSettings } from '../snap';
import { referencePoints } from '../underlay/state';

/**
 * Precision without effort (FLR-T-18.9), beside the editor's store as the arrange and mode state are:
 * the snap settings (the status bar's snap menu — per project and per mode, in this browser, never
 * in the model), what the temporary dimensions measure to, the smart guides of a drag in progress,
 * whether ⌥ is held over the plan, and the measure tool's points. Nothing here is ever sent: an edit
 * a temporary dimension makes is a batch handed to the store like any other.
 *
 * `snapAt` is the one entry point every tool snaps through — drawing, dragging, placing (FLR-T-18.7)
 * and measuring — so a toggle in the menu changes all of them at once.
 */

/** What a temporary dimension measures to on its neighbour (Tab cycles): its near face, its centre line, its other face. */
export type DimRef = 'face' | 'centre' | 'far';
export const DIM_REFS: readonly DimRef[] = ['face', 'centre', 'far'];
export const DIM_REF_LABELS: Readonly<Record<DimRef, string>> = { face: 'Face', centre: 'Centre', far: 'Other face' };

export interface MeasurePoint {
  point: Point;
  /** The element it snapped to, and its name: "Sink", "Cooktop". */
  ref?: string;
  label?: string;
}

export interface Measure {
  points: readonly MeasurePoint[];
  /** Where the next point would go. */
  cursor: Snap | null;
  /** The chain closed on its first point: an area. */
  closed: boolean;
  /** Ended (double click, Enter, or closed): the next click begins a new one. */
  done?: boolean;
}

export interface DragGuides {
  lines: readonly [Point, Point][];
  label?: string;
  /** Where the label goes, plan. */
  at?: Point;
}

export interface PrecisionState {
  /** The snap settings in force: the current mode's own, or its defaults. */
  snap: SnapSettings;
  /** The snap menu is open. */
  menu: boolean;
  ref: DimRef;
  /** The temporary dimension being typed into, by key. */
  editing: string | null;
  /** ⌥ is held: hovering an item shows its distances to its neighbours. */
  alt: boolean;
  /** ⇧, ⌘ or Ctrl is held: a click is a selection's (⇧-click, ⌘-click), so the numbers let it through to the plan. */
  through: boolean;
  /** Smart guides of the drag in progress. */
  guides: DragGuides | null;
  measure: Measure;
}

const EMPTY_MEASURE: Measure = { points: [], cursor: null, closed: false };

/** A grid step by units: what a mode starts with. */
interface Step {
  imperial: number | null;
  metric: number | null;
}

const STEP = {
  units: { imperial: null, metric: null } as Step,
  inch: { imperial: BASE_PER_INCH, metric: 10 * BASE_PER_MM } as Step,
  six: { imperial: 6 * BASE_PER_INCH, metric: 100 * BASE_PER_MM } as Step,
  foot: { imperial: BASE_PER_FOOT, metric: 250 * BASE_PER_MM } as Step,
};

/**
 * Each trade's snapping (FLR-T-18.3 left the per-mode defaults to this task): construction lays
 * walls out on a 6" grid with every snap; the decorator and the trades place items against walls
 * and each other on 1"; the landscape on a foot. No mode keeps the editor as it was: ½" or 10 mm.
 */
const MODE_SNAP: Readonly<Record<ModeId | 'none', { step: Step; patch?: Partial<SnapSettings> }>> = {
  none: { step: STEP.units },
  construction: { step: STEP.six },
  decorator: { step: STEP.inch, patch: { junctions: false } },
  electrical: { step: STEP.inch },
  plumbing: { step: STEP.inch },
  mechanical: { step: STEP.inch },
  lowvoltage: { step: STEP.inch },
  landscape: { step: STEP.foot, patch: { midpoints: false } },
};

/** A mode's snapping before anyone changes it. */
export function modeSnapDefaults(trade: ModeId | null, units: UnitSystem): SnapSettings {
  const m = MODE_SNAP[trade ?? 'none'];
  return { ...SNAP_DEFAULTS, ...m.patch, step: m.step[units] };
}

/** The grid steps the menu offers, by units. */
export function gridSteps(units: UnitSystem): number[] {
  return units === 'metric'
    ? [1, 5, 10, 25, 50, 100, 250, 500, 1000].map((mm) => mm * BASE_PER_MM)
    : [BASE_PER_INCH / 16, BASE_PER_INCH / 8, BASE_PER_INCH / 4, BASE_PER_INCH / 2, BASE_PER_INCH, 2 * BASE_PER_INCH, 3 * BASE_PER_INCH, 6 * BASE_PER_INCH, BASE_PER_FOOT];
}

export const snapKey = (projectId: string): string => `floorspec.snap.${projectId}`;

function isSettings(v: unknown): v is SnapSettings {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const flags = ['on', 'junctions', 'walls', 'midpoints', 'guides', 'items', 'ghosts', 'grid', 'angles'];
  return flags.every((f) => typeof o[f] === 'boolean') && (o['step'] === null || (typeof o['step'] === 'number' && Number.isSafeInteger(o['step']) && o['step'] > 0)) && typeof o['angle'] === 'number' && o['angle'] > 0 && o['angle'] <= 90;
}

function readSaved(projectId: string): Record<string, SnapSettings> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(snapKey(projectId));
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, SnapSettings] => isSettings(e[1])));
  } catch {
    return {};
  }
}

export class PrecisionStore {
  private state: PrecisionState;
  private readonly listeners = new Set<() => void>();
  private saved: Record<string, SnapSettings>;
  private modeKey: string;
  private units: UnitSystem;

  /** FLR-T-18.11 keeps a measurement as a dimension: it registers here, and the measure panel offers it. */
  keepAsDimension: ((store: EditorStore, points: readonly Point[]) => void) | null = null;

  constructor(private readonly editor: EditorStore) {
    this.saved = readSaved(editor.projectId);
    const modes = modesOf(editor);
    this.modeKey = modes.get().mode ?? 'none';
    this.units = editor.units;
    this.state = { snap: this.settingsFor(this.modeKey), menu: false, ref: 'face', editing: null, alt: false, through: false, guides: null, measure: EMPTY_MEASURE };
    // The mode changed: its own snapping comes with it.
    modes.subscribe(() => {
      const key = modes.get().mode ?? 'none';
      if (key === this.modeKey) return;
      this.modeKey = key;
      this.set({ snap: this.settingsFor(key) });
    });
    let was = { selection: editor.get().selection, level: editor.get().level, tool: editor.get().tool };
    editor.subscribe(() => {
      const s = editor.get();
      // Units switched: a mode's default step follows them.
      if (s.model !== null && editor.units !== this.units) {
        this.units = editor.units;
        if (this.saved[this.modeKey] === undefined) this.set({ snap: this.settingsFor(this.modeKey) });
      }
      // A temporary dimension being typed into goes with its element; a measurement with its level or tool.
      if (s.selection !== was.selection && this.state.editing !== null) this.set({ editing: null });
      if ((s.level !== was.level || (s.tool !== was.tool && was.tool === 'measure')) && this.state.measure !== EMPTY_MEASURE) this.set({ measure: EMPTY_MEASURE });
      was = { selection: s.selection, level: s.level, tool: s.tool };
    });
  }

  get = (): PrecisionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<PrecisionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private settingsFor(key: string): SnapSettings {
    const saved = this.saved[key];
    if (saved !== undefined) return saved;
    return modeSnapDefaults(modesOf(this.editor).tradeOf(key === 'none' ? null : key), this.units);
  }

  /** Change the snapping: kept for this project and this mode. */
  setSnap(patch: Partial<SnapSettings>): void {
    const snap = { ...this.state.snap, ...patch };
    this.saved = { ...this.saved, [this.modeKey]: snap };
    this.set({ snap });
    try {
      localStorage.setItem(snapKey(this.editor.projectId), JSON.stringify(this.saved));
    } catch {
      // Storage refused (a private window): the setting lasts for this session.
    }
  }

  /** The mode's snapping back to its defaults. */
  resetSnap(): void {
    this.saved = Object.fromEntries(Object.entries(this.saved).filter(([k]) => k !== this.modeKey));
    this.set({ snap: this.settingsFor(this.modeKey) });
    try {
      localStorage.setItem(snapKey(this.editor.projectId), JSON.stringify(this.saved));
    } catch {
      // As above.
    }
  }

  /** Whether the snapping is the mode's own defaults. */
  isDefault(): boolean {
    return this.saved[this.modeKey] === undefined;
  }

  /** Tab on a temporary dimension: face → centre → other face. */
  cycleRef(back = false): DimRef {
    const i = DIM_REFS.indexOf(this.state.ref);
    const ref = DIM_REFS[(i + (back ? DIM_REFS.length - 1 : 1)) % DIM_REFS.length] as DimRef;
    this.set({ ref });
    return ref;
  }

  clearMeasure(): void {
    this.set({ measure: EMPTY_MEASURE });
  }
}

const stores = new WeakMap<EditorStore, PrecisionStore>();

export function precisionOf(store: EditorStore): PrecisionStore {
  let p = stores.get(store);
  if (p === undefined) {
    p = new PrecisionStore(store);
    stores.set(store, p);
  }
  return p;
}

export function usePrecision<T>(store: EditorStore, selector: (s: PrecisionState) => T): T {
  const p = precisionOf(store);
  return useSyncExternalStore(p.subscribe, () => selector(p.get()), () => selector(p.get()));
}

// ─── The snap engine, as the tools call it ──────────────────────────────────────────────────

/** The snap settings in force. */
export const snapSettingsOf = (store: EditorStore): SnapSettings => precisionOf(store).get().snap;

/** The grid step in force, base units: the setting, or the units' working step. */
export function gridStepOf(store: EditorStore): number {
  return snapSettingsOf(store).step ?? gridStep(store.units);
}

/**
 * The step a drag, an opening or a device position rounds to: the grid when snapping and the grid
 * are on, else one base unit — an integer, never a float (FLR-ADR-004).
 */
export function snapGridOf(store: EditorStore): number {
  const s = snapSettingsOf(store);
  return s.on && s.grid ? gridStepOf(store) : 1;
}

/** The junctions of the levels next to this one, for "Other levels (ghost)". */
export function ghostPoints(store: EditorStore): Point[] {
  const { model, level } = store.get();
  if (model === null || level === null) return [];
  const order = sortedLevels(model.document).map((l) => l.id);
  const i = order.indexOf(level);
  const near = new Set([order[i - 1], order[i + 1]].filter((x): x is string => x !== undefined));
  return model.levels.filter((l) => near.has(l.id)).flatMap((l) => l.junctions.map((j) => j.position));
}

/** An element's name for a snap's label. */
export function namer(store: EditorStore): (id: string) => string {
  const model = store.get().model;
  return (id) => (model === null ? id : labelOf(model, id));
}

/**
 * Snap a plan point with the person's settings: the one entry point for every tool (drawing,
 * dragging, placing — FLR-T-18.7 — and measuring). `options` are snapPoint's, without the settings,
 * the grid, the ghosts, the reference level's points and the names, which come from the editor.
 */
export function snapAt(store: EditorStore, level: LevelView | undefined, raw: Point, options: Omit<SnapOptions, 'settings' | 'grid' | 'ghosts' | 'reference' | 'name'>): Snap {
  const settings = snapSettingsOf(store);
  // FLR-T-18.12: the reference level drawn under this one is snapped to while it is shown.
  return snapPoint(level, raw, { ...options, settings, grid: gridStepOf(store), ghosts: settings.ghosts ? ghostPoints(store) : [], reference: referencePoints(store), name: namer(store) });
}

/** The status bar's words for the snapping: "junctions, walls, grid 6"". */
export function snapSummary(s: SnapSettings, units: UnitSystem, step: number): string {
  if (!s.on) return 'off';
  const on = ([['junctions', s.junctions], ['walls', s.walls], ['midpoints', s.midpoints], ['guides', s.guides], ['items', s.items], ['levels', s.ghosts]] as const).filter(([, v]) => v).map(([k]) => k);
  const shown = on.length > 3 ? [...on.slice(0, 2), `+${String(on.length - 2)}`] : on;
  return [...shown, s.grid ? `grid ${prettyLen(step, units)}` : 'no grid'].join(', ');
}
