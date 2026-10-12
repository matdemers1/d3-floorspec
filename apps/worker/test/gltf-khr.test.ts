/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { validateBytes } from 'gltf-validator';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildScene, exportGltf, readGlb, type Scene } from '../src/export/gltf/index.js';
import { candelaOf, GLASS_IOR, LENS_LUMINANCE, lookRotation } from '../src/export/gltf/khr.js';
import { lampsOf } from '../src/pathtrace/index.js';
import { roomCamera } from '../src/render3d/camera.js';

/**
 * FLR-T-13.13 (FLR-ADR-040): the glTF export carries what a path tracer needs to see the house as
 * the worker's own does — the luminaires' lamps as KHR_lights_punctual lights in candela, glass as
 * KHR_materials_transmission + KHR_materials_ior, a lit lens's KHR_materials_emissive_strength, a
 * camera standing in each room, and each primitive's part — and the Khronos validator passes it with
 * no errors and no warnings.
 */

type Json = Record<string, unknown>;
type Vec3 = [number, number, number];
const VERSION = { version: { hash: 'e'.repeat(64) } };
const load = (p: string): Json => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as Json;
/** Nine luminaires and their lenses: recessed spots, a fan light, pendants, an exterior light. */
const SHOWCASE = load('../../../packages/mesh/test/fixtures/showcase.floorspec.json');
/** Windows: glass. */
const TWO_STOREY = load('./fixtures/two-storey.json');

interface Node {
  name: string;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  camera?: number;
  extensions?: { KHR_lights_punctual?: { light: number } };
  extras?: { floorspec?: Json };
}
interface Light {
  name: string;
  type: string;
  color: number[];
  intensity: number;
  spot?: { innerConeAngle: number; outerConeAngle: number };
  extras: { floorspec: { id: string; radius: number } };
}
interface Material {
  name: string;
  alphaMode?: string;
  emissiveFactor?: number[];
  extensions?: Record<string, Json>;
  extras: { floorspec: Json };
}

async function validate(bytes: Uint8Array): Promise<{ errors: number; warnings: number; messages: string[] }> {
  const report = await validateBytes(bytes, { maxIssues: 0, writeTimestamp: false, format: 'glb' });
  return { errors: report.issues.numErrors, warnings: report.issues.numWarnings, messages: report.issues.messages.map((m) => `${m.code} ${m.pointer ?? ''} ${m.message}`) };
}

