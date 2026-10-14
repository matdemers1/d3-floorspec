import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Checkbox, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, SegmentedControl, Tooltip } from '@d3cloud/ui';
import {
  AlignCenterVertical,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ChevronDown,
  CopyPlus,
  FlipHorizontal2,
  Focus,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { useEditor, type EditorStore, type Viewport } from '../store';
import type { EditorModel, LevelView, Point } from '../model';
import { toScreen } from '../viewport';
import { formatLen, parseLen, type UnitSystem } from '../units';
import { circuitsOf } from '../systems/view';
import { asGlyph, glyphCentre, GLYPH_R } from '../systems/hit';
import { boundsOfIds, rectOf, shapeOf } from './shapes';
import { arrangeOf, useArrange } from './state';
import { arrayBatch, defaultSpec, planArray, type ArrayMode, type ArraySpec } from './array';
import {
  alignSelection,
  deleteSelection,
  describeMany,
  distributeSelection,
  duplicateSelection,
  editable,
  mirrorSelection,
  selectSimilar,
  shortCount,
  turnSelection,
  zoomToSelection,
} from './actions';
import './arrange.css';

/**
 * What the multi-selection draws on the plan (FLR-T-18.8, the board's "Crossing marquee + selection
 * toolbar" and "Array along a wall"): the selection's one bounds box, the marquee — solid for a
 * window, dashed green for a crossing — the group as a ghost while it is dragged, the array's copies
 * as ghosts before anything is written, and over the canvas the contextual toolbar beside the
 * selection and the array popover.
 */

const S = (v: Viewport, p: Point) => toScreen(v, p);
const pts = (v: Viewport, ring: readonly Point[], d: Point = [0, 0]) => ring.map((p) => S(v, [p[0] + d[0], p[1] + d[1]]).map((n) => n.toFixed(1)).join(',')).join(' ');

/** The SVG layer: bounds, marquee, drag ghost, array ghosts. */
export function ArrangeLayer({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const selected = useEditor(store, (s) => s.selected);
  const tool = useEditor(store, (s) => s.tool);
  const marquee = useArrange(store, (a) => a.marquee);
  const dragging = useArrange(store, (a) => a.dragging);
  const array = useArrange(store, (a) => a.array);
  const ids = useMemo(() => selected.filter((id) => shapeOf(level, id) !== undefined), [selected, level]);
  const bounds = ids.length > 1 ? boundsOfIds(level, ids) : null;
  const plan = useMemo(() => (array === null ? null : planArray(level, ids, array)), [array, level, ids]);
  const out: ReactNode[] = [];
  if (bounds !== null && tool === 'select' && dragging === null) {
    const a = S(view, [bounds.minX, bounds.maxY]);
    const b = S(view, [bounds.maxX, bounds.minY]);
    const pad = 6;
    const x = a[0] - pad, y = a[1] - pad, w = b[0] - a[0] + 2 * pad, h = b[1] - a[1] + 2 * pad;
    out.push(<rect key="bounds" className="fs-arrange__bounds" x={x} y={y} width={w} height={h} />);
    for (const [cx, cy] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as const) out.push(<rect key={`c${String(cx)},${String(cy)}`} className="fs-handle" x={cx - 4} y={cy - 4} width={8} height={8} />);
  }
  if (dragging !== null) {
    for (const id of ids) {
      const s = shapeOf(level, id);
      if (s === undefined) continue;
      out.push(s.closed ? <polygon key={`g${id}`} className="fs-arrange__ghost" points={pts(view, s.points, dragging)} /> : <polyline key={`g${id}`} className="fs-arrange__ghost" points={pts(view, s.points, dragging)} fill="none" />);
    }
  }
  if (plan !== null) {
    const shapes = ids.map((id) => shapeOf(level, id)).filter((s) => s !== undefined);
    // A device drawn as a glyph (a light, an outlet) is ghosted as its glyph, so a copy reads at any zoom.
    const ghost = (key: string, id: string, points: readonly Point[], d: Point, testid?: string) => {
      const device = level.devices.find((x) => x.id === id);
      if (device !== undefined && asGlyph(device, view.s)) {
        const c = S(view, [glyphCentre(device, view.s)[0] + d[0], glyphCentre(device, view.s)[1] + d[1]]);
        return <circle key={key} className="fs-arrange__copy" data-testid={testid} cx={c[0]} cy={c[1]} r={GLYPH_R + 2} />;
      }
      return <polygon key={key} className="fs-arrange__copy" data-testid={testid} points={pts(view, points, d)} />;
    };
    plan.offsets.forEach((d, i) => {
      for (const s of shapes) out.push(ghost(`a${String(i)}${s.id}`, s.id, s.points, d, 'array-ghost'));
    });
    if (plan.move[0] !== 0 || plan.move[1] !== 0) for (const s of shapes) out.push(ghost(`m${s.id}`, s.id, s.points, plan.move));
    if (plan.wall !== null) {
      const w = plan.wall.wall;
      const a = S(view, w.a);
      const b = S(view, w.b);
      out.push(<line key="wall" className="fs-arrange__wall" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />);
    }
  }
  if (marquee !== null) {
    const r = rectOf(marquee.from, marquee.to);
    const a = S(view, [r.minX, r.maxY]);
    const b = S(view, [r.maxX, r.minY]);
    out.push(<rect key="marquee" className={marquee.crossing ? 'fs-marquee fs-marquee--crossing' : 'fs-marquee'} data-testid="marquee" x={a[0]} y={a[1]} width={b[0] - a[0]} height={b[1] - a[1]} />);
  }
  return out.length === 0 ? null : <g className="fs-arrange" aria-hidden="true">{out}</g>;
}

/** The HTML over the canvas: the selection toolbar, the array popover, the marquee's legend, the array's measures. */
export function ArrangeHtml({ store, view, level, model, units }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; units: UnitSystem }) {
  const marquee = useArrange(store, (a) => a.marquee);
  const array = useArrange(store, (a) => a.array);
  return (
    <>
      <SelectionToolbar store={store} view={view} level={level} model={model} />
      {array !== null ? <ArrayPopover store={store} level={level} model={model} units={units} spec={array} view={view} /> : null}
      {marquee !== null ? (
        <div className="fs-marquee-legend" role="status">
          <span className="fs-overline">Marquee</span>
          <span className={marquee.crossing ? undefined : 'fs-marquee-legend__on'}>
            <i className="fs-marquee-legend__swatch" aria-hidden="true" /> Drag right → window: only what is fully inside
          </span>
          <span className={marquee.crossing ? 'fs-marquee-legend__on' : undefined}>
            <i className="fs-marquee-legend__swatch fs-marquee-legend__swatch--crossing" aria-hidden="true" /> Drag left → crossing: anything it touches
          </span>
          <span className="fs-marquee-legend__keys">⇧ adds · ⌘ toggles</span>
        </div>
      ) : null}
    </>
  );
}

/** Whether the toolbar shows: two or more selected, or one item (furniture, a device) — what arranging is for. */
function wantsToolbar(level: LevelView, ids: readonly string[]): boolean {
  return ids.length > 1 || (ids.length === 1 && level.devices.some((d) => d.id === ids[0]));
}

function SelectionToolbar({ store, view, level, model }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel }) {
  const bar = useRef<HTMLDivElement>(null);
  // Its width as laid out, so it is kept on the canvas however wide its count's label is.
  const [width, setWidth] = useState(520);
  useLayoutEffect(() => {
    const w = bar.current?.offsetWidth;
    if (w !== undefined && w > 0 && Math.abs(w - width) > 1) setWidth(w);
  });
  const selected = useEditor(store, (s) => s.selected);
  const tool = useEditor(store, (s) => s.tool);
  const busy = useEditor(store, (s) => s.draft?.tool === 'select' && s.draft.drag !== null);
  const canEdit = useEditor(store, (s) => editable(s));
  const comparing = useEditor(store, (s) => s.compare !== null);
  const marquee = useArrange(store, (a) => a.marquee !== null);
  const dragging = useArrange(store, (a) => a.dragging !== null);
  const array = useArrange(store, (a) => a.array !== null);
  const ids = selected.filter((id) => shapeOf(level, id) !== undefined);
  const b = boundsOfIds(level, ids);
  // The array popover stands in for it while it is open.
  if (tool !== 'select' || comparing || busy || marquee || dragging || array || b === null || !wantsToolbar(level, ids)) return null;
  const top = S(view, [b.minX, b.maxY])[1];
  const bottom = S(view, [b.minX, b.minY])[1];
  const mid = S(view, [(b.minX + b.maxX) / 2, b.maxY])[0];
  const left = Math.max(8, Math.min(view.w - width - 8, mid - width / 2));
  const above = top - 56;
  const y = above >= 8 ? above : Math.min(view.h - 52, bottom + 16);
  const n = ids.length;
  const off = !canEdit;
  const tip = (content: string, child: ReactNode) => <Tooltip content={content}>{child}</Tooltip>;
  return (
    <div ref={bar} className="fs-seltool" role="toolbar" aria-label={`Arrange ${describeMany(model, ids)}`} style={{ left, top: y }} data-testid="selection-toolbar" onPointerDown={(e) => { e.stopPropagation(); }}>
      <Menu>
        <MenuTrigger>
          <Button variant="ghost" size="sm" className="fs-seltool__count" aria-label={`${shortCount(model, ids)} selected: select more like them`}>
            {shortCount(model, ids)}
            <ChevronDown aria-hidden="true" />
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem onSelect={() => { selectSimilar(store, 'item'); }}>Select similar — the same item (⇧⌘A)</MenuItem>
          <MenuItem onSelect={() => { selectSimilar(store, 'kind'); }}>Select every one of this kind on the level</MenuItem>
          <MenuItem onSelect={() => { selectSimilar(store, 'level'); }}>Select everything on the level (⌘A)</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => { store.select(null); }}>Clear the selection (Esc)</MenuItem>
        </MenuContent>
      </Menu>
      <span className="fs-seltool__sep" aria-hidden="true" />
      {tip('Align left', <IconButton size="sm" label="Align left" icon={<AlignStartVertical />} disabled={off || n < 2} onClick={() => { alignSelection(store, 'left'); }} />)}
      {tip('Align centres', <IconButton size="sm" label="Align centres" icon={<AlignCenterVertical />} disabled={off || n < 2} onClick={() => { alignSelection(store, 'centre'); }} />)}
      {tip('Align right', <IconButton size="sm" label="Align right" icon={<AlignEndVertical />} disabled={off || n < 2} onClick={() => { alignSelection(store, 'right'); }} />)}
      {tip('Align top', <IconButton size="sm" label="Align top" icon={<AlignStartHorizontal />} disabled={off || n < 2} onClick={() => { alignSelection(store, 'top'); }} />)}
      {tip('Distribute vertically  ⌥⇧V', <IconButton size="sm" label="Distribute vertically" icon={<AlignVerticalDistributeCenter />} disabled={off || n < 3} onClick={() => { distributeSelection(store, 'y'); }} />)}
      {tip('Distribute horizontally  ⌥⇧H', <IconButton size="sm" label="Distribute horizontally" icon={<AlignHorizontalDistributeCenter />} disabled={off || n < 3} onClick={() => { distributeSelection(store, 'x'); }} />)}
      <span className="fs-seltool__sep" aria-hidden="true" />
      {tip('Duplicate  ⌘D', <IconButton size="sm" label="Duplicate" icon={<CopyPlus />} disabled={off} onClick={() => { duplicateSelection(store); }} />)}
      {tip('Array…  ⌥A', <IconButton size="sm" label="Array" icon={<ArrayIcon />} disabled={off} pressed={array} onClick={() => { toggleArray(store); }} />)}
      <Menu>
        <MenuTrigger>
          <IconButton size="sm" label="Mirror" icon={<FlipHorizontal2 />} disabled={off} />
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem onSelect={() => { mirrorSelection(store, 'h'); }}>Mirror left ↔ right (⇧H)</MenuItem>
          <MenuItem onSelect={() => { mirrorSelection(store, 'v'); }}>Mirror top ↔ bottom (⇧V)</MenuItem>
        </MenuContent>
      </Menu>
      {tip('Rotate 90° right  ]', <IconButton size="sm" label="Rotate 90° right" icon={<RotateCw />} disabled={off} onClick={() => { turnSelection(store, -1); }} />)}
      {tip('Zoom to selection  ⇧2', <IconButton size="sm" label="Zoom to selection" icon={<Focus />} onClick={() => { zoomToSelection(store); }} />)}
      <span className="fs-seltool__sep" aria-hidden="true" />
      <Button variant="danger-ghost" size="sm" icon={<Trash2 />} disabled={off} onClick={() => { deleteSelection(store); }}>
        Delete
      </Button>
    </div>
  );
}

