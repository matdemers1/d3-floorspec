import { useMemo } from 'react';
import { defaultLevel, PALETTES, siteLayers, type SiteLayers } from '@floorspec/render2d';
import { siteDrawing, type SiteDrawing } from '@floorspec/engine';
import type { EditorStore, Layers, Viewport } from '../store';
import type { EditorModel, LevelView } from '../model';
import { toScreen } from '../viewport';
import type { PlanLook } from '../planStyle';
import { useSite } from './state';
import { FT } from './ops';

/**
 * The site on the plan (FLR-T-15.1): render2d's site layers — the same SVG text the plan render, the
 * PDF and floorspec_render draw — on the lowest level, in the plan style's palette. The contours go
 * under the floors; cut and fill, the spots, and the lot with its setback line over them. Each group
 * carries its layer's class, so a ghosted layer (Layers drawer) greys it as the others are.
 */

const drawings = new WeakMap<EditorModel, SiteDrawing>();

/** The model's site, drawn from its view (the design shown), once per model. */
export function siteDrawingOf(model: EditorModel): SiteDrawing {
  let d = drawings.get(model);
  if (d === undefined) {
    d = siteDrawing(model.view);
    drawings.set(model, d);
  }
  return d;
}

const hasSite = (d: SiteDrawing): boolean => d.lot !== null || d.surface !== null || d.spots.length > 0 || d.contours.length > 0;

function useSiteLayers(store: EditorStore, view: Viewport, level: LevelView, model: EditorModel, look: PlanLook | null): SiteLayers | null {
  const interval = useSite(store, (s) => s.interval);
  const lowest = defaultLevel(model.view) === level.id;
  const site = siteDrawingOf(model);
  const dark = typeof document !== 'undefined' && document.documentElement.dataset['theme'] === 'dark';
  const palette = look === null ? PALETTES[dark ? 'dark' : 'light'] : look.theme;
  return useMemo(
    () => (!lowest || !hasSite(site) ? null : siteLayers(site, { s: view.s, P: (p) => toScreen(view, p) }, palette, { interval: interval * FT, idPrefix: 'fs-site-canvas' })),
    [lowest, site, view, palette, interval],
  );
}

/** Under the floors: the contours and the survey's contour lines. */
export function SiteUnderLayer({ store, view, level, model, layers, look }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; layers: Layers; look: PlanLook | null }) {
  const svg = useSiteLayers(store, view, level, model, look);
  if (svg === null || layers.contours === false || svg.contours === '') return null;
  // render2d writes the SVG: markup of numbers, palette colours and the survey's heights only
  return <g className="fs-site fs-site-contours" data-testid="site-contours" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg.contours }} />;
}

/** Over the floors: cut and fill, the spots, the lot and its setback line. */
export function SiteOverLayer({ store, view, level, model, layers, look }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; layers: Layers; look: PlanLook | null }) {
  const svg = useSiteLayers(store, view, level, model, look);
  if (svg === null) return null;
  return (
    <g className="fs-site" aria-hidden="true">
      {layers.grading !== false && svg.grading !== '' ? <g className="fs-site-grading" data-testid="site-grading" dangerouslySetInnerHTML={{ __html: `<defs>${svg.defs}</defs>${svg.grading}` }} /> : null}
      {layers.spots !== false && svg.spots !== '' ? <g className="fs-site-spots" data-testid="site-spots" dangerouslySetInnerHTML={{ __html: svg.spots }} /> : null}
      {layers.site !== false && svg.lot !== '' ? <g className="fs-site-lot" data-testid="site-lot" dangerouslySetInnerHTML={{ __html: svg.lot }} /> : null}
    </g>
  );
}
