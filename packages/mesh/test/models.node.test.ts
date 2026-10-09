/**
 * Procedural models of extension elements (FLR-T-12.21): every modelled kind of every collection,
 * square to the level and turned 30°, drawn as pieces that are each a closed solid inside the
 * element's box (props.ts, `within`); a sink set into a counter; the plain box when models are off;
 * and the conformance suites' extension examples.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, OFFICIAL_READER, type Derived, type FloorspecDocument } from '@floorspec/engine';
import flat from '../../engine/standard/conformance/ext/FS_furniture/0.1.0/examples/001-p8-demo-flat/input.json' with { type: 'json' };
import house from '../../engine/standard/conformance/ext/FS_plumbing/0.1.0/examples/001-p5-demo-house/input.json' with { type: 'json' };
import { loadKernel, type Kernel } from '../src/kernel.js';
import { discriminant, elementKind, loadMesher, MODEL_ROLES, ROLE_LOOKS, type HouseMesh, type Mesher } from '../src/index.js';
import { checkHouse } from './props.js';

let kernel: Kernel;
let mesher: Mesher;
beforeAll(async () => {
  kernel = await loadKernel();
  mesher = await loadMesher();
});

type Json = Record<string, unknown>;
const MM = 1280;

/** Every kind a model is drawn for: extension, collection, the element's own members, and a box (mm) [x0, y0, z0, x1, y1, z1]. */
const KINDS: [string, string, Json, number[]][] = [
  ['FS_electrical', 'receptacles', {}, [0, -40, -60, 25, 40, 60]],
  ['FS_electrical', 'receptacles', { features: ['gfci'] }, [0, -40, -60, 25, 40, 60]],
  ['FS_electrical', 'receptacles', { volts: 240, amps: 30, outlets: 1 }, [0, -50, -70, 30, 50, 70]],
  ['FS_electrical', 'switches', {}, [0, -40, -60, 25, 40, 60]],
  ['FS_electrical', 'switches', { control: 'dimmer' }, [0, -40, -60, 25, 40, 60]],
  ['FS_electrical', 'panels', { volts: [120, 240], rating: 200, spaces: 40 }, [0, -200, -400, 100, 200, 400]],
  ['FS_electrical', 'alarms', { detects: ['smoke'] }, [-75, -75, -50, 75, 75, 0]],
  ...['ceiling', 'recessed', 'pendant', 'wall', 'track', 'underCabinet', 'fan', 'exterior'].map((fixture): [string, string, Json, number[]] => ['FS_electrical', 'lights', { fixture }, [-200, -200, -300, 200, 200, 0]]),
  ['FS_electrical', 'lights', {}, [-100, -100, -150, 100, 100, 0]],
  ['FS_plumbing', 'fixtures', { fixture: 'waterCloset' }, [0, -190, 0, 700, 190, 800]],
  ['FS_plumbing', 'fixtures', { fixture: 'bidet' }, [0, -190, 0, 600, 190, 400]],
  ['FS_plumbing', 'fixtures', { fixture: 'lavatory' }, [0, -250, -200, 500, 250, 150]],
  ['FS_plumbing', 'fixtures', { fixture: 'lavatory' }, [0, -250, -200, 500, 250, 0]],
  ['FS_plumbing', 'fixtures', { fixture: 'kitchenSink' }, [0, -425, -250, 550, 425, 300]],
  ['FS_plumbing', 'fixtures', { fixture: 'kitchenSink' }, [0, -325, -200, 550, 325, 0]],
  ['FS_plumbing', 'fixtures', { fixture: 'barSink' }, [0, -200, -180, 450, 200, 250]],
  ['FS_plumbing', 'fixtures', { fixture: 'laundryTub' }, [0, -300, -350, 550, 300, 250]],
  ['FS_plumbing', 'fixtures', { fixture: 'bathtub' }, [0, -762, 0, 762, 762, 508]],
  ['FS_plumbing', 'fixtures', { fixture: 'bathtubShower' }, [0, -762, 0, 762, 762, 2000]],
  ['FS_plumbing', 'fixtures', { fixture: 'bathtubShower' }, [0, -762, 0, 762, 762, 508]],
  ['FS_plumbing', 'fixtures', { fixture: 'shower' }, [0, -450, 0, 900, 450, 2000]],
  ['FS_plumbing', 'fixtures', { fixture: 'hoseBibb' }, [0, -40, -40, 100, 40, 40]],
  ['FS_plumbing', 'waterHeaters', { heater: 'storage', energy: 'electric' }, [-280, -280, 0, 280, 280, 1500]],
  ['FS_plumbing', 'waterHeaters', { heater: 'tankless', energy: 'naturalGas' }, [0, -230, -350, 200, 230, 350]],
  ...Object.entries({
    sofa: [900, 2100, 850],
    armchair: [850, 850, 850],
    chair: [500, 450, 850],
    bench: [400, 1200, 450],
    stool: [400, 400, 650],
    diningTable: [900, 1500, 750],
    coffeeTable: [600, 1200, 450],
    sideTable: [450, 450, 550],
    desk: [600, 1200, 750],
    bed: [2050, 1600, 1000],
    crib: [1300, 700, 900],
    nightstand: [450, 500, 600],
    dresser: [500, 1200, 800],
    wardrobe: [600, 1000, 2100],
    bookcase: [350, 900, 1800],
    sideboard: [450, 1600, 800],
    mediaUnit: [400, 1800, 500],
    shelf: [250, 900, 40],
  }).map(([category, [d, w, h]]): [string, string, Json, number[]] => ['FS_furniture', 'pieces', { category }, [0, -w! / 2, 0, d!, w! / 2, h!]]),
  ...Object.entries({
    refrigerator: [700, 900, 1780],
    freezer: [650, 600, 1700],
    range: [650, 760, 920],
    wallOven: [600, 760, 720],
    cooktop: [520, 760, 60],
    microwave: [400, 600, 350],
    dishwasher: [600, 600, 850],
    washer: [650, 690, 850],
    dryer: [650, 690, 850],
  }).map(([category, [d, w, h]]): [string, string, Json, number[]] => ['FS_furniture', 'appliances', { category }, [0, -w! / 2, 0, d!, w! / 2, h!]]),
  ['FS_furniture', 'appliances', { category: 'range' }, [0, -380, 0, 650, 380, 1150]],
  ...Object.entries({ baseCabinet: [600, 600, 900], wallCabinet: [350, 600, 750], tallCabinet: [600, 600, 2100], island: [900, 1800, 900], vanity: [550, 900, 850], shelving: [400, 1000, 1800] }).map(
    ([category, [d, w, h]]): [string, string, Json, number[]] => ['FS_furniture', 'casework', { category }, [0, -w! / 2, 0, d!, w! / 2, h!]],
  ),
  ...['range', 'cooktop', 'oven', 'dryer', 'grill', 'fireplace', 'lamp'].map((appliance): [string, string, Json, number[]] => [
    'FS_mechanical',
    'gasAppliances',
    { appliance, fuel: 'naturalGas' },
    appliance === 'grill' ? [0, -500, 0, 650, 500, 1150] : appliance === 'lamp' ? [0, -150, 0, 300, 150, 600] : [0, -380, 0, 650, 380, 920],
  ]),
  ['FS_mechanical', 'gasAppliances', { appliance: 'fireplace', fuel: 'propane' }, [0, -500, 0, 1000, 500, 400]],
];

