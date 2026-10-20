import type { HouseMesh } from '@floorspec/mesh';
import { fitOrbit, orbitBy, panBy, presetOf, zoomBy, PRESETS, type Orbit, type PresetId, type Vec3 } from './camera';
import type { ThreeStore } from './mode';
import { eyeAt, look, NO_INPUT, stepWalker, WALK, type WalkInput, type Walker, type World } from './walk';
import { lensProjection } from './shot/lens';

/**
 * The 3D view's camera and walker between frames (FLR-T-7.5): what pointer, wheel, keys, joystick
 * and the frame loop change, held outside React so a drag or a step re-renders nothing. The orbit
 * is written back to the ThreeStore when a gesture ends, so it outlasts re-meshes, a switch to the
 * plan and back, and a walk.
 */

export const FOV = 45;

/** A camera this controller can drive: three.js's PerspectiveCamera, narrowed to what is used. */
export interface CameraLike {
  position: { set(x: number, y: number, z: number): unknown };
  up: { set(x: number, y: number, z: number): unknown };
  lookAt(x: number, y: number, z: number): void;
  updateMatrixWorld(): void;
  /** A perspective camera's (FLR-T-13.10): its field of view and lens shift; absent on a test double. */
  fov?: number;
  updateProjectionMatrix?(): void;
  setViewOffset?(fullWidth: number, fullHeight: number, x: number, y: number, width: number, height: number): void;
  clearViewOffset?(): void;
  /** An orthographic camera's (the exploded axonometric, FLR-T-14.6): its frustum, metres either side of its axis. */
  isOrthographicCamera?: boolean;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/**
 * Metres the axonometric camera stands back from the orbit's target (FLR-T-14.6): far enough that
 * nothing of a house is behind it, whatever the zoom — an orthographic camera's zoom is its frustum,
 * not where it stands.
 */
export const AXO_STANDOFF = 400;

/** An orthographic frustum that frames at the target what the perspective one does: half its height, metres. */
export const axoHalfHeight = (distance: number, fovDeg: number = FOV): number => distance * Math.tan((fovDeg * Math.PI) / 360);

export class ThreeController {
  orbit: Orbit | null;
  walker: Walker | null = null;
  world: World | null = null;
  mesh: HouseMesh | null = null;
  /** Keys held while walking, by KeyboardEvent.code. */
  readonly keys = new Set<string>();
  /** The touch joystick: x right, y forward, each −1…1. */
  joystick: [number, number] = [0, 0];
  size = { width: 1, height: 1 };
  invalidate: () => void = () => undefined;
  /** Called after every frame that moved the walker (the overlay's minimap and location). */
  onWalk: (() => void) | null = null;
  private commitTimer = 0;

  constructor(readonly three: ThreeStore) {
    this.orbit = three.get().orbit;
  }

  /** Frame a box (metres) from a preset, or from the current preset. */
  fit(box: { min: Vec3; max: Vec3 }, preset: PresetId = this.three.get().preset ?? 'sw'): void {
    this.orbit = fitOrbit(box, preset, FOV, this.size.width / Math.max(1, this.size.height));
    this.commit(preset);
  }

  /**
   * Frame a box again from the way the camera faces now: after the view's shape changes (split, a
   * resized window) — or for a picture of another shape (`aspect`, width over height: a half of
   * Compare's side by side, FLR-T-14.4).
   */
  reframe(box: { min: Vec3; max: Vec3 }, aspect: number = this.size.width / Math.max(1, this.size.height)): void {
    const fitted = fitOrbit(box, 'sw', FOV, aspect);
    this.orbit = this.orbit === null ? fitted : { ...fitted, azimuth: this.orbit.azimuth, elevation: this.orbit.elevation };
    this.commit(this.three.get().preset ?? undefined);
  }

  /** Set when the view changes shape: the next size the canvas reports reframes the house. */
  reframeOnResize = false;

  /** Go to an orbit (FLR-T-13.10: a saved view's camera), as it is: no clamp on its elevation. */
  setOrbit(orbit: Orbit): void {
    this.orbit = orbit;
    this.commit();
  }

  /** Step to a preset view, keeping the target and distance. */
  toPreset(preset: PresetId): void {
    if (this.orbit === null) return;
    const p = PRESETS[preset];
    this.orbit = { ...this.orbit, azimuth: p.azimuth, elevation: p.elevation };
    this.commit(preset);
  }

  rotate(dxPx: number, dyPx: number): void {
    if (this.orbit === null) return;
    this.orbit = orbitBy(this.orbit, -dxPx * 0.008, dyPx * 0.008);
    this.changed();
  }

  pan(dxPx: number, dyPx: number): void {
    if (this.orbit === null) return;
    this.orbit = panBy(this.orbit, dxPx, dyPx, this.size.height, this.lens.fov);
    this.changed();
  }

  zoom(factor: number): void {
    if (this.orbit === null) return;
    this.orbit = zoomBy(this.orbit, factor);
    this.changed();
  }

