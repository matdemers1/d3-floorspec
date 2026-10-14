import './elements.css';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useEditor, type EditorStore } from './store';
import { useModes, type PlanLayer } from './modes';
import { filteredModel, useRenovationFilter } from './renovation';
import { pickableIds, planElements, type PlanElement } from './elements';
import { goTo } from './panzoom';
import { closeLibrary } from '../placing/state';
import { drawersActive, drawersOf, focusCanvas } from './drawers';
import { annotateOf, useAnnotate } from './annotate/state';
import { resolvedOf } from './annotate/resolved';

/**
 * The elements on the plan as a list (FLR-T-18.16): a WAI-ARIA listbox in the left drawer's Elements
 * tab that mirrors what the canvas draws on the current level (elements.ts), for a screen reader and
 * for anyone who would rather pick from a list than from the plan.
 *
 * The listbox keeps the focus and points at its active option (aria-activedescendant): ↑/↓ move,
 * Home/End jump, Enter or Space selects the element on the plan and frames it there, ⇧ or ⌘ with
 * Space or Enter (or a click) adds it to the selection or takes it out, ⇧↑/⇧↓ extend the selection,
 * ⌘A selects everything listed, and Esc goes back to the plan with the selection kept — where the
 * arrows nudge it. The plan's selection is the list's: aria-selected follows it, and the active
 * option follows the plan's primary selection. A ghosted layer's elements are listed, disabled, as
 * the plan shows them but does not pick them.
 */
