import { useSyncExternalStore } from 'react';
import { ALL_ON, LAYER_LABELS, MODE_IDS, MODES, PLAN_LAYERS, isLayerState, isModeId, layerOfElement, type LayerState, type LayerStates, type ModeId, type PlanLayer } from '@floorspec/render2d';
import type { EditorStore, Layers, ToolId } from './store';
import type { LevelView } from './model';
import type { Command } from './commands';
import type { ToolController } from './tools';

/**
 * Trade modes in the editor (FLR-T-18.3), beside the editor's store as the 3D view's state is: which
 * mode the plan is in, which of its layers are ghosts, a person's own modes, and a person's own
 * presets. A mode is a preset of layer states (`@floorspec/render2d`'s MODES — the same table the
 * server's plan render and the PDF and DXF drawings read): each layer On, Ghost or Off. Choosing a
 * mode changes the layers, the dimming, the tool rail and the inspector's emphasis in one step; the
 * Layers drawer can then set any layer otherwise, and a dot marks what differs from the preset.
 *
 * The editor's `layers` stay the one record of what is drawn (On and Ghost are drawn; Off is not);
 * this store adds which drawn layers are ghosts. Everything here is kept per project, in this
 * browser (the view-state pattern of FLR-T-13.2): never in the model.
 */

export { MODE_IDS, MODES, PLAN_LAYERS, LAYER_LABELS, type ModeId, type PlanLayer, type LayerState, type LayerStates };

/** A person's own mode: a name, the layers it sets, and the trade whose tools and colour it borrows. */
export interface CustomMode {
  id: string;
  name: string;
  base: ModeId | null;
  layers: LayerStates;
}

export interface ModesState {
  /** The mode the plan is in: a trade, a person's own (`custom:…`), or null for every layer as it was before modes. */
  mode: string | null;
  /** The drawn layers that are ghosts: grey, at reduced contrast, and not picked on the plan. */
  ghost: readonly PlanLayer[];
  /** A person's own modes ("Kitchen remodel"). */
  custom: readonly CustomMode[];
  /** A person's own presets for the trades: what "Reset" returns to. */
  presets: Readonly<Partial<Record<ModeId, LayerStates>>>;
  /** The "Save the current layers as a new mode" dialog is open. */
  saving: boolean;
}

/** No mode: the layers as the editor has always opened — every one on but the roof's, which is asked for. */
export const NO_MODE: LayerStates = { ...ALL_ON, roof: 'off' };

/** Where the mode is kept: one record per project. */
export const modeKey = (projectId: string): string => `floorspec.mode.${projectId}`;

interface Saved {
  mode?: unknown;
  states?: unknown;
  custom?: unknown;
  presets?: unknown;
}

function statesFrom(raw: unknown): LayerStates | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const out = { ...ALL_ON } as Record<PlanLayer, LayerState>;
  for (const l of PLAN_LAYERS) {
    const v = (raw as Record<string, unknown>)[l];
    if (isLayerState(v)) out[l] = v;
  }
  return out;
}

function read(projectId: string): Saved | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(modeKey(projectId));
    return raw === null ? null : (JSON.parse(raw) as Saved);
  } catch {
    return null;
  }
}

/** The editor's layer for a plan layer: every plan layer is one of the editor's, by the same name. */
const drawn = (layers: Layers, l: PlanLayer): boolean => layers[l] !== false;

/** The tools a mode's rail offers (FLR-T-18.3): drawing tools, device kinds, the library, quick add (FLR-T-18.7). */
export type RailItem = { tool: ToolId } | { device: string } | { library: true } | { quick: true };

