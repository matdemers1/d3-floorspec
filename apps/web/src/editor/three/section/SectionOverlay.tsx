import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ThreeStore } from '../mode';
import type { UnitSystem } from '../../units';
import { prettyLen } from '../../units';
import type { SectionRig } from './rig';
import {
  alongAxis,
  cornerAt,
  cornerFaces,
  cornersShown,
  cornerWords,
  CORNERS,
  edgesSeen,
  FACE_AXIS,
  FACE_WORDS,
  faceAt,
  faceCentre,
  faceDistance,
  FACES,
  facesEye,
  moveCorner,
  moveFace,
  movePlane,
  nudgeFace,
  onLevel,
  planeRect,
  snap,
  type Box,
  type Corner,
  type ExplodeState,
  type Face,
  type Layer,
  type SectionState,
  type Vec3,
} from './section';

/**
 * Over the 3D view (FLR-T-14.6): the section box's edges and handles — the board's frame "14.6 ·
 * Section box": a pill on each face, a square at each corner the box does not hide, its edges in the
 * accent, dashed behind the box, the face being moved emphasised with the way it moves and a tag of
 * how far it is from the house's side — and the exploded view's leader labels and plumb lines (the
 * frame "14.6 · Exploded axonometric", the P14/Leader label component).
 *
 * The handles are buttons over the canvas: dragged, a face follows the pointer along its normal and a
 * corner across the plan; focused, each is a slider the arrows move — → and ↑ out a 3″ module (75 mm),
 * ← and ↓ in, ⇧ four — as the plan's handles are (FLR-T-18.16). A face the box turns away from the
 * camera keeps its handle in the tab order, shown when it is focused. Everything is moved each frame
 * by the canvas (rig.ts `overlays`), not by React.
 */

const UNITS = 1_280_000;
const SVG = 'http://www.w3.org/2000/svg';

/** The arrows' step, metres: a 3″ module, or 75 mm. */
export const keyStep = (units: UnitSystem): number => (units === 'metric' ? 0.075 : 0.0762);
/** A drag's snap, metres: ½″ or 10 mm. */
const dragStep = (units: UnitSystem): number => (units === 'metric' ? 0.01 : 0.0127);

const len = (metres: number, units: UnitSystem): string => prettyLen(Math.round(metres * UNITS), units);

type Grab = { kind: 'face'; face: Face } | { kind: 'corner'; corner: Corner } | { kind: 'plane' };
const grabKey = (g: Grab | null): string => (g === null ? '' : g.kind === 'face' ? `face:${g.face}` : g.kind === 'corner' ? `corner:${g.corner.join(',')}` : 'plane');

export interface SectionOverlayProps {
  rig: SectionRig;
  three: ThreeStore;
  section: SectionState;
  /** The house's bounds, metres: what the tag measures from. */
  house: Box;
  units: UnitSystem;
  /** The level the bottom of the box stands on, for the tag. */
  levelName: (z: number) => string | null;
}

