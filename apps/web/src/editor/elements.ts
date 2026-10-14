import { LAYER_LABELS, layerOfElement, type PlanLayer } from '@floorspec/render2d';
import { labelOf, type EditorModel, type LevelView } from './model';
import type { Layers } from './store';
import { formatArea, prettyLen, type UnitSystem } from './units';
import { boxOf, sizeOf } from '../furniture/resize';

/**
 * The elements on the plan, as a list (FLR-T-18.16): what the canvas draws on the current level —
 * a layer turned Off is left out, a mode's ghosted layer is listed but cannot be picked, just as on
 * the plan, and a renovation plan lists the state it draws — in the groups a person thinks in, each
 * element with a name a screen reader can say on its own: what it is, its name, and how big it is.
 * The element list in the left drawer (ElementList.tsx) is drawn from this.
 */

export interface PlanElement {
  id: string;
  /** "Kitchen", "Wall W3", "Three-seat sofa". */
  label: string;
  /** What it is and how big: "room · 182 ft²", "12′-0″ long", "furniture · 7′-0″ × 3′-0″". */
  meta: string;
  /** On a ghosted layer: drawn grey and faint, and not picked on the plan — nor here. */
  ghost: boolean;
  /** One of the person's own dimensions or notes (FS_annotation): selected as an annotation, alone. */
  annotation?: true;
}

export interface PlanGroup {
  id: string;
  label: string;
  items: PlanElement[];
}

export interface PlanElementsInput {
  model: EditorModel;
  level: LevelView;
  layers: Layers;
  ghost: readonly PlanLayer[];
  units: UnitSystem;
  /** The person's own strings and notes on the level, when the plan shows them (FLR-T-18.11). */
  annotations?: { dimensions: readonly { id: string; lengths: readonly number[] }[]; notes: readonly { id: string; text: string }[] };
}

const drawn = (layers: Layers, layer: PlanLayer): boolean => (layers as unknown as Record<string, boolean | undefined>)[layer] !== false;
const lengthOf = (a: readonly [number, number], b: readonly [number, number]) => Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]));

/** The groups, in the order the plan stacks them, each holding what the canvas draws of it. */
export function planElements({ model, level, layers, ghost, units, annotations }: PlanElementsInput): PlanGroup[] {
  const ghosted = new Set(ghost);
  const out: PlanGroup[] = [];
  const add = (id: string, label: string, items: PlanElement[]) => {
    if (items.length > 0) out.push({ id, label, items });
  };
  const len = (v: number) => prettyLen(v, units);

  if (drawn(layers, 'rooms')) {
    const g = ghosted.has('rooms');
    add('rooms', 'Rooms', level.rooms.map((r) => ({ id: r.id, label: labelOf(model, r.id), meta: `room · ${formatArea(r.area2, units)}`, ghost: g })));
  }
  if (drawn(layers, 'walls')) {
    const g = ghosted.has('walls');
    add(
      'walls',
      'Walls',
      level.walls.map((w) => ({ id: w.id, label: labelOf(model, w.id), meta: `${w.arc === undefined ? '' : 'arc · '}${len(w.arc?.length ?? lengthOf(w.a, w.b))} long · ${len(w.thickness)} thick`, ghost: g })),
    );
  }
  if (drawn(layers, 'openings')) {
    const g = ghosted.has('openings');
    add(
      'openings',
      'Doors and windows',
      level.openings.map((o) => ({ id: o.id, label: labelOf(model, o.id), meta: `${o.kind} · ${len(o.width)} wide · in ${labelOf(model, o.wall)}`, ghost: g })),
    );
  }
  if (drawn(layers, 'walls')) {
    const g = ghosted.has('walls');
    add('separators', 'Room separators', level.separators.map((s) => ({ id: s.id, label: labelOf(model, s.id), meta: `separator · ${len(lengthOf(s.a, s.b))} long`, ghost: g })));
  }
  if (drawn(layers, 'rooms')) {
    const g = ghosted.has('rooms');
    add('slabs', 'Slabs', level.slabs.map((s) => ({ id: s.id, label: labelOf(model, s.id), meta: `slab${s.purpose === undefined ? '' : ` · ${s.purpose}`} · ${len(s.top - s.bottom)} thick`, ghost: g })));
  }
  // Stairs are drawn on every plan; roofs when the roof layer is on. Both are ghosts with that layer.
  const roofGhost = ghosted.has('roof');
  add('stairs', 'Stairs', level.stairs.map((s) => ({ id: s.id, label: labelOf(model, s.id), meta: `stair · ${s.form}`, ghost: roofGhost })));
  if (drawn(layers, 'roof')) add('roofs', 'Roofs', level.roofs.map((r) => ({ id: r.id, label: labelOf(model, r.id), meta: 'roof', ghost: roofGhost })));

  // The extension elements, by the plan layer that draws them: furniture, casework, each trade.
  const byLayer = new Map<PlanLayer | 'other', PlanElement[]>();
  for (const d of level.devices) {
    const layer = layerOfElement(d.extension, d.collection);
    if (layer !== null && !drawn(layers, layer)) continue;
    const box = d.extension === 'FS_furniture' || d.extension === 'FS_landscape' ? boxOf(d.element) : null;
    const size = box === null ? null : sizeOf(box);
    const what = d.kindLabel.toLowerCase();
    const label = labelOf(model, d.id);
    const meta = [label.toLowerCase().includes(what) ? null : what, size === null ? null : `${len(size.width)} × ${len(size.depth)}`].filter((x) => x !== null).join(' · ');
    const key = layer ?? 'other';
    const list = byLayer.get(key) ?? [];
    list.push({ id: d.id, label, meta: meta === '' ? (layer === null ? d.extension : LAYER_LABELS[layer].toLowerCase()) : meta, ghost: layer !== null && ghosted.has(layer) });
    byLayer.set(key, list);
  }
  for (const layer of ['furniture', 'casework', 'electrical', 'plumbing', 'mechanical', 'lowvoltage', 'landscape', 'other'] as const) {
    const items = byLayer.get(layer);
    if (items !== undefined) add(layer, layer === 'other' ? 'Other elements' : LAYER_LABELS[layer], items);
  }
  // The person's own dimension strings and notes, drawn with the dimensions layer.
  if (annotations !== undefined && drawn(layers, 'dimensions')) {
    const g = ghosted.has('dimensions');
    const clip = (t: string) => (t.length > 48 ? `${t.slice(0, 47)}…` : t);
    add('annotations', 'Dimensions and notes', [
      ...annotations.dimensions.map((d): PlanElement => ({ id: d.id, label: `Dimension ${d.id}`, meta: `dimension · ${d.lengths.map((l) => len(Math.round(l))).join(' + ')}`, ghost: g, annotation: true })),
      ...annotations.notes.map((n): PlanElement => ({ id: n.id, label: `Note ${n.id}`, meta: `note · “${clip(n.text)}”`, ghost: g, annotation: true })),
    ]);
  }
  return out;
}

/** Every element the list offers to pick together (⌘A), in order: not the ghosts, nor annotations — picked one at a time. */
export const pickableIds = (groups: readonly PlanGroup[]): string[] => groups.flatMap((g) => g.items.filter((i) => !i.ghost && i.annotation !== true).map((i) => i.id));
