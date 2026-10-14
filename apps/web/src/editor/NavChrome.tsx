import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { IconButton, SegmentedControl, Tooltip } from '@d3cloud/ui';
import { Bookmark, ChevronDown, Focus, Hand, Map as MapIcon, Plus, Scan, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useEditor, type EditorStore, type Viewport } from './store';
import { commandById } from './commands';
import { Plan } from './Canvas';
import { fit, MAX_PERCENT, MIN_PERCENT, panBy, toScreen, visibleRegion, zoomPercent } from './viewport';
import {
  WHEEL_HELP,
  WHEEL_LABELS,
  navOf,
  openView,
  removeView,
  saveView,
  suggestedName,
  useNav,
  zoomBy,
  zoomToFit,
  zoomToPercent,
  zoomToSelection,
  type SavedView,
  type WheelMode,
} from './panzoom';

/**
 * The canvas's pan and zoom chrome (FLR-T-18.6), after the board's "18.6 · Pan and zoom" frame:
 * the zoom bar (− · the zoom, editable · + | fit · selection · hand · minimap · saved views), its
 * menu, the saved views and the 2D minimap. In full screen the bar steps aside with the rest of the
 * chrome (FLR-T-18.2) while the minimap and the saved views stay where they were left; their keys
 * (⇧N, ⇧V) reach them there.
 */

const hint = (id: string) => commandById(id)?.hint ?? '';
const tip = (label: string, id: string) => `${label} (${hint(id)})`;

// ─── The zoom bar ────────────────────────────────────────────────────────────────────────────

export function ZoomBar({ store, view }: { store: EditorStore; view: Viewport }) {
  const [menu, setMenu] = useState(false);
  const readout = useRef<HTMLButtonElement>(null);
  const tool = useEditor(store, (s) => s.tool);
  const selected = useEditor(store, (s) => s.selection !== null);
  const minimap = useNav(store, (n) => n.minimap);
  const views = useNav(store, (n) => n.views);
  const nav = navOf(store);
  const percent = zoomPercent(view);
  return (
    <div className="fs-zoom" role="toolbar" aria-label="Zoom and navigate">
      <Tooltip content={tip('Zoom out', 'view.zoomOut')}>
        <IconButton size="sm" label="Zoom out" icon={<ZoomOut />} onClick={() => { zoomBy(store, 0.8); }} />
      </Tooltip>
      <button
        ref={readout}
        type="button"
        className="fs-zoom__value"
        aria-label={`Zoom ${String(percent)}%: type a zoom`}
        aria-haspopup="dialog"
        aria-expanded={menu}
        onClick={() => { setMenu(!menu); }}
      >
        <span>{percent}%</span>
        <ChevronDown aria-hidden="true" />
      </button>
      <Tooltip content={tip('Zoom in', 'view.zoomIn')}>
        <IconButton size="sm" label="Zoom in" icon={<ZoomIn />} onClick={() => { zoomBy(store, 1.25); }} />
      </Tooltip>
      <span className="fs-zoom__rule" aria-hidden="true" />
      <Tooltip content={tip('Zoom to fit', 'view.fit')}>
        <IconButton size="sm" label="Zoom to fit" icon={<Scan />} onClick={() => { zoomToFit(store); }} />
      </Tooltip>
      <Tooltip content={tip('Zoom to selection', 'view.zoomSelection')}>
        <IconButton size="sm" label="Zoom to selection" icon={<Focus />} disabled={!selected} onClick={() => { zoomToSelection(store); }} />
      </Tooltip>
      <Tooltip content={tip('Hand', 'tool.hand')}>
        <IconButton size="sm" label="Hand" icon={<Hand />} pressed={tool === 'hand'} onClick={() => { store.setTool(tool === 'hand' ? 'select' : 'hand'); }} />
      </Tooltip>
      <Tooltip content={tip('Minimap', 'view.minimap')}>
        <IconButton size="sm" label="Minimap" icon={<MapIcon />} pressed={minimap} onClick={() => { nav.setMinimap(!minimap); }} />
      </Tooltip>
      <Tooltip content={tip('Saved views', 'view.savedViews')}>
        <IconButton size="sm" label="Saved views" icon={<Bookmark />} pressed={views} onClick={() => { nav.setViews(!views); }} />
      </Tooltip>
      {menu ? (
        <ZoomMenu
          store={store}
          percent={percent}
          selected={selected}
          onClose={(refocus) => {
            setMenu(false);
            if (refocus) readout.current?.focus();
          }}
          trigger={readout}
        />
      ) : null}
    </div>
  );
}

