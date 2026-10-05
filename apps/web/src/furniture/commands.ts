import type { Command } from '../editor/commands';
import type { EditorStore } from '../editor/store';
import { labelOf } from '../editor/model';
import { furnitureOf } from './state';
import { EXTENSION, turnFurniture } from './ops';

/**
 * The furniture's commands (FLR-T-8.3), in the editor's one registry (editor/commands.ts): F opens
 * the library, and `[` and `]` turn the selected item a quarter left or right — with Shift, by 15°.
 */

const editable = (store: EditorStore) => {
  const s = store.get();
  return s.readOnly === null && s.model !== null && s.pending === null && s.compare === null;
};

/** The selected FS_furniture element that turns: one on a floor or standing free. */
function turnable(store: EditorStore): { id: string; host: Record<string, unknown> } | null {
  const { model, selection } = store.get();
  if (model === null || selection === null || model.ext.get(selection)?.extension !== EXTENSION) return null;
  const host = model.levels.flatMap((l) => l.devices).find((d) => d.id === selection)?.host ?? null;
  return host !== null && (host['mode'] === 'surface' || host['mode'] === 'free') ? { id: selection, host } : null;
}

function turn(store: EditorStore, degrees: number): void {
  const t = turnable(store);
  const model = store.get().model;
  if (t === null || model === null) return;
  void store.apply(`Turn ${labelOf(model, t.id)} ${degrees > 0 ? 'left' : 'right'} ${String(Math.abs(degrees))}°`, () => {
    // Built when the edit runs, so a quick run of presses turns from wherever the last one left it.
    const now = turnable(store);
    return now === null ? [] : (turnFurniture(now.id, now.host, degrees * 1_000_000) ?? []);
  }, { select: () => t.id });
}

export const FURNITURE_COMMANDS: readonly Command[] = [
  {
    id: 'tool.furniture',
    label: 'Place furniture and appliances',
    group: 'Tools',
    keywords: 'furniture appliance fridge refrigerator sofa bed cabinet library glTF',
    keys: ['f'],
    hint: 'F',
    enabled: (store) => editable(store) && store.get().level !== null,
    run: (store) => {
      furnitureOf(store).set({ open: true, uploading: false });
    },
  },
  {
    id: 'edit.turnLeft',
    label: 'Turn the selected item left 90°',
    group: 'Edit',
    keywords: 'rotate furniture counter-clockwise',
    keys: ['['],
    hint: '[',
    enabled: (store) => editable(store) && turnable(store) !== null,
    run: (store) => { turn(store, 90); },
  },
  {
    id: 'edit.turnRight',
    label: 'Turn the selected item right 90°',
    group: 'Edit',
    keywords: 'rotate furniture clockwise',
    keys: [']'],
    hint: ']',
    enabled: (store) => editable(store) && turnable(store) !== null,
    run: (store) => { turn(store, -90); },
  },
  {
    id: 'edit.turnLeftFine',
    label: 'Turn the selected item left 15°',
    group: 'Edit',
    keywords: 'rotate furniture',
    keys: ['Shift+{', 'Shift+['],
    hint: '⇧[',
    enabled: (store) => editable(store) && turnable(store) !== null,
    run: (store) => { turn(store, 15); },
  },
  {
    id: 'edit.turnRightFine',
    label: 'Turn the selected item right 15°',
    group: 'Edit',
    keywords: 'rotate furniture',
    keys: ['Shift+}', 'Shift+]'],
    hint: '⇧]',
    enabled: (store) => editable(store) && turnable(store) !== null,
    run: (store) => { turn(store, -15); },
  },
];
