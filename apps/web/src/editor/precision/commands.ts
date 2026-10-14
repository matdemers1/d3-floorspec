import { useEffect } from 'react';
import type { Command } from '../commands';
import type { EditorStore } from '../store';
import { temporaryDimensions } from './dimensions';
import { precisionOf } from './state';

/**
 * Precision's commands (FLR-T-18.9), in the registry so the palette and the keys reach them alike:
 * the measure tool (⇧M, the P18 read-me's key), snapping on and off and its menu, and typing into a
 * temporary dimension from the keyboard.
 */

const editable = (store: EditorStore) => {
  const s = store.get();
  return s.readOnly === null && s.model !== null && s.compare === null;
};

/** The selection's temporary dimensions now, measured to what the plan's are. */
function dimsOf(store: EditorStore) {
  const s = store.get();
  const level = store.levelView;
  if (s.model === null || level === undefined || s.selection === null || s.selected.length !== 1 || s.tool !== 'select') return [];
  return temporaryDimensions(s.model, level, s.selection, precisionOf(store).get().ref).filter((d) => d.apply !== undefined);
}

export const PRECISION_COMMANDS: readonly Command[] = [
  {
    id: 'tool.measure',
    label: 'Measure — point to point, chained, an area',
    group: 'Tools',
    keywords: 'measure tape ruler distance length area chain',
    codes: ['Shift+KeyM'],
    hint: '⇧M',
    enabled: (store) => store.get().model !== null && store.get().level !== null,
    run: (store, tools) => {
      tools.setTool(store.get().tool === 'measure' ? 'select' : 'measure');
    },
  },
  {
    id: 'snap.toggle',
    label: 'Turn snapping on or off',
    group: 'View',
    keywords: 'snap snapping magnet grid off on',
    run: (store) => {
      const p = precisionOf(store);
      p.setSnap({ on: !p.get().snap.on });
      store.set({ notice: { tone: 'info', text: p.get().snap.on ? 'Snapping is on.' : 'Snapping is off: points go where the pointer is.' } });
    },
  },
  {
    id: 'snap.menu',
    label: 'Snap settings…',
    group: 'View',
    keywords: 'snap snapping grid step angle junction midpoint guides items',
    run: (store) => {
      precisionOf(store).set({ menu: true });
    },
  },
  {
    id: 'dims.edit',
    label: 'Type a temporary dimension',
    group: 'Edit',
    keywords: 'temporary dimension distance move type position',
    enabled: (store) => editable(store) && dimsOf(store).length > 0,
    run: (store) => {
      const first = dimsOf(store)[0];
      if (first !== undefined) precisionOf(store).set({ editing: first.key });
    },
  },
  {
    id: 'dims.ref',
    label: 'Measure temporary dimensions to the next reference (face, centre, other face)',
    group: 'View',
    keywords: 'temporary dimension face centre center reference tab',
    run: (store) => {
      precisionOf(store).cycleRef();
    },
  },
];

/**
 * ⌥ held anywhere over the editor: hovering shows distances. ⇧, ⌘ or Ctrl held: the temporary
 * dimensions' numbers let a click through to what is under them (a ⇧-click adding it). Let go, or
 * the window loses focus, and both end.
 */
export function useAltHover(store: EditorStore): void {
  useEffect(() => {
    const p = precisionOf(store);
    const through = (e: KeyboardEvent) => e.shiftKey || e.metaKey || e.ctrlKey;
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && !p.get().alt) p.set({ alt: true });
      if (through(e) !== p.get().through) p.set({ through: through(e) });
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && p.get().alt) p.set({ alt: false });
      if (through(e) !== p.get().through) p.set({ through: through(e) });
    };
    const blur = () => {
      if (p.get().alt || p.get().through) p.set({ alt: false, through: false });
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [store]);
}
