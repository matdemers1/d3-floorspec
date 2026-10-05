import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { IconButton, Switch } from '@d3cloud/ui';
import { ChevronDown, ChevronRight, House, Layers as LayersIcon, Palette, Plus } from 'lucide-react';
import { useEditor, type EditorStore, type Layers } from './store';
import { elementOf, labelOf, sortedLevels, type EditorModel } from './model';
import { setOrUnset } from './ops';
import { formatArea, formatLen } from './units';
import { DoorIcon, EyeIcon, JunctionIcon, RoofIcon, RoomIcon, SeparatorIcon, WallIcon, WindowIcon, SlabIcon, StairIcon } from './icons';
import { newLevel } from './actions';
import { SYSTEMS } from './systems/catalog';
import { SystemIcon } from './systems/Panels';

/**
 * The project tree (FLR-T-3.3): buildings › levels › rooms, with each level's walls, openings and
 * separators in groups under it, and the project's types and materials. Selecting a row selects the
 * element on the canvas, and the canvas's selection is the row highlighted here.
 */

type Json = Record<string, unknown>;

interface TreeRow {
  key: string;
  depth: number;
  icon: ReactNode;
  label: string;
  meta?: string;
  id?: string;
  group?: boolean;
  strong?: boolean;
  parent: string | null;
}

/**
 * The tree is a WAI-ARIA tree with a roving tab stop (FLR-T-3.7): ↑/↓ move, → opens a group or
 * steps into it, ← closes it or steps out to its parent, Home/End jump, Enter or Space selects the
 * element (or opens the group), and F2 — or Enter on the row already selected — renames it in
 * place. Esc leaves the tree for the plan with the selection kept, where the arrows nudge it.
 */
