import './annotate.css';
import { useMemo, type ReactNode } from 'react';
import { approxMeasure, customString, layoutAnnotations, roomStrings, SCREEN_METRICS, tagsOf, type AnnoPrim, type DimString } from '@floorspec/render2d';
import type { EditorStore, Layers, Viewport } from '../store';
import { useEditor } from '../store';
import type { EditorModel, LevelView } from '../model';
import { toScreen } from '../viewport';
import { formatLen, BASE_PER_FOOT, type UnitSystem } from '../units';
import { annoSourceOfLevel, exteriorOf, labelClear, marks } from './source';
import { resolvedOf } from './resolved';
import { annotateOf, useAnnotate } from './state';

/**
 * The plan's dimensions and annotation (FLR-T-18.11): render2d's one layout, drawn in screen pixels in
 * the plan style's ink — the exterior strings (openings located, jogs, overall), each room's own
 * strings, door and window tags, and the person's own strings and notes (FS_annotation), which the
 * select tool picks.
 */

const S = (v: Viewport, p: readonly [number, number]) => toScreen(v, [p[0], p[1]]);
const f1 = (n: number): string => n.toFixed(1);

/** Below this many pixels to the foot, rooms' strings, tags and the openings strings would only crowd the plan. */
const FINE = 9;

export function AnnotationLayer({ store, view, level, model, layers, units, caps }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; layers: Layers; units: UnitSystem; caps: boolean }) {
  const show = useAnnotate(store, (a) => a.show);
  const selected = useAnnotate(store, (a) => a.selected);
  const tool = useEditor(store, (s) => s.tool);
  const comparing = useEditor(store, (s) => s.compare !== null);
  const resolved = useMemo(() => resolvedOf(model, level.id), [model, level.id]);
  const fine = view.s * BASE_PER_FOOT >= FINE;
  const prims = useMemo(() => {
    const strings: DimString[] = [];
    if (layers.dimensions) {
      // Zoomed out, the jogs and the overall size; the openings located (and recessed faces') once there is room to read them.
      if (show.exterior) strings.push(...exteriorOf(level, model.document).filter((s) => fine || s.kind !== 'openings'));
      if (show.rooms && fine) strings.push(...roomStrings(annoSourceOfLevel(level, model.document), view.s, (r) => labelClear(r, caps), SCREEN_METRICS.text + 6));
      if (show.notes) for (const c of resolved.dimensions) {
        const s = customString(c);
        if (s !== null) strings.push(s);
      }
    }
    const tags = layers.openings && show.tags && fine ? tagsOf(annoSourceOfLevel(level, model.document), marks(model)) : [];
    const notes = layers.dimensions && show.notes ? resolved.notes : [];
    return layoutAnnotations({ strings, tags, notes }, { P: (p) => S(view, p), k: view.s }, SCREEN_METRICS, approxMeasure, (v) => formatLen(Math.round(v), units)).prims;
  }, [layers.dimensions, layers.openings, show, fine, level, model, view, resolved, caps, units]);

  // Each owner's primitives together: a string, a note or a tag is one group, picked as one.
  const groups = new Map<string, AnnoPrim[]>();
  for (const p of prims) groups.set(p.owner, [...(groups.get(p.owner) ?? []), p]);
  const pickable = (owner: string): boolean => resolved.ids.has(owner) && !comparing && (tool === 'select' || tool === 'hand');
  const out: ReactNode[] = [];
  for (const [owner, ps] of groups) {
    const kind = owner.startsWith('ext:') ? 'exterior' : owner.startsWith('room:') ? 'room' : resolved.ids.has(owner) ? 'own' : 'tag';
    const pick = pickable(owner);
    out.push(
      <g
        key={owner}
        className={`fs-anno fs-anno--${kind}${selected === owner ? ' is-selected' : ''}`}
        data-anno={owner}
        onPointerDown={
          pick
            ? (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                annotateOf(store).select(owner);
              }
            : undefined
        }
      >
        {pick ? <AnnoHit prims={ps} /> : null}
        {ps.map((p, i) => prim(p, i))}
      </g>,
    );
  }
  if (out.length === 0) return null;
  return (
    <g className="fs-dim fs-annotation" aria-hidden="true">
      {out}
    </g>
  );
}

/** A wide, invisible stroke under a picked annotation's lines and text, so it is easy to click. */
function AnnoHit({ prims }: { prims: readonly AnnoPrim[] }) {
  return (
    <g className="fs-anno__hit">
      {prims.map((p, i) => {
        if (p.t === 'line') return <line key={i} x1={f1(p.a[0])} y1={f1(p.a[1])} x2={f1(p.b[0])} y2={f1(p.b[1])} />;
        if (p.t === 'text') {
          const w = approxMeasure(p.text, p.font, p.size);
          const x = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
          return <rect key={i} x={f1(x - 3)} y={f1(p.y - p.size)} width={f1(w + 6)} height={f1(p.size * 1.4)} transform={p.rotate === 0 ? undefined : `rotate(${f1(p.rotate)} ${f1(p.x)} ${f1(p.y)})`} />;
        }
        return null;
      })}
    </g>
  );
}

function prim(p: AnnoPrim, i: number): ReactNode {
  switch (p.t) {
    case 'line':
      return <line key={i} className={`fs-anno__${p.role}`} x1={f1(p.a[0])} y1={f1(p.a[1])} x2={f1(p.b[0])} y2={f1(p.b[1])} />;
    case 'arrow':
      return <path key={i} className="fs-anno__arrow" d={`M${f1(p.pts[0][0])} ${f1(p.pts[0][1])}L${f1(p.pts[1][0])} ${f1(p.pts[1][1])}L${f1(p.pts[2][0])} ${f1(p.pts[2][1])}Z`} />;
    case 'tag':
      return p.kind === 'door' ? (
        <circle key={i} className="fs-anno__tag" cx={f1(p.cx)} cy={f1(p.cy)} r={f1(p.r)} />
      ) : (
        <path key={i} className="fs-anno__tag" d={hexagon(p.cx, p.cy, p.r)} />
      );
    case 'text':
      return (
        <text
          key={i}
          className={p.role === 'dim' ? 'fs-dim__text' : p.role === 'tag' ? 'fs-anno__tagtext' : 'fs-anno__note'}
          x={f1(p.x)}
          y={f1(p.y)}
          textAnchor={p.anchor}
          fontSize={p.role === 'dim' ? undefined : p.size}
          transform={p.rotate === 0 ? undefined : `rotate(${f1(p.rotate)} ${f1(p.x)} ${f1(p.y)})`}
        >
          {p.text}
        </text>
      );
  }
}

function hexagon(cx: number, cy: number, r: number): string {
  const h = (r * Math.sqrt(3)) / 2;
  const pts: [number, number][] = [[cx - r, cy], [cx - r / 2, cy - h], [cx + r / 2, cy - h], [cx + r, cy], [cx + r / 2, cy + h], [cx - r / 2, cy + h]];
  return `${pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${f1(x)} ${f1(y)}`).join('')}Z`;
}
