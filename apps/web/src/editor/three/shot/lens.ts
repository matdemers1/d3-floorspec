import { ASPECT_RATIOS, lensTangents, type Aspect, type SavedView } from '@floorspec/mesh';
import { eyeOf, type Orbit, type Vec3 } from '../camera';
import type { Shot } from '../mode';

/**
 * The 3D view through a lens (FLR-T-13.10): what the editor's three.js camera is set to so that the
 * frame drawn over the view shows exactly what a saved view's still shows — kept out of three.js so
 * it can be tested. The frame is the picture's shape fitted inside the canvas; the canvas's field of
 * view is the lens's, widened by how much bigger the canvas is than the frame; two-point perspective
 * looks level and shifts the lens (three.js's view offset) so the orbit's target stays in the middle.
 */

/** The gap kept round the frame, CSS pixels. */
export const FRAME_MARGIN = 24;

/** The frame: the picture's shape, as large as fits inside the canvas less a margin, centred. */
export function frameRect(width: number, height: number, aspect: Aspect, margin = FRAME_MARGIN): { x: number; y: number; width: number; height: number } {
  const a = ASPECT_RATIOS[aspect];
  const w = Math.max(1, width - 2 * margin);
  const h = Math.max(1, height - 2 * margin);
  const [fw, fh] = w / h > a ? [h * a, h] : [w, w / a];
  return { x: (width - fw) / 2, y: (height - fh) / 2, width: fw, height: fh };
}

export interface LensProjection {
  /** The canvas's vertical field of view, degrees. */
  readonly fov: number;
  /** Where the camera looks: the target, or under two-point perspective the target brought level with the eye. */
  readonly look: Vec3;
  /** The lens shift in the canvas's half-heights (three.js's view offset is −shift × height / 2). */
  readonly shift: number;
}

/** How the three.js camera is set for an orbit seen through a lens, on a canvas of this size. */
export function lensProjection(orbit: Orbit, shot: Shot, width: number, height: number): LensProjection {
  const frame = frameRect(width, height, shot.aspect);
  const { tanY } = lensTangents(shot.focalLength, ASPECT_RATIOS[shot.aspect]);
  // The canvas is the frame grown by the margin round it: the same lens, seen wider.
  const canvasTan = tanY * (height / frame.height);
  const eye = eyeOf(orbit);
  const t = orbit.target;
  const flat = Math.hypot(t[0] - eye[0], t[1] - eye[1]);
  const rise = t[2] - eye[2];
  const shifting = shot.twoPoint && flat > 1e-6 && Math.abs(rise / flat) < 20;
  return {
    fov: (2 * Math.atan(canvasTan) * 180) / Math.PI,
    look: shifting ? [t[0], t[1], eye[2]] : t,
    // In the frame's half-heights the target is at rise / flat / tanY; the canvas's are frame.height / height of those.
    shift: shifting ? (rise / flat / tanY) * (frame.height / height) : 0,
  };
}

/** A saved view's eye and target (metres about the mesh's origin) as the orbit camera that sees them. */
export function orbitOfView(eye: readonly [number, number, number], target: readonly [number, number, number]): Orbit {
  const d: Vec3 = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]];
  const distance = Math.max(0.5, Math.hypot(d[0], d[1], d[2]));
  return { target: [target[0], target[1], target[2]], azimuth: Math.atan2(d[1], d[0]), elevation: Math.asin(Math.max(-1, Math.min(1, d[2] / distance))), distance };
}

/** The lens and frame of a saved view, as the 3D view keeps them. */
export function shotOfView(view: SavedView): Shot {
  return {
    focalLength: view.focalLength,
    twoPoint: view.twoPoint,
    aperture: view.aperture ?? 'f/2.8',
    dof: view.aperture !== undefined,
    focus: view.focus === undefined ? null : view.focus / 1_280_000,
    exposure: view.exposure,
    aspect: view.aspect,
    guides: true,
  };
}

/** A focal length's place on the panel's log slider, 0–1, between 12 and 200 mm — and back. */
export const FOCAL_SLIDER = { min: 12, max: 200 } as const;
export const focalToSlider = (mm: number): number => Math.log(mm / FOCAL_SLIDER.min) / Math.log(FOCAL_SLIDER.max / FOCAL_SLIDER.min);
export const sliderToFocal = (t: number): number => Math.round(FOCAL_SLIDER.min * (FOCAL_SLIDER.max / FOCAL_SLIDER.min) ** Math.max(0, Math.min(1, t)));

/** The focus slider: 0.3 m to 100 m on a log scale. */
export const FOCUS_SLIDER = { min: 0.3, max: 100 } as const;
export const focusToSlider = (m: number): number => Math.log(m / FOCUS_SLIDER.min) / Math.log(FOCUS_SLIDER.max / FOCUS_SLIDER.min);
export const sliderToFocus = (t: number): number => Math.round(FOCUS_SLIDER.min * (FOCUS_SLIDER.max / FOCUS_SLIDER.min) ** Math.max(0, Math.min(1, t)) * 10) / 10;