/** A unit quaternion applied to a vector. */
function rotate(q: number[], v: Vec3): Vec3 {
  const [x, y, z, w] = q as [number, number, number, number];
  const t: Vec3 = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

let scene: Scene;
let json: Json;
let bytes: Uint8Array;
beforeAll(async () => {
  scene = await buildScene(SHOWCASE);
  bytes = (await exportGltf(SHOWCASE, VERSION)).bytes;
  json = readGlb(bytes).json;
});

describe('glTF export extensions (FLR-T-13.13)', () => {
  it('passes the Khronos validator with no errors or warnings, lamps, lenses, glass and cameras included', async () => {
    for (const [name, doc] of [['showcase', SHOWCASE], ['two-storey', TWO_STOREY]] as const) {
      const file = await exportGltf(doc, VERSION);
      const report = await validate(file.bytes);
      expect(report.errors, `${name}: ${report.messages.join('\n')}`).toBe(0);
      expect(report.warnings, `${name}: ${report.messages.join('\n')}`).toBe(0);
    }
    expect(json['extensionsUsed']).toEqual(expect.arrayContaining(['KHR_lights_punctual', 'KHR_materials_emissive_strength']));
    const glass = readGlb((await exportGltf(TWO_STOREY, VERSION)).bytes).json;
    expect(glass['extensionsUsed']).toEqual(expect.arrayContaining(['KHR_materials_ior', 'KHR_materials_transmission']));
    // Required by nothing: a viewer without them still draws the house.
    expect(json['extensionsRequired']).toBeUndefined();
  });

  it('writes every lamp the path tracer shines, in candela, where the scene puts it', () => {
    const lights = (json['extensions'] as { KHR_lights_punctual: { lights: Light[] } }).KHR_lights_punctual.lights;
    expect(scene.lights.length).toBeGreaterThan(0);
    expect(lights).toHaveLength(scene.lights.length);
    // The worker's lamps, in its irradiance unit of 12 500 lx: the same candela, colour by colour.
    const lamps = lampsOf(scene);
    const nodes = json['nodes'] as Node[];
    scene.lights.forEach((l, i) => {
      const light = lights[i]!;
      expect(light.extras.floorspec.id).toBe(l.id);
      expect(light.type).toBe(l.spot === undefined ? 'point' : 'spot');
      expect(Math.max(...light.color)).toBeCloseTo(1, 6);
      for (let k = 0; k < 3; k++) expect(light.color[k]! * light.intensity, `${l.id}[${String(k)}]`).toBeCloseTo(lamps[i]!.intensity[k]! * 12_500, 1);
      expect(light.intensity).toBeCloseTo(candelaOf(l) * Math.max(...l.color), 2);
      expect(light.extras.floorspec.radius).toBeCloseTo(l.radius, 6);
      // Placed by a node under its luminaire's: at the lamp, a spot's −Z down its axis.
      const at = nodes.findIndex((n) => n.extensions?.KHR_lights_punctual?.light === i);
      const node = nodes[at]!;
      // The node repeats the lamp's size: three.js's loader makes the node the light, with the node's extras.
      expect(node.extras?.floorspec).toMatchObject({ id: l.id, kind: 'light' });
      expect(node.extras?.floorspec?.['radius']).toBeCloseTo(l.radius, 6);
      node.translation!.forEach((c, k) => { expect(c).toBeCloseTo(l.position[k]!, 5); });
      const parent = nodes.find((n) => n.children?.includes(at));
      expect(parent?.extras?.floorspec?.['id']).toBe(l.id);
      if (l.spot !== undefined) {
        rotate(node.rotation!, [0, 0, -1]).forEach((c, k) => { expect(c).toBeCloseTo(l.spot!.dir[k]!, 5); });
        expect(light.spot!.innerConeAngle).toBeLessThan(light.spot!.outerConeAngle);
        // A cone past the horizontal — a ceiling light's dome (FLR-T-13.16) — is written to the right angle glTF allows.
        if (l.spot.outer >= 0) expect(Math.cos(light.spot!.outerConeAngle)).toBeCloseTo(l.spot.outer, 5);
        else expect(light.spot!.outerConeAngle).toBeCloseTo(Math.PI / 2, 4);
      }
    });
  });

  it('stands a camera in every room, as the still in a room does', () => {
    const cameras = json['cameras'] as { type: string; perspective: { yfov: number; znear: number }; extras: { floorspec: { room: string; label: string } } }[];
    const nodes = json['nodes'] as Node[];
    expect(cameras).toHaveLength(scene.rooms.length);
    scene.rooms.forEach((room, i) => {
      const want = roomCamera(room, scene.doors, scene.obstacles);
      const camera = cameras[i]!;
      expect(camera.extras.floorspec).toEqual({ room: room.id, label: want.label });
      expect(camera.perspective.yfov).toBeCloseTo((want.fovY * Math.PI) / 180, 6);
      const at = nodes.findIndex((n) => n.camera === i);
      const node = nodes[at]!;
      expect(node.extras?.floorspec).toMatchObject({ kind: 'camera', room: room.id, label: want.label });
      node.translation!.forEach((c, k) => { expect(c).toBeCloseTo(want.eye[k]!, 5); });
      const forward = unit([want.target[0] - want.eye[0], want.target[1] - want.eye[1], want.target[2] - want.eye[2]]);
      rotate(node.rotation!, [0, 0, -1]).forEach((c, k) => { expect(c).toBeCloseTo(forward[k]!, 5); });
      // Upright: the picture's up has no sideways lean.
      expect(rotate(node.rotation!, [1, 0, 0])[1]).toBeCloseTo(0, 6);
      expect(nodes.find((n) => n.children?.includes(at))?.extras?.floorspec?.['id']).toBe(room.id);
    });
  });

  it('lets light through glass and makes a lens glow as bright as the path tracer shows it lit', async () => {
    const lens = (json['materials'] as Material[]).filter((m) => m.extensions?.['KHR_materials_emissive_strength'] !== undefined);
    expect(lens.length).toBeGreaterThan(0);
    for (const m of lens) {
      expect(Math.max(...m.emissiveFactor!)).toBeCloseTo(1, 6);
      expect(m.extensions!['KHR_materials_emissive_strength']!['emissiveStrength']).toBeGreaterThanOrEqual(LENS_LUMINANCE * 0.5);
    }
    const glassy = (readGlb((await exportGltf(TWO_STOREY, VERSION)).bytes).json['materials'] as Material[]).filter((m) => m.alphaMode === 'BLEND');
    expect(glassy.length).toBeGreaterThan(0);
    for (const m of glassy) {
      expect(m.extensions?.['KHR_materials_transmission']).toEqual({ transmissionFactor: 1 });
      expect(m.extensions?.['KHR_materials_ior']).toEqual({ ior: GLASS_IOR });
    }
  });

  it('says which part of its element each primitive is, so a view can cut the house away', () => {
    const meshes = json['meshes'] as { primitives: { extras?: { floorspec?: { part?: string } } }[] }[];
    const parts = new Set(meshes.flatMap((m) => m.primitives.map((p) => p.extras?.floorspec?.part)));
    expect(parts.has(undefined)).toBe(false);
    for (const p of ['wall', 'floor', 'ceiling']) expect(parts, p).toContain(p);
  });

  it('is deterministic: the same model writes the same bytes', async () => {
    expect((await exportGltf(SHOWCASE, VERSION)).bytes).toEqual(bytes);
  });

  it('turns −Z to look along any direction, upright', () => {
    for (const forward of [[1, 0, 0], [0, 0, 1], [0.3, -0.4, -0.8], [0, -1, 0], [0, 1, 0]] as Vec3[]) {
      const q = lookRotation(forward);
      expect(Math.hypot(...q)).toBeCloseTo(1, 9);
      rotate(q, [0, 0, -1]).forEach((c, k) => { expect(c).toBeCloseTo(unit(forward)[k]!, 9); });
    }
  });
});
