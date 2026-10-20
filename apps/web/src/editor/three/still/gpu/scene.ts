import {
  Box3,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  Path,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  type SpotLight,
  SRGBColorSpace,
  UnsignedByteType,
  LinearMipmapLinearFilter,
  Vector2,
  Vector3,
  type Light,
  type Material,
  type Object3D,
} from 'three';
import { PhysicalCamera } from 'three-gpu-pathtracer';
import type { StillCamera } from './cameras';
import { GRASS_TILE, grassTexture, type SkyField } from '@floorspec/mesh/sky';
import { skyPixels, stillSun, TRACE_UNIT, type Vec3 } from './sky';

export { orbitCamera, presetCamera, type StillCamera } from './cameras';

/**
 * The scene a GPU still traces (FLR-T-13.13, FLR-ADR-040), built from what the glTF export writes —
 * the same file Blender gets — and nothing the export does not know: its meshes and PBR materials,
 * its KHR_lights_punctual lamps (candela), its glass (KHR_materials_transmission + ior), its lit
 * lenses (KHR_materials_emissive_strength, cd/m²) and its room cameras; then the sky every view
 * shares (@floorspec/mesh's, FLR-T-13.4) — its sun, its HDRI dome — and the lawn (sky.ts). Plain three.js, no renderer: the tracer (tracer.ts) is the only
 * module that knows a GPU is involved, and this one is tested without one.
 *
 * Everything is in the export's frame: metres, +Y up, Floorspec (x, y, z) at (x, z, −y).
 */

export interface StillLighting {
  /** The luminaires' lamps lit, their lenses glowing; or dark. */
  readonly lights: boolean;
  /** The sky (FLR-T-13.4): @floorspec/mesh's preset with its sun, true north and maps — the worker tracer's. */
  readonly sky: SkyField;
  /** The sky map's width, texels (its height is half): 1024 by default. */
  readonly skyWidth?: number;
}

/** The lawn's tile as an sRGB texture (FLR-T-13.4). */
function lawnTexture(): DataTexture {
  const g = grassTexture();
  const n = g.width * g.height;
  const data = new Uint8Array(4 * n);
  const enc = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.min(1, c) ** (1 / 2.4) - 0.055));
  for (let i = 0; i < n; i++) {
    const from = 3 * ((g.height - 1 - Math.floor(i / g.width)) * g.width + (i % g.width));
    data[4 * i] = enc(g.data[from] ?? 0);
    data[4 * i + 1] = enc(g.data[from + 1] ?? 0);
    data[4 * i + 2] = enc(g.data[from + 2] ?? 0);
    data[4 * i + 3] = 255;
  }
  const t = new DataTexture(data, g.width, g.height, RGBAFormat, UnsignedByteType);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** The parts a cutaway leaves off the level it cuts at, as the editor's 3D view does. */
const CUT_PARTS = new Set(['ceiling', 'roof', 'roofGable']);
/** The parts the whole house leaves off with its roofs hidden. */
const ROOF_PARTS = new Set(['roof', 'roofGable']);

const floorspecOf = (o: { userData: Record<string, unknown> }): Record<string, unknown> | undefined => {
  const f = o.userData['floorspec'];
  return typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : undefined;
};

/** The camera the export stands in a room (its `extras.floorspec.room`), as a still's. */
export function roomCamera(cameras: readonly PerspectiveCamera[], room: string): StillCamera | null {
  const camera = cameras.find((c) => floorspecOf(c)?.['room'] === room);
  if (camera === undefined) return null;
  camera.updateWorldMatrix(true, false);
  const eye = new Vector3().setFromMatrixPosition(camera.matrixWorld);
  const forward = new Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
  const up = new Vector3(0, 1, 0).transformDirection(camera.matrixWorld);
  const label = floorspecOf(camera)?.['label'];
  return {
    eye: eye.toArray(),
    target: eye.clone().add(forward).toArray(),
    up: up.toArray(),
    fovY: camera.fov,
    near: Math.max(0.01, camera.near),
    label: typeof label === 'string' ? label : camera.name,
  };
}

