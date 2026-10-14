import './placing.css';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, SearchField, TabPanel, Tabs } from '@d3cloud/ui';
import { Flower2, LayoutGrid, Shrub, Sprout, Star, TreeDeciduous, Upload, Wheat } from 'lucide-react';
import { useEditor, type EditorStore } from '../editor/store';
import { DoorIcon, PlugIcon, WindowIcon } from '../editor/icons';
import { DEVICE_ICONS } from '../editor/ModeSwitcher';
import { furnitureOf } from '../furniture/state';
import { GROUPS, entriesFor, footprintText, groupLabel, matches, type Entry, type GroupId } from './catalog';
import { closeLibrary, dragEnd, dragMove, dragStart, openLibrary, placingOf, startPlacing, toggleFavourite, usePlacing } from './state';

/**
 * The library drawer (FLR-T-18.7, the board's "18.7 · Library drawer — dragging a sofa onto the
 * plan"): the left drawer's Library tab beside the project tree — a search over everything that can
 * be added, the categories as chips, the recent and favourite items, and the cards. A card dragged
 * onto the plan is placed where its ghost shows when it is let go; a card clicked (or Enter on it)
 * places it click after click until Esc. With a finger, a sideways drag from a card drags it (an
 * up-and-down one scrolls the cards); a tap starts placing it, and a tap on the plan places it.
 */

/** The thumbnail a card shows: a library item's plan symbol, else its kind's icon. */
export function Thumb({ entry }: { entry: Entry }): ReactNode {
  if (entry.symbol !== null) return <img className="fs-lib-card__img" src={entry.symbol} alt="" draggable={false} />;
  const src = entry.source;
  let icon: ReactNode = <LayoutGrid />;
  if (src.kind === 'device') icon = DEVICE_ICONS[src.device.id] ?? <PlugIcon />;
  else if (src.kind === 'opening') icon = src.type.kind === 'doorType' ? <DoorIcon /> : <WindowIcon />;
  else if (src.kind === 'landscape') {
    const form = typeof src.element['form'] === 'string' ? src.element['form'] : '';
    icon = src.collection === 'beds' ? <Flower2 /> : form === 'tree' ? <TreeDeciduous /> : form === 'shrub' ? <Shrub /> : form === 'grass' ? <Wheat /> : <Sprout />;
  }
  return (
    <span className="fs-lib-card__icon" aria-hidden="true">
      {icon}
    </span>
  );
}

/** The drag threshold: a press that moves this far is a drag, not a click. */
const DRAG_PX = { mouse: 5, pen: 5, touch: 10 } as const;

