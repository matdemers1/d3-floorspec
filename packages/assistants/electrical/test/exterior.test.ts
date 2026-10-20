import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, OFFICIAL_READER } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { exteriorOf } from '@floorspec/render2d/exterior';
import { EXTERIOR_DEFAULTS, proposeExterior, walksOf, readPlan, withExteriorDefaults } from '../src/index.js';

/**
 * The electrical assistant's exterior lighting (FLR-T-15.5) on the Courtyard House: path lights
 * along the walks and the drive at Floorspec's spacing defaults, a wall-washer at an unlit entry,
 * step lights on exterior steps, a 12 V transformer fed from the panel with its control and taps,
 * and an "Evening exterior" scene — one batch the reference applier commits, the same every time,
 * advisory in what it says.
 */

const IN = 32_512;
const FT = 12 * IN;
const COURTYARD = readFileSync(new URL('../../../../apps/worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');

type Json = Record<string, unknown>;

function commit(doc: string, batch: unknown[]): string {
  const r = apply(doc, { batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}

const lightsOf = (doc: string): Record<string, Json> => ((JSON.parse(doc) as { extensions: { FS_electrical: { collections: { lights: Record<string, Json> } } } }).extensions.FS_electrical.collections.lights);

describe('exterior lighting for the Courtyard House', () => {
  const p = proposeExterior(COURTYARD, { level: 'L1' });
  const after = commit(COURTYARD, p.batch);
  const derived = check(after, OFFICIAL_READER).derived!;

  it('commits, and the plan stays valid', () => {
    expect(check(after, OFFICIAL_READER).valid).toBe(true);
    expect(p.added.lights.length).toBeGreaterThan(5);
  });

  it('finds the dark stretches of the walks and the drive before proposing', () => {
    expect(p.exterior.stretches.map((s) => s.walk).sort()).toEqual(['LS-H1', 'SL3', 'SL4']);
    expect(p.exterior.stretches.find((s) => s.walk === 'SL4')?.kind).toBe('walk');
    expect(p.exterior.stretches.find((s) => s.walk === 'SL3')?.kind).toBe('drive');
  });

  it('spaces path lights along the front walk at the default, on alternating sides, off the paving', () => {
    const lights = lightsOf(after);
    const walk = walksOf(readPlan(after, { grid: IN }), EXTERIOR_DEFAULTS, 'L1').find((w) => w.id === 'SL4')!;
    const [a, b] = walk.line as [readonly [number, number], readonly [number, number]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L] as const;
    const onWalk = p.added.lights
      .filter((id) => exteriorOf(lights[id]!)?.kind === 'path')
      .map((id) => derived.placements![id]!.point)
      .map((pt) => ({ t: (pt[0] - a[0]) * u[0] + (pt[1] - a[1]) * u[1], s: -(pt[0] - a[0]) * u[1] + (pt[1] - a[1]) * u[0] }))
      .filter((x) => Math.abs(x.s) < walk.halfWidth + 2 * FT)
      .sort((x, y) => x.t - y.t);
    expect(onWalk.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < onWalk.length; i++) {
      expect(Math.abs(onWalk[i]!.t - onWalk[i - 1]!.t - EXTERIOR_DEFAULTS.walkSpacing)).toBeLessThan(2 * FT);
      expect(Math.sign(onWalk[i]!.s)).not.toBe(Math.sign(onWalk[i - 1]!.s));
    }
    // A foot off the walk's edge, on the ground.
    for (const x of onWalk) expect(Math.abs(Math.abs(x.s) - walk.halfWidth - EXTERIOR_DEFAULTS.setback)).toBeLessThan(IN);
  });

  it('lights the drive along its house side only, at the drive spacing', () => {
    const drive = p.exterior.groups.find((g) => g.where === 'driveway');
    expect(drive?.count).toBe(3);
    expect(drive?.detail).toContain('house side');
  });

  it('puts a wall-washer beside an entry with no light near it, on the outside face', () => {
    const lights = lightsOf(after);
    const washers = p.added.lights.filter((id) => exteriorOf(lights[id]!)?.kind === 'wallWash');
    expect(washers.length).toBeGreaterThanOrEqual(1);
    for (const id of washers) expect((lights[id]!['host'] as Json)['mode']).toBe('wallFace');
    // The doors with lanterns beside them are left alone.
    expect(p.exterior.groups.filter((g) => g.kind === 'wallWash').map((g) => g.where)).not.toContain('entry O1');
  });

  it('feeds a 12 V transformer from the panel, switches every lamp on a photocell and timer, and taps it within its limits', () => {
    const doc = JSON.parse(after) as { extensions: { FS_electrical: { collections: { panels: Record<string, Json>; switches: Record<string, Json> }; circuits: Record<string, Json> } } };
    const t = doc.extensions.FS_electrical.collections.panels[p.exterior.transformer!.id]!;
    expect(t['volts']).toEqual([12]);
    const feed = doc.extensions.FS_electrical.circuits[t['fedBy'] as string]!;
    expect(feed).toMatchObject({ volts: 120, protection: ['gfci'] });
    const control = doc.extensions.FS_electrical.collections.switches[p.added.switches[0]!]!;
    expect(control['control']).toBe('timer');
    expect([...(control['controls'] as string[])].sort()).toEqual([...p.added.lights].sort());
    const taps = p.circuits.filter((c) => c.panel === p.exterior.transformer!.id);
    expect(taps.flatMap((c) => c.loads).sort()).toEqual([...p.added.lights].sort());
    for (const c of taps) expect(c.estimatedLoad).toBeLessThanOrEqual(Math.floor(15 * 12 * 0.8));
    // No FS_electrical error, and no lint but the feed's: a feeder lists no loads of its own (3.4).
    const elec = check(after, OFFICIAL_READER).diagnostics.filter((d) => d.code.startsWith('FS-ELEC'));
    expect(elec.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('adds an "Evening exterior" scene with every exterior light on, the lanterns too, and each lamp at 2700 K', () => {
    const lighting = (JSON.parse(after) as { extensions: { FS_lighting: { scenes: Record<string, { name: string; on: Record<string, unknown> }>; luminaires: Record<string, Json> } } }).extensions.FS_lighting;
    const scene = lighting.scenes[p.exterior.scene!.id]!;
    expect(scene.name).toBe('Evening exterior');
    for (const id of [...p.added.lights, 'L-EXT-1', 'L-EXT-2', 'L-EXT-3']) expect(Object.keys(scene.on)).toContain(id);
    for (const id of p.added.lights) expect(lighting.luminaires[id]?.['cct']).toBe(2700);
  });

  it('says it uses Floorspec’s defaults and checks no code, and never says compliant', () => {
    const text = p.explanation.join(' ');
    expect(text).toContain('Floorspec’s spacing defaults');
    expect(text).toContain('no code is checked or cited');
    expect(text).toContain('not a lighting calculation');
    expect(text.toLowerCase()).not.toContain('compliant');
  });

  it('is the same batch every time', () => {
    expect(JSON.stringify(proposeExterior(COURTYARD, { level: 'L1' }).batch)).toBe(JSON.stringify(p.batch));
  });

  it('finds nothing dark on the walks once its proposal is accepted', () => {
    const again = proposeExterior(after, { level: 'L1' });
    expect(again.exterior.stretches).toEqual([]);
    expect(again.exterior.groups.some((g) => g.kind === 'path')).toBe(false);
  });

  it('takes a wider spacing, and refuses a bad one', () => {
    const wide = proposeExterior(COURTYARD, { level: 'L1', defaults: { walkSpacing: 16 * FT } });
    const n = (q: typeof p) => q.exterior.groups.find((g) => g.where === 'front walk')?.count ?? 0;
    expect(n(wide)).toBeLessThan(n(p));
    expect(() => withExteriorDefaults({ walkSpacing: 0 })).toThrow(RangeError);
  });
});

describe('step lights on exterior steps', () => {
  it('puts one on each riser of a stair that stands outside every room, at the tread below it', () => {
    const doc = JSON.parse(COURTYARD) as Json & { stairs: Record<string, Json> };
    // Deck stairs on the lawn west of the house, up to the upper level.
    doc.stairs['ST-DECK'] = { level: 'L1', to: 'L2', name: 'Deck stairs', position: [-9000000, 0], rotation: 0, tread: 325120, width: 1170432, maxRiser: 251968, minHeadroom: 2600960 };
    const src = JSON.stringify(doc);
    expect(check(src, OFFICIAL_READER).valid).toBe(true);
    const p = proposeExterior(src, { level: 'L1' });
    const after = commit(src, p.batch);
    const stair = check(after, OFFICIAL_READER).derived!.stairs!['ST-DECK']!;
    const lights = lightsOf(after);
    const steps = p.added.lights.filter((id) => exteriorOf(lights[id]!)?.kind === 'step');
    expect(steps).toHaveLength(stair.steps!.filter((s) => s.landing !== true).length);
    expect(p.exterior.groups.find((g) => g.kind === 'step')?.detail).toBe('one per riser');
    // The lowest one 4" over the ground at the foot.
    const lowest = lights[steps[0]!]!;
    expect(((lowest['fallback'] as Json)['box'] as { min: number[] }).min[2]).toBe(stair.bottom + 4 * IN);
  });
});
