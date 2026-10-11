/**
 * Appliances described twice (FLR-T-12.34): an FS_furniture appliance and the FS_plumbing fixture
 * or FS_mechanical gas appliance in its box — named in its `connections`, or the same appliance —
 * draw once, as the appliance; the element it stands for draws nothing and is named on the
 * appliance's parts. The Courtyard House's kitchen and mudroom, where an owner's walkthrough found
 * a washer's door through its own side and a dishwasher's top streaked; and the showcase's near
 * misses, which still draw.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, OFFICIAL_READER, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { loadKernel, type Kernel } from '../src/kernel.js';
import { loadMesher, pairedElements, type HouseMesh, type MeshOptions, type Mesher } from '../src/index.js';
import { paired } from './houses.js';
import { checkHouse } from './props.js';

type Json = Record<string, unknown>;

let kernel: Kernel;
let mesher: Mesher;
beforeAll(async () => {
  kernel = await loadKernel();
  mesher = await loadMesher();
});

const fixture = (name: string): Json => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as Json;
const courtyard = fixture('courtyard-kitchen-mudroom.floorspec.json');
const showcase = paired(fixture('showcase.floorspec.json'));

function meshed(input: object, options: MeshOptions = {}): { doc: FloorspecDocument; derived: Derived; mesh: HouseMesh } {
  const ev = evaluate(input, OFFICIAL_READER);
  if (!ev.valid) throw new Error(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('\n'));
  const derived = deriveEvaluation(ev);
  const doc = (ev.view ?? ev.document)!;
  return { doc, derived, mesh: mesher.meshDerived(doc, derived, { stats: true, ...options }) };
}

const ids = (mesh: HouseMesh): Set<string> => new Set(mesh.parts.map((p) => p.id));

describe('the Courtyard House', () => {
  const PAIRS = [
    ['KIT-COOKTOP-G', 'KIT-COOKTOP'],
    ['KIT-DW-P', 'KIT-DW'],
    ['MUD-WASH-P', 'MUD-WASHER'],
  ] as const;

  it('pairs the washer, the dishwasher and the gas cooktop with their appliances', () => {
    const { doc, derived } = meshed(courtyard);
    expect([...pairedElements(doc, derived)]).toEqual(PAIRS);
  });

  it('draws each pair once, as the appliance, which stands for the other', () => {
    // Meshed about the kitchen, as the editor meshes about a house's middle: Float32 stays precise 20 m out.
    const { doc, derived, mesh } = meshed(courtyard, { origin: [16_000_000, 22_000_000, 0] });
    checkHouse(kernel, doc, derived, mesh, 'courtyard');
    const drawn = ids(mesh);
    for (const [service, appliance] of PAIRS) {
      expect(drawn.has(service), service).toBe(false);
      const parts = mesh.parts.filter((p) => p.id === appliance);
      expect(parts.length, appliance).toBeGreaterThan(1);
      for (const p of parts) expect(p.standsFor, p.key).toEqual([service]);
    }
    // The washer is the white washer it is: no grey box over it, and its round door is its own.
    for (const p of mesh.parts.filter((q) => q.id === 'MUD-WASHER')) expect(p.model?.kind, p.key).toBe('washer');
    // Nothing else stands for anything, and the kitchen sink beside the dishwasher still draws.
    expect(mesh.parts.filter((p) => p.standsFor !== undefined && !PAIRS.some(([, a]) => a === p.id))).toEqual([]);
    expect(drawn.has('KIT-SINK')).toBe(true);
  });

  it('draws each pair once with models off too: the appliance’s box', () => {
    const { mesh } = meshed(courtyard, { models: false, include: ['extension'] });
    for (const [service, appliance] of PAIRS) {
      expect(ids(mesh).has(service), service).toBe(false);
      expect(mesh.parts.filter((p) => p.id === appliance).map((p) => [p.key, p.standsFor]), appliance).toEqual([[`extension:${appliance}`, [service]]]);
    }
  });
});

describe('the near misses', () => {
  it('pairs only what is in an appliance’s box and is that appliance', () => {
    const { doc, derived } = meshed(showcase);
    expect([...pairedElements(doc, derived)]).toEqual([
      ['CT1-G', 'CT1'],
      ['WM1-P', 'WM1'],
      ['X5-P', 'X5'],
    ]);
  });

  it('still draws the rest', () => {
    const { doc, derived, mesh } = meshed(showcase);
    checkHouse(kernel, doc, derived, mesh, 'paired showcase');
    const drawn = ids(mesh);
    for (const gone of ['CT1-G', 'WM1-P', 'X5-P']) expect(drawn.has(gone), gone).toBe(false);
    // A washer's fixture with no washer; one a washer names that stands elsewhere, and that washer;
    // a hose bibb a washer names inside its box (a thing of its own); a gas dryer in a washer's box
    // that no one names (another appliance).
    for (const kept of ['WM2-P', 'WM3', 'WM3-P', 'WM1-B', 'GD1', 'CT1', 'WM1', 'X5']) expect(drawn.has(kept), kept).toBe(true);
    expect(new Set(mesh.parts.filter((p) => p.id === 'WM1').map((p) => p.standsFor))).toEqual(new Set([['WM1-P']]));
  });

  it('pairs nothing in a model with no appliances', () => {
    const { doc, derived } = meshed(fixture('showcase.floorspec.json'));
    expect(pairedElements(doc, derived).size).toBe(0);
  });
});