/** A press on a card that may become a drag onto the plan. */
function useCardDrag(store: EditorStore) {
  const press = useRef<{ key: string; x: number; y: number; id: number; type: 'mouse' | 'pen' | 'touch'; dragging: boolean } | null>(null);
  const swallow = useRef(false);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (p === null || e.pointerId !== p.id) return;
      if (!p.dragging) {
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        if (Math.hypot(dx, dy) < DRAG_PX[p.type]) return;
        // A finger's up-and-down is a scroll of the cards, not a drag.
        if (p.type === 'touch' && Math.abs(dy) > Math.abs(dx)) {
          press.current = null;
          return;
        }
        p.dragging = true;
        dragStart(store, p.key, e.clientX, e.clientY);
      }
      dragMove(store, e.clientX, e.clientY, p.type === 'touch');
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      if (p === null || e.pointerId !== p.id) return;
      press.current = null;
      if (p.dragging) {
        swallow.current = true;
        void dragEnd(store, e.type === 'pointercancel');
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [store]);
  return {
    onPointerDown: (key: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      swallow.current = false;
      press.current = { key, x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse', dragging: false };
    },
    /** A drag ends in a click on the card it started from: not a click. */
    swallowClick: () => {
      const s = swallow.current;
      swallow.current = false;
      return s;
    },
  };
}

function Card({ store, entry, units, active, favourite, drag }: { store: EditorStore; entry: Entry; units: 'imperial' | 'metric'; active: boolean; favourite: boolean; drag: ReturnType<typeof useCardDrag> }) {
  const size = footprintText(entry, units);
  return (
    <li className="fs-lib-cards__item">
      <button
        type="button"
        className="fs-lib-card"
        data-entry={entry.key}
        aria-pressed={active}
        aria-label={`${entry.name}, ${size}`}
        onPointerDown={(e) => { drag.onPointerDown(entry.key, e); }}
        onClick={() => {
          if (drag.swallowClick()) return;
          startPlacing(store, entry.key);
          // The plan takes the keys from here: the arrows move the ghost, R turns it, Enter places it.
          document.querySelector<HTMLElement>('.fs-editor')?.focus({ preventScroll: true });
        }}
      >
        <span className="fs-lib-card__thumb">
          <Thumb entry={entry} />
        </span>
        <span className="fs-lib-card__name">{entry.name}</span>
        <span className="fs-lib-card__size">{size}</span>
      </button>
      <button
        type="button"
        className="fs-lib-card__star"
        aria-pressed={favourite}
        aria-label={favourite ? `Remove ${entry.name} from favourites` : `Add ${entry.name} to favourites`}
        onClick={() => { toggleFavourite(store, entry.key); }}
      >
        <Star aria-hidden="true" />
      </button>
    </li>
  );
}

/** A row of small tiles: the recent items, or the favourites. */
function Tiles({ store, label, entries, drag }: { store: EditorStore; label: string; entries: readonly Entry[]; drag: ReturnType<typeof useCardDrag> }) {
  if (entries.length === 0) return null;
  return (
    <section className="fs-lib__row" aria-label={label}>
      <h3 className="fs-lib__overline">{label}</h3>
      <ul className="fs-lib-tiles">
        {entries.map((e) => (
          <li key={e.key}>
            <button
              type="button"
              className="fs-lib-tile"
              aria-label={`${e.name} (${label.toLowerCase()})`}
              title={e.name}
              onPointerDown={(ev) => { drag.onPointerDown(e.key, ev); }}
              onClick={() => {
                if (drag.swallowClick()) return;
                startPlacing(store, e.key);
                document.querySelector<HTMLElement>('.fs-editor')?.focus({ preventScroll: true });
              }}
            >
              <Thumb entry={e} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LibraryPanel({ store }: { store: EditorStore }) {
  const model = useEditor(store, (s) => s.model);
  const readOnly = useEditor(store, (s) => s.readOnly) !== null;
  const units = useEditor(store, () => store.units);
  const query = usePlacing(store, (s) => s.query);
  const group = usePlacing(store, (s) => s.group);
  const recent = usePlacing(store, (s) => s.recent);
  const favourites = usePlacing(store, (s) => s.favourites);
  const active = usePlacing(store, (s) => s.dragging?.key ?? s.active);
  const focusSearch = usePlacing(store, (s) => s.focusSearch);
  const dragging = usePlacing(store, (s) => s.dragging);
  const drag = useCardDrag(store);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Focused with what it holds selected, so typing searches afresh.
    if (focusSearch > 0) {
      search.current?.focus();
      search.current?.select();
    }
  }, [focusSearch]);
  const document = model?.document;
  const all = useMemo(() => entriesFor(document), [document]);
  const found = useMemo(() => all.filter((e) => matches(e, query)), [all, query]);
  const shown = useMemo(() => (group === 'all' ? found : found.filter((e) => e.groups.includes(group))), [found, group]);
  const byKey = useMemo(() => new Map(all.map((e) => [e.key, e])), [all]);
  const recentEntries = recent.flatMap((k) => byKey.get(k) ?? []).slice(0, 4);
  const favouriteEntries = favourites.flatMap((k) => byKey.get(k) ?? []);
  const counts = (g: GroupId) => found.filter((e) => e.groups.includes(g)).length;
  const p = placingOf(store);
  const dragged = dragging === null ? undefined : byKey.get(dragging.key);
  return (
    <div className="fs-lib">
      <SearchField
        ref={search}
        className="fs-lib__search"
        aria-label="Search the library to add"
        placeholder={`Search ${String(all.length)} items`}
        value={query}
        onChange={(e) => { p.set({ query: e.currentTarget.value }); }}
        onKeyDown={(e) => {
          // Enter places the first match, click after click; Esc leaves the field for the plan.
          if (e.key === 'Enter' && shown[0] !== undefined && !readOnly) {
            e.preventDefault();
            startPlacing(store, shown[0].key);
            window.document.querySelector<HTMLElement>('.fs-editor')?.focus({ preventScroll: true });
          }
        }}
      />
      <div className="fs-lib__chips" role="group" aria-label="Categories">
        <button type="button" className="fs-lib-chip" aria-pressed={group === 'all'} onClick={() => { p.set({ group: 'all' }); }}>
          All
        </button>
        {GROUPS.filter((g) => counts(g.id) > 0 || group === g.id).map((g) => (
          <button key={g.id} type="button" className="fs-lib-chip" aria-pressed={group === g.id} onClick={() => { p.set({ group: g.id }); }}>
            {g.label}
          </button>
        ))}
      </div>
      {query === '' ? <Tiles store={store} label="Recent" entries={recentEntries} drag={drag} /> : null}
      {query === '' ? <Tiles store={store} label="Favourites" entries={favouriteEntries} drag={drag} /> : null}
      <section className="fs-lib__list" aria-label={`${group === 'all' ? 'Everything' : groupLabel(group)}: ${String(shown.length)} items`}>
        <h3 className="fs-lib__overline">
          {group === 'all' ? 'Everything' : groupLabel(group)} · {shown.length}
        </h3>
        {shown.length === 0 ? (
          <p className="fs-note fs-lib__none" role="status">
            Nothing {group === 'all' ? '' : `in ${groupLabel(group)} `}matches “{query}”.
          </p>
        ) : (
          <ul className="fs-lib-cards" aria-label="Library items to add">
            {shown.map((e) => (
              <Card key={e.key} store={store} entry={e} units={units} active={active === e.key} favourite={favourites.includes(e.key)} drag={drag} />
            ))}
          </ul>
        )}
      </section>
      {!readOnly ? (
        <div className="fs-lib__foot">
          <Button size="sm" variant="ghost" onClick={() => { furnitureOf(store).set({ open: true, uploading: false }); }}>
            Details…
          </Button>
          <Button size="sm" variant="ghost" icon={<Upload />} onClick={() => { furnitureOf(store).set({ open: true, uploading: true }); }}>
            Upload glTF
          </Button>
        </div>
      ) : null}
      <p className="fs-lib__help">Drag onto the plan, or click and place — R turns it, Esc stops.</p>
      {/* The card under the pointer until it is over the plan, where the ghost takes over; on the
          body, since a drawer's slide is a transform that a fixed box would be placed inside. */}
      {dragging !== null && !dragging.over && dragged !== undefined
        ? createPortal(
            <div className="fs-lib-drag" style={{ left: dragging.x, top: dragging.y }} aria-hidden="true">
              <Thumb entry={dragged} />
              <span>{dragged.name}</span>
            </div>,
            window.document.body,
          )
        : null}
    </div>
  );
}

/**
 * The left drawer's panel (FLR-T-18.7): the project tree and the library, as tabs. The history
 * (FLR-T-3.6) takes the panel's place while it is open, as before.
 */
export function LeftPanel({ store, tree }: { store: EditorStore; tree: ReactNode }) {
  const panel = usePlacing(store, (s) => s.panel);
  return (
    <div className="fs-left">
      <Tabs
        aria-label="Left drawer"
        className="fs-left__tabs"
        items={[{ value: 'tree', label: 'Tree' }, { value: 'library', label: 'Library' }]}
        value={panel ? 'library' : 'tree'}
        onValueChange={(v) => {
          if (v === 'library') openLibrary(store, { focus: false });
          else closeLibrary(store);
        }}
      >
        <TabPanel value="tree">{tree}</TabPanel>
        <TabPanel value="library">
          <LibraryPanel store={store} />
        </TabPanel>
      </Tabs>
    </div>
  );
}
