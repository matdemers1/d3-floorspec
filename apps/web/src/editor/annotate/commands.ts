import type { Command } from '../commands';
import type { EditorStore } from '../store';
import { annotateOf } from './state';
import { removeAnnotation } from './ops';

/**
 * Annotation's commands (FLR-T-18.11), in the registry so the palette and the keys reach them alike:
 * the dimension tool (⇧D, Revit's DI) and the note tool (⇧T, its TX), and what the plan shows.
 */

const drawable = (store: EditorStore): boolean => {
  const s = store.get();
  return s.readOnly === null && s.model !== null && s.level !== null && s.compare === null;
};

/** Remove the annotation selected on the plan, when one is. Returns whether one was. */
export function removeSelectedAnnotation(store: EditorStore): boolean {
  const a = annotateOf(store);
  const id = a.get().selected;
  const model = store.get().model;
  if (id === null || model === null || store.get().readOnly !== null) return false;
  void store.apply('Remove the annotation', removeAnnotation(model, id)).then((ok) => { if (ok) a.select(null); });
  return true;
}

export const ANNOTATE_COMMANDS: readonly Command[] = [
  {
    id: 'tool.dimension',
    label: 'Dimension — measure between walls, junctions, doors and windows, and keep it',
    group: 'Tools',
    keywords: 'dimension string aligned linear measure annotate',
    codes: ['Shift+KeyD'],
    hint: '⇧D',
    enabled: drawable,
    run: (store, tools) => {
      tools.setTool(store.get().tool === 'dimension' ? 'select' : 'dimension');
    },
  },
  {
    id: 'tool.note',
    label: 'Note — text on the plan, with a leader',
    group: 'Tools',
    keywords: 'note text label leader annotate comment callout',
    codes: ['Shift+KeyT'],
    hint: '⇧T',
    enabled: drawable,
    run: (store, tools) => {
      tools.setTool(store.get().tool === 'note' ? 'select' : 'note');
    },
  },
  ...(
    [
      ['exterior', 'exterior dimension strings'],
      ['rooms', 'room dimensions'],
      ['tags', 'door and window tags'],
      ['notes', 'your dimensions and notes'],
    ] as const
  ).map(
    ([key, words]): Command => ({
      id: `annotate.show.${key}`,
      label: `Show or hide ${words}`,
      group: 'View',
      keywords: `annotation dimensions show hide ${words}`,
      run: (store) => {
        const a = annotateOf(store);
        a.setShow({ [key]: !a.get().show[key] });
      },
    }),
  ),
];