const SELECT: RailItem = { tool: 'select' };
/** The hand (FLR-T-18.6), under Select in every rail. */
const HAND: RailItem = { tool: 'hand' };
export const RAILS: Readonly<Record<ModeId, readonly RailItem[]>> = {
  construction: [SELECT, HAND, { tool: 'wall' }, { tool: 'arc' }, { tool: 'door' }, { tool: 'window' }, { tool: 'room' }, { tool: 'wand' }, { tool: 'separator' }, { tool: 'slab' }, { tool: 'stair' }, { tool: 'roof' }],
  decorator: [SELECT, HAND, { library: true }, { quick: true }, { tool: 'room' }],
  electrical: [SELECT, HAND, { device: 'receptacle' }, { device: 'switch' }, { device: 'light' }, { device: 'alarm' }, { device: 'panel' }, { device: 'evCharger' }],
  plumbing: [SELECT, HAND, { device: 'toilet' }, { device: 'lavatory' }, { device: 'kitchenSink' }, { device: 'shower' }, { device: 'bathtub' }, { device: 'floorDrain' }, { device: 'waterHeater' }],
  mechanical: [SELECT, HAND, { device: 'furnace' }, { device: 'airHandler' }, { device: 'supply' }, { device: 'return' }, { device: 'exhaustFan' }, { device: 'gasRange' }],
  lowvoltage: [SELECT, HAND, { device: 'dataOutlet' }, { device: 'coaxOutlet' }, { device: 'headEnd' }],
  landscape: [SELECT, HAND, { tool: 'slab' }, { library: true }],
};

export class ModesStore {
  private state: ModesState;
  private readonly listeners = new Set<() => void>();
  private lastLayers: Layers;

  constructor(private readonly editor: EditorStore) {
    const saved = read(editor.projectId);
    const custom = Array.isArray(saved?.custom)
      ? (saved.custom as unknown[]).flatMap((c): CustomMode[] => {
          if (typeof c !== 'object' || c === null) return [];
          const o = c as Record<string, unknown>;
          const layers = statesFrom(o['layers']);
          return typeof o['id'] === 'string' && typeof o['name'] === 'string' && layers !== null ? [{ id: o['id'], name: o['name'], base: isModeId(o['base']) ? o['base'] : null, layers }] : [];
        })
      : [];
    const presets: Partial<Record<ModeId, LayerStates>> = {};
    if (typeof saved?.presets === 'object' && saved.presets !== null)
      for (const [k, v] of Object.entries(saved.presets)) {
        const s = statesFrom(v);
        if (isModeId(k) && s !== null) presets[k] = s;
      }
    const mode = typeof saved?.mode === 'string' && (isModeId(saved.mode) || custom.some((c) => c.id === saved.mode)) ? saved.mode : null;
    this.state = { mode, ghost: [], custom, presets, saving: false };
    // The layers as they were left — the mode's, with whatever was set otherwise.
    const states = statesFrom(saved?.states) ?? (mode === null ? null : this.presetOf(mode));
    if (states !== null) this.write(states);
    this.lastLayers = editor.get().layers;
    // Layers changed elsewhere (a command, the palette) are remembered too.
    editor.subscribe(() => {
      const layers = this.editor.get().layers;
      if (layers === this.lastLayers) return;
      this.lastLayers = layers;
      this.save();
    });
  }

  get = (): ModesState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: Partial<ModesState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  // ─── Reading ───────────────────────────────────────────────────────────────────────────────

  /** Every layer's state now: Off when not drawn, Ghost when drawn as one, else On. */
  states(): LayerStates {
    const layers = this.editor.get().layers;
    const ghost = new Set(this.state.ghost);
    return Object.fromEntries(PLAN_LAYERS.map((l) => [l, !drawn(layers, l) ? 'off' : ghost.has(l) ? 'ghost' : 'on'])) as Record<PlanLayer, LayerState>;
  }

  /** What a mode sets: a person's own mode's layers, their preset for a trade, or the trade's own. */
  presetOf(mode: string | null): LayerStates {
    if (mode === null) return NO_MODE;
    if (isModeId(mode)) return this.state.presets[mode] ?? MODES[mode].layers;
    return this.state.custom.find((c) => c.id === mode)?.layers ?? NO_MODE;
  }

  /** Whether a mode is one of the trades or one of this project's own. */
  knows(mode: string): boolean {
    return isModeId(mode) || this.state.custom.some((c) => c.id === mode);
  }

  /** The trade a mode is, or borrows its tools and colour from. */
  tradeOf(mode: string | null = this.state.mode): ModeId | null {
    if (mode === null) return null;
    if (isModeId(mode)) return mode;
    return this.state.custom.find((c) => c.id === mode)?.base ?? null;
  }

