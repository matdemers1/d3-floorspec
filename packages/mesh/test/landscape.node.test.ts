/**
 * FS_landscape's models (FLR-T-13.5): the conformance suite's Phase 13 garden — trees of every habit,
 * shrubs, a grass, a groundcover, beds at grade and raised, a lawn, stepping stones and a seat wall —
 * drawn as pieces that are each a closed solid inside the element's box, in the landscape's own roles,
 * the same bytes every time.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, OFFICIAL_READER, type Derived, type FloorspecDocument } from '@floorspec/engine';
import garden from '../../engine/standard/conformance/ext/FS_landscape/0.1.0/examples/001-p13-garden/input.json' with { type: 'json' };
import { loadKernel, type Kernel } from '../src/kernel.js';
import { LANDSCAPE_ROLES, loadMesher, type HouseMesh, type Mesher } from '../src/index.js';
import { checkHouse } from './props.js';

let kernel: Kernel;
let mesher: Mesher;
beforeAll(async () => {
  kernel = await loadKernel();
  mesher = await loadMesher();
});

type Json = Record<string, unknown>;
const MM = 1280;

function meshed(input: object): { doc: FloorspecDocument; derived: Derived; mesh: HouseMesh } {
  const ev = evaluate(input, OFFICIAL_READER);
  if (!ev.valid) throw new Error(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('\n'));
  const derived = deriveEvaluation(ev);
  const doc = (ev.view ?? ev.document)!;
  return { doc, derived, mesh: mesher.meshDerived(doc, derived, { stats: true }) };
}

/** The garden with a tree of every habit and a shrub of every habit added in the lawn, and a path and a curb. */
function everyHabit(): Json {
  const doc = structuredClone(garden) as unknown as Json;
  const c = (doc['extensions'] as Record<string, { collections: Record<string, Record<string, Json>> }>)['FS_landscape']!.collections;
  const FT = 390144;
  let n = 0;
  for (const form of ['tree', 'shrub'] as const)
    for (const habit of ['rounded', 'spreading', 'columnar', 'conical', 'weeping']) {
      const [s, h] = form === 'tree' ? [6000 * MM, 9000 * MM] : [1200 * MM, 1500 * MM];
      const r = Math.floor(s / 2);
      c['plants']![`H${String(++n)}`] = {
        form,
        habit,
        ...(form === 'tree' && { clearHeight: 2000 * MM }),
        ...(n % 2 === 0 && { foliage: 'evergreen' }),
        fallback: { level: 'L1', box: { min: [-r, -r, 0], max: [s - r, s - r, h] } },
        host: { mode: 'free', level: 'L1', position: [-60 * FT + n * 8 * FT, -40 * FT], ...(n % 3 === 0 && { rotation: 30_000_000 }) },
      };
    }
  const line = (points: number[][], w: number, z0: number, z1: number) => {
    const xs = points.map((p) => p[0]!);
    const ys = points.map((p) => p[1]!);
    const h = Math.floor(w / 2);
    return { points, width: w, fallback: { level: 'L1', box: { min: [Math.min(...xs) - h, Math.min(...ys) - h, z0], max: [Math.max(...xs) + h, Math.max(...ys) + h, z1] } } };
  };
  c['hardscape']!['P1'] = { form: 'path', material: 'gravel', ...line([[-30 * FT, -30 * FT], [-20 * FT, -30 * FT], [-20 * FT, -36 * FT]], 1000 * MM, -40 * MM, 10 * MM) };
  c['hardscape']!['P2'] = { form: 'curb', ...line([[-30 * FT, -33 * FT], [-24 * FT, -33 * FT]], 150 * MM, -100 * MM, 120 * MM) };
  return doc;
}

describe('FS_landscape models', () => {
  it('draws every plant, bed, lawn and line as pieces, each a closed solid inside its box, in the landscape roles', () => {
    const { doc, derived, mesh } = meshed(everyHabit());
    checkHouse(kernel, doc, derived, mesh, 'garden');
    const byId = new Map<string, typeof mesh.parts>();
    for (const p of mesh.parts) if (p.kind === 'extension') byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
    const ids = Object.values((doc.extensions as Record<string, { collections: Record<string, Json> }>)['FS_landscape']!.collections).flatMap((x) => Object.keys(x));
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      const parts = byId.get(id) ?? [];
      expect(parts.length, id).toBeGreaterThanOrEqual(1);
      for (const p of parts) {
        expect(p.model, p.key).toBeDefined();
        expect(LANDSCAPE_ROLES.includes(p.model!.role) || p.model!.role === 'stone' || p.model!.role === 'wood', `${p.key} ${p.model!.role}`).toBe(true);
      }
    }
    // a tree is its trunk and its crown; a raised planter its walls and its soil; stepping stones are stones
    expect(byId.get('X1')!.map((p) => p.model!.role)).toContain('trunk');
    expect(byId.get('X1')!.filter((p) => p.model!.role.startsWith('foliage')).length).toBeGreaterThanOrEqual(4);
    expect(byId.get('X11')!.map((p) => p.model!.role).sort()).toEqual(['concrete', 'soil']);
    expect(byId.get('X15')!.length).toBeGreaterThanOrEqual(6);
    expect(byId.get('X16')!.map((p) => p.model!.role).sort()).toEqual(['concrete', 'stone']);
    expect(byId.get('X20')!.map((p) => p.model!.role)).toEqual(['lawn']);
  });

  it('keeps a raised planter\'s soil below its walls\' top, and a bed at grade\'s cover a little below its edging', () => {
    const { mesh } = meshed(everyHabit());
    const top = (id: string, role: string) => Math.max(...mesh.parts.filter((p) => p.id === id && p.model?.role === role).map((p) => p.bbox.max[2]));
    expect(top('X11', 'concrete') - top('X11', 'soil')).toBe(50 * MM);
    expect(top('X10', 'corten') - top('X10', 'barkMulch')).toBe(15 * MM);
  });

  it('is the same bytes every time', async () => {
    const doc = everyHabit();
    const a = mesher.meshDocument(doc, { validate: OFFICIAL_READER });
    const b = (await loadMesher()).meshDocument(JSON.stringify(doc), { validate: OFFICIAL_READER });
    expect(b.parts.map((p) => p.key)).toEqual(a.parts.map((p) => p.key));
    a.parts.forEach((p, i) => { expect(Buffer.from(b.parts[i]!.mesh.positions.buffer).equals(Buffer.from(p.mesh.positions.buffer)), p.key).toBe(true); });
  });
});