export function SectionOverlay({ rig, three, section, house, units, levelName }: SectionOverlayProps) {
  const host = useRef<HTMLDivElement>(null);
  const lines = useRef<(SVGLineElement | null)[]>([]);
  const arrow = useRef<SVGLineElement>(null);
  const faces = useRef<Partial<Record<Face, HTMLDivElement | null>>>({});
  const corners = useRef<(HTMLButtonElement | null)[]>([]);
  const plane = useRef<HTMLDivElement>(null);
  const tag = useRef<HTMLDivElement>(null);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [focused, setFocused] = useState<Grab | null>(null);
  const active = grab ?? focused;
  const box = section.mode === 'box' ? section.box : null;
  const cut = section.mode === 'plane' ? section.plane : null;

  // Where everything is, each frame.
  useEffect(() => {
    const update = () => {
      const eye = rig.eye();
      const at = (p: Vec3) => rig.project(p);
      const place = (el: HTMLElement | null, p: Vec3) => {
        if (el === null) return;
        const s = at(p);
        el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
        el.style.visibility = s.front ? '' : 'hidden';
      };
      const line = (el: SVGLineElement | null | undefined, a: Vec3, b: Vec3, hidden: boolean, strong: boolean) => {
        if (el === null || el === undefined) return;
        const p = at(a);
        const q = at(b);
        el.setAttribute('x1', p.x.toFixed(1));
        el.setAttribute('y1', p.y.toFixed(1));
        el.setAttribute('x2', q.x.toFixed(1));
        el.setAttribute('y2', q.y.toFixed(1));
        el.dataset['hidden'] = hidden ? 'true' : 'false';
        el.dataset['strong'] = strong ? 'true' : 'false';
        el.style.display = '';
      };
      const face = active?.kind === 'face' ? active.face : active?.kind === 'plane' && cut !== null ? cut.face : null;
      if (box !== null) {
        edgesSeen(box, eye).forEach((e, i) => { line(lines.current[i], e.a, e.b, e.hidden, face !== null && e.faces.includes(face)); });
        // Handles a pointer can take, each its 24 px target clear of the others': a face the box turns
        // away, or one crowded onto another, steps back (still in the tab order, shown when focused);
        // a crowded corner is not drawn.
        const taken: { x: number; y: number }[] = [];
        const clear = (p: { x: number; y: number }) => taken.every((q) => Math.abs(q.x - p.x) >= 26 || Math.abs(q.y - p.y) >= 26);
        for (const f of FACES) {
          const el = faces.current[f];
          const c = faceCentre(box, f);
          place(el ?? null, c);
          if (el === null || el === undefined) continue;
          const p = at(c);
          const front = facesEye(box, f, eye) && clear(p);
          if (front) taken.push(p);
          el.dataset['back'] = front ? 'false' : 'true';
        }
        const shown = cornersShown(box, eye);
        CORNERS.forEach((c, i) => {
          const el = corners.current[i] ?? null;
          const v = cornerAt(box, c);
          place(el, v);
          if (el === null) return;
          const p = at(v);
          const on = shown.includes(c) && clear(p);
          if (on) taken.push(p);
          el.style.display = on ? '' : 'none';
        });
      } else if (cut !== null) {
        const r = planeRect(house, cut);
        r.forEach((a, i) => { line(lines.current[i], a, r[(i + 1) % 4] ?? a, false, face !== null); });
        for (let i = 4; i < 12; i++) if (lines.current[i]) (lines.current[i] as SVGLineElement).style.display = 'none';
        const c: Vec3 = [(r[0][0] + r[2][0]) / 2, (r[0][1] + r[2][1]) / 2, (r[0][2] + r[2][2]) / 2];
        place(plane.current, c);
      }
      // The way the face moves, and how far it is: while it is dragged or focused.
      const a = arrow.current;
      const t = tag.current;
      const from = face === null ? null : box !== null ? faceCentre(box, face) : cut !== null ? (() => {
        const r = planeRect(house, cut);
        return [(r[0][0] + r[2][0]) / 2, (r[0][1] + r[2][1]) / 2, (r[0][2] + r[2][2]) / 2] as Vec3;
      })() : null;
      if (a !== null && t !== null) {
        if (face === null || from === null) {
          a.style.display = 'none';
          t.style.display = 'none';
        } else {
          const { axis, sign } = FACE_AXIS[face];
          const to: Vec3 = [...from];
          to[axis] += sign * Math.max(0.6, Math.min(house.max[0] - house.min[0], house.max[1] - house.min[1]) * 0.08);
          const p = at(from);
          const q = at(to);
          a.setAttribute('x1', p.x.toFixed(1));
          a.setAttribute('y1', p.y.toFixed(1));
          a.setAttribute('x2', q.x.toFixed(1));
          a.setAttribute('y2', q.y.toFixed(1));
          a.style.display = '';
          t.style.display = '';
          t.style.transform = `translate(${(q.x + 8).toFixed(1)}px, ${(q.y - 9).toFixed(1)}px)`;
        }
      }
    };
    rig.overlays.add(update);
    rig.invalidate();
    return () => { rig.overlays.delete(update); };
  }, [rig, box, cut, house, active]);

  const local = (e: PointerEvent): [number, number] => {
    const r = host.current?.getBoundingClientRect();
    return r === undefined ? [0, 0] : [e.clientX - r.left, e.clientY - r.top];
  };
  const drag = (g: Grab, e: PointerEvent) => {
    const [x, y] = local(e);
    const ray = rig.ray(x, y);
    if (ray === null) return;
    const s = three.get().section;
    const step = dragStep(units);
    if (g.kind === 'face' && s.box !== null) {
      const at = alongAxis(ray.origin, ray.dir, faceCentre(s.box, g.face), FACE_AXIS[g.face].axis);
      if (at !== null) three.setSection({ box: moveFace(s.box, g.face, snap(at, step)) });
    } else if (g.kind === 'corner' && s.box !== null) {
      const p = onLevel(ray.origin, ray.dir, cornerAt(s.box, g.corner)[2]);
      if (p !== null) three.setSection({ box: moveCorner(s.box, g.corner, snap(p[0], step), snap(p[1], step)) });
    } else if (g.kind === 'plane' && s.plane !== null) {
      const r = planeRect(house, s.plane);
      const c: Vec3 = [(r[0][0] + r[2][0]) / 2, (r[0][1] + r[2][1]) / 2, (r[0][2] + r[2][2]) / 2];
      const at = alongAxis(ray.origin, ray.dir, c, FACE_AXIS[s.plane.face].axis);
      if (at !== null) three.setSection({ plane: movePlane(s.plane, house, snap(at, step)) });
    }
  };
  const handlers = (g: Grab) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus();
      setGrab(g);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      drag(g, e);
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      setGrab(null);
    },
    onPointerCancel: () => { setGrab(null); },
    onFocus: () => { setFocused(g); },
    onBlur: () => { setFocused((f) => (grabKey(f) === grabKey(g) ? null : f)); },
  });
  const back = () => document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
  const keys = (g: Grab) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      back();
      return;
    }
    const s = three.get().section;
    const by = keyStep(units) * (e.shiftKey ? 4 : 1);
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (dir === 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (g.kind === 'face' && s.box !== null) three.setSection({ box: nudgeFace(s.box, g.face, dir * by) });
    else if (g.kind === 'plane' && s.plane !== null) three.setSection({ plane: movePlane(s.plane, house, s.plane.at + FACE_AXIS[s.plane.face].sign * dir * by) });
    else if (g.kind === 'corner' && s.box !== null) {
      // A corner moves in plan: ← → east and west, ↑ ↓ north and south.
      const [fx, fy] = cornerFaces(g.corner);
      const horizontal = e.key === 'ArrowRight' || e.key === 'ArrowLeft';
      const f = horizontal ? fx : fy;
      three.setSection({ box: moveFace(s.box, f, faceAt(s.box, f) + dir * by) });
    }
  };

  const valueText = (f: Face, at: number): string => {
    const d = faceDistance(house, f, at);
    if (FACE_AXIS[f].axis === 2) {
      const level = levelName(at);
      return `${len(d.metres, units)} above ${level ?? 'the ground'}`;
    }
    return `${len(d.metres, units)} from ${d.from}`;
  };
  const tagText = (() => {
    const g = active;
    if (g === null) return '';
    if (g.kind === 'face' && box !== null) return valueText(g.face, faceAt(box, g.face));
    if (g.kind === 'plane' && cut !== null) return valueText(cut.face, cut.at);
    return '';
  })();

  return (
    <div className="fs-section__overlay" ref={host}>
      <svg className="fs-section__lines" aria-hidden="true">
        {Array.from({ length: 12 }, (_, i) => (
          <line key={i} ref={(el) => { lines.current[i] = el; }} className="fs-section__edge" />
        ))}
        <line ref={arrow} className="fs-section__arrow" markerEnd="url(#fs-section-head)" />
        <defs>
          <marker id="fs-section-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className="fs-section__head" />
          </marker>
        </defs>
      </svg>
      {box !== null
        ? FACES.map((f) => {
            const g: Grab = { kind: 'face', face: f };
            const at = faceAt(box, f);
            return (
              <div
                key={f}
                tabIndex={0}
                ref={(el) => { faces.current[f] = el; }}
                className="fs-section__handle fs-section__handle--face"
                role="slider"
                aria-label={`${FACE_WORDS[f]} of the section box`}
                aria-orientation={FACE_AXIS[f].axis === 2 ? 'vertical' : 'horizontal'}
                aria-valuemin={Math.round((house.min[FACE_AXIS[f].axis] - 50) * UNITS)}
                aria-valuemax={Math.round((house.max[FACE_AXIS[f].axis] + 50) * UNITS)}
                aria-valuenow={Math.round(at * UNITS)}
                aria-valuetext={valueText(f, at)}
                data-active={grab?.kind === 'face' && grab.face === f ? 'true' : undefined}
                data-face={f}
                onKeyDown={keys(g)}
                {...handlers(g)}
              >
                <span className="fs-section__pill" />
              </div>
            );
          })
        : null}
      {box !== null
        ? CORNERS.map((c, i) => {
            const g: Grab = { kind: 'corner', corner: c };
            return (
              <button
                key={c.join(',')}
                type="button"
                ref={(el) => { corners.current[i] = el; }}
                className="fs-section__handle fs-section__handle--corner"
                aria-label={`The section box’s ${cornerWords(c)}: arrows move it east, west, north and south`}
                data-corner={c.join(',')}
                onKeyDown={keys(g)}
                {...handlers(g)}
              >
                <span className="fs-section__square" />
              </button>
            );
          })
        : null}
      {cut !== null ? (
        <div
          tabIndex={0}
          ref={plane}
          className="fs-section__handle fs-section__handle--face"
          role="slider"
          aria-label={`Section plane, cutting away the ${cut.face === 'top' ? 'top' : cut.face === 'bottom' ? 'bottom' : `${cut.face} side`}`}
          aria-orientation={FACE_AXIS[cut.face].axis === 2 ? 'vertical' : 'horizontal'}
          aria-valuemin={Math.round((house.min[FACE_AXIS[cut.face].axis] - 50) * UNITS)}
          aria-valuemax={Math.round((house.max[FACE_AXIS[cut.face].axis] + 50) * UNITS)}
          aria-valuenow={Math.round(cut.at * UNITS)}
          aria-valuetext={valueText(cut.face, cut.at)}
          data-active={grab?.kind === 'plane' ? 'true' : undefined}
          data-face="plane"
          onKeyDown={keys({ kind: 'plane' })}
          {...handlers({ kind: 'plane' })}
        >
          <span className="fs-section__pill" />
        </div>
      ) : null}
      <div ref={tag} className="fs-section__tag" aria-hidden="true">
        {tagText}
      </div>
    </div>
  );
}