  nameOf(mode: string | null = this.state.mode): string {
    if (mode === null) return 'Every layer';
    if (isModeId(mode)) return MODES[mode].label;
    return this.state.custom.find((c) => c.id === mode)?.name ?? 'Mode';
  }

  /** The layers set otherwise than the mode's preset: each marked with a dot, and what Reset puts back. */
  changed(): ReadonlySet<PlanLayer> {
    const now = this.states();
    const preset = this.presetOf(this.state.mode);
    return new Set(PLAN_LAYERS.filter((l) => now[l] !== preset[l]));
  }

  /** The tools the rail offers in a mode; null for every tool (no mode, or a person's own without a trade). */
  rail(mode: string | null = this.state.mode): readonly RailItem[] | null {
    const trade = this.tradeOf(mode);
    return trade === null ? null : RAILS[trade];
  }

  // ─── Writing ───────────────────────────────────────────────────────────────────────────────

  /** Put the editor's layers and the ghosts in these states. */
  private write(states: LayerStates): void {
    const layers = { ...this.editor.get().layers };
    for (const l of PLAN_LAYERS) layers[l] = states[l] !== 'off';
    this.lastLayers = layers;
    this.editor.set({ layers });
    this.set({ ghost: PLAN_LAYERS.filter((l) => states[l] === 'ghost') });
  }

  /** Switch to a mode: its layers, its dimming, its rail and its inspector together; remembered for this project. */
  setMode(mode: string | null, tools?: ToolController): void {
    if (mode !== null && !isModeId(mode) && !this.state.custom.some((c) => c.id === mode)) return;
    this.set({ mode });
    this.write(this.presetOf(mode));
    // A tool the new rail does not offer is put down.
    const rail = this.rail(mode);
    const { tool, draw } = this.editor.get();
    // The measure tool is in every rail (FLR-T-18.9): it changes nothing, so no mode puts it down.
    // So are dimensions and notes (FLR-T-18.11): annotation is drawn over every trade's plan.
    if (rail !== null && tool !== 'select' && tool !== 'measure' && tool !== 'dimension' && tool !== 'note') {
      const offered = rail.some((r) => ('tool' in r && r.tool === tool) || ('device' in r && tool === 'device' && r.device === draw.device));
      if (!offered) {
        if (tools !== undefined) tools.setTool('select');
        else this.editor.setTool('select');
      }
    }
    this.save();
  }

  /** One layer On, Ghost or Off, within the mode. */
  setLayer(layer: PlanLayer, state: LayerState): void {
    this.write({ ...this.states(), [layer]: state });
    this.save();
  }

  /** Every layer back to the mode's preset. */
  reset(): void {
    this.write(this.presetOf(this.state.mode));
    this.save();
  }

  /** The current layers as a new mode of a person's own, switched to. */
  saveAsMode(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed === '') return null;
    const base = this.tradeOf();
    const taken = new Set(this.state.custom.map((c) => c.id));
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mode';
    let id = `custom:${slug}`;
    for (let i = 2; taken.has(id); i++) id = `custom:${slug}-${String(i)}`;
    const mode: CustomMode = { id, name: trimmed, base, layers: this.states() };
    this.set({ custom: [...this.state.custom, mode], mode: id, saving: false });
    this.save();
    return id;
  }

  /** The current layers as the trade's preset — what Reset returns to — for this project. */
  savePreset(): void {
    const mode = this.state.mode;
    if (mode === null) return;
    if (isModeId(mode)) this.set({ presets: { ...this.state.presets, [mode]: this.states() } });
    else this.set({ custom: this.state.custom.map((c) => (c.id === mode ? { ...c, layers: this.states() } : c)) });
    this.save();
  }

  /** A trade's preset back to the trade's own. */
  restorePreset(mode: ModeId): void {
    this.set({ presets: Object.fromEntries(Object.entries(this.state.presets).filter(([k]) => k !== mode)) });
    if (this.state.mode === mode) this.write(MODES[mode].layers);
    this.save();
  }

  deleteCustom(id: string): void {
    const custom = this.state.custom.filter((c) => c.id !== id);
    this.set({ custom });
    if (this.state.mode === id) this.setMode(null);
    else this.save();
  }

  setSaving(saving: boolean): void {
    this.set({ saving });
  }

  private save(): void {
    try {
      localStorage.setItem(modeKey(this.editor.projectId), JSON.stringify({ mode: this.state.mode, states: this.states(), custom: this.state.custom, presets: this.state.presets }));
    } catch {
      // Storage refused (a private window): the mode lasts for this session.
    }
  }
}