export interface PreparedHouse {
  /** Lamps lit (0 with the lights off). */
  readonly lamps: number;
  readonly glass: number;
  readonly lenses: number;
  /** Meshes of the luminaires whose lamps are lit: what no lamp's shadow ray stops at. */
  readonly fixtures: number;
  /** Of what is drawn, metres; null when nothing is. */
  readonly bounds: StillBounds | null;
}

/**
 * What is drawn, metres (+Y up), and — FLR-T-15.2 — where its ground lies: under everything but a
 * sunken pool (FS_outdoor), whose floor is not the ground; and each sunken pool's outline in plan,
 * `[x, z]` world, which the ground plate opens for.
 */
export interface StillBounds {
  min: Vec3;
  max: Vec3;
  ground?: number;
  holes?: [number, number][][];
}

/** The convex hull of points, counter-clockwise (Andrew's monotone chain). */
function hull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] ?? q, lower[lower.length - 1] ?? q, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2] ?? q, upper[upper.length - 1] ?? q, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The levels of an exported house, lowest first, by their nodes' `extras.floorspec`. */
function levelsOf(root: Object3D): { id: string; node: Object3D }[] {
  const out: { id: string; node: Object3D }[] = [];
  root.traverse((o) => {
    const f = floorspecOf(o);
    if (f?.['kind'] === 'level' && typeof f['id'] === 'string') out.push({ id: f['id'], node: o });
  });
  return out;
}

const materialsOf = (m: Material | Material[]): Material[] => (Array.isArray(m) ? m : [m]);

/** What one face of glass of index `ior` reflects, face on. */
const faceReflectance = (ior: number): number => ((ior - 1) / (ior + 1)) ** 2;

/**
 * The index of refraction a thin pane is traced with, for glass of index `ior` (FLR-T-13.18).
 * three-gpu-pathtracer's thin wall reflects as one face does — 4% face on at 1.5 — where a pane has
 * two, and the light between them: about 7.7% (@floorspec/mesh glass.ts, the worker tracer's
 * `thinPane`). Traced at the index whose one face reflects what the pane's two do, a window at night
 * shows the lit room in it as brightly as the worker's.
 */
export function paneIor(ior: number): number {
  const face = faceReflectance(ior);
  const pane = Math.sqrt((2 * face) / (1 + face));
  return (1 + pane) / (1 - pane);
}

/**
 * How much a pane's colour is raised when it is traced at `paneIor`: by what the stronger reflection
 * takes from what it lets through face on, so the light it lets through is what it was before the
 * index changed. Lowered by it, the GPU still's rooms under an overcast sky — already a fifth of a stop
 * under the worker's, measured by apps/worker/test/gpu-parity.test.ts — lost another eighth.
 */
export const paneGain = (ior: number): number => (1 - faceReflectance(ior)) / (1 - faceReflectance(paneIor(ior)));

/**
 * Where three-gpu-pathtracer samples a spot light: on a disc of the lamp's radius, `radius / tan(cone)`
 * ahead of the light along its axis — the cross-section of a cone whose apex is the light. The
 * distance a lamp is set back so that disc is the lamp (FLR-T-13.18).
 */
export const spotSetback = (radius: number, angle: number): number => radius / Math.max(Math.tan(angle), 1e-6);

/**
 * Make an exported house ready to trace, in place: its lamps lit or taken out, its lenses glowing or
 * dark, its glass a thin clear pane, and — for a cutaway at `cut` — the levels above it gone and its
 * own ceilings and roofs left off; with `roofs: false`, every roof left off, as the 3D view's roof
 * toggle does. A level shown alone (FLR-T-13.2) is an export of that level only, cut the same way.
 *
 * As the worker's path tracer traces a house (FLR-T-13.18, lighting.md "A fixture never shadows
 * itself"):
 * - every surface is seen from both sides — glTF's single-sided faces, a gable from inside, would
 *   let the sky in from behind;
 * - no piece of a lit luminaire — canopy, trim, shade, lens — stands in a lamp's way
 *   (three-gpu-pathtracer's `visibleToShadowRays`, which the sun's shadow rays pass too), as the
 *   editor leaves them out of its shadow maps;
 * - a spot lamp is set back along its axis by `spotSetback`, so the disc the tracer samples is the
 *   lamp where the export puts it, not that far ahead of it.
 */