// ─── The exploded view's labels ──────────────────────────────────────────────────────────────

/** A layer's leader label: what it says, and the box (metres, unlifted) it is pinned to. */
export interface LayerLabel {
  readonly layer: Layer;
  readonly title: string;
  readonly sub: string;
  readonly box: Box;
}

/** What the exploded view draws over the picture, CSS pixels: for the still. */
export interface Drawing {
  readonly width: number;
  readonly height: number;
  readonly plumb: { x1: number; y1: number; x2: number; y2: number }[];
  readonly labels: { x: number; y: number; title: string; sub: string }[];
}

/** The pin of a layer's label: of its top's corners, the one furthest right on screen. */
function pinOf(rig: SectionRig, l: LayerLabel): { x: number; y: number; front: boolean } {
  const lift = rig.liftOf(l.layer.key);
  const z = (l.layer.roof ? l.box.max[2] : l.box.max[2]) + lift;
  const pts: Vec3[] = l.layer.roof
    ? [[(l.box.min[0] + l.box.max[0]) / 2, (l.box.min[1] + l.box.max[1]) / 2, z]]
    : [[l.box.min[0], l.box.min[1], z], [l.box.max[0], l.box.min[1], z], [l.box.max[0], l.box.max[1], z], [l.box.min[0], l.box.max[1], z]];
  let best = rig.project(pts[0] ?? [0, 0, 0]);
  for (const p of pts.slice(1)) {
    const s = rig.project(p);
    if (s.x > best.x) best = s;
  }
  return best;
}

