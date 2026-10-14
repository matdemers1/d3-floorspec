import { useEffect } from 'react';
import type { Command } from '../commands';
import type { EditorStore } from '../store';
import { labelOf, sortedLevels } from '../model';
import { arrangeOf } from './state';
import { toggleArray } from './Overlay';
import {
  alignSelection,
  copySelection,
  copyToLevel,
  deleteSelection,
  distributeSelection,
  duplicateSelection,
  editable,
  lastClip,
  mirrorSelection,
  nudgeSelection,
  pasteClip,
  pasteText,
  selectedHere,
  selectSimilar,
  turnSelection,
  zoomToSelection,
} from './actions';

/**
 * The multi-selection's commands (FLR-T-18.8) in the editor's one registry, so the palette lists
 * them and the keyboard reaches them: ⌘D duplicate, ⌘A select all, ⇧⌘A select similar. The keys a
 * registry entry cannot spell — ⌥A, ⌥⇧H/⌥⇧V, ⇧H/⇧V, which ⌥ and ⇧ change the character of — and
 * `[` / `]` with several selected (the registry's are the single item's, FLR-T-8.3) are read by
 * `arrangeKey` by the key's place; ⌘C, ⌘X and ⌘V are the page's own
 * copy, cut and paste events (`useClipboard`), so a copy reaches the system clipboard and another
 * tab or project can paste it.
 */

const canEdit = (store: EditorStore) => editable(store.get()) && store.get().pending === null;
const some = (store: EditorStore, n = 1) => selectedHere(store).length >= n;

export const ARRANGE_COMMANDS: readonly Command[] = [
  {
    id: 'edit.duplicate',
    label: 'Duplicate the selection',
    group: 'Edit',
    keywords: 'copy clone repeat',
    keys: ['Mod+d'],
    hint: '⌘D',
    enabled: (store) => canEdit(store) && some(store),
    run: (store) => { duplicateSelection(store); },
  },
  {
    id: 'edit.copy',
    label: 'Copy the selection',
    group: 'Edit',
    keywords: 'clipboard',
    hint: '⌘C',
    enabled: (store) => some(store),
    run: (store) => { copySelection(store); },
  },
  {
    id: 'edit.paste',
    label: 'Paste',
    group: 'Edit',
    keywords: 'clipboard',
    hint: '⌘V',
    enabled: (store) => canEdit(store) && lastClip(store) !== null,
    run: (store) => {
      const clip = lastClip(store);
      if (clip !== null) void pasteClip(store, clip);
    },
  },
  {
    id: 'edit.selectAll',
    label: 'Select everything on this level',
    group: 'Edit',
    keywords: 'all marquee',
    keys: ['Mod+a'],
    hint: '⌘A',
    enabled: (store) => store.get().tool === 'select' && store.levelView !== undefined,
    run: (store, tools) => { selectSimilar(store, 'level', tools.pickLevel); },
  },
  {
    id: 'edit.selectSimilar',
    label: 'Select similar: every one of the same item on this level',
    group: 'Edit',
    keywords: 'matching same catalogue type instances',
    keys: ['Mod+Shift+a'],
    hint: '⇧⌘A',
    enabled: (store) => some(store),
    run: (store, tools) => { selectSimilar(store, 'item', tools.pickLevel); },
  },
  {
    id: 'edit.selectKind',
    label: 'Select every one of the same kind on this level',
    group: 'Edit',
    keywords: 'similar matching all lights walls doors',
    enabled: (store) => some(store),
    run: (store, tools) => { selectSimilar(store, 'kind', tools.pickLevel); },
  },
  {
    id: 'arrange.turnLeft',
    label: 'Turn the selection left 90°',
    group: 'Edit',
    keywords: 'rotate group counter-clockwise',
    hint: '[',
    enabled: (store) => canEdit(store) && some(store, 2),
    run: (store) => { turnSelection(store, 1); },
  },
  {
    id: 'arrange.turnRight',
    label: 'Turn the selection right 90°',
    group: 'Edit',
    keywords: 'rotate group clockwise',
    hint: ']',
    enabled: (store) => canEdit(store) && some(store, 2),
    run: (store) => { turnSelection(store, -1); },
  },
  { id: 'arrange.mirrorH', label: 'Mirror the selection left ↔ right', group: 'Edit', keywords: 'flip horizontal', hint: '⇧H', enabled: (store) => canEdit(store) && some(store), run: (store) => { mirrorSelection(store, 'h'); } },
  { id: 'arrange.mirrorV', label: 'Mirror the selection top ↔ bottom', group: 'Edit', keywords: 'flip vertical', hint: '⇧V', enabled: (store) => canEdit(store) && some(store), run: (store) => { mirrorSelection(store, 'v'); } },
  { id: 'arrange.alignLeft', label: 'Align left edges', group: 'Edit', keywords: 'align', enabled: (store) => canEdit(store) && some(store, 2), run: (store) => { alignSelection(store, 'left'); } },
  { id: 'arrange.alignCentre', label: 'Align centres', group: 'Edit', keywords: 'align center horizontal', enabled: (store) => canEdit(store) && some(store, 2), run: (store) => { alignSelection(store, 'centre'); } },
  { id: 'arrange.alignRight', label: 'Align right edges', group: 'Edit', keywords: 'align', enabled: (store) => canEdit(store) && some(store, 2), run: (store) => { alignSelection(store, 'right'); } },
  { id: 'arrange.alignTop', label: 'Align tops', group: 'Edit', keywords: 'align north', enabled: (store) => canEdit(store) && some(store, 2), run: (store) => { alignSelection(store, 'top'); } },
  { id: 'arrange.alignMiddle', label: 'Align middles', group: 'Edit', keywords: 'align center vertical', enabled: (store) => canEdit(store) && some(store, 2), run: (store) => { alignSelection(store, 'middle'); } },
  { id: 'arrange.alignBottom', label: 'Align bottoms', group: 'Edit', keywords: 'align south', enabled: (store) => canEdit(store) && some(store, 2), run: (store) => { alignSelection(store, 'bottom'); } },
  { id: 'arrange.distributeH', label: 'Distribute horizontally', group: 'Edit', keywords: 'space evenly across', hint: '⌥⇧H', enabled: (store) => canEdit(store) && some(store, 3), run: (store) => { distributeSelection(store, 'x'); } },
  { id: 'arrange.distributeV', label: 'Distribute vertically', group: 'Edit', keywords: 'space evenly up down', hint: '⌥⇧V', enabled: (store) => canEdit(store) && some(store, 3), run: (store) => { distributeSelection(store, 'y'); } },
  {
    id: 'arrange.array',
    label: 'Array the selection: along a line, a wall or a grid',
    group: 'Edit',
    keywords: 'repeat copies row along wall lights outlets cabinets multiple copy',
    hint: '⌥A',
    enabled: (store) => canEdit(store) && some(store),
    run: (store) => { toggleArray(store); },
  },
  { id: 'arrange.zoom', label: 'Zoom to the selection', group: 'View', keywords: 'fit selection', enabled: (store) => some(store), run: (store) => { zoomToSelection(store); } },
  {
    id: 'arrange.copyUp',
    label: 'Copy the selection to the level above',
    group: 'Edit',
    keywords: 'upper floor paste level',
    enabled: (store) => canEdit(store) && some(store) && otherLevel(store, 1) !== null,
    run: (store) => {
      const to = otherLevel(store, 1);
      if (to !== null) copyToLevel(store, to);
    },
  },
  {
    id: 'arrange.copyDown',
    label: 'Copy the selection to the level below',
    group: 'Edit',
    keywords: 'lower floor paste level',
    enabled: (store) => canEdit(store) && some(store) && otherLevel(store, -1) !== null,
    run: (store) => {
      const to = otherLevel(store, -1);
      if (to !== null) copyToLevel(store, to);
    },
  },
];

