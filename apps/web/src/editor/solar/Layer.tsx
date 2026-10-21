import { useMemo } from 'react';
import { PALETTES, solarLayers } from '@floorspec/render2d';
import { useEditor, type EditorStore, type Layers, type Viewport } from '../store';
import { useModes } from '../modes';
import type { EditorModel, LevelView } from '../model';
import { toScreen } from '../viewport';
import type { PlanLook } from '../planStyle';
import { solarDrawingOf, useSolarState } from './data';

/**
 * Solar on the plan (FLR-T-16.1): render2d's Solar layer — the same SVG the plan render, the PDF and
 * floorspec_render draw — on the level shown: the setbacks each face keeps as tinted strips and its slope,
 * each array's modules and footprint, and its tag. The selected array, or the face picked with the solar
 * tool, is drawn in the accent. The Solar layer (Layers drawer, Solar panel) shows, ghosts or hides it.
 */
export function SolarLayer({ store, view, level, model, layers, look }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; layers: Layers; look: PlanLook | null }) {
  const selection = useEditor(store, (s) => s.selection);
  const face = useSolarState(store, (s) => s.face);
  const drawing = solarDrawingOf(model);
  const dark = typeof document !== 'undefined' && document.documentElement.dataset['theme'] === 'dark';
  const palette = look === null ? PALETTES[dark ? 'dark' : 'light'] : look.theme;
  const svg = useMemo(
    () => (drawing.arrays.length === 0 && drawing.faces.every((f) => f.level !== level.id) ? null : solarLayers(drawing, level.id, { s: view.s, P: (p) => toScreen(view, p) }, palette, { highlight: (id) => id === selection, setbacks: drawing.arrays.length > 0 || face !== null })),
    [drawing, level.id, view, palette, selection, face],
  );
  const picked = face === null ? null : drawing.faces.find((f) => f.key === face && f.level === level.id);
  if (svg === null || layers.solar === false || (drawing.arrays.length === 0 && picked === undefined)) return null;
  // render2d writes the SVG: markup of numbers, palette colours and the arrays' IDs only
  return (
    <g className="fs-solar" data-testid="solar-layer" aria-hidden="true">
      <g dangerouslySetInnerHTML={{ __html: svg.setbacks + svg.arrays }} />
      {picked !== undefined && picked !== null
        ? picked.polygons.map((poly, i) => <polygon key={i} className="fs-solar__picked" data-testid="solar-picked-face" points={poly.map((p) => toScreen(view, [p[0], p[1]]).join(',')).join(' ')} />)
        : null}
      <g dangerouslySetInnerHTML={{ __html: svg.tags }} />
    </g>
  );
}

/** The Solar layer's state — on, ghost or off — as the plan's Layers drawer and the Solar panel set it; the 3D view reads it too. */
export function useSolarShown(store: EditorStore): 'on' | 'ghost' | 'off' {
  const drawn = useEditor(store, (s) => s.layers.solar !== false);
  const ghost = useModes(store, (s) => s.ghost.includes('solar'));
  return !drawn ? 'off' : ghost ? 'ghost' : 'on';
}