/** The plumb lines: from each lifted layer's outer bottom corners down to where they stood a spread lower. */
function plumbOf(rig: SectionRig, labels: readonly LayerLabel[]): Drawing['plumb'] {
  const out: Drawing['plumb'] = [];
  labels.forEach((l, k) => {
    if (k === 0) return;
    const below = labels[k - 1];
    if (below === undefined) return;
    const lift = rig.liftOf(l.layer.key);
    const under = rig.liftOf(below.layer.key);
    if (lift - under < 0.05) return;
    const z = l.box.min[2];
    const corners: Vec3[] = [[l.box.min[0], l.box.min[1], z], [l.box.max[0], l.box.min[1], z], [l.box.max[0], l.box.max[1], z], [l.box.min[0], l.box.max[1], z]];
    const seen = corners.map((c) => ({ c, s: rig.project([c[0], c[1], c[2] + lift]) })).sort((a, b) => a.s.x - b.s.x);
    for (const e of [seen[0], seen[seen.length - 1]]) {
      if (e === undefined) continue;
      const to = rig.project([e.c[0], e.c[1], e.c[2] + under]);
      out.push({ x1: e.s.x, y1: e.s.y, x2: to.x, y2: to.y });
    }
  });
  return out;
}

export function ExplodedOverlay({ rig, explode, labels, drawing }: { rig: SectionRig; explode: ExplodeState; labels: readonly LayerLabel[]; drawing: { current: Drawing | null } }) {
  const pins = useRef<(HTMLDivElement | null)[]>([]);
  const pills = useRef<(HTMLDivElement | null)[]>([]);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const update = () => {
      const { width, height } = rig.size;
      const plumb = explode.plumb ? plumbOf(rig, labels) : [];
      const placed: Drawing['labels'] = [];
      labels.forEach((l, i) => {
        const el = pins.current[i];
        const pill = pills.current[i];
        if (el === null || el === undefined) return;
        const p = pinOf(rig, l);
        el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
        el.style.visibility = explode.labels && p.front ? '' : 'hidden';
        // The pill never leaves the view: it slides along, its leader still on the pin.
        if (pill !== null && pill !== undefined) {
          const w = pill.offsetWidth;
          const left = p.x - w / 2;
          const shift = left < 8 ? 8 - left : left + w > width - 8 ? width - 8 - (left + w) : 0;
          pill.style.transform = `translateX(${shift.toFixed(1)}px)`;
          if (explode.labels && p.front) placed.push({ x: p.x, y: p.y, title: l.title, sub: l.sub });
        }
      });
      const s = svg.current;
      if (s !== null) {
        while (s.firstChild) s.removeChild(s.firstChild);
        for (const q of plumb) {
          const line = document.createElementNS(SVG, 'line');
          line.setAttribute('x1', q.x1.toFixed(1));
          line.setAttribute('y1', q.y1.toFixed(1));
          line.setAttribute('x2', q.x2.toFixed(1));
          line.setAttribute('y2', q.y2.toFixed(1));
          line.setAttribute('class', 'fs-explode__plumb');
          s.appendChild(line);
        }
      }
      drawing.current = { width, height, plumb, labels: placed };
    };
    rig.overlays.add(update);
    rig.invalidate();
    return () => { rig.overlays.delete(update); };
  }, [rig, explode.labels, explode.plumb, labels, drawing]);
  return (
    <div className="fs-explode__overlay" aria-hidden="true">
      <svg ref={svg} className="fs-section__lines" />
      {labels.map((l, i) => (
        <div key={l.layer.key} ref={(el) => { pins.current[i] = el; }} className="fs-explode__pin" data-layer={l.layer.key}>
          <div className="fs-explode__label">
            <div ref={(el) => { pills.current[i] = el; }} className="fs-explode__pill">
              <span className="fs-explode__title">{l.title}</span>
              <span className="fs-explode__sub">{l.sub}</span>
            </div>
            <span className="fs-explode__leader" />
            <span className="fs-explode__dot" />
          </div>
        </div>
      ))}
    </div>
  );
}
