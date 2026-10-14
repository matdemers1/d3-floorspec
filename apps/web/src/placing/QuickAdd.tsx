import { useEffect, useMemo, useRef } from 'react';
import type { LevelView, Point } from '../editor/model';
import { labelOf } from '../editor/model';
import { dist, faceAt, project } from '../editor/geometry';
import { useEditor, type EditorStore, type Viewport } from '../editor/store';
import { toScreen } from '../editor/viewport';
import { entriesFor, kindText, search, type Entry } from './catalog';
import { Thumb } from './LibraryPanel';
import { closeQuickAdd, openLibrary, placingOf, quickPlace, quickPreview, usePlacing } from './state';

/**
 * The quick-add bar (FLR-T-18.7, the board's "18.7 · Quick add"): / opens it at the pointer, a
 * search over the whole library — recent items first — with the highlighted one ghosted where it
 * would go. Enter places it there, ⇧Enter places it and keeps placing it, Tab opens it in the
 * library drawer, Esc closes. A combobox over a listbox, so a screen reader hears each result.
 */

const SHOWN = 6;
const MM = 1_280;

/** What is under the point, as the bar's corner says it: "on wall W31 · Den", "in the Den". */
export function contextAt(level: LevelView, model: Parameters<typeof labelOf>[0], at: Point): string {
  const room = faceAt(level, at)?.room ?? null;
  let wall: { id: string; d: number } | null = null;
  for (const w of level.walls) {
    const pr = project(at, w.a, w.b);
    if (pr.t < 0 || pr.t > 1) continue;
    const d = pr.distance - w.thickness / 2;
    if (d <= 300 * MM && (wall === null || d < wall.d)) wall = { id: w.id, d };
  }
  const roomName = room === null ? null : labelOf(model, room);
  if (wall !== null) return `on wall ${labelOf(model, wall.id)}${roomName === null ? '' : ` · ${roomName}`}`;
  if (roomName !== null) return `in ${roomName}`;
  return `on ${level.name}`;
}

/** Whether an opening fits the wall nearest the point, for the result's second line. */
function fitsHere(level: LevelView, entry: Entry, at: Point): boolean {
  if (entry.placement !== 'opening') return false;
  const width = entry.box.max[1] - entry.box.min[1];
  let best: { L: number; d: number } | null = null;
  for (const w of level.walls) {
    const pr = project(at, w.a, w.b);
    if (pr.t < 0 || pr.t > 1) continue;
    if (best === null || pr.distance < best.d) best = { L: w.arc?.length ?? dist(w.a, w.b), d: pr.distance };
  }
  return best !== null && best.d < 600 * MM && best.L >= width;
}

export function QuickAdd({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const quick = usePlacing(store, (s) => s.quick);
  const recent = usePlacing(store, (s) => s.recent);
  const model = useEditor(store, (s) => s.model);
  const input = useRef<HTMLInputElement>(null);
  const document = model?.document;
  const all = useMemo(() => entriesFor(document), [document]);
  const results = useMemo(() => (quick === null ? [] : search(all, quick.query, recent).slice(0, SHOWN)), [all, quick, recent]);
  const index = quick === null ? 0 : Math.min(quick.index, Math.max(0, results.length - 1));
  const highlighted = results[index];
  useEffect(() => {
    if (quick !== null) input.current?.focus();
  }, [quick !== null]);
  useEffect(() => {
    quickPreview(store, highlighted);
  }, [store, highlighted, quick?.at]);
  if (quick === null || model === null) return null;
  const p = placingOf(store);
  const screen = toScreen(view, quick.at);
  // Below and to the right of the pointer, kept inside the plan.
  const left = Math.max(8, Math.min(view.w - 448, screen[0] + 24));
  const top = Math.max(8, Math.min(view.h - 360, screen[1] + 40));
  const where = contextAt(level, model, quick.at);
  const close = () => {
    closeQuickAdd(store);
    window.document.querySelector<HTMLElement>('.fs-editor')?.focus({ preventScroll: true });
  };
  const place = (entry: Entry | undefined, repeat: boolean) => {
    if (entry === undefined) return;
    // Placed first: the focus leaving the bar closes it.
    void quickPlace(store, entry, repeat);
    window.document.querySelector<HTMLElement>('.fs-editor')?.focus({ preventScroll: true });
  };
  return (
    <div className="fs-quick" style={{ left, top }} role="dialog" aria-label="Quick add" data-testid="quick-add">
      <div className="fs-quick__bar">
        <kbd className="fs-quick__key" aria-hidden="true">/</kbd>
        <input
          ref={input}
          className="fs-quick__input"
          role="combobox"
          aria-label="Add to the plan"
          aria-expanded={results.length > 0}
          aria-controls="fs-quick-results"
          aria-activedescendant={highlighted === undefined ? undefined : `fs-quick-${highlighted.key}`}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          value={quick.query}
          placeholder="Search everything to add"
          onChange={(e) => { p.set({ quick: { ...quick, query: e.currentTarget.value, index: 0 } }); }}
          onBlur={(e) => {
            // Leaving the bar for anything but its own results closes it.
            if (!(e.relatedTarget instanceof Element && e.relatedTarget.closest('.fs-quick') !== null)) closeQuickAdd(store);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const n = results.length;
              if (n > 0) p.set({ quick: { ...quick, index: (index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n } });
            } else if (e.key === 'Enter') {
              e.preventDefault();
              place(highlighted, e.shiftKey);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === 'Tab' && !e.shiftKey && highlighted !== undefined) {
              // Its options: the library drawer, searched to it.
              e.preventDefault();
              closeQuickAdd(store);
              p.set({ query: highlighted.name, group: 'all' });
              openLibrary(store);
            }
          }}
        />
        <span className="fs-quick__where">{where}</span>
      </div>
      <ul id="fs-quick-results" className="fs-quick__results" role="listbox" aria-label="Results">
        {results.map((e, i) => {
          const sub = [recent.includes(e.key) ? 'Recent' : null, fitsHere(level, e, quick.at) ? 'fits this wall' : null, recent.includes(e.key) ? null : kindText(e)].filter((x) => x !== null).join(' · ');
          return (
            <li
              key={e.key}
              id={`fs-quick-${e.key}`}
              role="option"
              aria-selected={i === index}
              className="fs-quick__result"
              onPointerDown={(ev) => { ev.preventDefault(); }}
              onPointerEnter={() => { if (i !== index) p.set({ quick: { ...quick, index: i } }); }}
              onClick={(ev) => { place(e, ev.shiftKey); }}
            >
              <span className="fs-quick__thumb">
                <Thumb entry={e} />
              </span>
              <span className="fs-quick__text">
                <span className="fs-quick__name">{e.name}</span>
                <span className="fs-quick__sub">{sub}</span>
              </span>
              {i === index ? (
                <kbd className="fs-quick__enter" aria-hidden="true">
                  ↵
                </kbd>
              ) : null}
            </li>
          );
        })}
        {results.length === 0 ? (
          <li className="fs-quick__none" role="presentation">
            Nothing matches “{quick.query}”.
          </li>
        ) : null}
      </ul>
      <div className="fs-quick__foot" aria-hidden="true">
        <kbd>↵</kbd> <span>place</span> <kbd>⇧↵</kbd> <span>place and repeat</span> <kbd>⇥</kbd> <span>options</span> <kbd>Esc</kbd> <span>close</span>
      </div>
    </div>
  );
}
