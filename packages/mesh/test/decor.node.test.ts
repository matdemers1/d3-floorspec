/**
 * FLR-T-13.11: the FS_furniture starter library's decor drawn as what each item is — a rug, a
 * picture, a lamp, a plant, a curtain — each a closed solid inside its box, square to the level and
 * turned 30°; a project's own model of an `other` piece is not decor; matching pieces of one group
 * (a bed's two lamps) match; and a floor or table lamp shines, from its shade, with no switch.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, furniture, OFFICIAL_READER, type Derived, type FloorspecDocument } from '@floorspec/engine';
import flat from '../../engine/standard/conformance/ext/FS_furniture/0.1.0/examples/001-p8-demo-flat/input.json' with { type: 'json' };
import { loadKernel, type Kernel } from '../src/kernel.js';
import { decorFamily, LAMP_LUMENS, lightsOf, loadMesher, MODEL_ROLES, type HouseMesh, type Mesher } from '../src/index.js';
import { DECOR } from '../src/models/decor.js';
import { checkHouse } from './props.js';

type Json = Record<string, unknown>;
const MM = 1280;
const ITEMS = furniture.STARTER_LIBRARY_ITEMS;
const DECOR_ITEMS = Object.keys(ITEMS).filter((id) => ITEMS[id]!.element.category === 'other').sort();

let kernel: Kernel;
let mesher: Mesher;
beforeAll(async () => {
  kernel = await loadKernel();
  mesher = await loadMesher();
});

/** The demo flat with every decor item on R1's floor, each square and turned 30°, and its two assets. */
function everyItem(own = false): { doc: Json; items: Map<string, string> } {
  const doc = structuredClone(flat) as unknown as Json;
  const assets = doc['assets'] as Record<string, Json>;
  const pieces = ((doc['extensions'] as Record<string, { collections: Record<string, Record<string, Json>> }>)['FS_furniture']!.collections['pieces'] ??= {});
  const items = new Map<string, string>();
  let n = 0;
  for (const item of DECOR_ITEMS) {
    const lib = ITEMS[item]!;
    assets[`M-${item}`] = { path: `furniture/${item}.glb`, sha256: own ? 'f'.repeat(64) : lib.model.sha256, mediaType: lib.model.mediaType };
    assets[`S-${item}`] = { path: `furniture/${item}.svg`, sha256: lib.symbol.sha256, mediaType: lib.symbol.mediaType };
    for (const rotation of [0, 30_000_000]) {
      const id = `D${String(++n)}`;
      const at = [(400 + (n % 6) * 600) * MM, (400 + (Math.floor(n / 6) % 9) * 500) * MM];
      pieces[id] = { category: 'other', catalogue: item, fallback: { level: 'L1', box: structuredClone(lib.element.fallback.box), asset: `M-${item}`, symbol: `S-${item}` }, host: { mode: 'surface', room: 'R1', surface: 'floor', position: at, rotation } };
      items.set(id, item);
    }
  }
  return { doc, items };
}

function meshed(input: object): { doc: FloorspecDocument; derived: Derived; mesh: HouseMesh } {
  const ev = evaluate(input, OFFICIAL_READER);
  if (!ev.valid) throw new Error(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('\n'));
  const derived = deriveEvaluation(ev);
  const doc = (ev.view ?? ev.document)!;
  return { doc, derived, mesh: mesher.meshDerived(doc, derived, { stats: true }) };
}

describe('decor', () => {
  it('has a model for every decor item of the library', () => {
    expect(DECOR_ITEMS.length).toBeGreaterThanOrEqual(25);
    for (const item of DECOR_ITEMS) expect(Object.hasOwn(DECOR, decorFamily(item) ?? ''), item).toBe(true);
  });

  it('draws each as its model: pieces, each a closed solid inside its box', () => {
    const { doc: input, items } = everyItem();
    const { doc, derived, mesh } = meshed(input);
    checkHouse(kernel, doc, derived, mesh, 'decor');
    for (const [id, item] of items) {
      const parts = mesh.parts.filter((p) => p.id === id);
      expect(parts.length, item).toBeGreaterThanOrEqual(1);
      for (const p of parts) {
        expect(p.model?.kind, `${item} ${p.key}`).toBe(decorFamily(item));
        expect(MODEL_ROLES).toContain(p.model!.role);
      }
    }
  });

  it('draws a project\'s own model of an other piece as its box, not as decor', () => {
    const { doc: input, items } = everyItem(true);
    const { mesh } = meshed(input);
    for (const id of items.keys()) expect(mesh.parts.filter((p) => p.id === id).map((p) => p.model)).toEqual([undefined]);
  });

  it('is the same bytes every time', async () => {
    const { doc } = everyItem();
    const a = mesher.meshDocument(doc, { validate: OFFICIAL_READER });
    const b = (await loadMesher()).meshDocument(JSON.stringify(doc), { validate: OFFICIAL_READER });
    expect(b.parts.map((p) => p.key)).toEqual(a.parts.map((p) => p.key));
    a.parts.forEach((p, i) => {
      expect(Buffer.from(b.parts[i]!.mesh.positions.buffer).equals(Buffer.from(p.mesh.positions.buffer)), p.key).toBe(true);
    });
  });

  it('matches the pieces of one group: two lamps with one bed are drawn alike', () => {
    const { doc: input } = everyItem();
    const pieces = (input['extensions'] as Record<string, { collections: Record<string, Record<string, Json>> }>)['FS_furniture']!.collections['pieces']!;
    const lamps = Object.entries(pieces).filter(([, p]) => p['catalogue'] === 'lamp-table-600').map(([id]) => id);
    const bed = Object.entries(pieces).find(([, p]) => p['category'] === 'bed')![0];
    for (const id of lamps) pieces[id]!['with'] = bed;
    const { mesh } = meshed(input);
    const roles = lamps.map((id) => mesh.parts.filter((p) => p.id === id).map((p) => p.model!.role).join(','));
    expect(roles[0]).toBe(roles[1]);
  });
});

describe('a decor lamp', () => {
  it('shines from the middle of its shade, every way, warm, with no switch, in its room', () => {
    const { doc: input, items } = everyItem();
    const ev = evaluate(input, OFFICIAL_READER);
    const lights = lightsOf((ev.view ?? ev.document)!, deriveEvaluation(ev));
    const derived = deriveEvaluation(ev);
    const lamps = [...items].filter(([, item]) => item.startsWith('lamp-'));
    expect(lamps.length).toBe(4);
    for (const [id, item] of lamps) {
      const l = lights.find((x) => x.id === id);
      expect(l, id).toBeDefined();
      const f = derived.fallbacks![id]!;
      const z = (l!.position[2] - f.bottom) / (f.top - f.bottom);
      if (item.startsWith('lamp-floor')) {
        expect(l!.fixture).toBe('floorLamp');
        expect(z).toBeCloseTo(0.88, 2);
      } else {
        expect(l!.fixture).toBe('tableLamp');
        expect(z).toBeCloseTo(0.8, 2);
      }
      expect(l!.lumens).toBe(LAMP_LUMENS[l!.fixture]);
      expect([l!.direction, l!.kelvin, l!.switches, l!.room]).toEqual(['omni', 2700, [], 'R1']);
      expect(l!.radius).toBe(25 * MM);
    }
  });
});
