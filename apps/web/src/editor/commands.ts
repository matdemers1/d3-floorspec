import type { EditorStore, ToolId } from './store';
import type { ToolController } from './tools';
import { newLevel, roofOverLevel, switchUnits } from './actions';
import { navOf, zoomBy, zoomToFit, zoomToPercent, zoomToSelection, saveViewSoon } from './panzoom';
import { kindOf } from './model';
import { accept, openReview, reject } from './review';
import { compareOp, refreshLog, toggleHistory } from './history';
import { kindById, kindsOf, type SystemId } from './systems/catalog';
import { navigate } from '../lib/router';
import { threeOf } from './three/mode';
import { FURNITURE_COMMANDS } from '../furniture/commands';
import { MODE_COMMANDS } from './modes';
import { stageRooms } from './systems/Staging';
import { DRAWER_HINTS, drawersOf, setFullScreen, summonDrawer } from './drawers';
import { ARRANGE_COMMANDS } from './arrange/commands';

/**
 * The command registry: every editor action with a name, a group and its keys, in one list. The
 * keyboard dispatches through it and the command palette (⌘K, FLR-T-3.7) lists it, so a command
 * added here is reachable from both without being wired twice. The palette adds what depends on
 * the model — each level, each proposal, each unnamed space, each element — around these.
 */

export interface Command {
  id: string;
  label: string;
  group: 'Tools' | 'Edit' | 'View' | 'Model' | 'Review' | 'History';
  /** More words the palette matches on. */
  keywords?: string;
  /** Keys as KeyboardEvent.key, with `Mod+` for ⌘ on macOS and Ctrl elsewhere, `Shift+` for shift. */
  keys?: readonly string[];
  /**
   * Keys by their place on the keyboard (KeyboardEvent.code), for a key whose character a modifier
   * changes: `Shift+Digit1` (⇧1 types "!"), `Alt+KeyH` (⌥H types "˙" on a Mac), `Shift+KeyN` (a
   * letter's registry key has no Shift). Spelled as codeOf spells them.
   */
  codes?: readonly string[];
  /** A key hint for a tooltip: "W", "⌘Z". */
  hint?: string;
  enabled?: (store: EditorStore) => boolean;
  run: (store: EditorStore, tools: ToolController) => void;
}

const editable = (store: EditorStore) => {
  const s = store.get();
  return s.readOnly === null && s.model !== null && s.pending === null && s.compare === null;
};
const selectedKind = (store: EditorStore) => {
  const { model, selection } = store.get();
  return model === null || selection === null ? null : kindOf(model, selection);
};
const reviewing = (store: EditorStore) => {
  const r = store.get().review;
  return r !== null && r.busy === null && !r.loading;
};
const hasLevel = (store: EditorStore) => editable(store) && store.get().level !== null;

const tool = (id: ToolId, label: string, key: string): Command => ({
  id: `tool.${id}`,
  label,
  group: 'Tools',
  keys: [key.toLowerCase()],
  hint: key,
  enabled: id === 'select' || id === 'hand' ? () => true : hasLevel,
  run: (_store, tools) => {
    tools.setTool(id);
  },
});

/** The device tool on a system's kind: the one in use if it is that system's, else the system's first. */
const systemTool = (system: SystemId, label: string, key: string, keywords: string): Command => ({
  id: `tool.${system}`,
  label,
  group: 'Tools',
  keywords,
  keys: [key.toLowerCase()],
  hint: key,
  enabled: hasLevel,
  run: (store, tools) => {
    const current = kindById(store.get().draw.device);
    tools.useDevice(current?.system === system ? current.id : (kindsOf(system)[0]?.id ?? 'receptacle'));
  },
});

