import { useSyncExternalStore } from 'react';
import type { EditorStore } from '../editor/store';
import type { Point } from '../editor/model';
import { ghostsOf, pickable } from '../editor/modes';
import { pickableUnder, storeStyles } from '../editor/renovation';
import { keyboardPoint, placeHere, placingOf } from '../placing/state';
import { interpret, type Outcome, type PhraseContext } from './resolve';

/**
 * Say it on the plan (FLR-T-18.15): the phrase bar's state, beside the editor's store as the quick-add
 * bar's is. A phrase is read as it is typed; what it would do is shown on the plan as a ghost — the
 * store's preview of its batch, carried riders and all, or the quick-add ghost of what it places —
 * and nothing is in the model until it is accepted: one batch, so one undo step. Rejecting (Esc)
 * drops the ghost and leaves the model as it was.
 */

export interface PhraseState {
  open: boolean;
  text: string;
  /** Where the bar opened: the pointer, else the middle of the view. */
  at: Point | null;
  /** Answers to the bar's questions ("which wall?"), by question. */
  picks: Readonly<Record<string, string>>;
  outcome: Outcome | null;
  /** The text and picks the outcome was worked out for. */
  for: string | null;
  /** The highlighted choice of a question. */
  index: number;
  /** Elements lit on the plan: the highlighted choice's. */
  hover: readonly string[];
  /** What was last done, for the live region once the bar has gone. */
  said: string;
}

const INITIAL: PhraseState = { open: false, text: '', at: null, picks: {}, outcome: null, for: null, index: 0, hover: [], said: '' };

export class PhraseStore {
  private state: PhraseState = INITIAL;
  private readonly listeners = new Set<() => void>();
  timer: ReturnType<typeof setTimeout> | null = null;
  /** The placing ghost is the bar's: cleared when the bar is done with it. */
  placing = false;