/** "180", "180%", " 75 % ": a zoom percentage, or null. */
export function parsePercent(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(text);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, n)) : null;
}

function ZoomMenu({ store, percent, selected, onClose, trigger }: { store: EditorStore; percent: number; selected: boolean; onClose: (refocus: boolean) => void; trigger: React.RefObject<HTMLButtonElement | null> }) {
  const [text, setText] = useState(String(percent));
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const wheel = useNav(store, (n) => n.wheel);
  const id = useId();

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // A press outside the menu (and its trigger) closes it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t !== null && (panel.current?.contains(t) === true || trigger.current?.contains(t) === true)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => { document.removeEventListener('pointerdown', onDown, true); };
  }, [onClose, trigger]);

  const run = (fn: () => void) => () => {
    fn();
    onClose(true);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    }
  };
  const items: { label: string; keys?: string; disabled?: boolean; run: () => void }[] = [
    { label: 'Zoom to fit', keys: hint('view.fit'), run: () => { zoomToFit(store); } },
    { label: 'Zoom to selection', keys: hint('view.zoomSelection'), disabled: !selected, run: () => { zoomToSelection(store); } },
    { label: 'Zoom to 100%', keys: hint('view.zoom100'), run: () => { zoomToPercent(store, 100); } },
    { label: '50%', run: () => { zoomToPercent(store, 50); } },
    { label: '200%', run: () => { zoomToPercent(store, 200); } },
    { label: '400%', run: () => { zoomToPercent(store, 400); } },
  ];
  return (
    <div ref={panel} className="fs-zoommenu" role="dialog" aria-label="Zoom" onKeyDown={onKey}>
      <form
        className="fs-zoommenu__type"
        onSubmit={(e) => {
          e.preventDefault();
          const n = parsePercent(text);
          if (n === null) {
            setInvalid(true);
            return;
          }
          zoomToPercent(store, n);
          onClose(true);
        }}
      >
        <div className="fs-zoommenu__field">
          <input
            ref={input}
            aria-label="Zoom, percent"
            className="fs-zoommenu__input"
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={invalid}
            aria-describedby={invalid ? `${id}-err` : undefined}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setInvalid(false);
            }}
          />
          <span className="fs-zoommenu__unit" aria-hidden="true">%</span>
        </div>
        {invalid ? (
          <p id={`${id}-err`} className="fs-zoommenu__error" role="alert">
            A zoom from {MIN_PERCENT}% to {MAX_PERCENT}%
          </p>
        ) : null}
      </form>
      <ul className="fs-zoommenu__list">
        {items.map((item) => (
          <li key={item.label}>
            <button type="button" className="fs-zoommenu__item" disabled={item.disabled} onClick={run(item.run)}>
              <span>{item.label}</span>
              {item.keys !== undefined ? <kbd>{item.keys}</kbd> : null}
            </button>
          </li>
        ))}
      </ul>
      <div className="fs-zoommenu__wheel">
        <p className="fs-zoommenu__label" aria-hidden="true">
          Scroll wheel
        </p>
        <SegmentedControl
          size="sm"
          aria-label="Scroll wheel"
          items={(['zoom', 'pan', 'auto'] as const).map((m) => ({ value: m, label: WHEEL_LABELS[m] }))}
          value={wheel}
          onValueChange={(v) => { navOf(store).setWheel(v as WheelMode); }}
        />
        <p className="fs-zoommenu__help">{WHEEL_HELP[wheel]}</p>
      </div>
    </div>
  );
}