export function prepareHouse(root: Object3D, options: { lights: boolean; cut?: string | null; roofs?: boolean }): PreparedHouse {
  const levels = levelsOf(root);
  if (options.roofs === false)
    root.traverse((o) => {
      if (o instanceof Mesh && ROOF_PARTS.has(String(floorspecOf((o as Mesh).geometry)?.['part']))) o.visible = false;
    });
  const at = options.cut === undefined || options.cut === null ? -1 : levels.findIndex((l) => l.id === options.cut);
  const cutLevel = levels[at];
  if (cutLevel !== undefined) {
    for (const l of levels.slice(at + 1)) l.node.visible = false;
    cutLevel.node.traverse((o) => {
      if (o instanceof Mesh && CUT_PARTS.has(String(floorspecOf((o as Mesh).geometry)?.['part']))) o.visible = false;
    });
  }
  const lights: Light[] = [];
  const seen = new Set<Material>();
  /** Glass, as the tracer gets it: a fresh physical material in place of the loader's blended one. */
  const panes = new Map<Material, MeshPhysicalMaterial>();
  let glass = 0;
  let lenses = 0;
  root.traverse((o) => {
    if ((o as Partial<Light>).isLight) lights.push(o as Light);
    if (!(o instanceof Mesh)) return;
    for (const m of materialsOf(o.material as Material | Material[])) {
      if (seen.has(m)) continue;
      seen.add(m);
      const physical = m as Material & { transmission?: number; ior?: number; color?: Color; emissiveIntensity?: number; emissive?: Color };
      if ((physical.transmission ?? 0) > 0) {
        // A thin pane (no KHR_materials_volume): clear, its tint light — the glTF's colour is the
        // see-through look a viewer without transmission draws (FLR-T-13.7 finishes the optics).
        // Made afresh: the loader's material carries its blended, depth-less fallback look.
        glass++;
        panes.set(
          m,
          new MeshPhysicalMaterial({
            name: m.name,
            color: (physical.color ?? new Color(1, 1, 1))
              .clone()
              .lerp(new Color(1, 1, 1), 0.75)
              .multiplyScalar(paneGain(physical.ior ?? 1.5)),
            roughness: 0,
            metalness: 0,
            transmission: physical.transmission ?? 1,
            ior: paneIor(physical.ior ?? 1.5),
            thickness: 0,
            side: DoubleSide,
          }),
        );
      } else if ((physical.emissiveIntensity ?? 0) > 1 && physical.emissive !== undefined && physical.emissive.getHex() !== 0) {
        // A lens (KHR_materials_emissive_strength): lit with its lamp, dark without.
        lenses++;
        if (!options.lights) physical.emissiveIntensity = 0;
      }
      // Seen from both sides, as the worker's tracer sees every triangle.
      m.side = DoubleSide;
    }
  });
  if (panes.size > 0)
    root.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const mesh = o as Mesh;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => panes.get(m) ?? m) : (panes.get(mesh.material) ?? mesh.material);
    });
  let lamps = 0;
  /** The luminaires whose lamps are lit: the element node a lamp hangs under (its `extras.floorspec.id` is the lamp's). */
  const lit = new Set<Object3D>();
  for (const light of lights) {
    // Hidden with its level, or the lights off: out of the scene, so the tracer gathers none of it.
    let shown = options.lights;
    for (let p: Object3D | null = light; p !== null && shown; p = p.parent) if (!p.visible) shown = false;
    if (!shown) {
      light.removeFromParent();
      continue;
    }
    const lamp = light as Light & { decay?: number; distance?: number; radius?: number; isSpotLight?: boolean };
    lamp.decay = 2;
    lamp.distance = 0;
    const radius = floorspecOf(light)?.['radius'];
    if (lamp.isSpotLight === true && typeof radius === 'number') {
      lamp.radius = radius;
      const spot = light as unknown as SpotLight;
      if (light.userData['setBack'] !== true) {
        light.position.addScaledVector(new Vector3(0, 0, -1).applyQuaternion(light.quaternion), -spotSetback(radius, spot.angle));
        light.userData['setBack'] = true;
      }
    }
    const id = floorspecOf(light)?.['id'];
    for (let p = light.parent; p !== null; p = p.parent) {
      const f = floorspecOf(p);
      if (f?.['id'] === id && f?.['kind'] !== 'light') {
        lit.add(p);
        break;
      }
    }
    lamps++;
  }
  // A lit luminaire's own pieces never stand in a lamp's way: the tracer's shadow rays pass a mesh
  // marked so (three-gpu-pathtracer's per-object flag), and a brass knob elsewhere sharing their
  // material still shadows.
  let fixtures = 0;
  for (const fixture of lit)
    fixture.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.visibleToShadowRays = false;
      fixtures++;
    });
  root.updateMatrixWorld(true);
  const box = new Box3();
  // FLR-T-15.2: everything but FS_outdoor's pools sets the ground; a pool below it is a hole in it.
  const rest = new Box3();
  const pools = new Map<Object3D, { box: Box3; xz: [number, number][] }>();
  const v = new Vector3();
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    for (let p: Object3D | null = o; p !== null; p = p.parent) if (!p.visible) return;
    box.expandByObject(o);
    let pool: Object3D | null = null;
    for (let p: Object3D | null = o; p !== null && pool === null; p = p.parent) {
      const f = floorspecOf(p);
      if (f?.['extension'] === 'FS_outdoor' && f['collection'] === 'pools') pool = p;
    }
    if (pool === null) {
      rest.expandByObject(o);
      return;
    }
    const entry = pools.get(pool) ?? { box: new Box3(), xz: [] };
    entry.box.expandByObject(o);
    const pos = (o as Mesh).geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      entry.xz.push([v.x, v.z]);
    }
    pools.set(pool, entry);
  });
  if (box.isEmpty()) return { lamps, glass, lenses, fixtures, bounds: null };
  const ground = rest.isEmpty() ? box.min.y : rest.min.y;
  const holes = [...pools.values()].filter((p) => p.box.min.y < ground - 1e-3).map((p) => hull(p.xz));
  return { lamps, glass, lenses, fixtures, bounds: { min: box.min.toArray(), max: box.max.toArray(), ground, ...(holes.length === 0 ? {} : { holes }) } };
}

