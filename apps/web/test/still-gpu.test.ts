/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { describe, expect, it } from 'vitest';
import { DirectionalLight, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, PointLight, SpotLight, Vector3, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EXPOSURE_PER_NIT, UNITS_PER_METRE } from '@floorspec/mesh';
import { toneMappingExposure as viewToneMappingExposure } from '../src/editor/three/lights';
import { eyeOf, PRESETS, type Orbit } from '../src/editor/three/camera';
import { orbitCamera, presetCamera } from '../src/editor/three/still/gpu/cameras';
import { perspectiveOf, prepareHouse, roomCamera, stillScene } from '../src/editor/three/still/gpu/scene';
import { EXPOSURE_BAND, LUX_PER_UNIT, TRACE_UNIT, meteredExposure, skyPixels, stillSun, toneMappingExposure } from '../src/editor/three/still/gpu/sky';
import { skyField, skyLight, skyMapOf, type SkyMaps } from '@floorspec/mesh/sky';

/**
 * FLR-T-13.13: the scene a GPU still traces, built from a glTF export as the worker writes one —
 * its lamps (KHR_lights_punctual), glass (KHR_materials_transmission + ior), lit lenses
 * (KHR_materials_emissive_strength), room cameras and parts — read by three's own GLTFLoader, with
 * no GPU. The tracer itself (gpu/tracer.ts) needs WebGPU and is not tested here; its output is not
 * hash-tested anywhere (FLR-ADR-040: repeatable per machine, not across machines).
 */

type Json = Record<string, unknown>;

