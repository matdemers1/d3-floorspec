import { useEffect, useMemo, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Camera } from 'lucide-react';
import { filmCameraAt, filmDuration, UNITS_PER_METRE, type FilmShot } from '@floorspec/mesh';
import type { EditorModel } from '../../model';
import type { EditorStore } from '../../store';
import { viewsOf } from '../shot/views';
import { filmOf, keyLabel, shotsOf, theFilm, useFilmState } from './films';

/**
 * The film's path in the 3D view (FLR-T-14.1, the board's "Camera path (eased, dotted)" and its
 * numbered keyframe cameras): a dashed line along the eye's path as the film runs it, and a chip at
 * each named keyframe — drawn while the timeline is open.
 */

/** The eye's path, metres about the mesh's origin, sampled every tenth of a second; and the named keys' eyes. */
export function useFilmPath(store: EditorStore, model: EditorModel | null, origin: readonly [number, number, number] | null) {
  const open = useFilmState(store, (s) => s.open);
  return useMemo(() => {
    if (!open || model === null || origin === null) return null;
    const film = theFilm(model);
    if (film === null) return null;
    const views = viewsOf(model);
    const shots: FilmShot[] = shotsOf(film, views);
    if (shots.length === 0) return null;
    const m = (p: readonly [number, number, number]): [number, number, number] => [(p[0] - origin[0]) / UNITS_PER_METRE, (p[1] - origin[1]) / UNITS_PER_METRE, (p[2] - origin[2]) / UNITS_PER_METRE];
    const d = filmDuration(film);
    const points: [number, number, number][] = [];
    for (let t = 0; t <= d; t += 100) points.push(m(filmCameraAt(shots, t).eye));
    const marks = film.keys
      .map((k, index) => ({ k, index }))
      .filter(({ k }) => k.view !== undefined || k.name !== undefined)
      .flatMap(({ k, index }) => {
        const v = k.view === undefined ? undefined : views.find((x) => x.id === k.view);
        const eye = k.view === undefined ? k.eye : v?.eye;
        return eye === undefined ? [] : [{ index, label: keyLabel(k, index, views), at: m(eye) }];
      });
    return { points, marks };
  }, [open, model, origin]);
}

/** The dashed line, inside the canvas. */
export function FilmPathLine({ points, color }: { points: readonly (readonly [number, number, number])[]; color: string }) {
  const line = useMemo(() => {
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
    const material = new THREE.LineDashedMaterial({ color: new THREE.Color(color), dashSize: 0.35, gapSize: 0.25, depthTest: false, transparent: true, opacity: 0.95 });
    const l = new THREE.Line(geometry, material);
    l.computeLineDistances();
    l.renderOrder = 10;
    l.raycast = () => undefined;
    return l;
  }, [points, color]);
  useEffect(() => () => {
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  }, [line]);
  return <primitive object={line} />;
}

/** Each chip follows its keyframe's eye on the screen, from inside the canvas. */
export function FilmMarksTracker({ marks, el }: { marks: readonly { index: number; at: readonly [number, number, number] }[]; el: RefObject<HTMLDivElement | null> }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const host = el.current;
    if (host === null) return;
    for (const m of marks) {
      const node = host.querySelector<HTMLElement>(`[data-key="${String(m.index)}"]`);
      if (node === null) continue;
      v.set(m.at[0], m.at[1], m.at[2]).project(camera);
      const inView = v.z < 1 && Math.abs(v.x) <= 1.02 && Math.abs(v.y) <= 1.02;
      node.style.visibility = inView ? 'visible' : 'hidden';
      node.style.transform = `translate(${String(((v.x + 1) / 2) * size.width)}px, ${String(((1 - v.y) / 2) * size.height)}px) translate(-14px, -50%)`;
    }
  });
  return null;
}

/** The chips themselves, over the canvas: a keyframe's number, a camera, its name. A click opens it on the timeline. */
export function FilmMarks({ store, marks, el }: { store: EditorStore; marks: readonly { index: number; label: string }[]; el: RefObject<HTMLDivElement | null> }) {
  const selected = useFilmState(store, (s) => s.selected);
  return (
    <div className="fs-film-marks" ref={el} aria-hidden="true">
      {marks.map((m) => (
        <button
          key={m.index}
          type="button"
          tabIndex={-1}
          className="fs-film-mark"
          data-key={m.index}
          data-selected={selected === m.index ? 'true' : undefined}
          onClick={() => { filmOf(store).set({ selected: m.index, playing: false }); }}
        >
          <span className="fs-film-mark__n">{m.index + 1}</span>
          <Camera aria-hidden="true" />
          <span className="fs-film-mark__name">{m.label}</span>
        </button>
      ))}
    </div>
  );
}