/**
 * The scene a still traces: the prepared house on the worker's ground plate, under its sun (by day)
 * and its sky — an equirectangular map the tracer samples, which is also what the windows show.
 *
 * Traced in the worker tracer's units, not in lux and cd/m²: every light — sun, sky, lamps, lit
 * lenses — over `TRACE_UNIT`, so radiance is of order 1, where the tracer's firefly clamps are set
 * (an indirect path's at 10). In cd/m² the clamp would cut the daylight that comes in through the
 * windows to nothing. The tracer exposes the picture back in cd/m² (tracer.ts).
 */
export function stillScene(house: Object3D, bounds: StillBounds | null, lighting: StillLighting): { scene: Scene; dispose: () => void } {
  const scene = new Scene();
  house.traverse((o) => {
    const light = o as Partial<Light>;
    if (light.isLight === true && typeof light.intensity === 'number' && o.userData['traceUnit'] !== true) {
      light.intensity /= TRACE_UNIT;
      o.userData['traceUnit'] = true;
    }
    if (!(o instanceof Mesh)) return;
    for (const m of materialsOf(o.material as Material | Material[])) {
      const lit = m as Material & { emissiveIntensity?: number; userData: { traceUnit?: true } };
      if (lit.emissiveIntensity === undefined || lit.userData.traceUnit === true) continue;
      lit.emissiveIntensity /= TRACE_UNIT;
      lit.userData.traceUnit = true;
    }
  });
  scene.add(house);
  const sun = stillSun(lighting.sky.light);
  const sw = lighting.skyWidth ?? 1024;
  const sky = new DataTexture(skyPixels(lighting.sky, sw, sw / 2).map((v, i) => (i % 4 === 3 ? 1 : v / TRACE_UNIT)), sw, sw / 2, RGBAFormat, FloatType);
  sky.mapping = EquirectangularReflectionMapping;
  sky.magFilter = LinearFilter;
  sky.minFilter = LinearFilter;
  sky.generateMipmaps = false;
  sky.needsUpdate = true;
  scene.environment = sky;
  scene.background = sky;
  const disposables: { dispose: () => void }[] = [sky];
  if (bounds !== null) {
    // The ground under the house, out toward the horizon: the lawn at true scale (a tile every
    // GRASS_TILE metres), or the studio's floor, or light snow.
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    const r = 40 * Math.max(5, Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]));
    const y = (bounds.ground ?? bounds.min[1]) - 0.003;
    // FLR-T-15.2: the plate opens over a sunken pool — a shape with a hole for each, its UVs in metres.
    const holes = bounds.holes ?? [];
    const plate = (): ShapeGeometry => {
      // the plate is laid flat by turning it a quarter about x: its local (x, y) is the world's (x − cx, cz − z)
      const shape = new Shape([new Vector2(-r, -r), new Vector2(r, -r), new Vector2(r, r), new Vector2(-r, r)]);
      for (const h of holes) shape.holes.push(new Path(h.map(([x, z]) => new Vector2(x - cx, cz - z))));
      const g = new ShapeGeometry(shape);
      const uv = g.getAttribute('uv');
      // ShapeGeometry's UVs are its local coordinates: shifted to 0 … 2r, as the plane's run 0 … 1
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + r) / (2 * r), (uv.getY(i) + r) / (2 * r));
      return g;
    };
    const geometry = holes.length === 0 ? new PlaneGeometry(2 * r, 2 * r) : plate();
    const floor = lighting.sky.light.ground;
    const map = floor.grass ? lawnTexture() : null;
    if (map !== null) {
      map.repeat.set((2 * r) / GRASS_TILE, (2 * r) / GRASS_TILE);
      disposables.push(map);
    }
    // FLR-T-15.4: the lawn in its season and wet in the rain (a tint on the grass), or a field of light snow.
    const material = new MeshStandardMaterial({ color: map === null ? new Color(...floor.albedo) : new Color(...floor.tint), map, roughness: 1, metalness: 0 });
    const ground = new Mesh(geometry, material);
    ground.name = 'ground';
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, y, cz);
    scene.add(ground);
    disposables.push(geometry, material);
  }
  if (sun !== null) {
    const light = new DirectionalLight(new Color(...sun.color), sun.lux / TRACE_UNIT);
    light.name = 'sun';
    const target = bounds === null ? new Vector3() : new Vector3((bounds.min[0] + bounds.max[0]) / 2, bounds.ground ?? bounds.min[1], (bounds.min[2] + bounds.max[2]) / 2);
    light.position.copy(target).addScaledVector(new Vector3(...sun.dir), 100);
    light.target.position.copy(target);
    scene.add(light, light.target);
  }
  scene.updateMatrixWorld(true);
  return { scene, dispose: () => { for (const d of disposables) d.dispose(); } };
}

/** A still camera as three.js's, for a picture of this aspect. */
export function perspectiveOf(c: StillCamera, aspect: number): PerspectiveCamera {
  // A thin lens (FLR-T-13.10): three-gpu-pathtracer's physical camera, its film the 36 mm a focal length is given on — so its
  // aperture is the focal length over the f-number, and its plane in focus is across the line of sight, as the CPU tracer's.
  const camera = c.lens === undefined ? new PerspectiveCamera(c.fovY, aspect, c.near, 5000) : Object.assign(new PhysicalCamera(c.fovY, aspect, c.near, 5000), { filmGauge: 36, fStop: c.lens.fNumber, focusDistance: c.lens.focus, apertureBlades: 0 });
  // A shift lens (two-point perspective): three.js's view offset moves the frustum up by `shift` half-heights.
  if (c.shift !== undefined && c.shift !== 0) camera.setViewOffset(aspect, 1, 0, -c.shift / 2, aspect, 1);
  camera.position.set(...c.eye);
  camera.up.set(...c.up);
  camera.lookAt(...c.target);
  camera.updateMatrixWorld(true);
  return camera;
}