function otherLevel(store: EditorStore, dir: 1 | -1): string | null {
  const { model, level } = store.get();
  if (model === null || level === null) return null;
  const ids = sortedLevels(model.document).map((l) => l.id);
  return ids[ids.indexOf(level) + dir] ?? null;
}

export const levelName = (store: EditorStore, id: string): string => {
  const model = store.get().model;
  return model === null ? id : labelOf(model, id);
};

/**
 * The keys the registry cannot spell, read by their place (FLR-T-18.8): ⌥A array, ⌥⇧H / ⌥⇧V
 * distribute, ⇧H / ⇧V mirror (only with something selected — without, ⇧V stays the saved views'),
 * the arrows moving several at once. True when the key was taken.
 */
export function arrangeKey(store: EditorStore, e: KeyboardEvent, mac: boolean): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (mod || store.get().tool !== 'select') return false;
  const code = e.code;
  if (e.altKey && !e.shiftKey && code === 'KeyA') {
    if (!canEdit(store) || !some(store)) return false;
    toggleArray(store);
    return true;
  }
  if (e.altKey && e.shiftKey && (code === 'KeyH' || code === 'KeyV')) {
    if (!canEdit(store) || !some(store, 3)) return false;
    distributeSelection(store, code === 'KeyH' ? 'x' : 'y');
    return true;
  }
  if (!e.altKey && e.shiftKey && (code === 'KeyH' || code === 'KeyV')) {
    if (!canEdit(store) || !some(store)) return false;
    mirrorSelection(store, code === 'KeyH' ? 'h' : 'v');
    return true;
  }
  if (!e.altKey && !e.shiftKey && (e.key === '[' || e.key === ']') && store.get().selected.length > 1) {
    if (!canEdit(store)) return false;
    turnSelection(store, e.key === '[' ? 1 : -1);
    return true;
  }
  if (!e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') && store.get().selected.length > 1) {
    return nudgeSelection(store, e.key, e.shiftKey);
  }
  if (e.key === 'Escape' && arrangeOf(store).get().array !== null) {
    arrangeOf(store).set({ array: null });
    return true;
  }
  return false;
}

/**
 * ⌘C, ⌘X and ⌘V as the page's copy, cut and paste events: a copy of the selection goes onto the
 * system clipboard as JSON (and a line of text), so it pastes in another tab, another level or
 * another project; a paste of one lands here as one batch. A field being typed in keeps its own.
 */
export function useClipboard(store: EditorStore): void {
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return el !== null && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
    };
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (typing(e.target) || document.querySelector('[role="dialog"]') !== null || window.getSelection()?.toString()) return;
      if (selectedHere(store).length === 0) return;
      const clip = copySelection(store);
      if (clip === null || e.clipboardData === null) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', JSON.stringify(clip));
      if (cut && canEdit(store)) deleteSelection(store);
    };
    const copy = (e: ClipboardEvent) => { onCopy(e, false); };
    const cut = (e: ClipboardEvent) => { onCopy(e, true); };
    const paste = (e: ClipboardEvent) => {
      if (typing(e.target) || document.querySelector('[role="dialog"]') !== null || !canEdit(store)) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (pasteText(store, text)) {
        e.preventDefault();
        return;
      }
      // Nothing of ours on the system clipboard: the last copy made in this tab, if any.
      const clip = lastClip(store);
      if (clip !== null && text === '') {
        e.preventDefault();
        void pasteClip(store, clip);
      }
    };
    window.addEventListener('copy', copy);
    window.addEventListener('cut', cut);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('copy', copy);
      window.removeEventListener('cut', cut);
      window.removeEventListener('paste', paste);
    };
  }, [store]);
}