/** Kinds drawn as their fallback box: no model for them. */
const BOXES: [string, string, Json, number[]][] = [
  ['FS_plumbing', 'fixtures', { fixture: 'urinal' }, [0, -200, 0, 350, 200, 600]],
  ['FS_furniture', 'pieces', { category: 'other' }, [0, -300, 0, 600, 300, 600]],
  ['FS_mechanical', 'gasAppliances', { appliance: 'generator', fuel: 'propane' }, [0, -400, 0, 800, 400, 700]],
];

/** The demo flat with every kind on the kitchen's floor: square to the level, and turned 30°. */
function everyKind(): { doc: Json; kinds: Map<string, string> } {
  const doc = structuredClone(flat) as unknown as Json;
  doc['extensionsUsed'] = { FS_furniture: '0.1.0', FS_electrical: '0.1.0', FS_plumbing: '0.1.0', FS_mechanical: '0.1.0' };
  const exts = doc['extensions'] as Record<string, { collections: Record<string, Json> }>;
  const kinds = new Map<string, string>();
  let n = 0;
  for (const [ext, coll, members, b] of [...KINDS, ...BOXES])
    for (const rotation of [0, 30_000_000]) {
      const id = `K${String(++n)}`;
      const at = [(300 + (n % 8) * 400) * MM, (300 + Math.floor(n / 8) % 11 * 400) * MM];
      exts[ext] ??= { collections: {} };
      exts[ext].collections[coll] ??= {};
      const fallback: Json = { level: 'L1', box: { min: b.slice(0, 3).map((v) => Math.round(v * MM)), max: b.slice(3).map((v) => Math.round(v * MM)) } };
      if (ext === 'FS_furniture') Object.assign(fallback, { asset: 'M-nightstand-500', symbol: 'S-nightstand-500' });
      exts[ext].collections[coll][id] = { ...members, fallback, host: { mode: 'surface', room: 'R1', surface: b[5]! <= 0 ? 'ceiling' : 'floor', position: at, rotation } };
      kinds.set(id, `${ext} ${coll} ${JSON.stringify(members)}`);
    }
  return { doc, kinds };
}