export function ElementList({ store }: { store: EditorStore }) {
  const fullModel = useEditor(store, (s) => (s.compare === null ? s.model : ((s.compare.scrub === true ? s.compare.fromModel : s.compare.toModel) ?? s.model)));
  const renoFilter = useRenovationFilter(store, fullModel);
  const model = useMemo(() => (fullModel === null ? null : filteredModel(fullModel, renoFilter)), [fullModel, renoFilter]);
  const levelId = useEditor(store, (s) => s.level);
  const layers = useEditor(store, (s) => s.layers);
  const ghostKey = useModes(store, (s) => s.ghost.join(' '));
  const selected = useEditor(store, (s) => s.selected);
  const selection = useEditor(store, (s) => s.selection);
  const units = useEditor(store, () => store.units);
  // FLR-T-18.11's own strings and notes, when the plan shows them; one is selected as an annotation.
  const showNotes = useAnnotate(store, (a) => a.show.notes);
  const annotation = useAnnotate(store, (a) => a.selected);
  const level = model?.levels.find((l) => l.id === levelId);
  const groups = useMemo(() => {
    if (model === null || level === undefined) return [];
    const anno = showNotes ? resolvedOf(model, level.id) : null;
    return planElements({ model, level, layers, ghost: ghostKey === '' ? [] : (ghostKey.split(' ') as PlanLayer[]), units, ...(anno === null ? {} : { annotations: anno }) });
  }, [model, level, layers, ghostKey, units, showNotes]);
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const [active, setActive] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const base = useId();
  const optionId = (id: string) => `${base}-${id}`;

  // The plan's primary selection is the active option: chosen on the canvas, it is found here.
  useEffect(() => {
    const on = selection ?? annotation;
    if (on !== null && items.some((i) => i.id === on)) setActive(on);
  }, [selection, annotation, items]);
  const isSelected = (item: PlanElement) => (item.annotation === true ? item.id === annotation : selected.includes(item.id));
  const current = items.find((i) => i.id === active) ?? items.find((i) => isSelected(i)) ?? items[0];
  const currentId = current?.id;
  useEffect(() => {
    if (currentId === undefined) return;
    document.getElementById(`${base}-${currentId}`)?.scrollIntoView({ block: 'nearest' });
  }, [base, currentId]);

  if (model === null || level === undefined) return <p className="fs-elements__empty">No level is shown.</p>;

  const move = (to: PlanElement | undefined, extend: boolean) => {
    if (to === undefined) return;
    setActive(to.id);
    if (extend && !to.ghost && to.annotation !== true) {
      store.selectMany([to.id], { add: true });
      if (anchor.current === null) anchor.current = to.id;
    }
  };
  const pick = (item: PlanElement, toggle: boolean) => {
    setActive(item.id);
    if (item.ghost) {
      store.set({ notice: { tone: 'info', text: `${item.label} is on a ghosted layer: turn the layer On to pick it.` } });
      return;
    }
    anchor.current = item.id;
    if (item.annotation === true) annotateOf(store).select(item.id);
    else if (toggle) store.toggleSelected(item.id);
    // Selected on the plan, and framed there; the list keeps the focus.
    else goTo(store, item.id);
  };
  const index = current === undefined ? -1 : items.indexOf(current);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        move(items[index + 1], e.shiftKey);
        break;
      case 'ArrowUp':
        move(items[Math.max(0, index - 1)], e.shiftKey);
        break;
      case 'Home':
        move(items[0], false);
        break;
      case 'End':
        move(items[items.length - 1], false);
        break;
      case 'Enter':
      case ' ':
        if (current !== undefined) pick(current, e.shiftKey || mod);
        break;
      case 'a':
      case 'A':
        if (mod) store.selectMany(pickableIds(groups));
        else handled = false;
        break;
      case 'Escape':
        focusCanvas();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const count = items.length;
  return (
    <section className="fs-elements" aria-labelledby={`${base}-title`}>
      <div className="fs-panel-head">
        <h2 id={`${base}-title`} className="fs-overline">
          On the plan · {level.name}
        </h2>
      </div>
      <p className="fs-elements__lede" id={`${base}-lede`}>
        {count === 0 ? 'Nothing is drawn on this level yet.' : `${String(count)} ${count === 1 ? 'element' : 'elements'}. Enter selects on the plan; ⇧ or ⌘ adds to the selection; Esc goes back to the plan.`}
      </p>
      {count === 0 ? null : (
        <div
          ref={list}
          role="listbox"
          tabIndex={0}
          aria-label={`Elements on ${level.name}`}
          aria-describedby={`${base}-lede`}
          aria-multiselectable="true"
          aria-activedescendant={current === undefined ? undefined : optionId(current.id)}
          className="fs-elements__list"
          data-testid="element-list"
          onKeyDown={onKeyDown}
        >
          {groups.map((g) => (
            <div key={g.id} role="group" aria-label={`${g.label}, ${String(g.items.length)}`} className="fs-elements__group">
              <div className="fs-elements__heading" aria-hidden="true">
                {g.label} <span className="fs-elements__count">{g.items.length}</span>
              </div>
              {g.items.map((item) => {
                const on = isSelected(item);
                return (
                  <div
                    key={item.id}
                    id={optionId(item.id)}
                    role="option"
                    aria-selected={on}
                    aria-disabled={item.ghost ? true : undefined}
                    data-element={item.id}
                    className={['fs-elements__option', on ? 'is-selected' : '', current?.id === item.id ? 'is-active' : '', item.ghost ? 'is-ghost' : ''].join(' ')}
                    onMouseDown={(e: MouseEvent) => {
                      // The list keeps the focus; the option becomes the active one.
                      e.preventDefault();
                      list.current?.focus({ preventScroll: true });
                    }}
                    onClick={(e) => { pick(item, e.shiftKey || e.metaKey || e.ctrlKey); }}
                  >
                    <span className="fs-elements__label">{item.label}</span>
                    <span className="fs-elements__meta">
                      {item.meta}
                      {item.ghost ? ' · ghosted' : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * ⌥L, or the plan's "Elements" button: the left drawer's Elements tab, brought out if it was put
 * away, with the focus on the list — on the element selected on the plan.
 */
export function openElementList(store: EditorStore): void {
  closeLibrary(store);
  store.set({ leftTab: 'elements', left: 'tree', treeOpen: true });
  if (drawersActive(store)) drawersOf(store).reveal('left');
  if (typeof document === 'undefined') return;
  let tries = 6;
  const focus = () => {
    const el = document.querySelector<HTMLElement>('[data-testid="element-list"]');
    if (el !== null && el.getClientRects().length > 0) {
      el.focus({ preventScroll: true });
      if (document.activeElement === el) return;
    }
    if (tries-- > 0) requestAnimationFrame(focus);
  };
  requestAnimationFrame(focus);
}
