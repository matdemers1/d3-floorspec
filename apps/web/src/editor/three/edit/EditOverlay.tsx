import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import { useToast } from '@d3cloud/ui';
import type { Vec3 } from '@floorspec/mesh';
import { useEditor, type EditorStore } from '../../store';
import { labelOf, type EditorModel } from '../../model';
import { moveOpening } from '../../ops';
import { moveDevice } from '../../systems/ops';
import { isArrow, nudge } from '../../nudge';
import { keyRotate, turnBatch, turnsFreely } from '../../../furniture/resize';
import { prettyLen } from '../../units';
import { useThreeState } from '../mode';
import type { SectionRig } from '../section/rig';
import type { MotionRig } from './rig';
import { findEditable, isEditable, type EditController } from './controller';
import { chainLength, readingOf, readout } from './tape';
import './edit.css';

/**
 * Over the 3D view while editing (FLR-T-14.8), the board's frames "14.8 · Edit in 3D — dragging an
 * armchair on the floor" and "— a window slid along its wall, the tape measure, undo": the selection's
 * move gizmo (arrows on its host's axes, a handle in the middle) and rotate handle (the dashed arc,
 * P18's handle), the ghost of where it stood, the smart guide and its pill, the clearance tags, the
 * key hints; the tape's points, line and readout. Each handle is a control the keyboard reaches —
 * arrows nudge the middle one by the nudge step (⇧ twelve), turn the rotate handle 15° (⇧ 1°), as the
 * plan's handles do (FLR-T-18.16) — and every drop and press says what it did in a polite live region
 * and a toast that offers Undo.
 *
 * Positions are set each frame by the canvas (the section rig's `overlays`), not by React.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
/** How far apart on screen the move and rotate handles' middles are at the least: 24 px targets and a gap. */
const MIN_GAP_PX = 34;
/** The move gizmo's arrows: at least this long on screen, whatever the zoom. */
const ARROW_PX = 40;

export interface EditOverlayProps {
  ctl: EditController;
  store: EditorStore;
  rig: SectionRig;
  motion: MotionRig;
  /** The parts of an element as meshed: their box, metres in the mesh's frame. */
  boxOf: (id: string) => { min: Vec3; max: Vec3 } | null;
  /** The mesh's base units per metre. */
  k: number;
}

interface Gizmo {
  id: string;
  name: string;
  kind: 'floor' | 'face' | 'opening';
  /** Middle (metres, as drawn now), the arrows' unit directions, and the rotate handle when it turns. */
  centre: Vec3;
  axes: Vec3[];
  reach: number;
  /** The rotate handle: behind the item's back (its facing, radians), this far from its middle. */
  rotate: { facing: number; radius: number } | null;
}

const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

function useView(ctl: EditController) {
  return useSyncExternalStore(ctl.subscribe, ctl.get, ctl.get);
}

/** The selection's gizmo, worked out from the model shown and its parts as meshed. */
function gizmoOf(model: EditorModel | null, id: string | null, boxOf: EditOverlayProps['boxOf'], k: number): Gizmo | null {
  if (model === null || id === null || !isEditable(model, id)) return null;
  const found = findEditable(model, id);
  const box = boxOf(id);
  if (found === null || box === null) return null;
  const centre: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, box.max[2]];
  const half = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1]) / 2;
  const name = labelOf(model, id);
  if (found.opening !== undefined && found.wall !== undefined) {
    const w = found.wall;
    const l = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
    const t: Vec3 = [(w.b[0] - w.a[0]) / l, (w.b[1] - w.a[1]) / l, 0];
    return { id, name, kind: 'opening', centre: [centre[0], centre[1], (box.min[2] + box.max[2]) / 2], axes: [t, [-t[0], -t[1], 0]], reach: Math.max(0.5, found.opening.width / k / 2 + 0.35), rotate: null };
  }
  const d = found.device;
  if (d === undefined) return null;
  if (d.host?.['mode'] === 'wallFace') {
    const w = found.level.walls.find((x) => x.id === d.host?.['wall']);
    if (w === undefined) return null;
    const l = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
    const t: Vec3 = [(w.b[0] - w.a[0]) / l, (w.b[1] - w.a[1]) / l, 0];
    const mid: Vec3 = [centre[0], centre[1], (box.min[2] + box.max[2]) / 2];
    return { id, name, kind: 'face', centre: mid, axes: [t, [-t[0], -t[1], 0], [0, 0, 1], [0, 0, -1]], reach: Math.max(0.35, half + 0.25), rotate: null };
  }
  let rotate: Gizmo['rotate'] = null;
  if (turnsFreely(d) && d.placement !== null) {
    rotate = { facing: (d.placement.facing / 1_000_000) * (Math.PI / 180), radius: half + 0.35 };
  }
  return { id, name, kind: 'floor', centre, axes: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]], reach: Math.max(0.45, half + 0.3), rotate };
}

