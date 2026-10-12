/**
 * What the glTF export writes beyond core glTF (FLR-T-13.13, FLR-ADR-040), so a path tracer — the
 * editor's GPU still, Blender, any glTF consumer — sees the house as the worker's own tracer does:
 *
 * - **KHR_lights_punctual**: the lamps of FS_electrical's luminaires — the scene's `lights`, the
 *   ones @floorspec/mesh's `lightsOf` makes and the path tracer's `lampsOf` shines — each a point
 *   light, or a spot down its cone, in candela: its lumens over the solid angle it fills, as
 *   `lampsOf` spreads them (4π sr, or a cap out to the middle of the cone's edge).
 * - **KHR_materials_transmission** and **KHR_materials_ior**: glass lets light through (a thin pane,
 *   IOR 1.5), rather than only being drawn see-through.
 * - **KHR_materials_emissive_strength**: a luminaire's lens glows as brightly as the path tracer
 *   shows it lit (`LENS_LUMINANCE`), not at the 1.0 a core emissive factor stops at.
 * - **Cameras**: a person standing in each room (render3d/camera.ts `roomCamera`, FLR-T-12.29) —
 *   the view a still or a lit render "in a room" looks from — as a glTF perspective camera.
 *
 * Units are photometric, as KHR_lights_punctual's are: candela for a lamp, and cd/m² for a lens's
 * emissive strength, so the two agree in any renderer that treats glTF's units as physical.
 */
import { roomCamera } from '../../render3d/camera.js';
import type { Scene, SceneLight, SceneMaterial, Vec3 } from './scene.js';

type Json = Record<string, unknown>;

export const KHR_LIGHTS = 'KHR_lights_punctual';
export const KHR_TRANSMISSION = 'KHR_materials_transmission';
export const KHR_IOR = 'KHR_materials_ior';
export const KHR_EMISSIVE_STRENGTH = 'KHR_materials_emissive_strength';

/** A pane of window glass: its index of refraction. */
export const GLASS_IOR = 1.5;

/**
 * How bright a lit lens looks, cd/m²: the path tracer's (pathtrace/index.ts `LENS`, 2.5 of its
 * radiance units of 12 500 cd/m² — about a sunlit white wall's), so a lens in the export glows as it
 * does in the worker's stills.
 */
export const LENS_LUMINANCE = 2.5 * 12_500;

/** Rounded to what a float32 holds, so the JSON carries no false precision. */
const f = (x: number): number => Math.fround(x);

/**
 * A lamp's luminous intensity, candela: its lumens over 4π sr, or for a spot over the cap of its
 * cone out to the middle of the cone's edge — the path tracer's `lampsOf`, without its unit.
 */
export function candelaOf(light: Pick<SceneLight, 'lumens' | 'spot'>): number {
  const sr = light.spot === undefined ? 4 * Math.PI : 2 * Math.PI * (1 - (light.spot.inner + light.spot.outer) / 2);
  return light.lumens / sr;
}

/** A light's colour in glTF's range (each channel at most 1), and how much brighter it is than that. */
function normalized(rgb: readonly [number, number, number]): { color: number[]; scale: number } {
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  if (!(max > 0)) return { color: [1, 1, 1], scale: 0 };
  return { color: rgb.map((c) => f(c / max)), scale: max };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * The unit quaternion (x, y, z, w) that turns a glTF camera or spot — which looks down its −Z, +Y
 * up — to look along `forward` with `up` as near its +Y as it can be.
 */
export function lookRotation(forward: Vec3, up: Vec3 = [0, 1, 0]): [number, number, number, number] {
  const z = unit([-forward[0], -forward[1], -forward[2]]);
  let x = cross(up, z);
  // Looking straight along `up`: any right will do; north (−Z) is up the picture.
  if (Math.hypot(x[0], x[1], x[2]) < 1e-9) x = cross([0, 0, -1], z);
  x = unit(x);
  const y = cross(z, x);
  // The rotation matrix's columns are x, y, z; its quaternion, by the largest diagonal.
  const [m00, m11, m22] = [x[0], y[1], z[2]];
  const trace = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(y[2] - z[1]) * s, (z[0] - x[2]) * s, (x[1] - y[0]) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s];
  }
  const l = Math.hypot(...q);
  return q.map((c) => c / l) as [number, number, number, number];
}

/** The widest a spot's cone may be written, radians: just inside glTF's right angle. */
const RIGHT_ANGLE = Math.PI / 2 - 1e-5;

