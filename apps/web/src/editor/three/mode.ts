import { useSyncExternalStore } from 'react';
import type { EditorStore } from '../store';
import { ALL_OFF, ALL_ON, ALL_ON_NAME, toggled, withLights, withSetting, type Lighting, type NamedScene, type SceneSetting } from '@floorspec/mesh';
import type { Orbit, PresetId } from './camera';
import { softwareWebGL } from './software';

/**
 * The 3D view's state (FLR-T-7.5, FLR-REQ-113, 114), beside the editor's store rather than in it:
 * which view the canvas shows — the plan, 3D, or both side by side — and what the 3D view keeps
 * between visits: its camera, which levels it shows and the roof, the walkthrough's eye height. Selection is not
 * here: it is the editor's one selection, which is what keeps the views in step.
 *
 * The view is in the URL (`?view=3d`, `?view=split`), so a reload or a shared link opens it again.
 */

export type ViewMode = 'plan' | '3d' | 'split';

export const VIEW_LABELS: Record<ViewMode, string> = { plan: '2D plan', '3d': '3D', split: 'Split' };

/**
 * Which levels the 3D view shows (FLR-T-13.2), about the editor's current level — the one the top
 * bar's picker and Page Up / Page Down choose, which the plan shows too:
 * - `house`: the whole house — every level, every ceiling and every roof, nothing cut away
 *   (floorspec_render's `level: "all"`);
 * - `cutaway`: the current level and those below it, without the current level's ceilings or the
 *   roof it carries, so its rooms are seen from above (floorspec_render's `level: <id>`);
 * - `only`: the current level alone, cut the same way.
 */
export type LevelsShown = 'house' | 'cutaway' | 'only';

/**
 * How the 3D view draws (FLR-T-13.7): `draft`, as it always has — light, fast — or `presentation`:
 * ambient occlusion, soft shadows, bloom on lamps, reflections on glossy floors and glass, under the
 * same exposure and tone curve. Kept in this browser; Presentation is the default where WebGL runs
 * on a GPU, Draft where it is drawn in software.
 */
export type Quality = 'draft' | 'presentation';
const QUALITY_KEY = 'floorspec.quality3d';

/** The quality kept in this browser, or the default for this GPU. */
export function readQuality(software: () => boolean): Quality {
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    if (v === 'draft' || v === 'presentation') return v;
  } catch {
    // Storage refused (a private window): the default.
  }
  return software() ? 'draft' : 'presentation';
}

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
  /** Which levels show, about the current level (FLR-T-13.2). Kept per project, in this browser. */
  levels: LevelsShown;
  /** In the whole house, the roofs on or off. */
  roof: boolean;
  /** The orbit camera, kept between visits and re-meshes; null until the first mesh frames it. */
  orbit: Orbit | null;
  /** The named view the camera is at, or null once it has been orbited freely. */
  preset: PresetId | null;
  /** The walkthrough's eye height above the floor under it, metres. */
  eyeHeight: number;
  /**
   * The house's light fixtures turned on (FLR-T-12.22): each FS_electrical light a lamp, the view at
   * dusk so their light reads. A way of looking, not part of the model, and not kept between visits.
   */
  lights: boolean;
  /**
   * Which lights are on, how bright and how warm (FLR-T-13.12): the scene last chosen, as it was
   * chosen or as switches, lamps and dimmers have changed it since. View state: a person saves it to
   * the document as a scene (FS_lighting) from the Lighting panel.
   */
  lighting: Lighting;
  /** The scene last chosen: a document scene's ID and name, or a built-in's (`id` null). */
  scene: { readonly id: string | null; readonly name: string };
  /** The Lighting panel is open. */
  lightingOpen: boolean;
  /** Draft or Presentation (FLR-T-13.7). */
  quality: Quality;
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

/**
 * The levels shown are kept per project and per viewer (this browser), not in the model: the
 * cutaway at the current level until a person picks otherwise — what they are drawing, seen from above.
 */
const levelsKey = (projectId: string): string => `floorspec.levels3d.${projectId}`;

function readLevels(projectId: string | null): LevelsShown {
  if (projectId === null) return 'cutaway';
  try {
    const v = localStorage.getItem(levelsKey(projectId));
    return v === 'house' || v === 'only' ? v : 'cutaway';
  } catch {
    return 'cutaway';
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

  constructor(
    private readonly projectId: string | null = null,
    software: () => boolean = () => true,
  ) {
    this.state = {
      mode: readMode(),
      walking: false,
      walkFrom: null,
      levels: readLevels(projectId),
      roof: true,
      orbit: null,
      preset: 'sw',
      eyeHeight: readEye(),
      lights: false,
      lighting: ALL_ON,
      scene: { id: null, name: ALL_ON_NAME },
      lightingOpen: false,
      quality: readQuality(software),
    };
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

  /** Turn the light fixtures on or off; with no argument, the other way from now. */
  toggleLights(on: boolean = !this.state.lights): void {
    if (on !== this.state.lights) this.set({ lights: on });
  }

  /** Light the house as a scene does (FLR-T-13.12): its lights on, the view lit. */
  chooseScene(scene: NamedScene): void {
    this.set({ lights: true, lighting: scene.lighting, scene: { id: scene.id, name: scene.name } });
  }

  /**
   * Flip a switch (FLR-T-13.12): the lights it controls go off when any of them is on, else on —
   * `all` is every light the house has, to expand "All on". With the view's lights off, the house is
   * dark: the switch turns its lights on and nothing else.
   */
  flipSwitch(controls: readonly string[], all: readonly string[]): void {
    if (controls.length === 0) return;
    if (!this.state.lights) this.set({ lights: true, lighting: withLights(ALL_OFF, all, controls, true) });
    else this.set({ lighting: toggled(this.state.lighting, all, controls) });
  }

  /** Turn lights on or off, as they are now set. */
  setLightsOn(ids: readonly string[], on: boolean, all: readonly string[]): void {
    this.set({ lights: true, lighting: withLights(this.state.lights ? this.state.lighting : ALL_OFF, all, ids, on) });
  }

  /** Dim a light or set its colour temperature (turning it on). */
  setLight(id: string, setting: SceneSetting, all: readonly string[]): void {
    this.set({ lights: true, lighting: withSetting(this.state.lighting, all, id, setting) });
  }

  /** Show the whole house, a cutaway or one level alone; remembered for this project in this browser. */
  setLevels(levels: LevelsShown): void {
    if (levels !== this.state.levels) this.set({ levels });
    if (this.projectId === null) return;
    try {
      localStorage.setItem(levelsKey(this.projectId), levels);
    } catch {
      // Storage refused (a private window): the choice lasts for this session.
    }
  }

  /** Draw in Draft or Presentation; remembered in this browser. */
  setQuality(quality: Quality): void {
    if (quality !== this.state.quality) this.set({ quality });
    try {
      localStorage.setItem(QUALITY_KEY, quality);
    } catch {
      // Storage refused (a private window): the choice lasts for this session.
    }
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
    three = new ThreeStore(store.projectId, softwareWebGL);
    stores.set(store, three);
  }
  return three;
}

export function useThreeState<T>(store: EditorStore, selector: (s: ThreeState) => T): T {
  const three = threeOf(store);
  return useSyncExternalStore(three.subscribe, () => selector(three.get()));
}
