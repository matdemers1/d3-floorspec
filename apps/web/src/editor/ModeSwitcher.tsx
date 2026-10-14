import './modes.css';
import { useMemo, useState, type ReactNode } from 'react';
import { Button, IconButton, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Modal, SegmentedControl, Switch, Tooltip } from '@d3cloud/ui';
import {
  Activity,
  AirVent,
  AlarmSmoke,
  ArrowDownToLine,
  Bath,
  CarFront,
  Check,
  ChevronDown,
  CircleDot,
  CookingPot,
  Download,
  Droplets,
  Fan,
  Flame,
  Heater,
  Layers as LayersIcon,
  Lightbulb,
  Network,
  Plug,
  RotateCcw,
  Server,
  Settings2,
  ShowerHead,
  Toilet,
  ToggleRight,
  TrafficCone,
  Trash2,
  Trees,
  Tv,
  Utensils,
  Wind,
  Zap,
} from 'lucide-react';
import { useEditor, type EditorStore, type Viewport } from './store';
import type { ToolController } from './tools';
import type { EditorModel, LevelView } from './model';
import { AirIcon, DropIcon, EyeIcon, PlugIcon, SofaIcon } from './icons';
import { LAYER_LABELS, MODE_IDS, MODES, PLAN_LAYERS, modesOf, useModes, type LayerState, type LayerStates, type ModeId, type PlanLayer } from './modes';
import { TraceLayers } from './underlay/Panel';
import { Plan } from './Canvas';
import { layerOfElement as layerOf } from '@floorspec/render2d';
import { prettyLen, type UnitSystem } from './units';
import { AnnotationSummary } from './annotate/Summary';
import { dist } from './geometry';
import { ExportDialog, type ModeChoice } from '../exports/ExportDialog';
import { keyHint } from './shortcuts';

/**
 * The trade modes in the page (FLR-T-18.3), after the board's "18.3" frames: the switcher in the top
 * bar (icon-only but the active mode; every label in full screen's top drawer) and its menu, each row
 * previewing that mode on this very plan; the Layers drawer's On / Ghost / Off per layer, the mode's
 * preset and Reset; the status bar's and the HUD's mode; the inspector's lead when nothing is
 * selected — what this trade wants to know of the level — with its drawing (an electrical plan).
 * The state and its rules are in modes.ts; the colours, Okabe-Ito based, are in modes.css.
 */

// ─── Icons ───────────────────────────────────────────────────────────────────────────────────

const MODE_ICONS: Readonly<Record<ModeId, (props: { 'aria-hidden'?: boolean }) => ReactNode>> = {
  construction: (p) => <TrafficCone {...p} />,
  decorator: () => <SofaIcon />,
  electrical: () => <PlugIcon />,
  plumbing: () => <DropIcon />,
  mechanical: () => <AirIcon />,
  lowvoltage: (p) => <Activity {...p} />,
  landscape: (p) => <Trees {...p} />,
};

/** A mode's icon in its colour; a person's own mode wears its trade's, or the layers glyph. */
export function ModeIcon({ trade }: { trade: ModeId | null }) {
  return (
    <span className={`fs-mode-icon${trade === null ? '' : ` fs-mode-icon--${trade}`}`} aria-hidden="true">
      {trade === null ? <LayersIcon aria-hidden /> : MODE_ICONS[trade]({ 'aria-hidden': true })}
    </span>
  );
}

/** The device kinds a trade's rail offers, each with its glyph (FLR-T-18.3). */
export const DEVICE_ICONS: Readonly<Record<string, ReactNode>> = {
  receptacle: <Plug />,
  switch: <ToggleRight />,
  light: <Lightbulb />,
  alarm: <AlarmSmoke />,
  panel: <Zap />,
  evCharger: <CarFront />,
  toilet: <Toilet />,
  lavatory: <Droplets />,
  kitchenSink: <Utensils />,
  shower: <ShowerHead />,
  bathtub: <Bath />,
  floorDrain: <CircleDot />,
  waterHeater: <Heater />,
  furnace: <Flame />,
  airHandler: <Fan />,
  supply: <Wind />,
  return: <ArrowDownToLine />,
  exhaustFan: <AirVent />,
  gasRange: <CookingPot />,
  dataOutlet: <Network />,
  coaxOutlet: <Tv />,
  headEnd: <Server />,
};