// ─── The saved views and the minimap, stacked in the canvas's corner ────────────────────────

export function NavStack({ store, view }: { store: EditorStore; view: Viewport }) {
  const minimap = useNav(store, (n) => n.minimap);
  const views = useNav(store, (n) => n.views);
  if (!minimap && !views) return null;
  return (
    <div className="fs-navstack">
      {views ? <SavedViews store={store} /> : null}
      {minimap ? <Minimap store={store} view={view} /> : null}
    </div>
  );
}

function viewMeta(store: EditorStore, v: SavedView): string {
  const level = store.get().model?.levels.find((l) => l.id === v.level)?.name ?? 'A level no longer here';
  return [v.mode ?? level, v.fit ? 'fit' : `${String(v.zoom)}%`].join(' · ');
}

function SavedViews({ store }: { store: EditorStore }) {
  const saved = useNav(store, (n) => n.saved);
  const naming = useNav(store, (n) => n.naming);
  // Re-read the levels' names as the model changes.
  useEditor(store, (s) => s.model);
  const nav = navOf(store);
  const [name, setName] = useState('');
  const [current, setCurrent] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const canSave = useEditor(store, (s) => s.view !== null && s.level !== null);

  useEffect(() => {
    if (!naming) return;
    setName(suggestedName(store));
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.select();
    });
  }, [naming, store]);

  return (
    <section className="fs-saved" aria-labelledby={`${id}-title`}>
      <div className="fs-saved__head">
        <Bookmark aria-hidden="true" />
        <h2 className="fs-saved__title" id={`${id}-title`}>
          Saved views
        </h2>
        <span className="fs-spacer" />
        <Tooltip content={tip('Save this view', 'view.saveView')}>
          <IconButton size="sm" label="Save this view" icon={<Plus />} disabled={!canSave} pressed={naming} onClick={() => { nav.setNaming(!naming); }} />
        </Tooltip>
        <IconButton size="sm" label="Hide the saved views" icon={<X />} onClick={() => { nav.setViews(false); }} />
      </div>
      {naming ? (
        <form
          className="fs-saved__name"
          onSubmit={(e) => {
            e.preventDefault();
            const made = saveView(store, name);
            nav.setNaming(false);
            if (made !== null) setCurrent(made.id);
          }}
        >
          <input
            ref={field}
            aria-label="Name this view"
            className="fs-saved__input"
            value={name}
            autoComplete="off"
            onChange={(e) => { setName(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                nav.setNaming(false);
              }
            }}
          />
          <button type="submit" className="fs-saved__save">
            Save
          </button>
        </form>
      ) : null}
      {saved.length === 0 && !naming ? <p className="fs-saved__empty">No saved views yet. Save this view to come back to it.</p> : null}
      {saved.length > 0 ? (
        <ul className="fs-saved__list">
          {saved.map((v) => (
            <li key={v.id} className="fs-saved__row" data-current={current === v.id ? 'on' : undefined}>
              <button
                type="button"
                className="fs-saved__open"
                onClick={() => {
                  if (openView(store, v)) setCurrent(v.id);
                }}
              >
                <span className="fs-saved__name-text">{v.name}</span>
                <span className="fs-saved__meta">{viewMeta(store, v)}</span>
              </button>
              <IconButton
                size="sm"
                className="fs-saved__delete"
                label={`Delete the view ${v.name}`}
                icon={<Trash2 />}
                onClick={() => {
                  removeView(store, v.id);
                  if (current === v.id) setCurrent(null);
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const MINI_W = 188;

function Minimap({ store, view }: { store: EditorStore; view: Viewport }) {
  const level = useEditor(store, (s) => s.model?.levels.find((l) => l.id === s.level));
  const document = useEditor(store, (s) => s.model?.document);
  const layers = useEditor(store, (s) => s.layers);
  const units = useEditor(store, () => store.units);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const nav = navOf(store);

  const bounds = level?.bounds ?? null;
  const height = bounds === null ? 64 : Math.round(Math.min(MINI_W, Math.max(80, (MINI_W * (bounds.maxY - bounds.minY)) / Math.max(1, bounds.maxX - bounds.minX) + 12)));
  const mini = useMemo(() => fit(bounds, MINI_W, height, 6), [bounds, height]);
  // The plan, drawn once per level and model — not on every move of the view.
  const drawn = useMemo(
    () => (level === undefined || document === undefined ? null : <Plan view={mini} level={level} document={document} layers={{ ...layers, dimensions: false }} units={units} labels={false} />),
    [level, document, layers, units, mini],
  );

  // The view's rectangle on the minimap.
  const r = visibleRegion(view);
  const a = toScreen(mini, [r.minX, r.maxY]);
  const b = toScreen(mini, [r.maxX, r.minY]);
  // Kept inside the minimap (by a pixel), so its edge shows even when the view takes in more than the level.
  const x0 = Math.max(1, Math.min(MINI_W - 3, a[0]));
  const y0 = Math.max(1, Math.min(height - 3, a[1]));
  const rect = { x: x0, y: y0, w: Math.max(2, Math.min(MINI_W - 1, b[0]) - x0), h: Math.max(2, Math.min(height - 1, b[1]) - y0) };

  /** Centre the view on a point of the minimap (its own pixels). */
  const centreAt = (x: number, y: number, animate: boolean) => {
    const world = [(x - mini.w / 2) / mini.s + mini.cx, (mini.h / 2 - y) / mini.s + mini.cy] as const;
    const current = store.get().view;
    if (current === null) return;
    const to = { ...current, cx: world[0], cy: world[1] };
    nav.animateTo(to, animate ? {} : { instant: true });
  };
  const local = (e: ReactPointerEvent): [number, number] => {
    const box = svg.current?.getBoundingClientRect();
    return box === undefined ? [0, 0] : [e.clientX - box.left, e.clientY - box.top];
  };

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Not capturable: the drag still follows while over the minimap.
    }
    const [x, y] = local(e);
    const inside = x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
    // A press outside the rectangle brings the view there first; either way, the drag pans.
    if (!inside) centreAt(x, y, false);
    drag.current = { id: e.pointerId, x, y };
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d === null || d.id !== e.pointerId) return;
    const [x, y] = local(e);
    const current = store.get().view;
    if (current === null) return;
    // A minimap pixel is (view.s / mini.s) plan pixels; the plan moves the other way to the rectangle.
    const k = current.s / mini.s;
    nav.stop();
    store.set({ view: panBy(current, -(x - d.x) * k, -(y - d.y) * k) });
    drag.current = { ...d, x, y };
  };
  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const onKey = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    const step = (e.shiftKey ? 0.5 : 0.15) * Math.min(view.w, view.h);
    const by: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const d = by[e.key];
    if (d === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const current = store.get().view;
    if (current !== null) nav.animateTo(panBy(current, d[0], d[1]));
  };

  return (
    <section className="fs-minimap" aria-label="Minimap">
      <div className="fs-minimap__head">
        <span className="fs-minimap__level">{level?.name ?? 'No level'}</span>
        <span className="fs-spacer" />
        <span className="fs-minimap__zoom">{zoomPercent(view)}%</span>
        <IconButton size="sm" label="Hide the minimap" icon={<X />} onClick={() => { nav.setMinimap(false); }} />
      </div>
      {bounds === null ? (
        <p className="fs-minimap__empty">Nothing drawn on this level yet.</p>
      ) : (
        <svg
          ref={svg}
          className="fs-minimap__svg"
          width={MINI_W}
          height={height}
          // Inline: the editor sizes every other svg as an icon.
          style={{ width: MINI_W, height }}
          role="application"
          aria-roledescription="minimap"
          aria-label={`Minimap of ${level?.name ?? 'the level'}: drag the rectangle, or use the arrow keys, to pan`}
          tabIndex={0}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey}
        >
          {drawn}
          <rect className="fs-minimap__view" data-testid="minimap-viewport" x={rect.x} y={rect.y} width={rect.w} height={rect.h} />
        </svg>
      )}
    </section>
  );
}
