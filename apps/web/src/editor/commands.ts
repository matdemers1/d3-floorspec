import type { EditorStore, ToolId } from './store';
import type { ToolController } from './tools';
import { newLevel, switchUnits } from './actions';
import { fit, zoomAt } from './viewport';

/**
 * The command registry: every editor action with a name, a group and its keys, in one list. The
 * keyboard dispatches through it now; the command palette (next round) lists it, so a command added
 * here is reachable from both without being wired twice.
 */

export interface Command {
  id: string;
  label: string;
  group: 'Tools' | 'Edit' | 'View' | 'Model';
  /** Keys as KeyboardEvent.key, with `Mod+` for ⌘ on macOS and Ctrl elsewhere, `Shift+` for shift. */
  keys?: readonly string[];
  /** A key hint for a tooltip: "W", "⌘Z". */
  hint?: string;
  enabled?: (store: EditorStore) => boolean;
  run: (store: EditorStore, tools: ToolController) => void;
}

const editable = (store: EditorStore) => {
  const s = store.get();
  return s.readOnly === null && s.model !== null && s.pending === null;
};
const hasLevel = (store: EditorStore) => editable(store) && store.get().level !== null;

const tool = (id: ToolId, label: string, key: string): Command => ({
  id: `tool.${id}`,
  label,
  group: 'Tools',
  keys: [key.toLowerCase()],
  hint: key,
  enabled: id === 'select' ? () => true : hasLevel,
  run: (_store, tools) => {
    tools.setTool(id);
  },
});

export const COMMANDS: readonly Command[] = [
  tool('select', 'Select', 'V'),
  tool('wall', 'Draw walls', 'W'),
  tool('door', 'Place a door', 'D'),
  tool('window', 'Place a window', 'N'),
  tool('room', 'Name a room', 'R'),
  tool('separator', 'Draw a room separator', 'S'),
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
  {
    id: 'view.fit',
    label: 'Zoom to fit',
    group: 'View',
    keys: ['0', 'Shift+!'],
    hint: '0',
    run: (store) => {
      const { view } = store.get();
      if (view !== null) store.set({ view: fit(store.levelView?.bounds ?? null, view.w, view.h) });
    },
  },
  {
    id: 'view.zoomIn',
    label: 'Zoom in',
    group: 'View',
    keys: ['=', '+', 'Shift++'],
    hint: '+',
    run: (store) => {
      const { view } = store.get();
      if (view !== null) store.set({ view: zoomAt(view, 1.25, [view.w / 2, view.h / 2]) });
    },
  },
  {
    id: 'view.zoomOut',
    label: 'Zoom out',
    group: 'View',
    keys: ['-', '_', 'Shift+_'],
    hint: '−',
    run: (store) => {
      const { view } = store.get();
      if (view !== null) store.set({ view: zoomAt(view, 0.8, [view.w / 2, view.h / 2]) });
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
];

/** The key a KeyboardEvent names, in the registry's spelling. */
export function keyOf(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): string {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return `${mod ? 'Mod+' : ''}${e.shiftKey && (mod || key.length > 1 || !/^[a-z0-9]$/.test(key)) ? 'Shift+' : ''}${key}`;
}

export function commandFor(key: string): Command | undefined {
  return COMMANDS.find((c) => c.keys?.includes(key) === true);
}

export const commandById = (id: string): Command | undefined => COMMANDS.find((c) => c.id === id);
