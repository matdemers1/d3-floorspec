/**
 * The property tests over real documents: every valid case of the vendored conformance suites (the
 * walls, joins, openings, floors, ceilings, slabs, roofs and stairs the standard pins), the editor's
 * template and the plan renderer's fixture houses, and the layout solver's ranch under a hip roof.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate } from '@floorspec/engine';
import { loadKernel, type Kernel } from '../src/kernel.js';
import { loadMesher, type Mesher } from '../src/index.js';
import { conformanceInputs, templates, type Named } from './fixtures.js';
import { ranch } from './houses.js';
import { checkHouse } from './props.js';

let kernel: Kernel;
let mesher: Mesher;
beforeAll(async () => {
  kernel = await loadKernel();
  mesher = await loadMesher();
});

function meshAndCheck(input: string | object, name: string): ReturnType<typeof checkHouse> & { kinds: Set<string> } {
  const ev = evaluate(input);
  const derived = deriveEvaluation(ev);
  const doc = (ev.view ?? ev.document)!;
  const mesh = mesher.meshDerived(doc, derived, { stats: true });
  return { ...checkHouse(kernel, doc, derived, mesh, name), kinds: new Set(mesh.parts.map((p) => p.kind)) };
}

describe('the conformance suites', () => {
  it('meshes every valid case with every property holding', () => {
    const valid: Named[] = conformanceInputs().filter((c) => evaluate(c.text).valid);
    expect(valid.length).toBeGreaterThan(300);
    const kinds = new Set<string>();
    let solids = 0;
    let openings = 0;
    for (const c of valid) {
      const r = meshAndCheck(c.text, c.name);
      for (const k of r.kinds) kinds.add(k);
      solids += r.solids;
      openings += r.openings;
    }
    // Every kind of part was produced and checked — but a roof's gable ends, which only a roof with
    // a thickness has as parts of their own: no case declares one (the generated houses do).
    expect([...kinds].sort()).toEqual(['ceiling', 'extension', 'floor', 'junctionFill', 'opening', 'roof', 'slab', 'stairBlock', 'stairFlight', 'stairLanding', 'wall'].sort());
    expect(solids).toBeGreaterThan(1000);
    expect(openings).toBeGreaterThan(50);
  });
});

describe('the templates and fixture houses', () => {
  for (const t of templates())
    it(t.name, () => {
      const r = meshAndCheck(t.text, t.name);
      expect(r.openings).toBeGreaterThan(0);
    });

  it("the layout solver's ranch under a hip roof", () => {
    const doc = ranch();
    const r = meshAndCheck(doc, 'ranch');
    expect(r.kinds.has('roof')).toBe(true);
    expect(r.openings).toBeGreaterThan(10);
  });
});

describe('determinism', () => {
  it('meshes the same document to the same bytes', async () => {
    const doc = ranch();
    const a = mesher.meshDocument(doc);
    const b = (await loadMesher()).meshDocument(JSON.stringify(doc));
    expect(b.parts.map((p) => p.key)).toEqual(a.parts.map((p) => p.key));
    a.parts.forEach((p, i) => {
      const q = b.parts[i]!;
      expect(Buffer.from(q.mesh.positions.buffer).equals(Buffer.from(p.mesh.positions.buffer)), p.key).toBe(true);
      expect(Buffer.from(q.mesh.indices.buffer).equals(Buffer.from(p.mesh.indices.buffer)), p.key).toBe(true);
    });
  });
});

describe('a hip roof, against the closed form', () => {
  it('encloses exactly h · D · (3W − D) / 6 above its eave', () => {
    const c = conformanceInputs().find((x) => x.name === '0.3/roofs/001-hip-roof')!;
    const roof = mesher.meshDocument(c.text, { include: ['roof'], stats: true }).parts[0]!;
    // The eave outline is 6016000 × 4736000 at 6 : 12, so the ridge stands h = 4736000 / 4 above the eave.
    const [W, D] = [6_016_000n, 4_736_000n];
    const h = D / 4n;
    expect(BigInt(roof.stats!.volume6!)).toBe(h * D * (3n * W - D));
    expect(roof.bbox).toEqual({ min: [-448_000, -448_000, 3_456_000], max: [5_568_000, 4_288_000, 4_640_000] });
  });
});