export function ProjectTree({ store }: { store: EditorStore }) {
  const model = useEditor(store, (s) => s.model);
  const selection = useEditor(store, (s) => s.selection);
  const levelId = useEditor(store, (s) => s.level);
  const layers = useEditor(store, (s) => s.layers);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const renaming = useEditor(store, (s) => s.renaming);
  const units = useEditor(store, () => store.units);
  // Projects, buildings and levels start open; element groups, types and materials start closed.
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const wantFocus = useRef<string | null>(null);
  useEffect(() => {
    const key = wantFocus.current;
    if (key === null) return;
    wantFocus.current = null;
    refs.current.get(key)?.focus();
  });
  // The selection's row is always shown: its group opens when it is chosen on the canvas.
  useEffect(() => {
    if (model === null || selection === null) return;
    const level = model.levels.find((l) => [...l.walls, ...l.openings, ...l.separators, ...l.junctions, ...l.devices].some((x) => x.id === selection));
    if (level === undefined) return;
    const device = level.devices.find((d) => d.id === selection);
    const group = device !== undefined ? (device.system ?? 'junctions') : level.walls.some((w) => w.id === selection) ? 'walls' : level.openings.some((o) => o.id === selection) ? 'openings' : level.separators.some((x) => x.id === selection) ? 'separators' : 'junctions';
    const key = `${level.id}:${group}`;
    // Groups start closed, so "open" is "flipped".
    setFlipped((s) => (s.has(key) ? s : new Set([...s, key])));
  }, [model, selection]);
  if (model === null) return null;
  const startsOpen = (key: string) => key === 'project' || key.startsWith('b:') || key.startsWith('l:');
  const setOpen = (key: string, open: boolean) => { setFlipped((s) => {
    const next = new Set(s);
    if (open === startsOpen(key)) next.delete(key);
    else next.add(key);
    return next;
  }); };
  const open = (key: string) => startsOpen(key) !== flipped.has(key);
  const toggle = (key: string) => { setOpen(key, !open(key)); };
  const name = model.document.project.name;
  const buildings = Object.entries((model.document.buildings ?? {}) as Record<string, Json | undefined>).filter((e): e is [string, Json] => e[1] !== undefined);
  const levels = sortedLevels(model.document);

  const rows: TreeRow[] = [];
  rows.push({ key: 'project', depth: 0, icon: <House />, label: name, strong: true, group: true, parent: null });
  if (open('project')) {
    for (const [bid] of buildings) {
      const bLevels = levels.filter((l) => l.level['building'] === bid);
      rows.push({ key: `b:${bid}`, depth: 1, icon: <RoofIcon />, label: labelOf(model, bid), meta: `${String(bLevels.length)} ${bLevels.length === 1 ? 'level' : 'levels'}`, id: bid, group: true, parent: 'project' });
      if (!open(`b:${bid}`)) continue;
      for (const { id: lid } of bLevels) {
        const view = model.levels.find((l) => l.id === lid);
        const level = model.document.levels?.[lid];
        rows.push({ key: `l:${lid}`, depth: 2, icon: <LayersIcon />, label: labelOf(model, lid), meta: formatLen(level?.elevation ?? 0, units), id: lid, group: true, strong: lid === levelId, parent: `b:${bid}` });
        if (!open(`l:${lid}`) || view === undefined) continue;
        for (const room of view.rooms) rows.push({ key: room.id, depth: 3, icon: <RoomIcon />, label: room.name, meta: formatArea(room.area2, units), id: room.id, parent: `l:${lid}` });
        const groups: [string, string, ReactNode, { id: string }[]][] = [
          ['walls', 'Walls', <WallIcon key="w" />, view.walls],
          ['openings', 'Openings', <DoorIcon key="o" />, view.openings],
          ['separators', 'Separators', <SeparatorIcon key="s" />, view.separators],
          ['slabs', 'Slabs', <SlabIcon key="sl" />, view.slabs],
          ['roofs', 'Roofs', <RoofIcon key="rf" />, view.roofs],
          ['stairs', 'Stairs', <StairIcon key="st" />, view.stairs],
          ['junctions', 'Junctions', <JunctionIcon key="j" />, view.junctions],
          // The building systems' devices (FLR-T-5.7), one group per extension.
          ...SYSTEMS.map((sys): [string, string, ReactNode, { id: string }[]] => [sys.id, sys.label, <SystemIcon key={sys.id} system={sys.id} />, view.devices.filter((d) => d.system === sys.id)]),
        ];
        for (const [key, label, icon, items] of groups) {
          if (items.length === 0) continue;
          const gk = `${lid}:${key}`;
          rows.push({ key: gk, depth: 3, icon, label, meta: String(items.length), group: true, parent: `l:${lid}` });
          if (!open(gk)) continue;
          for (const item of items) {
            const o = view.openings.find((x) => x.id === item.id);
            rows.push({ key: item.id, depth: 4, icon: o === undefined ? icon : o.kind === 'window' ? <WindowIcon /> : <DoorIcon />, label: labelOf(model, item.id), meta: item.id, id: item.id, parent: gk });
          }
        }
      }
    }
    const types = Object.entries((model.document.types ?? {}) as Record<string, Json | undefined>).filter((e): e is [string, Json] => e[1] !== undefined);
    if (types.length > 0) {
      rows.push({ key: 'types', depth: 1, icon: <WallIcon />, label: 'Types', meta: String(types.length), group: true, parent: 'project' });
      if (open('types')) {
        for (const [id, t] of types) rows.push({ key: id, depth: 2, icon: t['kind'] === 'wallType' ? <WallIcon /> : t['kind'] === 'doorType' ? <DoorIcon /> : <WindowIcon />, label: labelOf(model, id), meta: id, id, parent: 'types' });
      }
    }
    const materials = Object.keys(model.document.materials ?? {});
    if (materials.length > 0) {
      rows.push({ key: 'materials', depth: 1, icon: <Palette />, label: 'Materials', meta: String(materials.length), group: true, parent: 'project' });
      if (open('materials')) for (const id of materials) rows.push({ key: id, depth: 2, icon: <Palette />, label: labelOf(model, id), meta: id, id, parent: 'materials' });
    }
  }

  const current = rows.find((r) => r.key === focusKey) ?? rows.find((r) => r.id !== undefined && r.id === selection) ?? rows[0];
  const focusRow = (row: TreeRow | undefined) => {
    if (row === undefined) return;
    setFocusKey(row.key);
    wantFocus.current = row.key;
    refs.current.get(row.key)?.focus();
  };
  const commitRename = (id: string, value: string) => {
    store.set({ renaming: null });
    const before = typeof (elementOf(model, id))?.['name'] === 'string' ? String(elementOf(model, id)?.['name']) : '';
    if (value.trim() === before) return;
    void store.apply(`Rename ${labelOf(model, id)}`, setOrUnset(id, '/name', value.trim(), before !== ''), { select: () => id });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number) => {
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        focusRow(rows[index + 1]);
        break;
      case 'ArrowUp':
        focusRow(rows[index - 1]);
        break;
      case 'Home':
        focusRow(rows[0]);
        break;
      case 'End':
        focusRow(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        if (row.group === true && !open(row.key)) setOpen(row.key, true);
        else if (row.group === true) focusRow(rows[index + 1]?.parent === row.key ? rows[index + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (row.group === true && open(row.key)) setOpen(row.key, false);
        else focusRow(rows.find((r) => r.key === row.parent));
        break;
      case 'Enter':
      case ' ':
        if (row.id !== undefined) {
          if (e.key === 'Enter' && row.id === selection && readOnly === null) store.set({ renaming: row.id });
          else store.select(row.id);
        } else if (row.group === true) toggle(row.key);
        break;
      case 'Escape':
        // Leave the tree for the plan, keeping the selection: the arrows then nudge it.
        (refs.current.get(row.key)?.closest('.fs-editor') as HTMLElement | null)?.focus();
        break;
      case 'F2':
        if (row.id !== undefined && readOnly === null) {
          store.select(row.id);
          store.set({ renaming: row.id });
        }
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <nav className="fs-tree" aria-label="Project">
      <div className="fs-panel-head">
        <span className="fs-overline">Project</span>
        <span className="fs-spacer" />
        <IconButton size="sm" label="Add a level" icon={<Plus />} disabled={readOnly !== null} onClick={() => { newLevel(store); }} />
      </div>
      <div role="tree" aria-label={`${name} elements`} className="fs-tree__rows">
        {rows.map((o, index) => {
          const expandable = o.group === true;
          const selected = o.id !== undefined && o.id === selection;
          const editing = o.id !== undefined && o.id === renaming;
          return (
            <div
              key={o.key}
              ref={(el) => {
                if (el === null) refs.current.delete(o.key);
                else refs.current.set(o.key, el);
              }}
              role="treeitem"
              aria-selected={selected}
              aria-expanded={expandable ? open(o.key) : undefined}
              aria-level={o.depth + 1}
              tabIndex={current?.key === o.key ? 0 : -1}
              className={['fs-tree__row', selected ? 'is-selected' : '', o.strong === true ? 'is-strong' : ''].join(' ')}
              style={{ paddingInlineStart: 8 + o.depth * 14 }}
              onFocus={() => { if (focusKey !== o.key) setFocusKey(o.key); }}
              onClick={() => {
                setFocusKey(o.key);
                if (o.id !== undefined) store.select(o.id);
                else if (expandable) toggle(o.key);
              }}
              onKeyDown={(e) => { if (!editing) onKeyDown(e, o, index); }}
            >
              <span
                className="fs-tree__chevron"
                onClick={(e) => {
                  if (!expandable) return;
                  e.stopPropagation();
                  toggle(o.key);
                }}
              >
                {expandable ? open(o.key) ? <ChevronDown /> : <ChevronRight /> : null}
              </span>
              <span className="fs-tree__icon">{o.icon}</span>
              {editing && o.id !== undefined ? (
                <RenameInput
                  initial={typeof elementOf(model, o.id)?.['name'] === 'string' ? String(elementOf(model, o.id)?.['name']) : ''}
                  label={`Rename ${o.label}`}
                  onDone={(value) => {
                    if (value === null) store.set({ renaming: null });
                    else commitRename(o.id as string, value);
                    focusRow(o);
                  }}
                />
              ) : (
                <span className="fs-tree__label">{o.label}</span>
              )}
              {o.meta !== undefined && !editing ? <span className="fs-tree__meta">{o.meta}</span> : null}
            </div>
          );
        })}
      </div>
      <LayerChips store={store} layers={layers} />
    </nav>
  );
}

function RenameInput({ initial, label, onDone }: { initial: string; label: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      className="fs-tree__rename"
      aria-label={label}
      autoFocus
      value={value}
      placeholder="No name"
      onChange={(e) => { setValue(e.target.value); }}
      onClick={(e) => { e.stopPropagation(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => { finish(value); }}
    />
  );
}

export function LayerChips({ store, layers }: { store: EditorStore; layers: Layers }) {
  const chips: [Exclude<keyof Layers, 'coreOnly'>, string][] = [
    ['walls', 'Walls'],
    ['openings', 'Openings'],
    ['rooms', 'Rooms'],
    ['dimensions', 'Dimensions'],
    ['electrical', 'Electrical'],
    ['plumbing', 'Plumbing'],
    ['mechanical', 'Mechanical'],
    ['lowvoltage', 'Low-voltage'],
  ];
  const after: [Exclude<keyof Layers, 'coreOnly'>, string][] = [
    ['roof', 'Roof'],
    ['findings', 'Findings'],
    ['clearances', 'Clearances'],
  ];
  const chip = ([key, label]: [Exclude<keyof Layers, 'coreOnly'>, string]) => (
    <button
      key={key}
      type="button"
      className={layers[key] ? 'fs-chip is-on' : 'fs-chip'}
      aria-pressed={layers[key]}
      onClick={() => { store.set({ layers: { ...layers, [key]: !layers[key] } }); }}
    >
      <EyeIcon />
      {label}
    </button>
  );
  return (
    <div className="fs-layers">
      <div className="fs-panel-head fs-panel-head--sub">
        <span className="fs-overline">Layers</span>
      </div>
      <div className="fs-layers__chips">
        {chips.map(chip)}
        <button
          type="button"
          className={layers.furniture !== false ? 'fs-chip is-on' : 'fs-chip'}
          aria-pressed={layers.furniture !== false}
          onClick={() => { store.set({ layers: { ...layers, furniture: layers.furniture === false } }); }}
        >
          <EyeIcon />
          Furniture
        </button>
        {after.map(chip)}
      </div>
      <div className="fs-layers__core">
        <Switch
          checked={layers.coreOnly}
          onCheckedChange={(on) => { store.set({ layers: { ...layers, coreOnly: on } }); }}
        >
          Show as core-only
        </Switch>
        <p className="fs-note">What a reader without the building-system extensions draws: each element’s fallback box.</p>
      </div>
    </div>
  );
}

export function levelName(model: EditorModel, id: string): string {
  return labelOf(model, id);
}