function meshed(input: object): { doc: FloorspecDocument; derived: Derived; mesh: HouseMesh } {
  const ev = evaluate(input, OFFICIAL_READER);
  if (!ev.valid) throw new Error(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('\n'));
  const derived = deriveEvaluation(ev);
  const doc = (ev.view ?? ev.document)!;
  return { doc, derived, mesh: mesher.meshDerived(doc, derived, { stats: true }) };
}

describe('every modelled kind', () => {
  it('is drawn as pieces, each a closed solid inside its box, with every other property holding', () => {
    const { doc: input, kinds } = everyKind();
    const { doc, derived, mesh } = meshed(input);
    checkHouse(kernel, doc, derived, mesh, 'every kind');
    const byId = new Map<string, typeof mesh.parts>();
    for (const p of mesh.parts) if (p.kind === 'extension') byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
    for (const [id, what] of kinds) {
      const parts = byId.get(id) ?? [];
      const boxed = BOXES.some(([e, c, m]) => what === `${e} ${c} ${JSON.stringify(m)}`);
      if (boxed) {
        expect(parts.map((p) => [p.key, p.model]), what).toEqual([[`extension:${id}`, undefined]]);
        continue;
      }
      expect(parts.length, `${what}: pieces`).toBeGreaterThanOrEqual(2);
      for (const p of parts) {
        expect(p.model, `${what} ${p.key}`).toBeDefined();
        expect(MODEL_ROLES).toContain(p.model!.role);
        expect(p.key.startsWith(`extension:${id}:`), p.key).toBe(true);
      }
    }
  });

  it('draws the plain boxes when models are off', () => {
    const { doc: input } = everyKind();
    const ev = evaluate(input, OFFICIAL_READER);
    const m = mesher.meshDerived((ev.view ?? ev.document)!, deriveEvaluation(ev), { models: false, include: ['extension'] });
    expect(m.parts.every((p) => p.model === undefined && p.key === `extension:${p.id}`)).toBe(true);
    expect(new Set(m.parts.map((p) => p.id)).size).toBe(m.parts.length);
  });

  it('is the same bytes every time', async () => {
    const { doc } = everyKind();
    const a = mesher.meshDocument(doc, { validate: OFFICIAL_READER });
    const b = (await loadMesher()).meshDocument(JSON.stringify(doc), { validate: OFFICIAL_READER });
    expect(b.parts.map((p) => p.key)).toEqual(a.parts.map((p) => p.key));
    a.parts.forEach((p, i) => {
      expect(Buffer.from(b.parts[i]!.mesh.positions.buffer).equals(Buffer.from(p.mesh.positions.buffer)), p.key).toBe(true);
    });
  });
});

