/**
 * FLR-T-13.12: lighting scenes (FS_lighting 0.1.0, FLR-ADR-043) as every view resolves them — the
 * showcase house's lights with a luminaire record and two scenes, through `lightsOf` with a lighting,
 * `scenesOf`/`sceneNamed`, the switch toggle and the lens glows.
 */
import { describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, OFFICIAL_READER, type Derived, type FloorspecDocument } from '@floorspec/engine';
import showcase from './fixtures/showcase.floorspec.json' with { type: 'json' };
import { ALL_OFF, ALL_ON, kelvinColor, lensGlows, lightsOf, sameLighting, sceneNamed, scenesOf, settingOf, toggled, withLights, withSetting } from '../src/index.js';

type Json = Record<string, unknown>;

function withScenes(): object {
  const doc = structuredClone(showcase) as Json;
  (doc['extensionsUsed'] as Json)['FS_lighting'] = '0.1.0';
  (doc['extensions'] as Json)['FS_lighting'] = {
    luminaires: { E7: { lumens: 1000, cct: 2700, cctRange: [2200, 3000], dimmable: true }, E12: { cct: 3500 } },
    scenes: {
      LS1: { name: 'Evening', on: { E7: { output: 40, cct: 2400 }, E15: {} } },
      LS2: { name: 'Night light', on: { E13: { output: 10 } } },
    },
  };
  return doc;
}

function derive(input: object): { doc: FloorspecDocument; derived: Derived } {
  const ev = evaluate(input, OFFICIAL_READER);
  if (!ev.valid) throw new Error(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('\n'));
  return { doc: (ev.view ?? ev.document)!, derived: deriveEvaluation(ev) };
}

describe('lighting scenes', () => {
  const { doc, derived } = derive(withScenes());
  const all = lightsOf(doc, derived);
  const ids = all.map((l) => l.id);

  it('validates and derives as FS_lighting says', () => {
    expect(derived.extensions?.FS_lighting).toEqual({
      scenes: { LS1: { name: 'Evening', on: ['E15', 'E7'], dimmed: ['E7'] }, LS2: { name: 'Night light', on: ['E13'], dimmed: ['E13'] } },
      luminaires: { E12: { scenes: [] }, E13: { scenes: ['LS2'] }, E15: { scenes: ['LS1'] }, E7: { scenes: ['LS1'] } },
    });
  });

  it('takes a luminaire’s own lumens and colour temperature in place of the typical lamp’s', () => {
    const byId = new Map(all.map((l) => [l.id, l]));
    expect(byId.get('E7')).toMatchObject({ lumens: 1000, fullLumens: 1000, output: 100, kelvin: 2700, ownKelvin: 2700 });
    expect(byId.get('E12')).toMatchObject({ kelvin: 3500, ownKelvin: 3500, color: kelvinColor(3500) });
    expect(byId.get('E15')!.kelvin).toBe(3000);
  });

  it('offers All on, the document’s scenes and Off, and finds one by name', () => {
    expect(scenesOf(doc).map((s) => `${s.id ?? '-'} ${s.name}`)).toEqual(['- All on', 'LS1 Evening', 'LS2 Night light', '- Off']);
    expect(sceneNamed(doc, 'Evening')?.id).toBe('LS1');
    expect(sceneNamed(doc, 'evening')?.id).toBe('LS1');
    expect(sceneNamed(doc, 'on')?.lighting).toBe(ALL_ON);
    expect(sceneNamed(doc, 'OFF')?.lighting).toBe(ALL_OFF);
    expect(sceneNamed(doc, 'Dinner')).toBeUndefined();
  });

  it('lights only what a scene turns on, at its output and colour temperature', () => {
    const evening = sceneNamed(doc, 'Evening')!.lighting;
    const lit = lightsOf(doc, derived, evening);
    expect(lit.map((l) => l.id)).toEqual(['E15', 'E7']);
    const e7 = lit.find((l) => l.id === 'E7')!;
    expect(e7).toMatchObject({ lumens: 400, fullLumens: 1000, output: 40, kelvin: 2400, ownKelvin: 2700, color: kelvinColor(2400) });
    expect(lightsOf(doc, derived, ALL_OFF)).toEqual([]);
    // "All on" is what every view drew before scenes.
    expect(lightsOf(doc, derived, ALL_ON)).toEqual(all);
  });

  it('flips a switch: its lights off when any is on, else on — and nothing else', () => {
    const evening = sceneNamed(doc, 'Evening')!.lighting;
    // E5 controls the kitchen's two downlights, off in the evening: on, at full.
    const on = toggled(evening, ids, ['E8', 'E9']);
    expect(lightsOf(doc, derived, on).map((l) => l.id)).toEqual(['E15', 'E7', 'E8', 'E9']);
    expect(settingOf(on, 'E7')).toEqual({ output: 40, cct: 2400 });
    const off = toggled(on, ids, ['E8', 'E9']);
    expect(sameLighting(off, evening, ids)).toBe(true);
    // From "All on", a switch turns its lights off and leaves the rest on.
    expect(lightsOf(doc, derived, toggled(ALL_ON, ids, ['E8', 'E9'])).map((l) => l.id)).toEqual(ids.filter((id) => id !== 'E8' && id !== 'E9'));
    // One of two on: the switch turns both off.
    expect(settingOf(toggled(withLights(ALL_OFF, ids, ['E8'], true), ids, ['E8', 'E9']), 'E8')).toBeNull();
  });

  it('dims a light and sets its colour temperature, within FS_lighting’s ranges', () => {
    const dim = withSetting(ALL_ON, ids, 'E12', { output: 250, cct: 99 });
    expect(settingOf(dim, 'E12')).toEqual({ output: 100, cct: 1000 });
    expect(settingOf(withSetting(ALL_ON, ids, 'E12', { output: 0 }), 'E12')).toEqual({ output: 1 });
  });

  it('dims a lens with its lamp, recolours it, and turns it off', () => {
    const evening = sceneNamed(doc, 'Evening')!.lighting;
    const glows = lensGlows(all, lightsOf(doc, derived, evening));
    expect(glows.get('E8')).toBeNull();
    expect(glows.has('E15')).toBe(false);
    const g = glows.get('E7')!;
    const to = kelvinColor(2400);
    const from = kelvinColor(2700);
    expect(g.map((c) => c.toFixed(6))).toEqual([0, 1, 2].map((k) => ((0.4 * to[k]!) / from[k]!).toFixed(6)));
    expect(lensGlows(all, all).size).toBe(0);
  });

  it('reads no scene from a document that does not declare FS_lighting', () => {
    const plain = structuredClone(showcase) as Json;
    expect(scenesOf(plain as unknown as FloorspecDocument).map((s) => s.name)).toEqual(['All on', 'Off']);
  });
});