/** A quad, 1 m on a side, in the XZ plane at height y. */
function quad(y: number): { positions: Float32Array; normals: Float32Array; indices: Uint16Array } {
  return {
    positions: new Float32Array([0, y, 0, 1, y, 0, 1, y, -1, 0, y, -1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

/**
 * A two-level house as the glTF export writes it (apps/worker/src/export/gltf/glb.ts): a floor and a
 * ceiling on L1, a roof on L2, a window pane, a lens, a recessed spot and a pendant's point lamp,
 * and a camera standing in room R1.
 */
function exportedHouse(): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const views: Json[] = [];
  const accessors: Json[] = [];
  const view = (a: Float32Array | Uint16Array, target: number): number => {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength, target });
    chunks.push(bytes);
    length += bytes.byteLength;
    const pad = (4 - (length % 4)) % 4;
    if (pad > 0) {
      chunks.push(new Uint8Array(pad));
      length += pad;
    }
    return views.length - 1;
  };
  const primitive = (y: number, material: number, part: string): Json => {
    const q = quad(y);
    const position = accessors.push({ bufferView: view(q.positions, 34962), componentType: 5126, count: 4, type: 'VEC3', min: [0, y, -1], max: [1, y, 0] }) - 1;
    const normal = accessors.push({ bufferView: view(q.normals, 34962), componentType: 5126, count: 4, type: 'VEC3' }) - 1;
    const indices = accessors.push({ bufferView: view(q.indices, 34963), componentType: 5123, count: 6, type: 'SCALAR' }) - 1;
    return { attributes: { POSITION: position, NORMAL: normal }, indices, material, mode: 4, extras: { floorspec: { part } } };
  };
  const meshes = [
    { name: 'R1', primitives: [primitive(0, 0, 'floor'), primitive(2.7, 0, 'ceiling')] },
    { name: 'RF1', primitives: [primitive(5.5, 0, 'roof')] },
    { name: 'O1', primitives: [primitive(1.2, 1, 'opening')] },
    { name: 'X1', primitives: [primitive(2.5, 2, 'extension')] },
  ];
  const json: Json = {
    asset: { version: '2.0', generator: 'test' },
    extensionsUsed: ['KHR_lights_punctual', 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_transmission'],
    extensions: {
      KHR_lights_punctual: {
        lights: [
          { name: 'X1', type: 'spot', color: [1, 0.9, 0.8], intensity: 120, spot: { innerConeAngle: 0.5, outerConeAngle: 0.7 }, extras: { floorspec: { id: 'X1', radius: 0.03 } } },
          { name: 'X2', type: 'point', color: [1, 0.9, 0.8], intensity: 60, extras: { floorspec: { id: 'X2', radius: 0.02 } } },
          { name: 'X3', type: 'point', color: [1, 1, 1], intensity: 60, extras: { floorspec: { id: 'X3', radius: 0.02 } } },
        ],
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'House', children: [1, 2], extras: { floorspec: { kind: 'model' } } },
      { name: 'L1', children: [3, 4, 5], extras: { floorspec: { id: 'L1', kind: 'level' } } },
      { name: 'L2', children: [8, 9], extras: { floorspec: { id: 'L2', kind: 'level' } } },
      { name: 'R1', mesh: 0, children: [6], extras: { floorspec: { id: 'R1', kind: 'room', level: 'L1' } } },
      { name: 'O1', mesh: 2, extras: { floorspec: { id: 'O1', kind: 'opening', level: 'L1' } } },
      { name: 'X1', mesh: 3, children: [7, 10], extras: { floorspec: { id: 'X1', kind: 'extension', level: 'L1' } } },
      { name: 'R1 camera', camera: 0, translation: [0.5, 1.6, 0], rotation: [0, 0, 0, 1], extras: { floorspec: { id: 'R1', kind: 'camera', level: 'L1', room: 'R1', label: 'Living room (R1) from its doorway D1' } } },
      { name: 'X1 light', translation: [0.5, 2.4, -0.5], rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], extensions: { KHR_lights_punctual: { light: 0 } }, extras: { floorspec: { id: 'X1', kind: 'light', radius: 0.03 } } },
      { name: 'RF1', mesh: 1, extras: { floorspec: { id: 'RF1', kind: 'roof', level: 'L2' } } },
      { name: 'X3 light', translation: [0.5, 5, -0.5], extensions: { KHR_lights_punctual: { light: 2 } } },
      { name: 'X2 light', translation: [0.2, 2.2, -0.2], extensions: { KHR_lights_punctual: { light: 1 } } },
    ],
    cameras: [{ name: 'Living room (R1) from its doorway D1', type: 'perspective', perspective: { yfov: (68 * Math.PI) / 180, znear: 0.05 }, extras: { floorspec: { room: 'R1', label: 'Living room (R1) from its doorway D1' } } }],
    meshes,
    materials: [
      { name: 'Paint', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
      {
        name: 'Default glass',
        pbrMetallicRoughness: { baseColorFactor: [0.5, 0.67, 0.76, 0.35], metallicFactor: 0, roughnessFactor: 0.05 },
        alphaMode: 'BLEND',
        doubleSided: true,
        extensions: { KHR_materials_transmission: { transmissionFactor: 1 }, KHR_materials_ior: { ior: 1.5 } },
      },
      { name: 'Lens', pbrMetallicRoughness: { baseColorFactor: [1, 0.92, 0.72, 1] }, emissiveFactor: [1, 0.92, 0.72], extensions: { KHR_materials_emissive_strength: { emissiveStrength: 31250 } }, extras: { floorspec: { role: 'lens' } } },
    ],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: length }],
  };
  const bin = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.byteLength;
  }
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jl = text.byteLength + ((4 - (text.byteLength % 4)) % 4);
  const out = new Uint8Array(12 + 8 + jl + 8 + bin.byteLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.byteLength, true);
  v.setUint32(12, jl, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.byteLength, 20 + jl);
  v.setUint32(20 + jl, bin.byteLength, true);
  v.setUint32(24 + jl, 0x004e4942, true);
  out.set(bin, 28 + jl);
  return out.buffer;
}

async function load(): Promise<{ scene: Object3D; cameras: PerspectiveCamera[] }> {
  const gltf = await new GLTFLoader().parseAsync(exportedHouse(), '');
  return { scene: gltf.scene, cameras: gltf.cameras.filter((c): c is PerspectiveCamera => c instanceof PerspectiveCamera) };
}