  /** Orbit by angles (keyboard), radians. */
  orbitBy(dAzimuth: number, dElevation: number): void {
    if (this.orbit === null) return;
    this.orbit = orbitBy(this.orbit, dAzimuth, dElevation);
    this.changed();
  }

  private changed(): void {
    this.invalidate();
    // Written back once the gesture settles: the store's listeners (the view cube's label) re-render then, not on every move.
    window.clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => { this.commit(); }, 120);
  }

  private commit(preset?: PresetId): void {
    window.clearTimeout(this.commitTimer);
    if (this.orbit === null) return;
    this.three.set({ orbit: this.orbit, preset: preset ?? presetOf(this.orbit) });
    this.invalidate();
  }

  // ─── Walking ─────────────────────────────────────────────────────────────────────────────

  /** What the keys and joystick ask for now. */
  input(): WalkInput {
    const k = this.keys;
    const held = (...codes: string[]) => codes.some((c) => k.has(c));
    const forward = (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0) + this.joystick[1];
    const strafe = (held('KeyD') ? 1 : 0) - (held('KeyA') ? 1 : 0) + this.joystick[0];
    const turn = (held('ArrowLeft', 'KeyQ') ? 1 : 0) - (held('ArrowRight', 'KeyE') ? 1 : 0);
    if (forward === 0 && strafe === 0 && turn === 0) return NO_INPUT;
    return { forward: Math.max(-1, Math.min(1, forward)), strafe: Math.max(-1, Math.min(1, strafe)), turn, fast: held('ShiftLeft', 'ShiftRight') };
  }

  /** Look by a number of pixels (a drag or a locked mouse). */
  lookBy(dxPx: number, dyPx: number): void {
    if (this.walker === null) return;
    this.walker = look(this.walker, -dxPx * 0.0035, -dyPx * 0.0035);
    this.invalidate();
  }

  /** Advance one frame and point the camera. */
  frame(camera: CameraLike, dt: number): void {
    camera.up.set(0, 0, 1);
    if (this.three.get().walking && this.walker !== null && this.world !== null) {
      const eye = this.three.get().eyeHeight;
      const before = this.walker;
      this.walker = stepWalker(this.world, this.walker, this.input(), dt, { ...WALK, eye });
      const [x, y, z] = eyeAt(this.walker, eye);
      const c = Math.cos(this.walker.pitch);
      camera.position.set(x, y, z);
      camera.lookAt(x + c * Math.cos(this.walker.yaw), y + c * Math.sin(this.walker.yaw), z + Math.sin(this.walker.pitch));
      camera.updateMatrixWorld();
      this.project(camera, FOV, 0);
      if (before !== this.walker) this.onWalk?.();
      return;
    }
    if (this.orbit === null) return;
    const o = this.orbit;
    const cos = Math.cos(o.elevation);
    if (camera.isOrthographicCamera === true) {
      // The exploded axonometric (FLR-T-14.6): parallel projection along the orbit's line of sight.
      const d = AXO_STANDOFF;
      camera.position.set(o.target[0] + d * cos * Math.cos(o.azimuth), o.target[1] + d * cos * Math.sin(o.azimuth), o.target[2] + d * Math.sin(o.elevation));
      camera.lookAt(o.target[0], o.target[1], o.target[2]);
      camera.updateMatrixWorld();
      const half = axoHalfHeight(o.distance);
      const aspect = this.size.width / Math.max(1, this.size.height);
      if (camera.top !== half || camera.right !== half * aspect) {
        camera.top = half;
        camera.bottom = -half;
        camera.right = half * aspect;
        camera.left = -half * aspect;
        camera.updateProjectionMatrix?.();
      }
      return;
    }
    camera.position.set(o.target[0] + o.distance * cos * Math.cos(o.azimuth), o.target[1] + o.distance * cos * Math.sin(o.azimuth), o.target[2] + o.distance * Math.sin(o.elevation));
    // Through a lens (FLR-T-13.10): its field of view for the frame, looking level and shifted under two-point perspective.
    const shot = this.three.get().shot;
    const lens = shot === null ? null : lensProjection(o, shot, this.size.width, this.size.height);
    const at = lens?.look ?? o.target;
    camera.lookAt(at[0], at[1], at[2]);
    camera.updateMatrixWorld();
    this.project(camera, lens === null ? FOV : lens.fov, lens?.shift ?? 0);
  }

  /** The lens last set, so the projection is made again only when it changes. */
  private lens = { fov: FOV, shift: 0, width: 0, height: 0 };

  private project(camera: CameraLike, fov: number, shift: number): void {
    if (camera.updateProjectionMatrix === undefined) return;
    const { width, height } = this.size;
    const l = this.lens;
    if (l.fov === fov && l.shift === shift && l.width === width && l.height === height && camera.fov === fov) return;
    this.lens = { fov, shift, width, height };
    camera.fov = fov;
    // three.js's view offset is the shift lens: the frustum moved up by `shift` half-heights.
    if (shift === 0) camera.clearViewOffset?.();
    else camera.setViewOffset?.(width, height, 0, (-shift * height) / 2, width, height);
    camera.updateProjectionMatrix();
  }
}
