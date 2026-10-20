import { useMemo } from 'react';
import { contextLayers, defaultLevel, PALETTES, type ContextLayers } from '@floorspec/render2d';
import { useEditor, type EditorStore, type Layers, type Viewport } from '../store';
import { useModes } from '../modes';
import type { EditorModel, LevelView } from '../model';
import { toScreen } from '../viewport';
import type { PlanLook } from '../planStyle';
import { contextDrawingOf } from './ops';
import { useContextState } from './state';

/**
 * Context on the plan (FLR-T-15.3): render2d's context layers — the same SVG the plan render, the PDF
 * and floorspec_render draw — on the lowest level, in its one neutral style and the plan style's
 * palette: the street and the neighbours under the floors, the trees and the tags over them. The
 * Context layer (Layers drawer, Context panel) shows, ghosts or hides it; the group carries its class,
 * so a ghost greys it as the others are. A record being dragged is drawn where it is going.
 */

function useContextLayers(store: EditorStore, view: Viewport, level: LevelView, model: EditorModel, look: PlanLook | null): ContextLayers | null {
  const selected = useContextState(store, (s) => s.selected?.id ?? null);
  const lowest = defaultLevel(model.view) === level.id;
  const ctx = contextDrawingOf(model);
  const dark = typeof document !== 'undefined' && document.documentElement.dataset['theme'] === 'dark';
  const palette = look === null ? PALETTES[dark ? 'dark' : 'light'] : look.theme;
  return useMemo(
    () => (!lowest || ctx.empty ? null : contextLayers(ctx, { s: view.s, P: (p) => toScreen(view, p) }, palette, { idPrefix: 'fs-context-canvas', highlight: (id) => id === selected })),
    [lowest, ctx, view, palette, selected],
  );
}

/** The drag's offset on screen, for the record being dragged. */
function useDragShift(store: EditorStore, view: Viewport): { id: string; dx: number; dy: number } | null {
  const drag = useContextState(store, (s) => s.drag);
  if (drag === null) return null;
  return { id: drag.id, dx: (drag.to[0] - drag.from[0]) * view.s, dy: -(drag.to[1] - drag.from[1]) * view.s };
}

/** The dragged record's group, moved: render2d's groups carry `data-id`. */
function shifted(svg: string, shift: { id: string; dx: number; dy: number } | null): string {
  if (shift === null) return svg;
  return svg.replace(`data-id="${shift.id}"`, `data-id="${shift.id}" transform="translate(${shift.dx.toFixed(1)} ${shift.dy.toFixed(1)})"`);
}

/** Under the floors: the streets and the neighbours' massing. */
export function ContextUnderLayer({ store, view, level, model, layers, look }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; layers: Layers; look: PlanLook | null }) {
  const svg = useContextLayers(store, view, level, model, look);
  const shift = useDragShift(store, view);
  if (svg === null || layers.context === false) return null;
  // render2d writes the SVG: markup of numbers, palette colours and the records' names only
  return (
    <g className="fs-context fs-context-under" data-testid="context-under" aria-hidden="true">
      {svg.massing !== '' ? <defs dangerouslySetInnerHTML={{ __html: svg.defs }} /> : null}
      <g dangerouslySetInnerHTML={{ __html: shifted(svg.ground, shift) + shifted(svg.massing, shift) }} />
    </g>
  );
}

/** Over the floors: the trees beyond the lot, and the tags that say it is context. */
export function ContextOverLayer({ store, view, level, model, layers, look }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; layers: Layers; look: PlanLook | null }) {
  const svg = useContextLayers(store, view, level, model, look);
  const shift = useDragShift(store, view);
  if (svg === null || layers.context === false) return null;
  return <g className="fs-context fs-context-over" data-testid="context-over" aria-hidden="true" dangerouslySetInnerHTML={{ __html: shifted(svg.trees, shift) + svg.tags }} />;
}

/** The Context layer's state — on, ghost or off — as the plan's Layers drawer and the Context panel set it; the 3D view reads it too. */
export function useContextShown(store: EditorStore): 'on' | 'ghost' | 'off' {
  const drawn = useEditor(store, (s) => s.layers.context !== false);
  const ghost = useModes(store, (s) => s.ghost.includes('context'));
  return !drawn ? 'off' : ghost ? 'ghost' : 'on';
}
