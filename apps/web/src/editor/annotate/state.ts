import { useSyncExternalStore } from 'react';
import type { EditorStore } from '../store';
import type { Point } from '../model';
import { modesOf } from '../modes';

/**
 * Dimensions and annotation in the editor (FLR-T-18.11, FLR-ADR-047), beside the editor's store as the
 * precision and mode state are: what a viewer shows of the annotation (per project and per mode, in
 * this browser — view state, never the model), the annotation selected on the plan, and the dimension
 * and note tools' drafts. What a person keeps — their own strings and notes — is FS_annotation in the
 * document, written as Ops like any other edit (ops.ts).
 */

/** What the plan shows of the annotation: Construction's summary toggles. */
export interface ShowSettings {
  /** The exterior strings: openings located, jogs, overall. */
  exterior: boolean;
  /** Each room's own strings, across and up it. */
  rooms: boolean;
  /** Door and window tags. */
  tags: boolean;
  /** The person's own strings and notes. */
  notes: boolean;
}

export const SHOW_LABELS: Readonly<Record<keyof ShowSettings, string>> = {
  exterior: 'Dimension strings',
  rooms: 'Room dimensions',
  tags: 'Door and window tags',
  notes: 'Your dimensions and notes',
};

/** Construction shows everything; every other view the exterior strings and the person's own. */
export function showDefaults(mode: string | null): ShowSettings {
  return mode === 'construction' ? { exterior: true, rooms: true, tags: true, notes: true } : { exterior: true, rooms: false, tags: false, notes: true };
}

/** An anchor of a string being drawn: what it will be measured to, and where it is on the plan. */
export type DraftAnchor =
  | { readonly kind: 'junction'; readonly id: string; readonly point: Point }
  | { readonly kind: 'wall'; readonly id: string; readonly face: 'left' | 'right' | 'axis'; readonly point: Point; readonly along: Point }
  | { readonly kind: 'opening'; readonly id: string; readonly point: Point }
  | { readonly kind: 'point'; readonly point: Point };

export interface DimensionDraft {
  /** The anchors picked so far, in order. */
  readonly anchors: readonly DraftAnchor[];
  /** What is under the pointer now: the next anchor, or where the line will go. */
  readonly hover: DraftAnchor | null;
  /** The pointer, plan. */
  readonly cursor: Point | null;
  /** Picking anchors, or placing the line (after a second anchor and a double click, or Enter). */
  readonly placing: boolean;
}

export interface NoteDraft {
  /** The point the leader points at, when it has one. */
  readonly tip: Point | null;
  /** Where the text goes (its first line's left baseline). */
  readonly at: Point | null;
  /** The text being typed, once placed. */
  readonly text: string;
  /** The pointer, plan, while dragging a leader. */
  readonly cursor: Point | null;
}

export interface AnnotateState {
  readonly show: ShowSettings;
  /** The annotation selected on the plan: a string's or a note's ID. */
  readonly selected: string | null;
  /** The note being edited in place. */
  readonly editing: string | null;
  readonly dimension: DimensionDraft;
  readonly note: NoteDraft | null;
}

export const EMPTY_DIMENSION: DimensionDraft = { anchors: [], hover: null, cursor: null, placing: false };

const showKey = (projectId: string): string => `floorspec.annotate.${projectId}`;

const isShow = (v: unknown): v is ShowSettings => {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return ['exterior', 'rooms', 'tags', 'notes'].every((k) => typeof o[k] === 'boolean');
};

function readSaved(projectId: string): Record<string, ShowSettings> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(showKey(projectId));
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, ShowSettings] => isShow(e[1])));
  } catch {
    return {};
  }
}

export class AnnotateStore {
  private state: AnnotateState;
  private readonly listeners = new Set<() => void>();
  private saved: Record<string, ShowSettings>;
  private modeKey: string;

  constructor(private readonly editor: EditorStore) {
    this.saved = readSaved(editor.projectId);
    const modes = modesOf(editor);
    this.modeKey = modes.get().mode ?? 'none';
    this.state = { show: this.showFor(this.modeKey), selected: null, editing: null, dimension: EMPTY_DIMENSION, note: null };
    modes.subscribe(() => {
      const key = modes.get().mode ?? 'none';
      if (key === this.modeKey) return;
      this.modeKey = key;
      this.set({ show: this.showFor(key) });
    });
    let was = { tool: editor.get().tool, level: editor.get().level, hash: editor.get().model?.hash };
    editor.subscribe(() => {
      const s = editor.get();
      // A tool put down, or the level changed: its draft goes.
      if (s.tool !== was.tool || s.level !== was.level) {
        if (this.state.dimension !== EMPTY_DIMENSION || this.state.note !== null) this.set({ dimension: EMPTY_DIMENSION, note: null });
        if (s.level !== was.level && this.state.selected !== null) this.set({ selected: null, editing: null });
      }
      // The selected annotation was removed (an undo, another tab): nothing is selected.
      if (s.model?.hash !== was.hash && this.state.selected !== null && s.model !== null && !annotationIds(s.model.document).has(this.state.selected)) this.set({ selected: null, editing: null });
      // Something else selected on the plan: the annotation lets go.
      if (s.selection !== null && this.state.selected !== null) this.set({ selected: null, editing: null });
      was = { tool: s.tool, level: s.level, hash: s.model?.hash };
    });
  }

  private showFor(key: string): ShowSettings {
    return this.saved[key] ?? showDefaults(key === 'none' ? null : key);
  }

  get = (): AnnotateState => this.state;

  set(patch: Partial<AnnotateState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** One toggle, remembered for this project and mode. */
  setShow(patch: Partial<ShowSettings>): void {
    const show = { ...this.state.show, ...patch };
    this.saved = { ...this.saved, [this.modeKey]: show };
    try {
      localStorage.setItem(showKey(this.editor.projectId), JSON.stringify(this.saved));
    } catch {
      // Private browsing: the toggle holds for this visit.
    }
    this.set({ show });
  }

  /** Select an annotation on the plan; the plan's own selection lets go. */
  select(id: string | null): void {
    if (id !== null && this.editor.get().selection !== null) this.editor.set({ selection: null, selected: [] });
    this.set({ selected: id, editing: null });
  }
}

type Json = Record<string, unknown>;

/** Every annotation ID a document holds (FS_annotation's dimensions and notes). */
export function annotationIds(document: unknown): Set<string> {
  const data = ((document as Json | null)?.['extensions'] as Json | undefined)?.['FS_annotation'] as Json | undefined;
  const ids = new Set<string>();
  for (const member of ['dimensions', 'notes']) {
    const rec = data?.[member];
    if (typeof rec === 'object' && rec !== null && !Array.isArray(rec)) for (const id of Object.keys(rec)) ids.add(id);
  }
  return ids;
}

const stores = new WeakMap<EditorStore, AnnotateStore>();

export function annotateOf(store: EditorStore): AnnotateStore {
  let a = stores.get(store);
  if (a === undefined) {
    a = new AnnotateStore(store);
    stores.set(store, a);
  }
  return a;
}

export function useAnnotate<T>(store: EditorStore, selector: (s: AnnotateState) => T): T {
  const a = annotateOf(store);
  return useSyncExternalStore(a.subscribe, () => selector(a.get()), () => selector(a.get()));
}
