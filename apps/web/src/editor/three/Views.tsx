import './three.css';
import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { SegmentedControl, Spinner } from '@d3cloud/ui';
import { Link2, Map as MapIcon } from 'lucide-react';
import { useEditor, type EditorStore } from '../store';
import { fit } from '../viewport';
import { threeOf, useThreeState, VIEW_LABELS, type ViewMode } from './mode';

/**
 * The canvas area's views (FLR-T-7.5, FLR-REQ-113): the plan, the 3D view, or both side by side
 * with one selection between them. The plan stays mounted throughout — hidden, not unmounted, in
 * 3D — so its zoom and pan are where they were when it comes back. The 3D view is its own chunk,
 * loaded the first time it is shown: three.js does not weigh on the plan.
 */

const ThreeView = lazy(() => import('./ThreeView'));

export function Views({ store, plan }: { store: EditorStore; plan: ReactNode }) {
  const mode = useThreeState(store, (s) => s.mode);
  const walking = useThreeState(store, (s) => s.walking);
  const levelName = useEditor(store, (s) => s.model?.levels.find((l) => l.id === s.level)?.name ?? null);
  const showPlan = mode === 'plan' || (mode === 'split' && !walking);
  const split = mode === 'split' && !walking;
  // The plan's pane changes width between the plan alone and the split: frame the level again for it.
  const pane = useRef<HTMLDivElement>(null);
  const shape = showPlan ? (split ? 'half' : 'whole') : 'hidden';
  const shown = useRef(shape);
  useEffect(() => {
    if (shown.current === shape) return;
    shown.current = shape;
    if (shape === 'hidden') return;
    const frame = requestAnimationFrame(() => {
      const box = pane.current?.getBoundingClientRect();
      if (box === undefined || box.width === 0 || box.height === 0) return;
      store.set({ view: fit(store.levelView?.bounds ?? null, box.width, box.height) });
    });
    return () => { cancelAnimationFrame(frame); };
  }, [shape, store]);
  return (
    <div className="fs-views" data-mode={walking ? 'walk' : mode}>
      <div className="fs-views__plan" hidden={!showPlan} ref={pane}>
        {plan}
        {split ? (
          <div className="fs-views__label" role="note">
            <MapIcon aria-hidden="true" />
            Plan · {levelName ?? 'no level'}
          </div>
        ) : null}
      </div>
      {mode !== 'plan' ? (
        <div className="fs-views__three">
          <Suspense
            fallback={
              <div className="fs-three__message">
                <Spinner size="lg" label="Loading the 3D view" />
              </div>
            }
          >
            <ThreeView store={store} compact={split} />
          </Suspense>
        </div>
      ) : null}
      {split ? (
        <div className="fs-views__synced" role="note">
          <Link2 aria-hidden="true" />
          Selection synced · click in either view
        </div>
      ) : null}
    </div>
  );
}

/** The top bar's view switch: 2D plan, 3D, Split (1, 2, 3). */
export function ViewSwitch({ store }: { store: EditorStore }) {
  const mode = useThreeState(store, (s) => s.mode);
  const ready = useEditor(store, (s) => s.status === 'ready');
  return (
    <SegmentedControl
      aria-label="View"
      className="fs-topbar__views"
      value={mode}
      items={(['plan', '3d', 'split'] as const).map((value) => ({ value, label: VIEW_LABELS[value], disabled: !ready }))}
      onValueChange={(value) => { threeOf(store).setMode(value as ViewMode); }}
    />
  );
}