const stores = new WeakMap<EditorStore, ModesStore>();

/** The modes of an editor: one per editor store, made on first use (which applies the remembered mode). */
export function modesOf(store: EditorStore): ModesStore {
  let modes = stores.get(store);
  if (modes === undefined) {
    modes = new ModesStore(store);
    stores.set(store, modes);
  }
  return modes;
}

export function useModes<T>(store: EditorStore, selector: (s: ModesState) => T): T {
  const modes = modesOf(store);
  return useSyncExternalStore(modes.subscribe, () => selector(modes.get()), () => selector(modes.get()));
}

// ─── Picking: ghosts are not selectable on the plan ──────────────────────────────────────────

const picked = new WeakMap<LevelView, { key: string; view: LevelView }>();

/**
 * The level as the select tool picks from it: a ghosted layer's elements left out, so a click goes
 * through the walls in the electrical plan to the receptacle — or to nothing. The tree, the palette
 * and the Layers drawer (turning the layer back On) still reach them.
 */
export function pickable(level: LevelView, ghost: readonly PlanLayer[]): LevelView {
  if (ghost.length === 0) return level;
  const key = ghost.join(' ');
  const cached = picked.get(level);
  if (cached?.key === key) return cached.view;
  const g = new Set(ghost);
  const view: LevelView = {
    ...level,
    junctions: g.has('walls') ? [] : level.junctions,
    walls: g.has('walls') ? [] : level.walls,
    separators: g.has('walls') ? [] : level.separators,
    openings: g.has('openings') ? [] : level.openings,
    faces: g.has('rooms') ? level.faces.map((f) => ({ ...f, room: null })) : level.faces,
    slabs: g.has('rooms') ? [] : level.slabs,
    stairs: g.has('roof') ? [] : level.stairs,
    roofs: g.has('roof') ? [] : level.roofs,
    devices: level.devices.filter((d) => {
      const layer = layerOfElement(d.extension, d.collection);
      return layer === null || !g.has(layer);
    }),
  };
  picked.set(level, { key, view });
  return view;
}

/** The ghosts of an editor, for the tools. */
export const ghostsOf = (store: EditorStore): readonly PlanLayer[] => modesOf(store).get().ghost;

// ─── Keys and the command palette ────────────────────────────────────────────────────────────

export const MODE_COMMANDS: readonly Command[] = [
  ...MODE_IDS.map(
    (id, i): Command => ({
      id: `mode.${id}`,
      label: `${MODES[id].label} mode`,
      group: 'View',
      keywords: `mode trade view preset layers ${MODES[id].summary.toLowerCase()} ${MODES[id].plan.toLowerCase()}`,
      hint: `⌥${String(i + 1)}`,
      // ⌥1–⌥7 by the key's place (FLR-T-18.6's codes): ⌥ changes the character a digit types.
      codes: [`Alt+Digit${String(i + 1)}`],
      run: (store, tools) => {
        modesOf(store).setMode(id, tools);
      },
    }),
  ),
  {
    id: 'mode.none',
    label: 'Show every layer (no mode)',
    group: 'View',
    keywords: 'mode all layers everything clear',
    enabled: (store) => modesOf(store).get().mode !== null,
    run: (store, tools) => {
      modesOf(store).setMode(null, tools);
    },
  },
  {
    id: 'mode.reset',
    label: 'Reset the layers to the mode’s preset',
    group: 'View',
    keywords: 'mode layers reset preset',
    enabled: (store) => modesOf(store).changed().size > 0,
    run: (store) => {
      modesOf(store).reset();
    },
  },
  {
    id: 'mode.save',
    label: 'Save the current layers as a new mode…',
    group: 'View',
    keywords: 'mode layers save custom preset new',
    run: (store) => {
      modesOf(store).setSaving(true);
    },
  },
];