export const COMMANDS: readonly Command[] = [
  // Core 0.4, chapter 21: in the arc-wall tool's bulge step, bulge the other way.
  {
    id: 'arc.flip',
    label: 'Flip the arc being drawn',
    group: 'Tools',
    keywords: 'arc bulge flip curve',
    // Shift+F is read by the editor's key handler itself: a registry key of a letter has no Shift (keyOf).
    hint: 'Shift+F',
    enabled: (store) => {
      const d = store.get().draft;
      return d?.tool === 'arc' && d.start !== null && d.end !== null;
    },
    run: (_store, tools) => {
      tools.flipArc();
    },
  },
  tool('select', 'Select', 'V'),
  // FLR-T-18.6: the hand drags the plan; H, as in Figma (the P18 read-me moved the history to ⌥H).
  tool('hand', 'Hand — drag to pan', 'H'),
  tool('wall', 'Draw walls', 'W'),
  tool('arc', 'Draw arc walls', 'A'),
  tool('door', 'Place a door', 'D'),
  tool('window', 'Place a window', 'N'),
  tool('room', 'Name a room', 'R'),
  tool('separator', 'Draw a room separator', 'S'),
  tool('slab', 'Draw a slab', 'B'),
  tool('roof', 'Draw a roof', 'O'),
  tool('stair', 'Place a stair', 'T'),
  systemTool('electrical', 'Place electrical devices', 'E', 'receptacle switch light panel outlet'),
  systemTool('plumbing', 'Place plumbing fixtures', 'P', 'toilet sink lavatory shower tub water heater'),
  systemTool('mechanical', 'Place mechanical equipment', 'M', 'furnace register return fan range hvac'),
  systemTool('lowvoltage', 'Place low-voltage outlets', 'L', 'data coax network'),
  // The 3D view, the split view and the walkthrough (FLR-T-7.5).
  {
    id: 'view.plan',
    label: 'Show the 2D plan',
    group: 'View',
    keywords: 'view 2d plan',
    keys: ['1'],
    hint: '1',
    run: (store) => {
      threeOf(store).setMode('plan');
    },
  },
  {
    id: 'view.3d',
    label: 'Show the 3D view',
    group: 'View',
    keywords: 'three model orbit render',
    keys: ['2'],
    hint: '2',
    enabled: (store) => store.get().model !== null,
    run: (store) => {
      threeOf(store).setMode('3d');
    },
  },
  {
    id: 'view.split',
    label: 'Show the plan and 3D side by side',
    group: 'View',
    keywords: 'split 3d both synced',
    keys: ['3'],
    hint: '3',
    enabled: (store) => store.get().model !== null,
    run: (store) => {
      threeOf(store).setMode('split');
    },
  },
  {
    id: 'view.walk',
    label: 'Walk through in 3D',
    group: 'View',
    keywords: 'walkthrough first person eye height tour',
    keys: ['4'],
    hint: '4',
    enabled: (store) => store.get().model !== null,
    run: (store) => {
      const three = threeOf(store);
      if (three.get().walking) three.stopWalking();
      else three.walk(null);
    },
  },
  // FLR-T-13.2: which levels the 3D view shows — the same choices as its levels control.
  {
    id: 'view.wholeHouse',
    label: 'Show the whole house in 3D',
    group: 'View',
    keywords: '3d whole house all levels roof top complete',
    enabled: (store) => threeOf(store).get().mode !== 'plan',
    run: (store) => {
      threeOf(store).setLevels('house');
    },
  },
  {
    id: 'view.cutaway',
    label: 'Cut away the levels above in 3D',
    group: 'View',
    keywords: '3d cutaway levels below section',
    enabled: (store) => threeOf(store).get().mode !== 'plan' && store.get().level !== null,
    run: (store) => {
      threeOf(store).setLevels('cutaway');
    },
  },
  {
    id: 'view.onlyLevel',
    label: 'Show only this level in 3D',
    group: 'View',
    keywords: '3d isolate one level floor selection',
    enabled: (store) => threeOf(store).get().mode !== 'plan' && store.get().level !== null,
    run: (store) => {
      threeOf(store).setLevels('only');
    },
  },
  {
    id: 'view.coreOnly',
    label: 'Show as core-only',
    group: 'View',
    keywords: 'fallback reader extension boxes',
    run: (store) => {
      const layers = store.get().layers;
      store.set({ layers: { ...layers, coreOnly: !layers.coreOnly } });
    },
  },
  {
    id: 'view.roof',
    label: 'Show the roof layer',
    group: 'View',
    keywords: 'roofs eave ridge hip valley gable',
    run: (store) => {
      const layers = store.get().layers;
      store.set({ layers: { ...layers, roof: !layers.roof } });
    },
  },
  {
    id: 'model.roofOverLevel',
    label: 'Roof over this level',
    group: 'Model',
    keywords: 'roof hip gable footprint exterior walls',
    enabled: hasLevel,
    run: (store) => {
      roofOverLevel(store);
    },
  },
  {
    id: 'view.schedules',
    label: 'Open the schedules',
    group: 'View',
    keywords: 'rooms doors windows receptacles fixtures table csv',
    run: (store) => {
      navigate(`/projects/${store.projectId}/schedules`);
    },
  },
  {
    id: 'view.clearances',
    label: 'Show clearance envelopes',
    group: 'View',
    keywords: 'working space fixture clearance swing access',
    run: (store) => {
      const layers = store.get().layers;
      store.set({ layers: { ...layers, clearances: !layers.clearances } });
    },
  },
  {
    id: 'edit.undo',
    label: 'Undo',
    group: 'Edit',
    keys: ['Mod+z'],
    hint: '⌘Z',
    enabled: (store) => editable(store) && store.get().history.undo !== null,
    run: (store) => void store.undo('undo'),
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    group: 'Edit',
    keys: ['Mod+Shift+z', 'Mod+y'],
    hint: '⇧⌘Z',
    enabled: (store) => editable(store) && store.get().history.redo !== null,
    run: (store) => void store.undo('redo'),
  },
  {
    id: 'edit.delete',
    label: 'Delete the selection',
    group: 'Edit',
    keys: ['Delete', 'Backspace'],
    hint: '⌫',
    enabled: (store) => editable(store) && store.get().selection !== null,
    run: (_store, tools) => {
      tools.remove();
    },
  },
  // Pan and zoom (FLR-T-18.6), Figma's keys: ⇧1 fit, ⇧2 the selection, ⇧0 100%; animated.
  {
    id: 'view.fit',
    label: 'Zoom to fit',
    group: 'View',
    keywords: 'whole level all frame',
    keys: ['0'],
    codes: ['Shift+Digit1'],
    hint: '⇧1',
    run: (store) => {
      zoomToFit(store);
    },
  },
  {
    id: 'view.zoomSelection',
    label: 'Zoom to selection',
    group: 'View',
    keywords: 'frame selected element focus',
    codes: ['Shift+Digit2'],
    hint: '⇧2',
    enabled: (store) => store.get().selection !== null,
    run: (store) => {
      zoomToSelection(store);
    },
  },
  {
    id: 'view.zoom100',
    label: 'Zoom to 100%',
    group: 'View',
    keywords: 'actual size reset one hundred percent',
    codes: ['Shift+Digit0'],
    hint: '⇧0',
    run: (store) => {
      zoomToPercent(store, 100);
    },
  },
  {
    id: 'view.zoomIn',
    label: 'Zoom in',
    group: 'View',
    keys: ['=', '+', 'Shift++'],
    hint: '+',
    run: (store) => {
      zoomBy(store, 1.25);
    },
  },
  {
    id: 'view.zoomOut',
    label: 'Zoom out',
    group: 'View',
    keys: ['-', '_', 'Shift+_'],
    hint: '−',
    run: (store) => {
      zoomBy(store, 0.8);
    },
  },
  {
    id: 'view.minimap',
    label: 'Show the minimap',
    group: 'View',
    keywords: 'overview navigator map whole plan',
    codes: ['Shift+KeyN'],
    hint: '⇧N',
    run: (store) => {
      const nav = navOf(store);
      nav.setMinimap(!nav.get().minimap);
    },
  },
  {
    id: 'view.savedViews',
    label: 'Show the saved views',
    group: 'View',
    keywords: 'bookmarks named views camera',
    codes: ['Shift+KeyV'],
    hint: '⇧V',
    run: (store) => {
      const nav = navOf(store);
      nav.setViews(!nav.get().views);
    },
  },
  {
    id: 'view.saveView',
    label: 'Save this view',
    group: 'View',
    keywords: 'bookmark name view camera',
    codes: ['Mod+Shift+KeyS'],
    hint: '⇧⌘S',
    enabled: (store) => store.get().view !== null && store.get().level !== null,
    run: (store) => {
      saveViewSoon(store);
    },
  },
  {
    id: 'edit.rename',
    label: 'Rename the selection',
    group: 'Edit',
    keys: ['F2'],
    hint: 'F2',
    enabled: (store) => editable(store) && store.get().selection !== null,
    run: (store) => {
      store.set({ renaming: store.get().selection, treeOpen: true, left: 'tree' });
    },
  },
  {
    id: 'edit.addDoor',
    label: 'Add a door to the selected wall',
    group: 'Edit',
    keywords: 'opening centred',
    enabled: (store) => hasLevel(store) && selectedKind(store) === 'wall',
    run: (_store, tools) => {
      tools.setTool('door');
      tools.enter();
    },
  },
  {
    id: 'edit.addWindow',
    label: 'Add a window to the selected wall',
    group: 'Edit',
    keywords: 'opening centred',
    enabled: (store) => hasLevel(store) && selectedKind(store) === 'wall',
    run: (_store, tools) => {
      tools.setTool('window');
      tools.enter();
    },
  },
  {
    id: 'edit.nameRoom',
    label: 'Name a room in the largest unnamed space',
    group: 'Edit',
    keywords: 'add room face',
    enabled: (store) => hasLevel(store) && (store.levelView?.faces.some((f) => f.room === null) ?? false),
    run: (_store, tools) => {
      const face = tools.unnamedSpaces()[0];
      if (face !== undefined) tools.nameRoomIn(face);
    },
  },
  {
    id: 'model.stageRoom',
    label: 'Stage this room',
    group: 'Model',
    keywords: 'decor rug art lamp plant curtains staging assistant',
    enabled: (store) => editable(store) && selectedKind(store) === 'room',
    run: (store) => {
      const room = store.get().selection;
      if (room !== null) void stageRooms(store, [room]);
    },
  },
  {
    id: 'edit.selectNone',
    label: 'Clear the selection',
    group: 'Edit',
    enabled: (store) => store.get().selection !== null,
    run: (store) => {
      store.select(null);
    },
  },
  {
    id: 'view.palette',
    label: 'Command palette',
    group: 'View',
    keys: ['Mod+k'],
    hint: '⌘K',
    run: (store) => {
      store.set({ palette: !store.get().palette });
    },
  },
  // Full screen and the edge drawers (FLR-T-18.2). The drawers' keys are read by the editor's key
  // handler itself, by the key's place (⌥ and ⇧ change the character \\ types): ⌘\\, ⌘⌥\\, ⌘⇧\\.
  {
    id: 'view.fullscreen',
    label: 'Full screen',
    group: 'View',
    keywords: 'fullscreen chrome hide drawers edges focus plan only',
    keys: ['f'],
    hint: 'F',
    run: (store) => {
      setFullScreen(store, !drawersOf(store).get().full);
    },
  },
  {
    id: 'view.drawerLeft',
    label: 'Show the left drawer: tools and the project tree',
    group: 'View',
    keywords: 'project tree tools panel sidebar collapse pin',
    hint: DRAWER_HINTS.left,
    run: (store) => {
      summonDrawer(store, 'left');
    },
  },
  {
    id: 'view.drawerTop',
    label: 'Show the top drawer: the top bar',
    group: 'View',
    keywords: 'top bar toolbar levels views collapse pin',
    hint: DRAWER_HINTS.top,
    run: (store) => {
      summonDrawer(store, 'top');
    },
  },
  {
    id: 'view.drawerRight',
    label: 'Show the right drawer: the inspector',
    group: 'View',
    keywords: 'inspector properties panel sidebar collapse pin review findings',
    hint: DRAWER_HINTS.right,
    run: (store) => {
      summonDrawer(store, 'right');
    },
  },
  {
    id: 'view.levelUp',
    label: 'Go to the level above',
    group: 'View',
    keys: ['PageUp'],
    hint: 'PgUp',
    enabled: (store) => stepLevel(store, 1) !== null,
    run: (store) => {
      const next = stepLevel(store, 1);
      if (next !== null) store.setLevel(next);
    },
  },
  {
    id: 'view.levelDown',
    label: 'Go to the level below',
    group: 'View',
    keys: ['PageDown'],
    hint: 'PgDn',
    enabled: (store) => stepLevel(store, -1) !== null,
    run: (store) => {
      const next = stepLevel(store, -1);
      if (next !== null) store.setLevel(next);
    },
  },
  {
    id: 'history.toggle',
    label: 'Show the history',
    group: 'History',
    // ⌥H since FLR-T-18.6 (the P18 read-me): H is the hand, as in Figma.
    codes: ['Alt+KeyH'],
    hint: '⌥H',
    keywords: 'versions log undo',
    run: (store) => {
      toggleHistory(store);
    },
  },
  {
    id: 'history.compareLast',
    label: 'Compare the last change with the version before it',
    group: 'History',
    keywords: 'diff versions',
    enabled: (store) => store.get().history.seq !== null,
    run: (store) => {
      void (async () => {
        await refreshLog(store);
        const last = store.get().log?.find((e) => e.before !== null);
        if (last !== undefined) compareOp(store, last);
      })();
    },
  },
  {
    id: 'history.endCompare',
    label: 'Close the comparison',
    group: 'History',
    enabled: (store) => store.get().compare !== null,
    run: (store) => {
      store.set((s) => ({ compare: null, level: s.model?.levels.some((l) => l.id === s.level) === true ? s.level : (s.model?.levels[0]?.id ?? null) }));
    },
  },
  {
    id: 'review.open',
    label: 'Review the proposal',
    group: 'Review',
    keywords: 'changeset claude agent',
    enabled: (store) => store.get().proposals.length > 0,
    run: (store) => {
      const s = store.get();
      void openReview(store, s.review?.id ?? (s.proposals[0]?.id as string));
    },
  },
  {
    id: 'review.accept',
    label: 'Accept the proposal',
    group: 'Review',
    keywords: 'changeset merge',
    enabled: (store) => reviewing(store),
    run: (store) => {
      void accept(store);
    },
  },
  {
    id: 'review.reject',
    label: 'Reject the proposal',
    group: 'Review',
    keywords: 'changeset discard',
    enabled: (store) => reviewing(store),
    run: (store) => {
      void reject(store);
    },
  },
  {
    id: 'model.newLevel',
    label: 'Add a level',
    group: 'Model',
    enabled: editable,
    run: (store) => {
      newLevel(store);
    },
  },
  {
    id: 'model.metric',
    label: 'Show metric units',
    group: 'Model',
    enabled: (store) => editable(store) && store.units !== 'metric',
    run: (store) => {
      switchUnits(store, 'metric');
    },
  },
  {
    id: 'model.imperial',
    label: 'Show feet and inches',
    group: 'Model',
    enabled: (store) => editable(store) && store.units !== 'imperial',
    run: (store) => {
      switchUnits(store, 'imperial');
    },
  },
  // Multi-select and arrange (FLR-T-18.8): duplicate, select all and similar, align, distribute, mirror, array.
  ...ARRANGE_COMMANDS,
  // Furniture (FLR-T-8.3): I opens the library; [ and ] turn the selected item.
  ...FURNITURE_COMMANDS,
  // FLR-T-18.3: the trade modes, ⌥1–⌥7 (read by the editor's key handler, by the key's place).
  ...MODE_COMMANDS,
];

/** The level `dir` steps above (1) or below (-1) the current one, by elevation. */
function stepLevel(store: EditorStore, dir: 1 | -1): string | null {
  const { model, level } = store.get();
  if (model === null) return null;
  const ids = model.levels.map((l) => l.id);
  const i = level === null ? -1 : ids.indexOf(level);
  return ids[i + dir] ?? null;
}

/** The key a KeyboardEvent names, in the registry's spelling. */
export function keyOf(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): string {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return `${mod ? 'Mod+' : ''}${e.shiftKey && (mod || key.length > 1 || !/^[a-z0-9]$/.test(key)) ? 'Shift+' : ''}${key}`;
}

export function commandFor(key: string): Command | undefined {
  return COMMANDS.find((c) => c.keys?.includes(key) === true);
}

/** The key a KeyboardEvent names by its place on the keyboard, in the registry's `codes` spelling. */
export function codeOf(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): string {
  const mod = mac ? e.metaKey : e.ctrlKey;
  return `${mod ? 'Mod+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.code}`;
}

export function commandForCode(code: string): Command | undefined {
  return COMMANDS.find((c) => c.codes?.includes(code) === true);
}

export const commandById = (id: string): Command | undefined => COMMANDS.find((c) => c.id === id);
