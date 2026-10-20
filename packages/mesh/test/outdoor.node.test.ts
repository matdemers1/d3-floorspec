/**
 * FS_outdoor's models (FLR-T-15.2): the conformance suite's back terrace — a pergola, a plunge pool, a
 * raised spa, an outdoor kitchen, a fire pit and a fence with a gate — drawn as pieces that are each a
 * closed solid inside the element's box, the same bytes every time. A pergola stretched longer gets
 * more posts, each still its post size, spaced at most its post spacing apart; a pool has its coping
 * round its basin and its water at the water line; a fence leaves its gate's opening.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, OFFICIAL_READER, outdoor, type Derived, type FloorspecDocument } from '@floorspec/engine';
import terrace from '../../engine/standard/conformance/ext/FS_outdoor/0.1.0/examples/001-p15-back-terrace/input.json' with { type: 'json' };
import { loadKernel, type Kernel } from '../src/kernel.js';
import { loadMesher, OUTDOOR_ROLES, type HouseMesh, type MeshPart, type Mesher } from '../src/index.js';
import { checkHouse } from './props.js';

let kernel: Kernel;
let mesher: Mesher;
beforeAll(async () => {
  kernel = await loadKernel();
  mesher = await loadMesher();
});

type Json = Record<string, unknown>;
type El = Json & { fallback: { box: { min: number[]; max: number[] } }; host?: { position: number[] } };
const IN = 32512;
const FT = 12 * IN;

function meshed(input: object): { doc: FloorspecDocument; derived: Derived; mesh: HouseMesh } {
  const ev = evaluate(input, OFFICIAL_READER);
  if (!ev.valid) throw new Error(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('\n'));
  const derived = deriveEvaluation(ev);
  const doc = (ev.view ?? ev.document)!;
  return { doc, derived, mesh: mesher.meshDerived(doc, derived, { stats: true }) };
}
const doc = (): Json => structuredClone(terrace);
const coll = (d: Json, c: string): Record<string, El> => (d['extensions'] as Record<string, { collections: Record<string, Record<string, El>> }>)['FS_outdoor']!.collections[c]!;
const partsOf = (mesh: HouseMesh, id: string): MeshPart[] => mesh.parts.filter((p) => p.kind === 'extension' && p.id === id);
const named = (parts: MeshPart[], name: string): MeshPart[] => parts.filter((p) => new RegExp(`:${name}\\d*$`).test(p.key));

describe('FS_outdoor models', () => {
  it('draws every outdoor room as pieces, each a closed solid inside its box', () => {
    const { doc: d, derived, mesh } = meshed(doc());
    checkHouse(kernel, d, derived, mesh, 'terrace');
    for (const id of ['X1', 'X2', 'X3', 'X4', 'X5', 'X6']) {
      const parts = partsOf(mesh, id);
      expect(parts.length, id).toBeGreaterThan(1);
      for (const p of parts) expect(p.model, p.key).toBeDefined();
    }
    const roles = new Set(mesh.parts.filter((p) => p.extension?.name === 'FS_outdoor').map((p) => p.model!.role));
    for (const r of ['water', 'coping', 'poolInterior', 'cedar', 'ember'] as const) expect(roles.has(r), r).toBe(true);
    expect([...roles].filter((r) => OUTDOOR_ROLES.includes(r)).length).toBeGreaterThanOrEqual(5);
  });

  it("gives a pool its coping round the basin and its water at the water line", () => {
    const { mesh } = meshed(doc());
    const pool = partsOf(mesh, 'X1');
    const coping = named(pool, 'coping')[0]!;
    const water = named(pool, 'water')[0]!;
    // the pool stands at (7', -18'), 8' x 14', 5' 6" deep below the ground, a 12" coping, the water 6" down
    expect(coping.bbox.max[2]).toBe(0);
    expect(coping.bbox.min[0]).toBe(3 * FT);
    expect(coping.bbox.max[0]).toBe(11 * FT);
    expect(water.bbox.max[2]).toBe(-6 * IN);
    expect(water.bbox.min[0]).toBeGreaterThanOrEqual(4 * FT);
    expect(water.bbox.max[0]).toBeLessThanOrEqual(10 * FT);
    expect(water.bbox.max[0] - water.bbox.min[0]).toBeGreaterThan(6 * FT - 10 * 1280);
    // the raised spa's walls above the ground are faced in its coping's material
    const spa = partsOf(mesh, 'X2');
    expect(Math.max(...spa.map((p) => p.bbox.max[2]))).toBe(18 * IN);
    expect(named(spa, 'water')[0]!.bbox.max[2]).toBe(18 * IN - 4 * IN);
  });

  it('re-spaces a stretched pergola\'s posts and never makes them wider', () => {
    const d = doc();
    const p = coll(d, 'shelters')['X3']!;
    const counts: number[] = [];
    for (const depth of [12, 20, 28]) {
      p.fallback.box.max[0] = p.fallback.box.min[0]! + depth * FT;
      const { mesh } = meshed(d);
      const posts = named(partsOf(mesh, 'X3'), 'post');
      expect(posts.length).toBe(outdoor.shelterLayout(p as never).posts);
      for (const q of posts) {
        expect(q.bbox.max[0] - q.bbox.min[0]).toBe(6 * IN);
        expect(q.bbox.max[1] - q.bbox.min[1]).toBe(6 * IN);
      }
      const xs = [...new Set(posts.map((q) => (q.bbox.min[0] + q.bbox.max[0]) / 2))].sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i++) expect(xs[i + 1]! - xs[i]!).toBeLessThanOrEqual(8 * FT + 1);
      counts.push(posts.length);
    }
    expect(counts).toEqual([8, 10, 12]);
  });

  it('leaves the gate\'s opening in a fence, with its leaf in it', () => {
    const { mesh } = meshed(doc());
    const fence = partsOf(mesh, 'X6');
    // the gate is 40' to 44' along the line: 6' to 10' east along its south run, at y = -30'
    const x0 = -10 * FT + 6 * FT;
    const x1 = -10 * FT + 10 * FT;
    const leaf = named(fence, 'gate');
    expect(leaf.length).toBe(1);
    expect(leaf[0]!.bbox.min[0]).toBeGreaterThanOrEqual(x0);
    expect(leaf[0]!.bbox.max[0]).toBeLessThanOrEqual(x1);
    const infill = fence.filter((p) => /:(boards|cap)\d*$/.test(p.key) && p.bbox.min[1] < -29 * FT);
    for (const b of infill) expect(b.bbox.max[0] <= x0 + 1 || b.bbox.min[0] >= x1 - 1, b.key).toBe(true);
    // posts either side of the gate, none in its opening
    for (const q of named(fence, 'post')) {
      const mid = (q.bbox.min[0] + q.bbox.max[0]) / 2;
      if (q.bbox.min[1] < -29 * FT) expect(mid <= x0 || mid >= x1, q.key).toBe(true);
    }
  });

  it('draws every kind of top, fire, kitchen appliance and fence style', () => {
    const d = doc();
    const s = coll(d, 'shelters');
    s['X7'] = { ...structuredClone(s['X3']!), top: 'solid', attached: true, host: { mode: 'free', level: 'L1', position: [-20 * FT, 20 * FT] } } as El;
    s['X8'] = { ...structuredClone(s['X3']!), top: 'sail', host: { mode: 'free', level: 'L1', position: [-40 * FT, 20 * FT] } } as El;
    const f = coll(d, 'fires');
    for (const [k, form, x] of [['X9', 'bowl', -20], ['X10', 'table', -30], ['X11', 'fireplace', -40]] as const) f[k] = { ...structuredClone(f['X5']!), form, fuel: form === 'fireplace' ? 'wood' : 'gas', host: { mode: 'free', level: 'L1', position: [x * FT, -40 * FT] } } as El;
    f['X11']!.fallback.box = { min: [-18 * IN, -36 * IN, 0], max: [18 * IN, 36 * IN, 10 * FT] };
    coll(d, 'kitchens')['X4']!['appliances'] = ['grill', 'sideBurner', 'sink', 'refrigerator', 'iceMaker', 'pizzaOven', 'smoker', 'warmingDrawer'];
    const fences = coll(d, 'fences');
    let n = 12;
    for (const style of ['picket', 'rail', 'mesh', 'panel']) {
      const y = -50 * FT - n * 4 * FT;
      fences[`X${String(n++)}`] = { ...structuredClone(fences['X6']!), style, points: [[-20 * FT, y], [0, y]], gates: [], fallback: { level: 'L1', box: { min: [-20 * FT - 2 * IN, y - 2 * IN, 0], max: [2 * IN, y + 2 * IN, 6 * FT] } } } as El;
    }
    fences['X20'] = { form: 'wall', material: 'brick', width: 8 * IN, points: [[0, -100 * FT], [10 * FT, -100 * FT]], gates: [{ offset: 3 * FT, width: 4 * FT, leaves: 2 }], fallback: { level: 'L1', box: { min: [-4 * IN, -100 * FT - 4 * IN, 0], max: [10 * FT + 4 * IN, -100 * FT + 4 * IN, 3 * FT] } } } as El;
    const { doc: dd, derived, mesh } = meshed(d);
    checkHouse(kernel, dd, derived, mesh, 'terrace, every kind');
    expect(named(partsOf(mesh, 'X7'), 'roof').length).toBe(1);
    expect(named(partsOf(mesh, 'X7'), 'ledger').length).toBe(1);
    expect(named(partsOf(mesh, 'X7'), 'post').length).toBe(outdoor.shelterLayout(s['X7'] as never).posts);
    expect(named(partsOf(mesh, 'X8'), 'sail').length).toBe(1);
    for (const id of ['X9', 'X10', 'X11']) expect(partsOf(mesh, id).some((p) => p.model!.role === 'ember'), id).toBe(true);
    expect(named(partsOf(mesh, 'X20'), 'gate').length).toBe(2);
  });

  it('is the same bytes every time', async () => {
    const d = doc();
    const a = mesher.meshDocument(d, { validate: OFFICIAL_READER });
    const b = (await loadMesher()).meshDocument(JSON.stringify(d), { validate: OFFICIAL_READER });
    expect(b.parts.map((p) => p.key)).toEqual(a.parts.map((p) => p.key));
    a.parts.forEach((p, i) => { expect(Buffer.from(b.parts[i]!.mesh.positions.buffer).equals(Buffer.from(p.mesh.positions.buffer)), p.key).toBe(true); });
  });
});