const find = <T extends Object3D>(root: Object3D, test: (o: Object3D) => o is T): T[] => {
  const out: T[] = [];
  root.traverse((o) => { if (test(o)) out.push(o); });
  return out;
};
const shown = (o: Object3D): boolean => {
  for (let p: Object3D | null = o; p !== null; p = p.parent) if (!p.visible) return false;
  return true;
};
const meshes = (root: Object3D) => find(root, (o): o is Mesh => o instanceof Mesh);
const partOf = (m: Mesh): string => String((m.geometry.userData as { floorspec?: { part?: string } }).floorspec?.part);

describe('the GPU still’s scene (FLR-T-13.13)', () => {
  it('reads the export’s lamps, glass and lenses as three.js does, and lights them', async () => {
    const { scene } = await load();
    const house = prepareHouse(scene, { lights: true });
    expect(house).toMatchObject({ lamps: 3, glass: 1, lenses: 1 });
    const spot = find(scene, (o): o is SpotLight => o instanceof SpotLight)[0]!;
    // Candela, falling off with the square of the distance; the lamp's size where the tracer reads it.
    expect(spot.intensity).toBeCloseTo(120, 6);
    expect(spot.decay).toBe(2);
    expect(spot.distance).toBe(0);
    expect((spot as SpotLight & { radius?: number }).radius).toBeCloseTo(0.03, 6);
    // Pointing down, its cone the export's.
    spot.updateWorldMatrix(true, true);
    const dir = spot.target.getWorldPosition(new Vector3()).sub(spot.getWorldPosition(new Vector3())).normalize();
    expect(dir.y).toBeCloseTo(-1, 5);
    expect(spot.angle).toBeCloseTo(0.7, 6);
    // Glass: a clear thin pane that lets light through, not a see-through blend.
    const glass = meshes(scene).find((m) => (m.material as MeshPhysicalMaterial).transmission > 0)!.material as MeshPhysicalMaterial;
    expect(glass.transmission).toBe(1);
    expect(glass.ior).toBeCloseTo(1.5, 6);
    expect(glass.transparent).toBe(false);
    expect(glass.opacity).toBe(1);
    expect(glass.thickness).toBe(0);
    expect(glass.color.r).toBeGreaterThan(0.8);
    // A lens glows at the export's strength.
    const lens = meshes(scene).find((m) => (m.material as MeshStandardMaterial).emissiveIntensity > 1)!.material as MeshStandardMaterial;
    expect(lens.emissiveIntensity).toBeCloseTo(31250, 0);
  });

  it('takes the lamps out and darkens the lenses with the lights off', async () => {
    const { scene } = await load();
    const house = prepareHouse(scene, { lights: false });
    expect(house.lamps).toBe(0);
    expect(find(scene, (o): o is PointLight => o instanceof PointLight || o instanceof SpotLight)).toHaveLength(0);
    const lens = meshes(scene).find((m) => (m.material as MeshStandardMaterial).name === 'Lens')!.material as MeshStandardMaterial;
    expect(lens.emissiveIntensity).toBe(0);
  });

  it('cuts away above a level as the 3D view does: the levels above gone, its ceilings off, their lamps out', async () => {
    const { scene } = await load();
    const house = prepareHouse(scene, { lights: true, cut: 'L1' });
    const drawn = meshes(scene).filter(shown).map(partOf).sort();
    expect(drawn).toEqual(['extension', 'floor', 'opening']);
    // The lamp on L2 is not in the scene; L1's are.
    expect(house.lamps).toBe(2);
    expect(house.bounds?.max[1]).toBeCloseTo(2.5, 6);
    // The whole house with its roofs hidden, as the 3D view's roof toggle draws it.
    const bare = await load();
    prepareHouse(bare.scene, { lights: false, roofs: false });
    expect(meshes(bare.scene).filter(shown).map(partOf)).not.toContain('roof');
    expect(meshes(bare.scene).filter(shown).map(partOf)).toContain('ceiling');
    // Uncut, everything is drawn.
    const whole = await load();
    expect(prepareHouse(whole.scene, { lights: true }).bounds?.max[1]).toBeCloseTo(5.5, 6);
  });

  it('stands in a room where the export’s camera stands, looking where it looks', async () => {
    const { cameras } = await load();
    const c = roomCamera(cameras, 'R1')!;
    expect(c.label).toBe('Living room (R1) from its doorway D1');
    expect(c.eye).toEqual([0.5, 1.6, 0]);
    expect(c.fovY).toBeCloseTo(68, 4);
    // Its −Z: straight ahead, toward project north.
    expect(c.target[2] - c.eye[2]).toBeCloseTo(-1, 6);
    expect(roomCamera(cameras, 'R9')).toBeNull();
    const camera = perspectiveOf(c, 4 / 3);
    expect(camera.aspect).toBeCloseTo(4 / 3, 9);
    expect(camera.getWorldDirection(new Vector3()).z).toBeCloseTo(-1, 6);
  });

  it('puts the house on the lawn under the shared sky: its sun, its dome, in the tracer’s units', async () => {
    const { scene: root } = await load();
    const house = prepareHouse(root, { lights: false });
    const sky = skyField(skyLight('clear', { azimuth: 225, altitude: 35 }, 0), MAPS);
    const day = stillScene(root, house.bounds, { lights: false, sky, skyWidth: 64 });
    const sun = find(day.scene, (o): o is DirectionalLight => o instanceof DirectionalLight)[0]!;
    // Traced in the worker's units (12 500 lx).
    const want = stillSun(sky.light)!;
    expect(sun.intensity).toBeCloseTo(want.lux / TRACE_UNIT, 6);
    expect(TRACE_UNIT).toBe(LUX_PER_UNIT);
    const toward = sun.position.clone().sub(sun.target.position).normalize();
    want.dir.forEach((c, k) => { expect(toward.getComponent(k)).toBeCloseTo(c, 6); });
    const ground = day.scene.getObjectByName('ground') as Mesh;
    expect(ground.position.y).toBeCloseTo(-0.003, 6);
    // The lawn: its tile, at true scale.
    expect((ground.material as MeshStandardMaterial).map).not.toBeNull();
    expect(day.scene.environment).toBe(day.scene.background);
    day.dispose();
    // The lamps and lit lenses too, once however often the scene is made.
    const { scene: lit } = await load();
    prepareHouse(lit, { lights: true });
    const night = skyField(skyLight('night', null, 0), MAPS);
    stillScene(lit, null, { lights: true, sky: night, skyWidth: 64 });
    stillScene(lit, null, { lights: true, sky: night, skyWidth: 64 });
    expect(find(lit, (o): o is SpotLight => o instanceof SpotLight)[0]!.intensity).toBeCloseTo(120 / TRACE_UNIT, 12);
    const lens = meshes(lit).find((m) => (m.material as MeshStandardMaterial).name === 'Lens')!.material as MeshStandardMaterial;
    expect(lens.emissiveIntensity).toBeCloseTo(31250 / TRACE_UNIT, 6);
    // At dusk: no sun at all. In the studio: a pale floor, no lawn.
    const dusk = stillScene(root, house.bounds, { lights: false, sky: skyField(skyLight('dusk', null, 0), MAPS), skyWidth: 64 });
    expect(find(dusk.scene, (o): o is DirectionalLight => o instanceof DirectionalLight)).toHaveLength(0);
    dusk.dispose();
    const studio = stillScene(root, house.bounds, { lights: false, sky: skyField(skyLight('studio', null, 0), MAPS), skyWidth: 64 });
    expect(((studio.scene.getObjectByName('ground') as Mesh).material as MeshStandardMaterial).map).toBeNull();
    studio.dispose();
  }, 30_000);
});

