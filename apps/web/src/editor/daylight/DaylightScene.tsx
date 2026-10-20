import { useEffect, useMemo, type RefObject } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { DaylightGrid, GlareFlag } from '@floorspec/analysis';
import type { EditorStore } from '../store';
import { useDaylight } from './state';
import { declutter, paintGrid, useBandColours, type BandColours, type Pill } from './paint';
import type { DaylightMeasure } from './state';
import { GlareFlagChip } from './Daylight';

/**
 * The study in the 3D view (FLR-T-14.7, the board's "14.7 · Daylight in 3D"): each level's grid as a
 * picture laid a centimetre over its floors — one map, unlit, on a plane of its own, so a surface's
 * own texture units are untouched (the materials suite's 16-unit budget) — and the glare flags as
 * chips over the view, each pinned to its desk or bed.
 */

/** A level's study laid on its floors. */
function GridPlane({ grid, measure, colours, origin, k }: { grid: DaylightGrid; measure: DaylightMeasure; colours: BandColours; origin: readonly [number, number, number]; k: number }) {
  const invalidate = useThree((s) => s.invalidate);
  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(paintGrid(grid, measure, colours, 0.72));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [grid, measure, colours]);
  useEffect(() => {
    invalidate();
    return () => { texture.dispose(); };
  }, [texture, invalidate]);
  const w = grid.columns * grid.spacing;
  const h = grid.rows * grid.spacing;
  const x = grid.origin[0] + w / 2 - origin[0] / k;
  const y = grid.origin[1] + h / 2 - origin[1] / k;
  const z = grid.elevation + 0.012 - origin[2] / k;
  return (
    <mesh position={[x, y, z]} renderOrder={5} userData={{ daylight: grid.level }} raycast={() => null}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} />
    </mesh>
  );
}

/** Inside the canvas: the planes of the levels drawn. */
export function DaylightScene({ store, levels, origin, k }: { store: EditorStore; levels: ReadonlySet<string>; origin: readonly [number, number, number]; k: number }) {
  const on = useDaylight(store, (s) => s.on);
  const study = useDaylight(store, (s) => s.study);
  const measure = useDaylight(store, (s) => s.measure);
  const colours = useBandColours();
  if (!on || study === null) return null;
  return (
    <group name="daylight">
      {study.levels
        .filter((g) => levels.has(g.level))
        .map((g) => (
          <GridPlane key={g.level} grid={g} measure={measure} colours={colours} origin={origin} k={k} />
        ))}
    </group>
  );
}

/** The flags to pin in 3D: daylight on, glare on, on a level drawn. */
export function useGlareFlags(store: EditorStore, levels: ReadonlySet<string>): readonly GlareFlag[] {
  const on = useDaylight(store, (s) => s.on);
  const glare = useDaylight(store, (s) => s.glare);
  const study = useDaylight(store, (s) => s.study);
  return useMemo(() => (!on || !glare || study === null ? [] : study.glare.filter((g) => levels.has(g.level))), [on, glare, study, levels]);
}

/** Inside the canvas: keeps each flag over its point as the camera moves, no two pills overlapping. */
export function GlareTracker({ flags, el, origin, k }: { flags: readonly GlareFlag[]; el: RefObject<HTMLDivElement | null>; origin: readonly [number, number, number]; k: number }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const host = el.current;
    if (host === null) return;
    const shown: { node: HTMLElement; pill: Pill }[] = [];
    for (const f of flags) {
      const node = host.querySelector<HTMLElement>(`[data-mark="${CSS.escape(f.id)}"]`);
      if (node === null) continue;
      v.set(f.at[0] - origin[0] / k, f.at[1] - origin[1] / k, f.z - origin[2] / k).project(camera);
      const inView = v.z < 1 && Math.abs(v.x) <= 1.02 && Math.abs(v.y) <= 1.02;
      node.style.visibility = inView ? 'visible' : 'hidden';
      if (!inView) continue;
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      node.style.transform = `translate(${String(x)}px, ${String(y)}px)`;
      const chip = node.querySelector<HTMLElement>('.fs-daylight__flag');
      shown.push({ node, pill: { x, y, w: chip?.offsetWidth ?? 160, h: chip?.offsetHeight ?? 24 } });
    }
    const lifts = declutter(shown.map((s) => s.pill));
    shown.forEach((s, i) => { s.node.style.setProperty('--lift', `${String(lifts[i] ?? 0)}px`); });
  });
  return null;
}

/** Over the canvas: the flags themselves. */
export function GlareMarks({ flags, el }: { flags: readonly GlareFlag[]; el: RefObject<HTMLDivElement | null> }) {
  return (
    <div className="fs-daylight__marks" ref={el} role="list" aria-label="Glare at desks and beds">
      {flags.map((f) => (
        <span key={f.id} role="listitem" className="fs-daylight__pin" data-mark={f.id} style={{ visibility: 'hidden' }}>
          <span className="fs-daylight__leader" aria-hidden="true" />
          <span className="fs-daylight__dot" aria-hidden="true" />
          <GlareFlagChip flag={f} />
        </span>
      ))}
    </div>
  );
}
