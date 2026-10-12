import { UNITS_PER_METRE } from '@floorspec/mesh';
import { eyeOf, PRESETS, type Orbit, type PresetId } from '../../camera';
import type { Vec3 } from './sky';

/**
 * Where a GPU still looks from (FLR-T-13.13), in the glTF export's frame — metres, +Y up, Floorspec
 * (x, y, z) at (x, z, −y): the view in the editor, or a named view framed as the worker frames it
 * (render3d/camera.ts `presetCamera`). A room's camera is the export's own (scene.ts `roomCamera`).
 * No three.js here: the 3D view asks for its camera without loading the still.
 */

/** Where a still looks from, in the export's frame. */
export interface StillCamera {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  /** Vertical field of view, degrees. */
  readonly fovY: number;
  readonly near: number;
  /** What it is, in words: "SW iso", "Kitchen (R3) from its doorway D2". */
  readonly label: string;
}

/** Floorspec plan (x, y) and height z, metres, to the export's frame. */
const yUp = (x: number, y: number, z: number): Vec3 => [x, z, -y];

/**
 * The editor's orbit camera (camera.ts, metres relative to the mesh's origin, z up) as a still's,
 * in the export's frame: the view the person is looking at.
 */
export function orbitCamera(orbit: Orbit, origin: readonly [number, number, number], fovY: number): StillCamera {
  const o: Vec3 = [origin[0] / UNITS_PER_METRE, origin[1] / UNITS_PER_METRE, origin[2] / UNITS_PER_METRE];
  const eye = eyeOf(orbit);
  const near = Math.max(0.05, Math.min(0.5, orbit.distance / 200));
  return {
    eye: yUp(eye[0] + o[0], eye[1] + o[1], eye[2] + o[2]),
    target: yUp(orbit.target[0] + o[0], orbit.target[1] + o[1], orbit.target[2] + o[2]),
    // The editor's camera is up = +z (the export's +Y), whatever its elevation (at most 89.5°).
    up: [0, 1, 0],
    fovY,
    near,
    label: 'The view in the editor',
  };
}

/** A named view framing a box: its bounding sphere fills the narrower field of view (the worker's `presetCamera`). */
export function presetCamera(preset: PresetId, box: { min: Vec3; max: Vec3 }, aspect: number): StillCamera {
  const a = PRESETS[preset];
  const fovY = 30;
  const DEG = Math.PI / 180;
  const elevation = preset === 'top' ? 90 * DEG : a.elevation;
  const target: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const radius = Math.max(0.5, Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2);
  const vertical = (fovY * DEG) / 2;
  const horizontal = Math.atan(Math.tan(vertical) * aspect);
  const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.02;
  const c = Math.cos(elevation);
  const dir = yUp(c * Math.cos(a.azimuth), c * Math.sin(a.azimuth), Math.sin(elevation));
  const eye: Vec3 = [target[0] + dir[0] * distance, target[1] + dir[1] * distance, target[2] + dir[2] * distance];
  return { eye, target, up: preset === 'top' ? yUp(0, 1, 0) : [0, 1, 0], fovY, near: Math.max(0.05, distance - radius * 1.5), label: a.label };
}

