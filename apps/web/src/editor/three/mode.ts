import { useSyncExternalStore } from 'react';
import type { EditorStore } from '../store';
import type { Orbit, PresetId } from './camera';

/**
 * The 3D view's state (FLR-T-7.5, FLR-REQ-113, 114), beside the editor's store rather than in it:
 * which view the canvas shows — the plan, 3D, or both side by side — and what the 3D view keeps
 * between visits: its camera, cutaway and roof, the walkthrough's eye height. Selection is not
 * here: it is the editor's one selection, which is what keeps the views in step.
 *
 * The view is in the URL (`?view=3d`, `?view=split`), so a reload or a shared link opens it again.
 */

export type ViewMode = 'plan' | '3d' | 'split';

export const VIEW_LABELS: Record<ViewMode, string> = { plan: '2D plan', '3d': '3D', split: 'Split' };

/** A request to start walking: where (base units, the document's frame) and facing which way (radians, from east, anticlockwise). */
export interface WalkStart {
  x: number;
  y: number;
  yaw: number | null;
  /** The level whose floor to stand on, when the point alone is ambiguous. */
  level: string | null;
}

export interface ThreeState {
  mode: ViewMode;
  /** First-person walkthrough: the 3D view fills the editor and the panels step aside. */
  walking: boolean;
  /** A walk asked for and not yet begun (the mesh may still be loading); null to start at the entry. */
  walkFrom: WalkStart | null;
  /** Show only the levels up to the current one, without the current level's ceilings. */
  cutaway: boolean;
  roof: boolean;
  /** The orbit camera, kept between visits and re-meshes; null until the first mesh frames it. */
  orbit: Orbit | null;
  /** The named view the camera is at, or null once it has been orbited freely. */
  preset: PresetId | null;
  /** The walkthrough's eye height above the floor under it, metres. */
  eyeHeight: number;
}

export const EYE_HEIGHTS = [1.2, 1.5, 1.6, 1.7, 1.8] as const;
const EYE_KEY = 'floorspec.eyeHeight';

function readEye(): number {
  try {
    const n = Number(localStorage.getItem(EYE_KEY));
    return Number.isFinite(n) && n >= 0.5 && n <= 2.5 ? n : 1.6;
  } catch {
    return 1.6;
  }
}

function readMode(): ViewMode {
  if (typeof window === 'undefined') return 'plan';
  const v = new URLSearchParams(window.location.search).get('view');
  return v === '3d' || v === 'split' ? v : 'plan';
}

function writeMode(mode: ViewMode): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (mode === 'plan') params.delete('view');
  else params.set('view', mode);
  const rest = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest === '' ? '' : `?${rest}`}${window.location.hash}`);
}

export class ThreeStore {
  private state: ThreeState;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.state = { mode: readMode(), walking: false, walkFrom: null, cutaway: true, roof: true, orbit: null, preset: 'sw', eyeHeight: readEye() };
  }

  get = (): ThreeState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<ThreeState>): void {
    const before = this.state;
    this.state = { ...before, ...patch };
    if (patch.mode !== undefined && patch.mode !== before.mode) writeMode(patch.mode);
    for (const l of this.listeners) l();
  }

  setMode(mode: ViewMode): void {
    // Leaving 3D ends a walk; the plan has nothing to walk in.
    this.set(mode === 'plan' ? { mode, walking: false, walkFrom: null } : { mode });
  }

  /** Walk through: from a point, or from the entry door when `from` is null. Opens the 3D view if it is not showing. */
  walk(from: WalkStart | null = null): void {
    this.set({ mode: this.state.mode === 'plan' ? '3d' : this.state.mode, walking: true, walkFrom: from });
  }

  stopWalking(): void {
    this.set({ walking: false, walkFrom: null });
  }

  setEyeHeight(metres: number): void {
    this.set({ eyeHeight: metres });
    try {
      localStorage.setItem(EYE_KEY, String(metres));
    } catch {
      // Storage refused (a private window): the setting lasts for this session.
    }
  }
}

const stores = new WeakMap<EditorStore, ThreeStore>();

/** The 3D state of an editor: one per editor store, made on first use. */
export function threeOf(store: EditorStore): ThreeStore {
  let three = stores.get(store);
  if (three === undefined) {
    three = new ThreeStore();
    stores.set(store, three);
  }
  return three;
}

export function useThreeState<T>(store: EditorStore, selector: (s: ThreeState) => T): T {
  const three = threeOf(store);
  return useSyncExternalStore(three.subscribe, () => selector(three.get()));
}