describe('a sink set into a counter', () => {
  const showcase = readFileSync(join(import.meta.dirname, 'fixtures', 'showcase.floorspec.json'), 'utf8');

  it('cuts the counter for its bowls and takes its rim to the counter', () => {
    const { doc, derived, mesh } = meshed(JSON.parse(showcase) as object);
    checkHouse(kernel, doc, derived, mesh, 'showcase');
    // X4 is the base cabinet under the kitchen sink S1; V1 the vanity under the basin S3.
    for (const [counter, sink] of [
      ['X4', 'S1'],
      ['V1', 'S3'],
    ] as const) {
      const top = mesh.parts.find((p) => p.key === `extension:${counter}:top`)!;
      const f = derived.fallbacks![counter]!;
      const t = top.bbox.max[2] - top.bbox.min[2];
      // The slab's volume is its outline's less the cut-out's.
      const full = Math.abs(f.footprint.reduce((s, p, i) => s + p[0] * f.footprint[(i + 1) % 4]![1] - f.footprint[(i + 1) % 4]![0] * p[1], 0)) / 2;
      expect(top.stats!.volume, counter).toBeLessThan(full * t * 0.9);
      // Undermounted: no deck of its own, its bowls' tops at the counter's top.
      expect(mesh.parts.some((p) => p.key === `extension:${sink}:deck`), sink).toBe(false);
      const bowl = mesh.parts.find((p) => p.id === sink && (p.key.endsWith(':basin') || p.key.endsWith(':basin2')))!;
      expect(top.bbox.max[2] - bowl.bbox.max[2], sink).toBeGreaterThanOrEqual(0);
      expect(top.bbox.max[2] - bowl.bbox.max[2], sink).toBeLessThanOrEqual(3 * MM);
    }
  });
});

describe('the extension examples', () => {
  for (const [name, input] of [
    ['FS_furniture demo flat', flat],
    ['FS_plumbing demo house', house],
  ] as const)
    it(name, () => {
      const { doc, derived, mesh } = meshed(input);
      checkHouse(kernel, doc, derived, mesh, name);
      expect(mesh.parts.filter((p) => p.model !== undefined).length).toBeGreaterThan(20);
    });
});

describe('what an element is', () => {
  it('reads the member its collection names, or the collection', () => {
    expect(discriminant('FS_plumbing', 'fixtures')).toBe('fixture');
    expect(discriminant('FS_furniture', 'casework')).toBe('category');
    expect(discriminant('FS_electrical', 'receptacles')).toBeUndefined();
    expect(discriminant('FS_unknown', 'things')).toBeUndefined();
    expect(discriminant('FS_plumbing', 'toString')).toBeUndefined();
    expect(elementKind('FS_plumbing', 'fixtures', { fixture: 'lavatory' })).toBe('lavatory');
    expect(elementKind('FS_lowvoltage', 'outlets', { media: ['coax', 'data'] })).toBe('coax');
    expect(elementKind('FS_electrical', 'lights', {})).toBe('ceiling');
    expect(elementKind('FS_electrical', 'receptacles', { features: ['gfci'] })).toBe('receptacles');
  });

  it('has a look for every role', () => {
    for (const r of MODEL_ROLES) expect(ROLE_LOOKS[r].color).toMatch(/^#[0-9a-f]{6}$/);
  });
});
