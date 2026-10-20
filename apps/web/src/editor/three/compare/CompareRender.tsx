import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { FOV, type ThreeController } from '../controller';
import { passes, SECTION_ROOT, type CompareState, type Side } from './compare';

/**
 * Compare in 3D, inside the canvas (FLR-T-14.4): the frame drawn in two passes from one scene. Each
 * pass shows one side's house — main's parts, or a compared model's — and hides the other's, then
 * draws through the scissor (and, side by side, the viewport) compare.ts `passes` gives it. One
 * camera drives both: in a swipe, the view's own camera draws both pictures, so every pixel of A and
 * B lines up; side by side, the same camera at each half's shape — or, with the cameras unlinked, B's
 * half through a camera of its own that B's half orbits.
 *
 * Mounted only while comparing: it takes over drawing (a `useFrame` at priority 1, so React Three
 * Fiber does not draw the frame itself). The shadows are drawn again for each side, since what casts
 * them differs; when it goes, the view's shadows are drawn once more for the house alone.
 */

export function CompareRender({
  state,
  groupOf,
  houses,
  main,
  ctlB,
}: {
  state: Pick<CompareState, 'mode' | 'divider' | 'flipped' | 'linked'>;
  /** The group a side's house is drawn by. */
  groupOf: (side: Side) => THREE.Object3D | null;
  /** Every house group: main's and each compared model's. */
  houses: () => readonly THREE.Object3D[];
  /** Main's house: the section's caps and ghost are drawn with it only. */
  main: () => THREE.Object3D | null;
  /** B's own camera, when the cameras are unlinked side by side. */
  ctlB: ThreeController;
}) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const camB = useMemo(() => {
    const c = new THREE.PerspectiveCamera(FOV, 1, 0.05, 4000);
    c.up.set(0, 0, 1);
    return c;
  }, []);
  useEffect(() => {
    invalidate();
    return () => {
      // Back to one house: its shadows drawn again, the frame drawn by React Three Fiber.
      gl.shadowMap.needsUpdate = true;
      gl.setScissorTest(false);
      invalidate();
    };
  }, [gl, invalidate]);
  useEffect(() => { invalidate(); }, [state.mode, state.divider, state.flipped, state.linked, invalidate]);

  useFrame(({ scene, camera, size }, dt) => {
    const list = passes(state, size.width, size.height);
    const all = houses();
    const visible = all.map((g) => g.visible);
    const house = main();
    const section = scene.getObjectByName(SECTION_ROOT);
    const sectionShown = section?.visible ?? false;
    const unlinked = state.mode === 'side' && !state.linked;
    if (unlinked) {
      ctlB.size = { width: Math.max(1, Math.floor(size.width / 2)), height: size.height };
      ctlB.frame(camB, dt);
    }
    gl.setScissorTest(true);
    try {
      for (const p of list) {
        const g = groupOf(p.side);
        all.forEach((o, i) => { o.visible = o === g && (visible[i] ?? true); });
        if (section !== undefined) section.visible = sectionShown && g !== null && g === house;
        const cam = unlinked && p.side === 'b' ? camB : camera;
        const perspective = cam instanceof THREE.PerspectiveCamera ? cam : null;
        const aspect = perspective?.aspect ?? 1;
        const shaped = perspective !== null && state.mode === 'side';
        if (shaped) {
          perspective.aspect = p.viewport.width / Math.max(1, p.viewport.height);
          perspective.updateProjectionMatrix();
        }
        gl.setViewport(p.viewport.x, p.viewport.y, p.viewport.width, p.viewport.height);
        gl.setScissor(p.scissor.x, p.scissor.y, p.scissor.width, p.scissor.height);
        gl.shadowMap.needsUpdate = true;
        gl.render(scene, cam);
        if (shaped) {
          perspective.aspect = aspect;
          perspective.updateProjectionMatrix();
        }
      }
    } finally {
      all.forEach((o, i) => { o.visible = visible[i] ?? true; });
      if (section !== undefined) section.visible = sectionShown;
      gl.setScissorTest(false);
      gl.setViewport(0, 0, size.width, size.height);
    }
  }, 1);
  return null;
}
