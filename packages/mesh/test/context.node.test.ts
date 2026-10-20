/**
 * FS_context in 3D (FLR-T-15.3): the conformance suite's garden on its street meshed — the street's
 * carriageway a surface, its curbs, strips and sidewalks solids up by the curb's height; each neighbour's
 * massing to its eaves and its roof to its ridge; each tree a trunk and a crown — every piece a closed
 * solid in a neutral context role, on the lowest level, the same bytes every time. Nothing of the house
 * changes with context; a season bares the deciduous trees beyond the lot and snow lies on a neighbour's
 * roof. Context casts shade: one flag.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, OFFICIAL_READER, type Derived, type FloorspecDocument } from '@floorspec/engine';
import street from '../../engine/standard/conformance/ext/FS_context/0.1.0/examples/001-p15-garden-on-its-street/input.json' with { type: 'json' };
import { loadKernel, type Kernel } from '../src/kernel.js';
import { CONTEXT_CASTS_SHADE, CONTEXT_ROLES, lookMesh, loadMesher, ROLE_LOOKS, UNITS_PER_METRE, type HouseMesh, type Mesher } from '../src/index.js';
import { checkHouse } from './props.js';

let kernel: Kernel;
let mesher: Mesher;
beforeAll(async () => {
  kernel = await loadKernel();
  mesher = await loadMesher();
});

type Json = Record<string, unknown>;
const FT = 390_144;

function meshed(input: object): { doc: FloorspecDocument; derived: Derived; mesh: HouseMesh } {
  const ev = evaluate(input, OFFICIAL_READER);
  if (!ev.valid) throw new Error(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('\n'));
  const derived = deriveEvaluation(ev);
  const doc = (ev.view ?? ev.document)!;
  return { doc, derived, mesh: mesher.meshDerived(doc, derived, { stats: true }) };
}
const withoutContext = (): Json => {
  const d = structuredClone(street) as Json & { extensionsUsed: Json; extensions: Json };
  delete d.extensionsUsed['FS_context'];
  delete d.extensions['FS_context'];
  return d;
};

describe('FS_context in 3D', () => {
  it('draws every record as context parts, each a closed solid (the carriageway a surface), in the neutral roles only', () => {
    const { doc, derived, mesh } = meshed(structuredClone(street));
    checkHouse(kernel, doc, derived, mesh, 'street');
    const ctx = mesh.parts.filter((p) => p.kind === 'context');
    expect(new Set(ctx.map((p) => p.id))).toEqual(new Set(['ST1', 'NB1', 'NB2', 'NB3', 'TR1', 'TR2']));
    for (const p of ctx) {
      expect(CONTEXT_ROLES).toContain(p.model!.role);
      expect(p.level).toBe('L1');
      expect(p.extension?.name).toBe('FS_context');
      expect(ROLE_LOOKS[p.model!.role].metallic).toBe(0);
      expect(ROLE_LOOKS[p.model!.role].roughness).toBe(1);
    }
    expect(ctx.filter((p) => !p.closed).map((p) => p.key)).toEqual(['context:ST1:carriageway']);
    // the street's 2 curbs, 2 strips and 2 sidewalks
    expect(ctx.filter((p) => p.id === 'ST1' && p.closed)).toHaveLength(6);
  });

  it('puts a neighbour\'s eaves and ridge where FS_context derives them, and a flat roof\'s massing to its ridge', () => {
    const { mesh } = meshed(structuredClone(street));
    const part = (key: string) => mesh.parts.find((p) => p.key === key)!;
    expect(part('context:NB1:massing').bbox.max[2]).toBe(6 * FT);
    expect(part('context:NB1:roof').bbox.max[2]).toBe(12 * FT);
    expect(part('context:NB1:massing').bbox.min[2]).toBe(-4 * FT);
    expect(part('context:NB2:roof').bbox.max[2]).toBe(21 * FT);
    expect(mesh.parts.find((p) => p.key === 'context:NB3:roof')).toBeUndefined();
    expect(part('context:NB3:massing').bbox.max[2]).toBe(6 * FT);
    expect(part('context:TR1:crown').bbox.max[2]).toBe(40 * FT);
  });

  it('changes nothing of the house: every other part is the same, byte for byte', () => {
    const a = meshed(structuredClone(street)).mesh;
    const b = meshed(withoutContext()).mesh;
    const strip = (m: HouseMesh) => m.parts.filter((p) => p.kind !== 'context').map((p) => [p.key, Array.from(p.mesh.positions), Array.from(p.mesh.indices)]);
    expect(strip(a)).toEqual(strip(b));
    // and the same context every time
    const again = meshed(structuredClone(street)).mesh.parts.filter((p) => p.kind === 'context');
    expect(again.map((p) => Array.from(p.mesh.positions))).toEqual(a.parts.filter((p) => p.kind === 'context').map((p) => Array.from(p.mesh.positions)));
  });

  it('leaves context out when a view asks for other kinds only', () => {
    const ev = evaluate(structuredClone(street), OFFICIAL_READER);
    const m = mesher.meshDerived((ev.view ?? ev.document)!, deriveEvaluation(ev), { include: ['wall', 'roof'] });
    expect(m.parts.some((p) => p.kind === 'context')).toBe(false);
  });

  it('bares the deciduous tree beyond the lot in winter, keeps the evergreen, warms it in autumn, and lays snow on a neighbour\'s roof', () => {
    const { doc, mesh } = meshed(structuredClone(street));
    const winter = lookMesh(mesh, doc, { season: 'winter' });
    expect(winter.parts.find((p) => p.key === 'context:TR1:crown')).toBeUndefined();
    expect(winter.parts.find((p) => p.key === 'context:TR1:crown:bare')?.model?.role).toBe('contextTrunk');
    expect(winter.parts.find((p) => p.key === 'context:TR2:crown')?.model?.role).toBe('contextConifer');
    const autumn = lookMesh(mesh, doc, { season: 'autumn' });
    expect(autumn.parts.find((p) => p.key === 'context:TR1:crown')?.model?.role).toBe('contextAutumn');
    const snow = lookMesh(mesh, doc, { weather: 'snow' });
    expect(snow.parts.some((p) => p.key === 'context:NB1:roof:snow')).toBe(true);
    expect(snow.parts.some((p) => p.key === 'context:ST1:carriageway:snow')).toBe(false);
  });

  it('casts shade: one flag, on', () => {
    expect(CONTEXT_CASTS_SHADE).toBe(true);
    expect(UNITS_PER_METRE).toBe(1_280_000);
  });
});
