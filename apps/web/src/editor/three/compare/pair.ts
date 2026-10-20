import { viewRecord, type SavedView } from '@floorspec/mesh';
import type { EditorModel } from '../../model';
import type { EditorStore } from '../../store';
import type { PairRequest, PairSideRequest, ShotSize, StillQuality } from '../../../exports/api';
import type { CompareSource } from './compare';

/**
 * Matched pairs (FLR-T-14.4): A and B rendered on the server from one camera — the view the person is
 * looking at, as a saved view would record it, or one of the document's saved views — into a ZIP of
 * the two pictures and their swipe and side-by-side composites (`POST /exports`, `kind: "pair"`).
 */

type PairCamera = Omit<SavedView, 'id'>;

const cameras = new WeakMap<EditorStore, () => PairCamera | null>();

/** The 3D view says where its camera is (null when it has none yet); null when it goes. */
export function setPairCamera(store: EditorStore, camera: (() => PairCamera | null) | null): void {
  if (camera === null) cameras.delete(store);
  else cameras.set(store, camera);
}

/** The view the 3D view is looking at now, as a saved view records one; null without a 3D view. */
export function pairCameraOf(store: EditorStore): PairCamera | null {
  return cameras.get(store)?.() ?? null;
}

/** A side as the pair export names it: main's head (in the design the editor shows), a changeset, a design, a version. */
export function pairSide(source: CompareSource, main: EditorModel): PairSideRequest {
  const design = Object.keys(main.design).length === 0 ? {} : { design: { ...main.design } };
  switch (source.kind) {
    case 'main':
      return design;
    case 'changeset':
      return { changeset: source.id, ...design };
    case 'option':
      return { design: { ...main.design, [source.set]: source.option } };
    case 'version':
      return { version: source.hash };
  }
}

/** The pair export's request: both sides, the camera — this view, or a saved view by ID — its size and quality. */
export function pairRequest(o: { a: CompareSource; b: CompareSource; main: EditorModel; camera: { shot: PairCamera } | { view: string }; size: ShotSize; quality: StillQuality }): PairRequest {
  return {
    a: pairSide(o.a, o.main),
    b: pairSide(o.b, o.main),
    ...('view' in o.camera ? { view: o.camera.view } : { shot: viewRecord(o.camera.shot) }),
    size: o.size,
    quality: o.quality,
  };
}