  get = (): PhraseState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<PhraseState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

const stores = new WeakMap<EditorStore, PhraseStore>();

export function phrasesOf(store: EditorStore): PhraseStore {
  let p = stores.get(store);
  if (p === undefined) {
    p = new PhraseStore();
    stores.set(store, p);
  }
  return p;
}

export function usePhrases<T>(store: EditorStore, selector: (s: PhraseState) => T): T {
  const p = phrasesOf(store);
  const snapshot = (): T => selector(p.get());
  return useSyncExternalStore(p.subscribe, snapshot, snapshot);
}

/** How long typing rests before the phrase is read and previewed. */
export const READ_AFTER_MS = 220;

const keyOf = (s: PhraseState) => `${s.text}\u0000${JSON.stringify(s.picks)}`;

/** What the resolver reads of the editor. */
export function contextOf(store: EditorStore): PhraseContext | null {
  const s = store.get();
  if (s.model === null) return null;
  const ghosts = ghostsOf(store);
  const styles = storeStyles(store);
  return {
    model: s.model,
    level: s.level,
    selected: s.selected,
    units: store.units,
    nudgeStep: store.nudgeStep,
    pickable: (level) => pickableUnder(pickable(level, ghosts), styles),
    at: phrasesOf(store).get().at ?? keyboardPoint(store),
  };
}

const editable = (store: EditorStore) => {
  const s = store.get();
  return s.readOnly === null && s.model !== null && s.compare === null && s.level !== null;
};

/** Open the bar, at the pointer; with a phrase (from the palette), read it at once. */
export function openPhrases(store: EditorStore, text = ''): void {
  if (!editable(store)) return;
  const p = phrasesOf(store);
  clearGhosts(store);
  p.set({ ...INITIAL, open: true, text, at: keyboardPoint(store), said: p.get().said });
  if (text.trim() !== '') read(store);
}

/** Drop whatever the bar is showing on the plan. */
function clearGhosts(store: EditorStore): void {
  const p = phrasesOf(store);
  if (p.timer !== null) {
    clearTimeout(p.timer);
    p.timer = null;
  }
  if (p.get().outcome?.status === 'ready' || p.get().for !== null) store.preview(null);
  if (p.placing) {
    placingOf(store).set({ ghost: null, quickKey: null });
    p.placing = false;
  }
}

/** Esc, or the focus leaving the bar: reject what it shows and close it. The model is untouched. */
export function closePhrases(store: EditorStore, said = ''): void {
  const p = phrasesOf(store);
  if (!p.get().open) return;
  clearGhosts(store);
  p.set({ ...INITIAL, said });
}

export function setText(store: EditorStore, text: string): void {
  const p = phrasesOf(store);
  clearGhosts(store);
  p.set({ text, picks: {}, outcome: null, for: null, index: 0, hover: [] });
  if (text.trim() === '') return;
  p.timer = setTimeout(() => {
    p.timer = null;
    read(store);
  }, READ_AFTER_MS);
}

/** The first choice that can be chosen. */
const firstEnabled = (o: Outcome | null): number => (o?.status === 'choose' ? Math.max(0, o.options.findIndex((c) => c.disabled === undefined)) : 0);

/** Read the phrase against the model now, and show what it would do. */
export function read(store: EditorStore): Outcome | null {
  const p = phrasesOf(store);
  if (p.timer !== null) {
    clearTimeout(p.timer);
    p.timer = null;
  }
  const ctx = contextOf(store);
  const s = p.get();
  if (ctx === null || !s.open) return null;
  clearGhosts(store);
  const outcome = interpret(s.text, ctx, s.picks);
  const index = firstEnabled(outcome);
  p.set({ outcome, for: keyOf(s), index, hover: outcome.status === 'choose' ? (outcome.options[index]?.highlight ?? []) : [] });
  if (outcome.status === 'ready') show(store, outcome);
  return outcome;
}

/** The ghost of a ready outcome: its batch previewed (carried riders included), or its placement's ghost. */
function show(store: EditorStore, outcome: Extract<Outcome, { status: 'ready' }>): void {
  // What it changes is on another level: go there, so the ghost is seen.
  if (store.get().level !== outcome.level) store.set({ level: outcome.level, draft: null, hover: null });
  if (outcome.place !== undefined) {
    placingOf(store).set({ ghost: outcome.place.ghost, quickKey: outcome.place.entry.key });
    phrasesOf(store).placing = true;
    return;
  }
  const batch = outcome.batch;
  if (batch === undefined) return;
  store.preview(typeof batch === 'function' ? batch(0) : batch);
}

/** Answer the bar's question with a choice, and read the phrase again with it. */
export function choose(store: EditorStore, value: string): void {
  const p = phrasesOf(store);
  const o = p.get().outcome;
  if (o?.status !== 'choose') return;
  const option = o.options.find((c) => c.value === value);
  if (option === undefined || option.disabled !== undefined) return;
  p.set({ picks: { ...p.get().picks, [o.key]: value } });
  read(store);
}

/** The highlighted choice moved (arrows, hover): light its element on the plan. */
export function highlight(store: EditorStore, index: number): void {
  const p = phrasesOf(store);
  const o = p.get().outcome;
  if (o?.status !== 'choose') return;
  const n = o.options.length;
  if (n === 0) return;
  const i = ((index % n) + n) % n;
  p.set({ index: i, hover: o.options[i]?.highlight ?? [] });
}

/** Whether the outcome showing is for the phrase as it is now. */
export const current = (s: PhraseState): boolean => s.for === keyOf(s);

/**
 * Accept: the phrase is read once more against the model as it is now (main may have moved), and
 * what it makes is applied — one batch, one undo step. Resolves true when it was committed.
 */
export async function accept(store: EditorStore): Promise<boolean> {
  const p = phrasesOf(store);
  const s = p.get();
  if (!s.open) return false;
  if (!current(s) || s.outcome?.status !== 'ready') {
    read(store);
    return false;
  }
  // A batch the applier refuses is not sent: the card says why.
  if (s.outcome.batch !== undefined && store.get().preview?.model === null) return false;
  const ctx = contextOf(store);
  if (ctx === null) return false;
  const outcome = interpret(s.text, ctx, s.picks);
  if (outcome.status !== 'ready') {
    p.set({ outcome, for: keyOf(s) });
    return false;
  }
  closePhrases(store, `Applied: ${outcome.summary}`);
  if (outcome.place !== undefined) return placeHere(store, outcome.place.entry.key, outcome.place.ghost);
  if (outcome.batch === undefined) return false;
  const ok = await store.apply(outcome.label, outcome.batch, {
    select: (created) => (outcome.selectNew === true ? (created.find((id) => /^O\d+$/.test(id)) ?? null) : outcome.select === null ? undefined : outcome.select),
  });
  if (!ok) phrasesOf(store).set({ said: `Not applied: ${outcome.summary}` });
  return ok;
}
