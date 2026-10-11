import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildScene, exportGltf, readGlb, type Scene, type SceneNode } from '../src/export/gltf/index.js';
import { ptScene } from '../src/pathtrace/index.js';
import { sceneTriangles } from '../src/render3d/index.js';

/**
 * FLR-T-12.34: an appliance described twice — an FS_furniture washer, dishwasher or cooktop and the
 * FS_plumbing fixture or FS_mechanical gas appliance in its box — is drawn once, as the appliance,
 * by every 3D output the worker makes: the scene the headless render and the path tracer draw has
 * no node for the element the appliance stands for, the appliance's node names it, a highlight of
 * it lights the appliance, and the .glb carries the same. The Courtyard House's kitchen and
 * mudroom, trimmed (packages/mesh/test/fixtures).
 */

type Json = Record<string, unknown>;
const COURTYARD = JSON.parse(readFileSync(new URL('../../../packages/mesh/test/fixtures/courtyard-kitchen-mudroom.floorspec.json', import.meta.url), 'utf8')) as Json;
const VERSION = { version: { hash: 'f'.repeat(64) } };

/** Service element → the appliance that stands for it. */
const PAIRS: Record<string, string> = { 'KIT-COOKTOP-G': 'KIT-COOKTOP', 'KIT-DW-P': 'KIT-DW', 'MUD-WASH-P': 'MUD-WASHER' };

const nodes = (scene: Scene): SceneNode[] => scene.levels.flatMap((l) => l.nodes);
const triangles = (n: SceneNode): number => n.primitives.reduce((s, p) => s + p.indices.length / 3, 0);

describe('an appliance described twice', () => {
  it('is one node, which stands for the other element', async () => {
    const scene = await buildScene(COURTYARD);
    const byId = new Map(nodes(scene).map((n) => [n.id, n]));
    for (const [service, appliance] of Object.entries(PAIRS)) {
      expect(byId.has(service), service).toBe(false);
      expect(byId.get(appliance)?.standsFor, appliance).toEqual([service]);
    }
    expect(nodes(scene).filter((n) => n.standsFor !== undefined).map((n) => n.id).sort()).toEqual(Object.values(PAIRS).sort());
    // Still an obstacle a camera keeps out of: it is in the document, only its geometry is the appliance's.
    for (const service of Object.keys(PAIRS)) expect(scene.obstacles.some((o) => o.id === service), service).toBe(true);
  });

  it('is drawn once by the path tracer and the headless render: they draw the scene’s nodes and nothing else', async () => {
    const scene = await buildScene(COURTYARD);
    const all = nodes(scene).reduce((s, n) => s + triangles(n), 0);
    // The path tracer's ground is a plate of two triangles; the headless render's is left off here.
    expect(ptScene(scene).count).toBe(all + 2);
    expect(sceneTriangles(scene, { ground: false })).toHaveLength(all);
  });

  it('lights the appliance when the element it stands for is highlighted', async () => {
    const scene = await buildScene(COURTYARD);
    const plain = sceneTriangles(scene, { ground: false });
    const lit = sceneTriangles(scene, { ground: false, highlight: ['KIT-DW-P'] });
    const changed = lit.filter((t, i) => t.rgb.some((c, k) => c !== plain[i]?.rgb[k])).length;
    const dishwasher = nodes(scene).find((n) => n.id === 'KIT-DW');
    expect(dishwasher).toBeDefined();
    expect(changed).toBe(dishwasher === undefined ? -1 : triangles(dishwasher));
  });

  it('is one node in the .glb, which names the other element', async () => {
    const { json } = readGlb((await exportGltf(COURTYARD, VERSION)).bytes);
    const fs = ((json['nodes'] ?? []) as Json[]).map((n) => (n['extras'] as Json | undefined)?.['floorspec'] as Json | undefined);
    for (const [service, appliance] of Object.entries(PAIRS)) {
      expect(fs.some((f) => f?.['id'] === service), service).toBe(false);
      expect(fs.find((f) => f?.['id'] === appliance && f['kind'] === 'extension')?.['standsFor'], appliance).toEqual([service]);
    }
  });
});
