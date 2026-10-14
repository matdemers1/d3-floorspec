import type { Command } from '../editor/commands';
import type { EditorStore } from '../editor/store';
import { openPhrases } from './state';

/**
 * Say it on the plan (FLR-T-18.15): ⌘/ opens the phrase bar at the pointer. The command palette
 * (⌘K) reads a phrase typed into it too, and hands it to the bar with its preview.
 */

const editable = (store: EditorStore) => {
  const s = store.get();
  return s.readOnly === null && s.model !== null && s.compare === null && s.level !== null;
};

export const PHRASE_COMMANDS: readonly Command[] = [
  {
    id: 'edit.sayIt',
    label: 'Say it on the plan — an edit in plain words, previewed before it is applied',
    group: 'Edit',
    keywords: 'phrase say type plain words natural language command bar move push resize add door window place rename paint finish',
    keys: ['Mod+/'],
    hint: '⌘/',
    enabled: editable,
    run: (store) => {
      openPhrases(store);
    },
  },
];