/** The array's icon (the board's Icon/fs/array): three in a row. */
export function ArrayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="1.5" y="5.5" width="3.5" height="5" rx="0.5" />
      <rect x="6.25" y="5.5" width="3.5" height="5" rx="0.5" />
      <rect x="11" y="5.5" width="3.5" height="5" rx="0.5" />
    </svg>
  );
}

/** Open the array popover on the selection (⌥A), or close it. */
export function toggleArray(store: EditorStore): void {
  const a = arrangeOf(store);
  if (a.get().array !== null) {
    a.set({ array: null });
    return;
  }
  const level = store.levelView;
  const ids = store.get().selected;
  if (level === undefined || ids.length === 0 || !editable(store.get())) return;
  a.set({ array: defaultSpec(level, ids, store.units === 'metric') });
}

const MODES: { value: ArrayMode; label: string }[] = [
  { value: 'line', label: 'Line' },
  { value: 'wall', label: 'Along wall' },
  { value: 'grid', label: 'Grid' },
];

function ArrayPopover({ store, level, model, units, spec, view }: { store: EditorStore; level: LevelView; model: EditorModel; units: UnitSystem; spec: ArraySpec; view: Viewport }) {
  const selected = useEditor(store, (s) => s.selected);
  const pending = useEditor(store, (s) => s.pending !== null);
  const set = (patch: Partial<ArraySpec>) => { arrangeOf(store).set({ array: { ...spec, ...patch } }); };
  const plan = planArray(level, selected, spec);
  const circuits = [...new Set(selected.flatMap((id) => circuitsOf(model.document, id)))];
  const noun = shortCount(model, selected.length === 1 ? [selected[0] as string, selected[0] as string] : selected).replace(/^\d+ /, '');
  const adds = plan === null ? 0 : plan.offsets.length * selected.length;
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); first.current?.select(); }, []);
  const apply = () => {
    if (adds === 0) return;
    const ids = [...selected];
    let named: string[] = [];
    void store
      .apply(`Array ${describeMany(model, ids)}: ${String(adds)} more`, (attempt) => {
        const m = store.get().model;
        const lv = store.levelView;
        if (m === null || lv === undefined) return [];
        const out = arrayBatch(m, lv, ids, spec, { attempt, project: store.projectId });
        named = out.ids;
        return out.batch;
      }, { selectMany: () => [...ids, ...named] })
      .then((ok) => {
        if (ok && named.length < adds) store.set({ notice: { tone: 'info', text: `${String(adds - named.length)} of the copies fell outside a room or off the wall and were left out.` } });
      });
    arrangeOf(store).set({ array: null });
  };
  const wallFace = selected.some((id) => level.devices.find((d) => d.id === id)?.host?.['mode'] === 'wallFace');
  const tag = plan !== null && plan.offsets[0] !== undefined ? plan.offsets[0] : null;
  const bounds = boundsOfIds(level, selected);
  const tagAt = tag === null || plan === null || bounds === null ? null : S(view, [(bounds.minX + bounds.maxX) / 2 + (tag[0] + plan.move[0]) / 2, (bounds.minY + bounds.maxY) / 2 + (tag[1] + plan.move[1]) / 2]);
  return (
    <>
      {tagAt !== null && plan !== null ? (
        <div className="fs-arrange__tag" style={{ left: tagAt[0], top: tagAt[1] - 28 }} aria-hidden="true">{formatLen(plan.spacing, units)}</div>
      ) : null}
      <form
        className="fs-arraypop"
        aria-label="Array"
        data-testid="array-popover"
        onSubmit={(e) => { e.preventDefault(); apply(); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            arrangeOf(store).set({ array: null });
          }
          e.stopPropagation();
        }}
      >
        <div className="fs-arraypop__head">
          <ArrayIcon />
          <h2 className="fs-arraypop__title">Array</h2>
          <kbd className="fs-kbd">⌥A</kbd>
        </div>
        <SegmentedControl size="sm" aria-label="Array along" items={MODES} value={spec.mode} onValueChange={(v) => { set({ mode: v as ArrayMode }); }} />
        <NumberRow label={spec.mode === 'grid' ? 'Columns' : 'Count'} value={spec.count} min={1} max={100} inputRef={first} onChange={(count) => { set({ count }); }} />
        {spec.mode === 'grid' ? <NumberRow label="Rows" value={spec.rows} min={1} max={100} onChange={(rows) => { set({ rows }); }} /> : null}
        <LengthRow label="Spacing" value={spec.fit && spec.mode === 'wall' && plan !== null ? plan.spacing : spec.spacing} units={units} disabled={spec.fit && spec.mode === 'wall'} onChange={(spacing) => { set({ spacing }); }} />
        {spec.mode === 'line' ? (
          <SegmentedControl
            size="sm"
            aria-label="Direction"
            items={[{ value: '0', label: 'East' }, { value: '90', label: 'North' }, { value: '180', label: 'West' }, { value: '270', label: 'South' }]}
            value={String(spec.direction)}
            onValueChange={(v) => { set({ direction: Number(v) as ArraySpec['direction'] }); }}
          />
        ) : null}
        {spec.mode === 'wall' && !wallFace && plan?.wall?.off !== null ? (
          <LengthRow label="Offset from wall" value={spec.offset ?? plan?.wall?.off ?? 0} units={units} onChange={(offset) => { set({ offset }); }} />
        ) : null}
        {spec.mode === 'wall' ? (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => { set({ sense: spec.sense === 1 ? -1 : 1 }); }}>
              Run the other way along {plan?.wall === null || plan === null ? 'the wall' : plan.wall.wall.id}
            </Button>
            <Checkbox label="Fit between the room’s ends" checked={spec.fit} onCheckedChange={(v) => { set({ fit: v === true }); }} />
          </>
        ) : null}
        {circuits.length > 0 ? <Checkbox label={`Keep on circuit ${circuits.join(', ')}`} checked={spec.keepCircuit} onCheckedChange={(v) => { set({ keepCircuit: v === true }); }} /> : null}
        <div className="fs-arraypop__actions">
          <Button type="submit" variant="primary" size="sm" disabled={adds === 0 || pending}>
            Add {String(adds)} {adds === 1 ? noun.replace(/s$/, '') : noun}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => { arrangeOf(store).set({ array: null }); }}>
            Cancel
          </Button>
        </div>
      </form>
    </>
  );
}

function NumberRow({ label, value, min, max, onChange, inputRef }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; inputRef?: React.Ref<HTMLInputElement> }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const id = `fs-array-${label.toLowerCase()}`;
  return (
    <div className="fs-arraypop__row">
      <label htmlFor={id}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        className="fs-arraypop__input"
        inputMode="numeric"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= min && n <= max) onChange(n);
        }}
      />
    </div>
  );
}

function LengthRow({ label, value, units, onChange, disabled = false }: { label: string; value: number; units: UnitSystem; onChange: (v: number) => void; disabled?: boolean }) {
  const shown = formatLen(value, units);
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(shown); setBad(false); }, [shown]);
  const id = `fs-array-${label.toLowerCase().replace(/\s+/g, '-')}`;
  const commit = () => {
    const r = parseLen(text, units);
    if (r.ok && r.value >= 0) onChange(r.value);
    else setBad(true);
  };
  return (
    <div className="fs-arraypop__row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="fs-arraypop__input"
        value={text}
        disabled={disabled}
        aria-invalid={bad}
        onChange={(e) => { setText(e.target.value); setBad(false); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // Enter commits the length; the plan redraws, and Enter again (or the button) adds.
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}
