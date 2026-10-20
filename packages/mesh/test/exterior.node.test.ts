/**
 * FLR-T-15.5: the light exterior lights give — a path light down and out from under its cap, an
 * uplight aimed up at what is ahead of it, a wall-washer down its wall, a step light onto its tread,
 * a string from three of its bulbs — at their kind's lumens and 2700 K unless FS_lighting says
 * otherwise, under a scene like any light.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, OFFICIAL_READER, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { EXTERIOR_DEFS, exteriorMembers, stringBox, type ExteriorKind } from '@floorspec/render2d/exterior';
import { lightsOf, sceneNamed } from '../src/index.js';

type Json = Record<string, unknown>;
const IN = 32_512;
const FT = 12 * IN;
const COURTYARD = readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');

function derive(input: object): { doc: FloorspecDocument; derived: Derived } {
  const ev = evaluate(input, OFFICIAL_READER);
  if (!ev.valid) throw new Error(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('\n'));
  return { doc: (ev.view ?? ev.document)!, derived: deriveEvaluation(ev) };
}

function withLights(): Json {
  const doc = JSON.parse(COURTYARD) as Json & { extensions: { FS_electrical: { collections: { lights: Record<string, Json> } }; FS_lighting: { luminaires: Record<string, Json>; scenes: Record<string, Json> } } };
  const lights = doc.extensions.FS_electrical.collections.lights;
  const free = (id: string, kind: ExteriorKind, position: [number, number], rotation = 0, box?: Json) => {
    const m = exteriorMembers(kind);
    lights[id] = { ...m, fallback: { level: 'L1', box: box ?? structuredClone(EXTERIOR_DEFS[kind].box) }, host: { mode: 'free', level: 'L1', position, ...(rotation === 0 ? {} : { rotation }) } };
  };
  free('XP', 'path', [-8_000_000, 12_000_000]);
  // Facing east, at the tree LS-T2 6' ahead of it.
  free('XU', 'uplight', [-7_680_000 - 6 * FT, 2_944_000]);
  free('XS', 'step', [-6_000_000, 6_000_000], 90_000_000);
  free('XT', 'string', [26_000_000, 10_000_000], 0, stringBox(12 * FT));
  lights['XW'] = { ...exteriorMembers('wallWash'), fallback: { level: 'L1', box: structuredClone(EXTERIOR_DEFS.wallWash.box) }, host: { mode: 'wallFace', wall: 'W21', side: 'left', offset: 1_500_000, height: 6 * FT } };
  doc.extensions.FS_lighting.luminaires['XP'] = { lumens: 200, cct: 3000 };
  doc.extensions.FS_lighting.scenes['LS9'] = { name: 'Grounds', on: { XP: { output: 50 }, XU: {} } };
  return doc;
}

describe('the light of exterior lights', () => {
  const { doc, derived } = derive(withLights());
  const lights = lightsOf(doc, derived);
  const of = (id: string) => lights.filter((l) => l.id === id);

  it('gives each kind its lamps, outside every room, at integer positions', () => {
    for (const id of ['XP', 'XU', 'XS', 'XW']) expect(of(id)).toHaveLength(1);
    expect(of('XT')).toHaveLength(3);
    expect(of('XT').map((l) => l.part)).toEqual([0, 1, 2]);
    for (const id of ['XP', 'XU', 'XS', 'XW', 'XT']) for (const l of of(id)) {
      expect(l.room).toBeNull();
      expect(l.fixture).toBe('exterior');
      expect(l.position.every(Number.isInteger)).toBe(true);
    }
  });

  it('shines a path light down from under its cap, and an uplight up towards what is ahead of it', () => {
    const [p] = of('XP');
    expect(p!.direction).toBe('aimed');
    expect(p!.aim).toEqual([0, 0, -1]);
    expect(p!.position[2]).toBeLessThan(EXTERIOR_DEFS.path.box.max[2]);
    expect(p!.position[2]).toBeGreaterThan(EXTERIOR_DEFS.path.box.max[2] - 100 * 1280);
    const [u] = of('XU');
    expect(u!.aim![2]).toBeGreaterThan(0.8);
    expect(u!.aim![0]).toBeGreaterThan(0.1);
    expect(Math.abs(u!.aim![1])).toBeLessThan(1e-3);
    expect(u!.cone!.outer).toBeCloseTo(Math.cos((25 / 2) * (Math.PI / 180)), 3);
  });

  it('tips a step light’s light down its facing and a wall-washer’s down its wall', () => {
    const [s] = of('XS');
    // Facing north: forward and down.
    expect(s!.aim![1]).toBeGreaterThan(0.3);
    expect(s!.aim![2]).toBeLessThan(-0.5);
    const [w] = of('XW');
    expect(w!.aim![2]).toBeLessThan(-0.8);
  });

  it('gives a kind’s lumens and 2700 K, a string its bulbs’ shared among its lamps, and FS_lighting’s own when it has them', () => {
    expect(of('XU')[0]!.lumens).toBe(EXTERIOR_DEFS.uplight.lumens);
    expect(of('XU')[0]!.kelvin).toBe(2700);
    const t = of('XT');
    expect(t.reduce((a, l) => a + l.lumens, 0)).toBe(6 * EXTERIOR_DEFS.string.lumens);
    expect(of('XP')[0]!.lumens).toBe(200);
    expect(of('XP')[0]!.kelvin).toBe(3000);
  });

  it('follows a scene: on at its output, off when it is not in it', () => {
    const scene = sceneNamed(doc, 'Grounds')!;
    const lit = lightsOf(doc, derived, scene.lighting);
    expect([...new Set(lit.map((l) => l.id))].sort()).toEqual(['XP', 'XU']);
    expect(lit.find((l) => l.id === 'XP')!.lumens).toBe(100);
  });
});
