import { useEffect, useRef, useState } from 'react';
import { loadMesher, type HouseMesh, type Mesher, type Vec3 } from '@floorspec/mesh';
import type { EditorModel } from '../model';
import { buildWorld, type World } from './walk';

/**
 * The model as meshed for the 3D view (FLR-T-7.5): @floorspec/mesh over what the engine already
 * derived (FLR-T-7.4), on the main thread — a house meshes in milliseconds — and again, debounced,
 * whenever the shown model changes: the head moving, a proposal under review, the ghost of an edit
 * in progress. The previous mesh stays on screen until the next is ready, so the camera never
 * jumps and the view never blanks.
 */

export type MeshState =
  | { status: 'loading' }
  | { status: 'ready'; mesh: HouseMesh; world: World; model: EditorModel; ms: number }
  | { status: 'invalid' }
  | { status: 'empty' }
  | { status: 'error'; message: string };

let mesher: Promise<Mesher> | null = null;
/** manifold-3d's WASM, fetched once for the page. */
const getMesher = (): Promise<Mesher> => (mesher ??= loadMesher());

const DEBOUNCE = 120;

/**
 * Where the mesh is centred: the middle of every level's plan, at project zero, in whole base units
 * — so Float32 metres stay precise for a house far from the document's origin. Chosen once per
 * editor and kept, so the camera's numbers keep meaning the same place as the model changes.
 */
export function originOf(model: EditorModel): Vec3 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of model.levels) {
    if (l.bounds === null) continue;
    minX = Math.min(minX, l.bounds.minX);
    minY = Math.min(minY, l.bounds.minY);
    maxX = Math.max(maxX, l.bounds.maxX);
    maxY = Math.max(maxY, l.bounds.maxY);
  }
  if (!Number.isFinite(minX)) return [0, 0, 0];
  return [Math.round((minX + maxX) / 2), Math.round((minY + maxY) / 2), 0];
}

export function useHouseMesh(model: EditorModel | null, originRef: { current: Vec3 | null }): MeshState {
  const [state, setState] = useState<MeshState>({ status: 'loading' });
  const first = useRef(true);
  useEffect(() => {
    if (model === null) return;
    if (model.derived === null) {
      setState({ status: 'invalid' });
      return;
    }
    if (model.levels.every((l) => l.walls.length === 0 && l.slabs.length === 0 && l.roofs.length === 0 && l.stairs.length === 0)) {
      setState({ status: 'empty' });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        getMesher()
          .then((m) => {
            if (cancelled || model.derived === null) return;
            const started = performance.now();
            originRef.current ??= originOf(model);
            const mesh = m.meshDerived(model.document, model.derived, { origin: originRef.current });
            const world = buildWorld(model, mesh);
            setState({ status: 'ready', mesh, world, model, ms: performance.now() - started });
          })
          .catch((error: unknown) => {
            if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
          });
      },
      first.current ? 0 : DEBOUNCE,
    );
    first.current = false;
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [model, originRef]);
  return state;
}