/** One lamp as a KHR_lights_punctual light. */
function lightJson(l: SceneLight): Json {
  const { color, scale } = normalized(l.color);
  const extras = { floorspec: { id: l.id, fixture: l.fixture, radius: f(l.radius), lumens: f(l.lumens) } };
  const intensity = f(candelaOf(l) * scale);
  if (l.spot === undefined) return { name: l.id, type: 'point', color, intensity, extras };
  // Cosines to angles, inner strictly inside outer and both within a right angle (as glTF requires):
  // a ceiling light's dome, which shines a little past the horizontal (FLR-T-13.16), is written out to
  // the right angle, a hair inside it so a 32-bit reader does not round it past.
  const outer = Math.min(RIGHT_ANGLE, Math.acos(Math.max(-1, Math.min(1, l.spot.outer))));
  const inner = Math.min(Math.acos(Math.max(-1, Math.min(1, l.spot.inner))), outer * 0.999);
  return { name: l.id, type: 'spot', color, intensity, spot: { innerConeAngle: f(Math.max(0, inner)), outerConeAngle: f(outer) }, extras };
}

export interface PunctualParts {
  /** The `KHR_lights_punctual` extension's light definitions, in the scene's order. */
  readonly lights: Json[];
  /** The perspective cameras, in the scene's room order. */
  readonly cameras: Json[];
  /**
   * The nodes that place them: a lamp's under its luminaire's node, a camera under its room's — by
   * that element's ID, with the level it is on for an element the export has no node for.
   */
  readonly nodes: Map<string, { readonly level: string; readonly nodes: Json[] }>;
}

/** The lamps and the room cameras of a scene, as glTF lights, cameras and the nodes that place them. */
export function punctualParts(scene: Scene): PunctualParts {
  const lights: Json[] = [];
  const cameras: Json[] = [];
  const nodes = new Map<string, { level: string; nodes: Json[] }>();
  const add = (element: string, level: string, node: Json): void => {
    const entry = nodes.get(element) ?? { level, nodes: [] };
    entry.nodes.push(node);
    nodes.set(element, entry);
  };
  const levels = new Set(scene.levels.map((l) => l.id));
  for (const l of scene.lights) {
    if (!levels.has(l.level) || !(l.lumens > 0)) continue;
    lights.push(lightJson(l));
    add(l.id, l.level, {
      name: `${l.id} light`,
      translation: l.position.map(f),
      ...(l.spot === undefined ? {} : { rotation: lookRotation(l.spot.dir, [0, 0, -1]).map(f) }),
      extensions: { [KHR_LIGHTS]: { light: lights.length - 1 } },
      // The light's own facts again: a loader that makes the node the light (three.js's) keeps the node's extras.
      extras: { floorspec: { id: l.id, kind: 'light', fixture: l.fixture, level: l.level, room: l.room, radius: f(l.radius) } },
    });
  }
  for (const room of scene.rooms) {
    if (!levels.has(room.level)) continue;
    const c = roomCamera(room, scene.doors, scene.obstacles);
    cameras.push({ name: c.label, type: 'perspective', perspective: { yfov: f((c.fovY * Math.PI) / 180), znear: f(c.near) }, extras: { floorspec: { room: room.id, label: c.label } } });
    add(room.id, room.level, {
      name: `${room.id} camera`,
      translation: c.eye.map(f),
      rotation: lookRotation(sub(c.target, c.eye), c.up).map(f),
      camera: cameras.length - 1,
      extras: { floorspec: { id: room.id, kind: 'camera', level: room.level, room: room.id, label: c.label } },
    });
  }
  return { lights, cameras, nodes };
}

/** The extensions a material needs beyond core glTF: glass's transmission and IOR, a lens's strength. */
export function materialExtensions(m: SceneMaterial): { extensions: Json; emissiveFactor?: number[] } {
  const extensions: Json = {};
  if (m.blend) {
    extensions[KHR_TRANSMISSION] = { transmissionFactor: 1 };
    extensions[KHR_IOR] = { ior: GLASS_IOR };
  }
  if (m.emissive === undefined) return { extensions };
  const { color, scale } = normalized(m.emissive);
  if (scale === 0) return { extensions };
  extensions[KHR_EMISSIVE_STRENGTH] = { emissiveStrength: f(LENS_LUMINANCE * scale) };
  return { extensions, emissiveFactor: color };
}
