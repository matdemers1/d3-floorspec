import { useState, type ReactNode } from 'react';
import { IconButton } from '@d3cloud/ui';
import { ChevronDown, ChevronRight, House, Layers as LayersIcon, Palette, Plus } from 'lucide-react';
import { useEditor, type EditorStore, type Layers } from './store';
import { labelOf, sortedLevels, type EditorModel } from './model';
import { formatArea, formatLen } from './units';
import { DoorIcon, EyeIcon, JunctionIcon, RoofIcon, RoomIcon, SeparatorIcon, WallIcon, WindowIcon } from './icons';
import { newLevel } from './actions';

/**
 * The project tree (FLR-T-3.3): buildings › levels › rooms, with each level's walls, openings and
 * separators in groups under it, and the project's types and materials. Selecting a row selects the
 * element on the canvas, and the canvas's selection is the row highlighted here.
 */

type Json = Record<string, unknown>;

export function ProjectTree({ store }: { store: EditorStore }) {
  const model = useEditor(store, (s) => s.model);
  const selection = useEditor(store, (s) => s.selection);
  const levelId = useEditor(store, (s) => s.level);
  const layers = useEditor(store, (s) => s.layers);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const units = useEditor(store, () => store.units);
  // Projects, buildings and levels start open; element groups, types and materials start closed.
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());
  if (model === null) return null;
  const startsOpen = (key: string) => key === 'project' || key.startsWith('b:') || key.startsWith('l:');
  const toggle = (key: string) => { setFlipped((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }); };
  const open = (key: string) => startsOpen(key) !== flipped.has(key);
  const name = model.document.project.name;
  const buildings = Object.entries((model.document.buildings ?? {}) as Record<string, Json | undefined>).filter((e): e is [string, Json] => e[1] !== undefined);
  const levels = sortedLevels(model.document);

  const row = (o: { key: string; depth: number; icon: ReactNode; label: string; meta?: string; id?: string; group?: boolean; strong?: boolean }) => {
    const expandable = o.group === true;
    const selected = o.id !== undefined && o.id === selection;
    return (
      <div
        key={o.key}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={expandable ? open(o.key) : undefined}
        aria-level={o.depth + 1}
        tabIndex={selected ? 0 : -1}
        className={['fs-tree__row', selected ? 'is-selected' : '', o.strong === true ? 'is-strong' : ''].join(' ')}
        style={{ paddingInlineStart: 8 + o.depth * 14 }}
        onClick={() => {
          if (o.id !== undefined) store.select(o.id);
          else if (expandable) toggle(o.key);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (o.id !== undefined) store.select(o.id);
            else if (expandable) toggle(o.key);
          }
        }}
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
        <span className="fs-tree__label">{o.label}</span>
        {o.meta !== undefined ? <span className="fs-tree__meta">{o.meta}</span> : null}
      </div>
    );
  };

  const rows: ReactNode[] = [];
  rows.push(row({ key: 'project', depth: 0, icon: <House />, label: name, strong: true, group: true }));
  if (open('project')) {
    for (const [bid] of buildings) {
      const bLevels = levels.filter((l) => l.level['building'] === bid);
      rows.push(row({ key: `b:${bid}`, depth: 1, icon: <RoofIcon />, label: labelOf(model, bid), meta: `${String(bLevels.length)} ${bLevels.length === 1 ? 'level' : 'levels'}`, id: bid, group: true }));
      if (!open(`b:${bid}`)) continue;
      for (const { id: lid } of bLevels) {
        const view = model.levels.find((l) => l.id === lid);
        const level = model.document.levels?.[lid];
        rows.push(row({ key: `l:${lid}`, depth: 2, icon: <LayersIcon />, label: labelOf(model, lid), meta: formatLen(level?.elevation ?? 0, units), id: lid, group: true, strong: lid === levelId }));
        if (!open(`l:${lid}`) || view === undefined) continue;
        for (const room of view.rooms) rows.push(row({ key: room.id, depth: 3, icon: <RoomIcon />, label: room.name, meta: formatArea(room.area2, units), id: room.id }));
        const groups: [string, string, ReactNode, { id: string }[]][] = [
          ['walls', 'Walls', <WallIcon key="w" />, view.walls],
          ['openings', 'Openings', <DoorIcon key="o" />, view.openings],
          ['separators', 'Separators', <SeparatorIcon key="s" />, view.separators],
          ['junctions', 'Junctions', <JunctionIcon key="j" />, view.junctions],
        ];
        for (const [key, label, icon, items] of groups) {
          if (items.length === 0) continue;
          const gk = `${lid}:${key}`;
          rows.push(row({ key: gk, depth: 3, icon, label, meta: String(items.length), group: true }));
          if (!open(gk) && !items.some((i) => i.id === selection)) continue;
          for (const item of items) {
            const o = view.openings.find((x) => x.id === item.id);
            rows.push(row({ key: item.id, depth: 4, icon: o === undefined ? icon : o.kind === 'window' ? <WindowIcon /> : <DoorIcon />, label: labelOf(model, item.id), meta: item.id, id: item.id }));
          }
        }
      }
    }
    const types = Object.entries((model.document.types ?? {}) as Record<string, Json | undefined>).filter((e): e is [string, Json] => e[1] !== undefined);
    if (types.length > 0) {
      rows.push(row({ key: 'types', depth: 1, icon: <WallIcon />, label: 'Types', meta: String(types.length), group: true }));
      if (open('types') || types.some(([id]) => id === selection)) {
        for (const [id, t] of types) rows.push(row({ key: id, depth: 2, icon: t['kind'] === 'wallType' ? <WallIcon /> : t['kind'] === 'doorType' ? <DoorIcon /> : <WindowIcon />, label: labelOf(model, id), meta: id, id }));
      }
    }
    const materials = Object.keys(model.document.materials ?? {});
    if (materials.length > 0) {
      rows.push(row({ key: 'materials', depth: 1, icon: <Palette />, label: 'Materials', meta: String(materials.length), group: true }));
      if (open('materials') || materials.includes(selection ?? '')) for (const id of materials) rows.push(row({ key: id, depth: 2, icon: <Palette />, label: labelOf(model, id), meta: id, id }));
    }
  }

  return (
    <nav className="fs-tree" aria-label="Project">
      <div className="fs-panel-head">
        <span className="fs-overline">Project</span>
        <span className="fs-spacer" />
        <IconButton size="sm" label="Add a level" icon={<Plus />} disabled={readOnly !== null} onClick={() => { newLevel(store); }} />
      </div>
      <div role="tree" aria-label={`${name} elements`} className="fs-tree__rows">
        {rows}
      </div>
      <LayerChips store={store} layers={layers} />
    </nav>
  );
}

export function LayerChips({ store, layers }: { store: EditorStore; layers: Layers }) {
  const chips: [keyof Layers, string][] = [
    ['walls', 'Walls'],
    ['openings', 'Openings'],
    ['rooms', 'Rooms'],
    ['dimensions', 'Dimensions'],
    ['findings', 'Findings'],
  ];
  return (
    <div className="fs-layers">
      <div className="fs-panel-head fs-panel-head--sub">
        <span className="fs-overline">Layers</span>
      </div>
      <div className="fs-layers__chips">
        {chips.map(([key, label]) => (
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
        ))}
        {['Electrical', 'Plumbing', 'Furniture'].map((label) => (
          <button key={label} type="button" className="fs-chip" disabled title="Building systems and furniture arrive with their extensions (P5, P8)">
            <EyeIcon />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function levelName(model: EditorModel, id: string): string {
  return labelOf(model, id);
}