export function EditOverlay({ ctl, store, rig, motion, boxOf, k }: EditOverlayProps) {
  const tool = useThreeState(store, (s) => s.edit);
  const tape = useThreeState(store, (s) => s.tape);
  const view = useView(ctl);
  const units = useEditor(store, () => store.units);
  const selection = useEditor(store, (s) => s.selection);
  const shown = useEditor(store, (s) => s.preview?.model ?? s.model);
  const readOnly = useEditor(store, (s) => s.readOnly !== null || s.compare !== null);
  const toast = useToast();
  const [said, setSaid] = useState('');

  const gizmo = useMemo(() => (tool !== 'move' || readOnly ? null : gizmoOf(shown, selection, boxOf, k)), [tool, readOnly, shown, selection, boxOf, k]);

  // What a drop did: the toast, with Undo (⌘Z does the same anywhere), and the live region.
  useEffect(() => {
    ctl.onDropped = (text) => {
      setSaid(text);
      toast.show({ message: text, action: { label: 'Undo', shortcut: 'z', onAction: () => { void store.undo('undo'); } } });
    };
    return () => { ctl.onDropped = null; };
  }, [ctl, toast, store]);

  // Esc cancels a drag wherever focus is.
  useEffect(() => {
    if (view.drag === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ctl.cancel();
      setSaid('Move cancelled');
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); };
  }, [view.drag, ctl]);

  // ── Where everything is, each frame.
  const svg = useRef<SVGSVGElement>(null);
  const tags = useRef<(HTMLDivElement | null)[]>([]);
  const guidePill = useRef<HTMLDivElement>(null);
  const centreEl = useRef<HTMLButtonElement>(null);
  const rotateEl = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => {
      const s = svg.current;
      if (s === null) return;
      const at = (p: Vec3) => rig.project(p);
      const paths: { d: string; cls: string }[] = [];
      const poly = (pts: Vec3[], close: boolean) => {
        const q = pts.map((p) => at(p));
        if (q.some((x) => !x.front)) return '';
        return `${q.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.x.toFixed(1)} ${x.y.toFixed(1)}`).join(' ')}${close ? ' Z' : ''}`;
      };
      if (view.ghost !== null) paths.push({ d: poly(view.ghost, true), cls: 'fs-edit3d__ghost' });
      for (const [a, b] of view.guides) paths.push({ d: poly([a, b], false), cls: 'fs-edit3d__guide' });
      view.tags.forEach((t, i) => {
        paths.push({ d: poly([t.from, t.to], false), cls: `fs-edit3d__leader fs-edit3d__leader--${t.tone}` });
        const el = tags.current[i];
        if (el === null || el === undefined) return;
        const m = at([(t.from[0] + t.to[0]) / 2, (t.from[1] + t.to[1]) / 2, (t.from[2] + t.to[2]) / 2]);
        el.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px)`;
        el.style.visibility = m.front ? '' : 'hidden';
      });
      // The guide's pill, at the guide's far end.
      const g = view.guides[0];
      if (guidePill.current !== null) {
        if (g === undefined) guidePill.current.style.visibility = 'hidden';
        else {
          const p = at(g[1]);
          guidePill.current.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
          guidePill.current.style.visibility = p.front ? '' : 'hidden';
        }
      }
      // The gizmo: arrows out from the middle, and the rotate handle on its dashed arc.
      if (gizmo !== null) {
        // Where its parts are drawn now: moved with them while it is dragged.
        const c = motion.at(gizmo.id, gizmo.centre);
        const sc = at(c);
        // Each arrow along its axis as the camera sees it, never shorter than ARROW_PX on screen.
        if (sc.front) for (const a of gizmo.axes) {
          const tip = at(add(c, a, gizmo.reach));
          const dx = tip.x - sc.x;
          const dy = tip.y - sc.y;
          const l = Math.hypot(dx, dy);
          if (l < 1e-3) continue;
          const len = Math.max(ARROW_PX, l);
          const ux = dx / l;
          const uy = dy / l;
          const x0 = sc.x + ux * 14;
          const y0 = sc.y + uy * 14;
          const x1 = sc.x + ux * len;
          const y1 = sc.y + uy * len;
          // A head: two strokes back from the tip.
          const hx = -ux * 6;
          const hy = -uy * 6;
          paths.push({ d: `M${x0.toFixed(1)} ${y0.toFixed(1)} L${x1.toFixed(1)} ${y1.toFixed(1)} M${(x1 + hx - uy * 4).toFixed(1)} ${(y1 + hy + ux * 4).toFixed(1)} L${x1.toFixed(1)} ${y1.toFixed(1)} L${(x1 + hx + uy * 4).toFixed(1)} ${(y1 + hy - ux * 4).toFixed(1)}`, cls: 'fs-edit3d__arrow' });
        }
        if (centreEl.current !== null) {
          centreEl.current.style.transform = `translate(${sc.x.toFixed(1)}px, ${sc.y.toFixed(1)}px)`;
          centreEl.current.style.visibility = sc.front ? '' : 'hidden';
        }
        if (gizmo.rotate !== null) {
          const r = gizmo.rotate;
          const a0 = r.facing + Math.PI;
          const handle: Vec3 = [c[0] + Math.cos(a0) * r.radius, c[1] + Math.sin(a0) * r.radius, c[2]];
          const arc: Vec3[] = [];
          for (let i = -8; i <= 8; i++) {
            const a = a0 + (i / 8) * 0.75;
            arc.push([c[0] + Math.cos(a) * r.radius, c[1] + Math.sin(a) * r.radius, c[2]]);
          }
          paths.push({ d: poly(arc, false), cls: 'fs-edit3d__arc' });
          paths.push({ d: poly([c, handle], false), cls: 'fs-edit3d__stem' });
          // Never on top of the move handle: each its own 24 px target, a clear gap between them.
          const q = at(handle);
          const dx = q.x - sc.x;
          const dy = q.y - sc.y;
          const l = Math.hypot(dx, dy);
          const p = l >= MIN_GAP_PX ? q : { ...q, x: sc.x + (l < 1e-3 ? 0 : (dx / l) * MIN_GAP_PX), y: sc.y + (l < 1e-3 ? -MIN_GAP_PX : (dy / l) * MIN_GAP_PX) };
          if (rotateEl.current !== null) {
            rotateEl.current.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
            rotateEl.current.style.visibility = p.front ? '' : 'hidden';
          }
        }
      }
      // The tape: its segments, points, the next point under the pointer, and the readout on the last segment.
      const pts = tape.map((t) => t.at);
      if (pts.length >= 2) paths.push({ d: poly(pts, false), cls: 'fs-edit3d__tape' });
      if (view.hover !== null && pts.length >= 1) paths.push({ d: poly([pts[pts.length - 1] as Vec3, view.hover.at], false), cls: 'fs-edit3d__tape fs-edit3d__tape--next' });
      while (s.firstChild) s.removeChild(s.firstChild);
      for (const p of paths) {
        if (p.d === '') continue;
        const el = document.createElementNS(SVG_NS, 'path');
        el.setAttribute('d', p.d);
        el.setAttribute('class', p.cls);
        s.appendChild(el);
      }
      const dot = (p: Vec3, cls: string) => {
        const q = at(p);
        if (!q.front) return;
        const el = document.createElementNS(SVG_NS, 'circle');
        el.setAttribute('cx', q.x.toFixed(1));
        el.setAttribute('cy', q.y.toFixed(1));
        el.setAttribute('r', '5');
        el.setAttribute('class', cls);
        s.appendChild(el);
      };
      for (const p of pts) dot(p, 'fs-edit3d__point');
      if (view.hover !== null) dot(view.hover.at, `fs-edit3d__point fs-edit3d__point--hover fs-edit3d__point--${view.hover.kind}`);
      if (card.current !== null) {
        const a = pts[pts.length - 2];
        const b = pts[pts.length - 1];
        if (a === undefined || b === undefined) card.current.style.visibility = 'hidden';
        else {
          const m = at([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
          card.current.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px)`;
          card.current.style.visibility = m.front ? '' : 'hidden';
        }
      }
    };
    rig.overlays.add(update);
    rig.invalidate();
    return () => { rig.overlays.delete(update); };
  }, [rig, motion, view, gizmo, tape]);
  useEffect(() => { rig.invalidate(); }, [rig, motion, gizmo]);

  // ── The handles: pointer and keys.
  const back = () => document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
  const say = (text: string) => { setSaid(text); };
  const onCentreDown = (e: PointerEvent<HTMLElement>) => {
    if (gizmo === null || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!ctl.grab(gizmo.id, gizmo.centre, e)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
  };
  const onRotateDown = (e: PointerEvent<HTMLElement>) => {
    if (gizmo?.rotate === null || gizmo === null || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!ctl.grabRotate(gizmo.id, gizmo.centre[2], e)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
  };
  const onMove = (e: PointerEvent<HTMLElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    ctl.move(e);
  };
  const onUp = (e: PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    ctl.up();
  };

  const step = (big: boolean) => store.nudgeStep * (big ? (units === 'metric' ? 10 : 12) : 1);
  const onCentreKey = (e: KeyboardEvent<HTMLElement>) => {
    if (gizmo === null || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      back();
      return;
    }
    if (!isArrow(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const model = store.get().model;
    const found = model === null ? null : findEditable(model, gizmo.id);
    if (model === null || found === null) return;
    const by = step(e.shiftKey);
    const len = prettyLen(by, units);
    const toEnd = e.key === 'ArrowRight' || e.key === 'ArrowUp';
    if (gizmo.kind === 'floor') {
      const words = { ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east' }[e.key];
      if (nudge(store, e.key, e.shiftKey)) say(`${gizmo.name}: ${len} ${words}`);
      return;
    }
    if (gizmo.kind === 'opening' && found.opening !== undefined && found.wall !== undefined) {
      const w = found.wall;
      const max = Math.max(0, Math.floor(Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) - found.opening.width));
      const offset = Math.max(0, Math.min(max, found.opening.offset + (toEnd ? by : -by)));
      if (offset === found.opening.offset) {
        say(`${gizmo.name} is at the ${toEnd ? 'end' : 'start'} of its wall`);
        return;
      }
      void store.apply(`Move ${gizmo.name}`, moveOpening(gizmo.id, offset), { select: () => gizmo.id }).then((ok) => {
        if (ok) say(`${gizmo.name}: ${prettyLen(offset, units)} from its wall’s start`);
      });
      return;
    }
    const d = found.device;
    const h = d?.host;
    if (d === undefined || h?.['mode'] !== 'wallFace' || typeof h['wall'] !== 'string' || typeof h['offset'] !== 'number') return;
    const w = found.level.walls.find((x) => x.id === h['wall']);
    if (w === undefined) return;
    const height = typeof h['height'] === 'number' ? h['height'] : 0;
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    const length = Math.floor(Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]));
    const offset = vertical ? h['offset'] : Math.max(0, Math.min(length, h['offset'] + (toEnd ? by : -by)));
    const up = vertical ? Math.max(0, height + (toEnd ? by : -by)) : height;
    void store.apply(`Move ${gizmo.name}`, moveDevice(d.id, { mode: 'wallFace', wall: w.id, side: h['side'] === 'left' ? 'left' : 'right', at: offset, height: up }), { select: () => d.id }).then((ok) => {
      if (ok) say(`${gizmo.name}: ${len} ${vertical ? (toEnd ? 'up' : 'down') : `along ${labelOf(model, w.id)}`}`);
    });
  };
  const device = gizmo === null || shown === null ? undefined : findEditable(shown, gizmo.id)?.device;
  const rotation = typeof device?.host?.['rotation'] === 'number' ? device.host['rotation'] : 0;
  const cw = -Math.round(rotation / 1_000_000);
  const turnText = cw === 0 ? 'as drawn' : `${String(Math.abs(cw))}° ${cw > 0 ? 'right' : 'left'}`;
  const onRotateKey = (e: KeyboardEvent<HTMLElement>) => {
    if (gizmo === null || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      back();
      return;
    }
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const now = store.get().model;
    const current = now === null ? undefined : findEditable(now, gizmo.id)?.device;
    if (current === undefined) return;
    const next = keyRotate(current, dir, e.shiftKey);
    if (next === null) return;
    void store.apply(`Turn ${gizmo.name}`, turnBatch(current, next), { select: () => gizmo.id }).then((ok) => {
      if (!ok) return;
      const deg = -Math.round(next / 1_000_000);
      say(`${gizmo.name}: turned ${deg === 0 ? 'back as drawn' : `${String(Math.abs(deg))}° ${deg > 0 ? 'right' : 'left'}`}`);
    });
  };

  const drag = view.drag;
  const lastTwo = tape.length >= 2 ? [tape[tape.length - 2]?.at, tape[tape.length - 1]?.at] as [Vec3, Vec3] : null;
  const reading = lastTwo === null ? null : readout(readingOf(lastTwo[0], lastTwo[1]), units);
  const total = tape.length >= 3 ? readout({ length: chainLength(tape.map((t) => t.at)), dx: 0, dy: 0, dz: 0 }, units).length : null;
  const centreLabel = gizmo === null ? '' : gizmo.kind === 'floor'
    ? `Move ${gizmo.name}: drag it, or arrow keys nudge it ${prettyLen(step(false), units)} north, south, east or west (Shift ${prettyLen(step(true), units)})`
    : gizmo.kind === 'face'
      ? `Move ${gizmo.name} on its wall: drag it, or left and right arrows move it along the wall, up and down raise and lower it`
      : `Slide ${gizmo.name} along its wall: drag it, or the arrow keys move it ${prettyLen(step(false), units)}`;

  return (
    <div className="fs-edit3d" data-tool={tool ?? undefined}>
      <svg ref={svg} className="fs-edit3d__lines" aria-hidden="true" />
      {view.tags.map((t, i) => (
        <div key={i} ref={(el) => { tags.current[i] = el; }} className={`fs-edit3d__tag fs-edit3d__tag--${t.tone}`} aria-hidden="true">
          {t.text}
        </div>
      ))}
      <div ref={guidePill} className="fs-edit3d__guide-pill" aria-hidden="true" data-on={drag?.guide === null || drag === null ? undefined : 'true'}>
        {drag?.guide ?? ''}
      </div>
      {gizmo !== null && drag?.kind !== 'rotate' ? (
        <button
          ref={centreEl}
          type="button"
          className="fs-edit3d__handle fs-edit3d__handle--move"
          aria-label={centreLabel}
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight Escape"
          data-active={drag !== null ? 'true' : undefined}
          onPointerDown={onCentreDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onCentreKey}
        >
          <span className="fs-edit3d__knob" />
        </button>
      ) : null}
      {gizmo?.rotate !== null && gizmo !== null && (drag === null || drag.kind === 'rotate') ? (
        <div
          ref={rotateEl}
          tabIndex={0}
          role="slider"
          className="fs-edit3d__handle fs-edit3d__handle--rotate"
          aria-label={`Turn ${gizmo.name}`}
          aria-valuemin={-179}
          aria-valuemax={180}
          aria-valuenow={cw === -180 ? 180 : cw}
          aria-valuetext={`Turned ${turnText}`}
          aria-roledescription="rotate handle"
          data-active={drag?.kind === 'rotate' ? 'true' : undefined}
          onPointerDown={onRotateDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onRotateKey}
        >
          <span className="fs-edit3d__knob fs-edit3d__knob--rotate" />
        </div>
      ) : null}
      {tool === 'tape' ? (
        <div className="fs-three__chip fs-edit3d__hint fs-edit3d__hint--top" role="note">
          Tape measure · click to chain <kbd>Esc</kbd> finish
        </div>
      ) : null}
      {tool === 'move' ? (
        <div className="fs-three__chip fs-edit3d__hint" role="note">
          {drag !== null && drag.kind !== 'rotate' ? (
            <>
              <span className="fs-edit3d__doing">
                {drag.kind === 'opening' ? 'Sliding' : 'Moving'} {drag.name} {drag.where}
              </span>
              {drag.kind === 'floor' ? (
                <>
                  <kbd>Shift</kbd> lock axis
                </>
              ) : null}
              <kbd>Alt</kbd> no snap <kbd>Esc</kbd> cancel
            </>
          ) : drag?.kind === 'rotate' ? (
            <>
              <span className="fs-edit3d__doing">Turning {drag.name}</span> <kbd>Shift</kbd> 1° steps <kbd>Esc</kbd> cancel
            </>
          ) : (
            <>
              <span className="fs-edit3d__doing">Edit in 3D</span> drag an item or an opening <kbd>Tab</kbd> its handles <kbd>Arrows</kbd> nudge
            </>
          )}
        </div>
      ) : null}
      {reading !== null ? (
        <div ref={card} className="fs-edit3d__readout" data-testid="tape-readout">
          <span className="fs-edit3d__length">{reading.length}</span>
          <span className="fs-edit3d__deltas">{reading.deltas}</span>
          {total !== null ? <span className="fs-edit3d__deltas">total {total}</span> : null}
        </div>
      ) : null}
      <div className="fs-three__sr" role="status" aria-live="polite">
        {said}
        {reading !== null ? ` Measured ${reading.length}: ${reading.deltas}.` : ''}
      </div>
    </div>
  );
}

/** A tape point in the document's frame, metres — what the test hook reports. */
export function docMetres(p: Vec3, origin: Vec3, k: number): Vec3 {
  return [p[0] + origin[0] / k, p[1] + origin[1] / k, p[2] + origin[2] / k];
}