/** A mode's keys, from the command registry (⌥1–⌥7): written once, in modes.ts's MODE_COMMANDS. */
const keyOf = (id: ModeId): string => keyHint(`mode.${id}`) ?? '';

// ─── The switcher ────────────────────────────────────────────────────────────────────────────

/**
 * The mode switcher: one toggle per trade (⌥1–⌥7), the active one with its name, and the chevron
 * that opens the mode menu. In full screen it is the top drawer's second row, every name showing.
 */
export function ModeSwitcher({ store, tools }: { store: EditorStore; tools: ToolController }) {
  const mode = useModes(store, (s) => s.mode);
  const modes = modesOf(store);
  const trade = modes.tradeOf(mode);
  return (
    <div className="fs-modes" data-mode={trade ?? undefined}>
      <span className="fs-modes__overline fs-overline" aria-hidden="true">Mode</span>
      <div className="fs-modes__group" role="group" aria-label="Mode">
        {MODE_IDS.map((id) => {
          const on = trade === id;
          return (
            <Tooltip key={id} content={`${MODES[id].label}  ${keyOf(id)} — ${MODES[id].summary.toLowerCase()}`}>
              <button
                type="button"
                className="fs-modes__button"
                data-mode={id}
                aria-pressed={on}
                aria-label={`${MODES[id].label} mode`}
                onClick={() => { modes.setMode(id, tools); }}
              >
                <ModeIcon trade={id} />
                <span className="fs-modes__label">{MODES[id].label}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>
      <ModeMenu store={store} tools={tools} />
    </div>
  );
}

/** The chevron's menu: each mode with a preview of this plan in it, a person's own modes, and saving one. */
function ModeMenu({ store, tools }: { store: EditorStore; tools: ToolController }) {
  const [open, setOpen] = useState(false);
  const mode = useModes(store, (s) => s.mode);
  const custom = useModes(store, (s) => s.custom);
  const presets = useModes(store, (s) => s.presets);
  const modes = modesOf(store);
  const changed = useModes(store, () => modes.changed().size > 0);
  const name = modes.nameOf(mode);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger>
        <IconButton size="sm" className="fs-modes__more" label="Modes menu" icon={<ChevronDown />} />
      </MenuTrigger>
      <MenuContent align="start" className="fs-mode-menu">
        <MenuLabel>
          <span className="fs-mode-menu__title">Modes</span>
          <span className="fs-mode-menu__lede">Each mode sets the layers, the dimming, the tools and the inspector in one step.</span>
        </MenuLabel>
        {MODE_IDS.map((id) => (
          <MenuItem key={id} onSelect={() => { modes.setMode(id, tools); }}>
            <ModeRow store={store} open={open} id={id} label={MODES[id].label} summary={presets[id] === undefined ? MODES[id].summary : `${MODES[id].summary} · your preset`} trade={id} current={mode === id} hint={keyOf(id)} />
          </MenuItem>
        ))}
        {custom.length > 0 ? <MenuSeparator /> : null}
        {custom.map((c) => (
          <MenuItem key={c.id} onSelect={() => { modes.setMode(c.id, tools); }}>
            <ModeRow store={store} open={open} id={c.id} label={c.name} summary={c.base === null ? 'Your own mode' : `Your own mode · ${MODES[c.base].label} tools`} trade={c.base} current={mode === c.id} />
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<Settings2 />} onSelect={() => { modes.setSaving(true); }}>
          Save the current layers as a new mode…
        </MenuItem>
        {mode !== null && changed ? (
          <MenuItem icon={<Settings2 />} onSelect={() => { modes.savePreset(); }}>
            Make these layers the {name} preset
          </MenuItem>
        ) : null}
        {mode !== null && mode in presets ? (
          <MenuItem icon={<RotateCcw />} onSelect={() => { modes.restorePreset(mode as ModeId); }}>
            Restore the {name} preset as it ships
          </MenuItem>
        ) : null}
        {mode !== null && mode.startsWith('custom:') ? (
          <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => { modes.deleteCustom(mode); }}>
            Delete the {name} mode
          </MenuItem>
        ) : null}
        {mode !== null ? (
          <MenuItem icon={<LayersIcon />} onSelect={() => { modes.setMode(null, tools); }}>
            Show every layer (no mode)
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

function ModeRow({ store, open, id, label, summary, trade, current, hint }: { store: EditorStore; open: boolean; id: string; label: string; summary: string; trade: ModeId | null; current: boolean; hint?: string }) {
  return (
    <span className="fs-mode-row" data-current={current ? 'true' : undefined}>
      {open ? <ModeThumb store={store} mode={id} /> : <span className="fs-mode-thumb" />}
      <span className="fs-mode-row__text">
        <span className="fs-mode-row__name">
          <ModeIcon trade={trade} />
          {label}
          {current ? <span className="fs-visually-hidden"> (current)</span> : null}
        </span>
        <span className="fs-mode-row__summary">{summary}</span>
      </span>
      {current ? <Check className="fs-mode-row__check" aria-hidden="true" /> : <span className="fs-mode-row__check" />}
      {hint !== undefined ? <kbd className="fs-mode-row__kbd">{hint}</kbd> : null}
    </span>
  );
}

const THUMB = { w: 64, h: 44 };

/** The whole level in a preview: framed 3 px in, at whatever scale that takes (the canvas's zoom limits are not a preview's). */
function thumbView(level: LevelView): Viewport | null {
  const b = level.bounds;
  if (b === null || b.maxX <= b.minX || b.maxY <= b.minY) return null;
  const s = Math.min((THUMB.w - 6) / (b.maxX - b.minX), (THUMB.h - 6) / (b.maxY - b.minY));
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, s, w: THUMB.w, h: THUMB.h };
}

/** A mode previewed on this level: its plan in the mode's layer states, at a glance. */
function ModeThumb({ store, mode }: { store: EditorStore; mode: string }) {
  const model = useEditor(store, (s) => s.model);
  const level = useEditor(store, () => store.levelView);
  const units = useEditor(store, () => store.units);
  const states = modesOf(store).presetOf(mode);
  const view = useMemo(() => (level === undefined ? null : thumbView(level)), [level]);
  if (model === null || level === undefined || view === null) return <span className="fs-mode-thumb" />;
  const layers = { ...store.get().layers, ...Object.fromEntries(PLAN_LAYERS.map((l) => [l, states[l] !== 'off'])) };
  return (
    <svg className="fs-mode-thumb" width={THUMB.w} height={THUMB.h} aria-hidden="true" data-ghost={ghostAttr(states)}>
      <Plan view={view} level={level} document={model.document} layers={layers} units={units} labels={false} />
      <ThumbDevices view={view} level={level} states={states} />
    </svg>
  );
}

/** The extension elements in a preview: each a dot of its trade's colour, a ghost's grey and faint. */
function ThumbDevices({ view, level, states }: { view: Viewport; level: LevelView; states: LayerStates }) {
  const shown = level.devices.flatMap((d) => {
    const layer = layerOf(d.extension, d.collection);
    if (layer === null || states[layer] === 'off') return [];
    return [{ d, layer, ghost: states[layer] === 'ghost' }];
  });
  return (
    <g className="fs-mode-thumb__devices">
      {shown.map(({ d, layer, ghost }) => {
        const x = d.footprint.reduce((s, p) => s + p[0], 0) / d.footprint.length;
        const y = d.footprint.reduce((s, p) => s + p[1], 0) / d.footprint.length;
        const sx = (x - view.cx) * view.s + view.w / 2;
        const sy = view.h / 2 - (y - view.cy) * view.s;
        return <circle key={d.id} className={`fs-mode-thumb__dot fs-mode-thumb__dot--${layer}`} data-ghost={ghost ? 'true' : undefined} cx={sx.toFixed(1)} cy={sy.toFixed(1)} r={1.1} />;
      })}
    </g>
  );
}

/** The layers a canvas draws as ghosts, as its `data-ghost` attribute. */
export function ghostAttr(states: LayerStates): string | undefined {
  const ghosts = PLAN_LAYERS.filter((l) => states[l] === 'ghost');
  return ghosts.length === 0 ? undefined : ghosts.join(' ');
}

// ─── Saving a mode ───────────────────────────────────────────────────────────────────────────

/** "Save the current layers as a new mode": a name — "Kitchen remodel" — and it is the mode now. */
export function SaveModeDialog({ store }: { store: EditorStore }) {
  const saving = useModes(store, (s) => s.saving);
  const [name, setName] = useState('');
  const modes = modesOf(store);
  const close = () => {
    modes.setSaving(false);
    setName('');
  };
  const save = () => {
    if (modes.saveAsMode(name) !== null) setName('');
  };
  if (!saving) return null;
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Save the current layers as a new mode"
      description="A mode of your own for this project: the layers as they are now, and the tools of the mode you are in."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={name.trim() === ''} onClick={save}>Save mode</Button>
        </>
      }
    >
      <label className="fs-mode-save">
        <span>Name</span>
        <Input
          autoFocus
          value={name}
          placeholder="Kitchen remodel"
          maxLength={60}
          onChange={(e) => { setName(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
          }}
        />
      </label>
    </Modal>
  );
}

// ─── The Layers drawer ───────────────────────────────────────────────────────────────────────

const STATE_ITEMS: { value: LayerState; label: string }[] = [
  { value: 'on', label: 'On' },
  { value: 'ghost', label: 'Ghost' },
  { value: 'off', label: 'Off' },
];

/**
 * The Layers tab: the mode's preset with Reset, then each layer On, Ghost or Off — a dot marks one
 * set otherwise than the preset — then clearances and the core-only view.
 */
export function ModeLayers({ store }: { store: EditorStore }) {
  const mode = useModes(store, (s) => s.mode);
  const modes = modesOf(store);
  const layers = useEditor(store, (s) => s.layers);
  // The states read from the editor's layers and this store's ghosts: re-read when either moves.
  useModes(store, (s) => s.ghost);
  const states = modes.states();
  const changed = modes.changed();
  const trade = modes.tradeOf(mode);
  return (
    <div className="fs-layers" data-mode={trade ?? undefined}>
      <div className="fs-layers__preset">
        <ModeIcon trade={trade} />
        <span className="fs-layers__preset-name">{mode === null ? 'Every layer' : `${modes.nameOf(mode)} preset`}</span>
        <Button size="sm" variant="ghost" disabled={changed.size === 0} onClick={() => { modes.reset(); }}>
          Reset
        </Button>
      </div>
      <ul className="fs-layers__rows" aria-label="Layers">
        {PLAN_LAYERS.map((l) => (
          <li key={l} className="fs-layers__row" data-state={states[l]}>
            <span className="fs-layers__name">
              {LAYER_LABELS[l]}
              {changed.has(l) ? (
                <span className="fs-layers__dot" title="Set otherwise than the preset">
                  <span className="fs-visually-hidden"> (changed)</span>
                </span>
              ) : null}
            </span>
            <SegmentedControl aria-label={`${LAYER_LABELS[l]} layer`} size="sm" value={states[l]} items={STATE_ITEMS} onValueChange={(v) => { modes.setLayer(l, v as LayerState); }} />
          </li>
        ))}
      </ul>
      {/* FLR-T-18.12: the level's underlay and the reference level, in the same drawer. */}
      <TraceLayers store={store} />
      <div className="fs-layers__chips">
        <button
          type="button"
          className={layers.clearances ? 'fs-chip is-on' : 'fs-chip'}
          aria-pressed={layers.clearances}
          onClick={() => { store.set({ layers: { ...layers, clearances: !layers.clearances } }); }}
        >
          <EyeIcon />
          Clearances
        </button>
      </div>
      <div className="fs-layers__core">
        <Switch checked={layers.coreOnly} onCheckedChange={(on) => { store.set({ layers: { ...layers, coreOnly: on } }); }}>
          Show as core-only
        </Switch>
        <p className="fs-note">What a reader without the building-system extensions draws: each element’s fallback box.</p>
      </div>
    </div>
  );
}

// ─── The status bar and the HUD ──────────────────────────────────────────────────────────────

/** The mode in the status bar: "Electrical mode". */
export function ModeStatus({ store }: { store: EditorStore }) {
  const mode = useModes(store, (s) => s.mode);
  if (mode === null) return null;
  const modes = modesOf(store);
  return (
    <span className="fs-statusbar__item fs-mode-status" data-mode={modes.tradeOf(mode) ?? undefined}>
      <ModeIcon trade={modes.tradeOf(mode)} />
      {modes.nameOf(mode)} mode
    </span>
  );
}

/** The mode in full screen's quiet HUD. */
export function HudMode({ store }: { store: EditorStore }) {
  const mode = useModes(store, (s) => s.mode);
  if (mode === null) return null;
  const modes = modesOf(store);
  return (
    <>
      <span className="fs-hud__mode">
        <ModeIcon trade={modes.tradeOf(mode)} />
        {modes.nameOf(mode)}
      </span>
      <span className="fs-hud__rule" />
    </>
  );
}

// ─── Exports ─────────────────────────────────────────────────────────────────────────────────

/** The drawings the Export dialog offers: every layer, each trade's plan, and the plan as shown now. */
export function useModeChoices(store: EditorStore): readonly ModeChoice[] {
  const mode = useModes(store, (s) => s.mode);
  const custom = useModes(store, (s) => s.custom);
  const ghost = useModes(store, (s) => s.ghost);
  const layers = useEditor(store, (s) => s.layers);
  return useMemo(() => {
    const modes = modesOf(store);
    const states = modes.states();
    const changed = modes.changed().size > 0;
    const choices: ModeChoice[] = [{ value: 'none', label: 'Every layer', request: {} }];
    for (const id of MODE_IDS) {
      const own = mode === id;
      choices.push({ value: id, label: `${MODES[id].plan}${own && changed ? ' (as shown)' : ''}`, request: own && changed ? { mode: id, layers: states } : modes.get().presets[id] === undefined ? { mode: id } : { mode: id, layers: modes.presetOf(id) }, current: mode === id });
    }
    for (const c of custom) choices.push({ value: c.id, label: `${c.name} plan`, request: { ...(c.base === null ? {} : { mode: c.base }), layers: mode === c.id ? states : c.layers }, current: mode === c.id });
    return choices;
  }, [store, mode, custom, ghost, layers]);
}

/** "Export the electrical plan (PDF)": the Export dialog, opened on this mode's drawing. */
function ExportPlan({ store, label }: { store: EditorStore; label: string }) {
  const [open, setOpen] = useState(false);
  const project = useEditor(store, (s) => s.project);
  const model = useEditor(store, (s) => s.model);
  const seq = useEditor(store, (s) => s.history.seq);
  const choices = useModeChoices(store);
  if (project === null || model === null) return null;
  const levels = model.levels.map((l) => ({ id: l.id, name: l.name }));
  return (
    <>
      <Button size="sm" variant="secondary" icon={<Download />} onClick={() => { setOpen(true); }}>
        Export the {label.toLowerCase()} (PDF)
      </Button>
      <ExportDialog open={open} onOpenChange={setOpen} projectId={project.id} projectName={model.document.project.name} versionLabel={seq === null ? null : `v${String(seq)}`} levels={levels} optionSets={model.optionSets} modes={choices} />
    </>
  );
}

// ─── The inspector's lead ────────────────────────────────────────────────────────────────────

/** Counts by name, most first. */
function tally(names: readonly string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const raw of names) {
    // A kind the catalogue does not name is its collection's: "plants" reads "Plants".
    const n = raw.charAt(0).toUpperCase() + raw.slice(1);
    m.set(n, (m.get(n) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * With nothing selected, the inspector leads with what the mode's trade wants to know of the level —
 * walls by type and their runs, openings and area in Construction; devices by kind in a building
 * system; the rooms and their furniture in Decorator; the garden in Landscape — and its drawing.
 */
export function ModeSummary({ store, model, units }: { store: EditorStore; model: EditorModel; units: UnitSystem }) {
  const mode = useModes(store, (s) => s.mode);
  const level = useEditor(store, () => store.levelView);
  if (mode === null || level === undefined) return null;
  const modes = modesOf(store);
  const trade = modes.tradeOf(mode);
  const plan = trade === null ? `${modes.nameOf(mode)} plan` : MODES[trade].plan;
  const rows = trade === null ? [] : summaryRows(trade, model, level, units);
  return (
    <section className="fs-section fs-mode-summary" aria-label={`${modes.nameOf(mode)} summary`} data-mode={trade ?? undefined}>
      <div className="fs-section__head">
        <h3 className="fs-overline">
          {modes.nameOf(mode)} · {level.name}
        </h3>
      </div>
      {rows.map((group) => (
        <div key={group.title} className="fs-mode-summary__group">
          <h4 className="fs-mode-summary__title">{group.title}</h4>
          {group.rows.length === 0 ? (
            <p className="fs-note">{group.empty}</p>
          ) : (
            <dl className="fs-mode-summary__rows">
              {group.rows.map(([name, value]) => (
                <div key={name} className="fs-mode-summary__row">
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
      {trade === 'construction' ? <AnnotationSummary store={store} model={model} level={level} units={units} /> : null}
      <ExportPlan store={store} label={plan} />
    </section>
  );
}

interface SummaryGroup {
  title: string;
  rows: [string, string][];
  empty: string;
}

const SYSTEM_EXT: Partial<Record<ModeId, readonly string[]>> = {
  electrical: ['FS_electrical', 'FS_lighting'],
  plumbing: ['FS_plumbing'],
  mechanical: ['FS_mechanical'],
  lowvoltage: ['FS_lowvoltage'],
  landscape: ['FS_landscape'],
};

function summaryRows(trade: ModeId, model: EditorModel, level: LevelView, units: UnitSystem): SummaryGroup[] {
  const count = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;
  if (trade === 'construction') {
    const byType = new Map<string, { n: number; length: number }>();
    for (const w of level.walls) {
      const typeId = model.document.walls?.[w.id]?.type;
      const name = typeId === undefined ? 'Own layers' : (model.document.types?.[typeId]?.name ?? typeId);
      const run = w.arc?.length ?? dist(w.a, w.b);
      const t = byType.get(name) ?? { n: 0, length: 0 };
      byType.set(name, { n: t.n + 1, length: t.length + run });
    }
    const doors = level.openings.filter((o) => o.kind === 'door').length;
    const windows = level.openings.filter((o) => o.kind === 'window').length;
    return [
      { title: 'Walls', empty: 'No walls on this level.', rows: [...byType].sort((a, b) => b[1].n - a[1].n).map(([name, t]) => [name, `${String(t.n)} · ${prettyLen(Math.round(t.length), units)}`]) },
      { title: 'Openings', empty: 'No openings.', rows: doors + windows === 0 ? [] : [['Doors', String(doors)], ['Windows', String(windows)], ['Other openings', String(level.openings.length - doors - windows)]] },
      // The area — gross, net, finished — the show toggles and the schedule follow (FLR-T-18.11, AnnotationSummary).
    ];
  }
  if (trade === 'decorator') {
    const pieces = level.devices.filter((d) => d.extension === 'FS_furniture');
    return [
      { title: 'Furniture and casework', empty: 'Nothing placed yet — the library is on the rail (I).', rows: tally(pieces.map((d) => d.kindLabel)).slice(0, 8).map(([n, c]) => [n, String(c)]) },
      { title: 'Rooms', empty: 'No rooms yet.', rows: level.rooms.length === 0 ? [] : [['Rooms', String(level.rooms.length)], ['Furnished', count(new Set(pieces.map((d) => roomAt(level, d))).size, 'room', 'rooms')]] },
    ];
  }
  const exts = SYSTEM_EXT[trade] ?? [];
  const devices = level.devices.filter((d) => exts.includes(d.extension));
  return [{ title: trade === 'landscape' ? 'The garden' : 'Devices', empty: 'Nothing of this trade on this level yet.', rows: tally(devices.map((d) => d.kindLabel)).map(([n, c]) => [n, String(c)]) }];
}

/** The room an element stands in, by the centre of its footprint (its first face holding it). */
function roomAt(level: LevelView, d: LevelView['devices'][number]): string | null {
  const x = d.footprint.reduce((s, p) => s + p[0], 0) / d.footprint.length;
  const y = d.footprint.reduce((s, p) => s + p[1], 0) / d.footprint.length;
  for (const f of level.faces) {
    if (f.room === null) continue;
    let inside = false;
    const ring = f.outer;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a === undefined || b === undefined) continue;
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    if (inside) return f.room;
  }
  return null;
}

export type { PlanLayer };