/** Synthetic even maps: the scene's wiring, not the real HDRIs (the worker's tests read those). */
const MAPS: SkyMaps = Object.fromEntries((['clear', 'overcast', 'dusk', 'night'] as const).map((id) => [id, skyMapOf(id, { width: 64, height: 17, data: new Float32Array(64 * 17 * 3).fill(1) })]));

describe('the GPU still’s cameras and light (FLR-T-13.13)', () => {
  it('turns the editor’s orbit into the export’s frame: (x, y, z) at (x, z, −y), from the mesh’s origin', () => {
    const orbit: Orbit = { target: [1, 2, 1.5], azimuth: -2, elevation: 0.5, distance: 20 };
    const origin: [number, number, number] = [10 * UNITS_PER_METRE, 20 * UNITS_PER_METRE, 0];
    const c = orbitCamera(orbit, origin, 45);
    const eye = eyeOf(orbit);
    expect(c.eye[0]).toBeCloseTo(eye[0] + 10, 9);
    expect(c.eye[1]).toBeCloseTo(eye[2], 9);
    expect(c.eye[2]).toBeCloseTo(-(eye[1] + 20), 9);
    expect(c.target).toEqual([11, 1.5, -22]);
    expect(c.fovY).toBe(45);
  });

  it('frames a named view as the worker does: from the editor’s angle, the box filling the narrower field', () => {
    const box = { min: [0, 0, -10] as [number, number, number], max: [12, 6, 0] as [number, number, number] };
    const c = presetCamera('sw', box, 4 / 3);
    expect(c.label).toBe(PRESETS.sw.label);
    expect(c.target).toEqual([6, 3, -5]);
    // South-west and above: −x, +y, +z (south) of the middle.
    expect(c.eye[0]).toBeLessThan(6);
    expect(c.eye[1]).toBeGreaterThan(3);
    expect(c.eye[2]).toBeGreaterThan(-5);
    const radius = Math.hypot(12, 6, 10) / 2;
    expect(Math.hypot(c.eye[0] - 6, c.eye[1] - 3, c.eye[2] + 5)).toBeCloseTo((radius / Math.sin((15 * Math.PI) / 180)) * 1.02, 6);
    expect(presetCamera('top', box, 1).eye[1]).toBeGreaterThan(6);
  });

  it('meters within the time of day’s band, and hands three.js the exposure its ACES curve expects', () => {
    expect(meteredExposure(0.18 / 1e-3, 'day')).toBeCloseTo(1e-3, 12);
    expect(meteredExposure(1e9, 'day')).toBe(EXPOSURE_BAND.day.min);
    expect(meteredExposure(1e-9, 'night')).toBe(EXPOSURE_BAND.night.max);
    expect(toneMappingExposure(0.02)).toBeCloseTo(0.012, 12);
    // FLR-T-13.1's calibration, as the editor's 3D view applies it.
    expect(EXPOSURE_BAND.night).toEqual({ min: EXPOSURE_PER_NIT.night, max: EXPOSURE_PER_NIT.nightMax });
    expect(EXPOSURE_BAND.day).toEqual({ min: EXPOSURE_PER_NIT.day, max: EXPOSURE_PER_NIT.dayMax });
    expect(toneMappingExposure(0.02)).toBeCloseTo(viewToneMappingExposure(0.02), 12);
  });

  it('draws the sky as an equirectangular map in cd/m², the lawn far off below the horizon', () => {
    const sky = skyField(skyLight('overcast', { azimuth: 180, altitude: 45 }, 0), MAPS);
    const W = 64;
    const H = 32;
    const px = skyPixels(sky, W, H);
    // An even map: every texel well above the horizon the same, its illuminance over π.
    const top = px[4 * ((H - 1) * W) + 1]!;
    expect(Math.abs((top * Math.PI) / sky.light.layers[0]!.lux - 1)).toBeLessThan(0.01);
    // Straight down: the lawn, lit, far darker than the sky.
    expect(px[1]!).toBeLessThan(0.3 * top);
    expect(px[1]!).toBeGreaterThan(px[0]!);
  });

});
