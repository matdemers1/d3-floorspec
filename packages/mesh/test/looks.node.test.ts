/**
 * Seasons and weather on a meshed house (FLR-T-15.4, looks.ts): on the Courtyard House — a Japanese
 * maple, a red maple and two columnar hornbeams (deciduous), evergreen boxwoods, groundcovers and grasses
 * whose foliage is not stated, two lawns, beds, stepping stones and its roofs — the season → foliage
 * mapping, a deciduous tree bare in winter, autumn's leaves, and a light snow on the roofs and lawns
 * but not the walk. Every look is the same bytes twice, and summer without snow is the mesh itself.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, OFFICIAL_READER, type FloorspecDocument } from '@floorspec/engine';
import { autumnHue, blossoms, landscapeCollection, lawnRole, loadMesher, lookMesh, LOOK_ROLES, MODEL_ROLES, ROLE_LOOKS, seasonRole, snowHold, wetPart, type HouseMesh, type MeshPart, type Mesher } from '../src/index.js';
import { LOOK_SEASONS } from '../src/sky/weather.js';

const HOUSE = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as object;

let mesher: Mesher;
let doc: FloorspecDocument;
let house: HouseMesh;
beforeAll(async () => {
  mesher = await loadMesher();
  const ev = evaluate(HOUSE, OFFICIAL_READER);
  if (!ev.valid) throw new Error('the Courtyard House is not valid');
  doc = (ev.view ?? ev.document)!;
  house = mesher.meshDerived(doc, deriveEvaluation(ev), {});
});

const plantParts = (mesh: HouseMesh, id: string): MeshPart[] => mesh.parts.filter((p) => p.id === id);
const roles = (parts: readonly MeshPart[]): string[] => [...new Set(parts.map((p) => p.model?.role ?? ''))].sort();
const FOLIAGE = ['foliage', 'foliageDark', 'foliageLight'];

/** Every part's bytes, for comparing two meshes. */
function digest(mesh: HouseMesh): string {
  return mesh.parts.map((p) => `${p.key}|${p.model?.role ?? ''}|${String(p.mesh.indices.length)}|${Array.from(p.mesh.indices.slice(0, 30)).join(',')}|${p.bbox.min.join(',')}|${p.bbox.max.join(',')}`).join('\n');
}

describe('the season → foliage mapping', () => {
  it('changes only a deciduous plant’s canopy, and only outside summer', () => {
    for (const season of LOOK_SEASONS)
      for (const role of FOLIAGE) {
        expect(seasonRole(role as 'foliage', season, 'evergreen')).toBe(role);
        expect(seasonRole(role as 'foliage', season, 'unstated')).toBe(role);
      }
    for (const role of ['trunk', 'grass', 'plume', 'lawn'] as const) for (const season of LOOK_SEASONS) expect(seasonRole(role, season, 'deciduous')).toBe(role);
    for (const role of FOLIAGE) expect(seasonRole(role as 'foliage', 'summer', 'deciduous')).toBe(role);
  });

  it('is bare in winter, fresh (or in blossom) in spring, and gold, orange or red in autumn', () => {
    for (const role of FOLIAGE) expect(seasonRole(role as 'foliage', 'winter', 'deciduous')).toBeNull();
    expect(seasonRole('foliage', 'spring', 'deciduous')).toBe('leafSpring');
    expect(seasonRole('foliageLight', 'spring', 'deciduous', { hue: 'gold', blossom: false })).toBe('leafSpringLight');
    expect(seasonRole('foliageLight', 'spring', 'deciduous', { hue: 'gold', blossom: true })).toBe('blossom');
    expect(seasonRole('foliage', 'autumn', 'deciduous', { hue: 'red', blossom: false })).toBe('autumnRed');
    expect(seasonRole('foliage', 'autumn', 'deciduous', { hue: 'gold', blossom: false })).toBe('autumnGold');
    expect(seasonRole('foliage', 'autumn', 'deciduous', { hue: 'orange', blossom: false })).toBe('autumnOrange');
  });

  it('turns a maple red and a hornbeam gold by name, and anything else by its ID, the same every time', () => {
    expect(autumnHue('T1', { commonName: 'Japanese maple' })).toBe('red');
    expect(autumnHue('T2', { species: 'Acer rubrum' })).toBe('red');
    expect(autumnHue('T3', { commonName: 'Columnar hornbeam' })).toBe('gold');
    expect(autumnHue('LS-T9')).toBe(autumnHue('LS-T9'));
    const hues = new Set(Array.from({ length: 40 }, (_, i) => autumnHue(`T${String(i)}`)));
    expect([...hues].sort()).toEqual(['gold', 'orange', 'red']);
    expect(blossoms('T1', { commonName: 'Kwanzan cherry' })).toBe(true);
    expect(blossoms('T1', { commonName: 'Red maple' })).toBe(false);
  });

  it('greens a lawn in spring, yellows it in autumn and leaves it dormant in winter', () => {
    expect(lawnRole('lawn', 'summer')).toBe('lawn');
    expect(lawnRole('lawn', 'spring')).toBe('lawnSpring');
    expect(lawnRole('meadow', 'winter')).toBe('meadowWinter');
    expect(lawnRole('mulch', 'winter')).toBe('mulch');
    // Every look's role has a look of its own, and is a model role.
    for (const r of LOOK_ROLES) {
      expect(MODEL_ROLES).toContain(r);
      expect(ROLE_LOOKS[r].color).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Spring's lawn is greener than summer's, winter's less green and more yellow.
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [sr, sg] = rgb(ROLE_LOOKS.lawn.color);
    expect(rgb(ROLE_LOOKS.lawnSpring.color)[1]!).toBeGreaterThan(sg!);
    expect(rgb(ROLE_LOOKS.lawnWinter.color)[0]!).toBeGreaterThan(sr!);
  });
});

describe('a look on the Courtyard House', () => {
  it('is the very mesh in summer without snow, and the same bytes twice in every other look', () => {
    expect(lookMesh(house, doc)).toBe(house);
    expect(lookMesh(house, doc, { season: 'summer', weather: 'rain' })).toBe(house);
    expect(lookMesh(house, doc, { season: 'summer', weather: 'overcast' })).toBe(house);
    for (const season of LOOK_SEASONS)
      for (const weather of ['clear', 'snow'] as const) {
        if (season === 'summer' && weather === 'clear') continue;
        expect(digest(lookMesh(house, doc, { season, weather }))).toBe(digest(lookMesh(house, doc, { season, weather })));
      }
    // The mesh it started from is untouched.
    expect(digest(house)).toBe(digest(mesher.meshDerived(doc, deriveEvaluation(evaluate(HOUSE, OFFICIAL_READER)), {})));
  });

  it('strips a deciduous tree bare in winter: its leaves gone, a crown of limbs inside the box they filled', () => {
    const plants = landscapeCollection(doc, 'plants');
    const deciduous = Object.keys(plants).filter((id) => plants[id]!['foliage'] === 'deciduous');
    expect(deciduous.sort()).toEqual(['LS-T1', 'LS-T2', 'LS-T3', 'LS-T4']);
    const winter = lookMesh(house, doc, { season: 'winter' });
    for (const id of deciduous) {
      const summer = plantParts(house, id);
      const bare = plantParts(winter, id);
      expect(roles(summer).some((r) => FOLIAGE.includes(r))).toBe(true);
      expect(roles(bare)).toEqual(['trunk']);
      const crown = bare.find((p) => p.key.endsWith(':bare'))!;
      expect(crown, id).toBeDefined();
      expect(crown.mesh.indices.length / 3).toBeGreaterThan(200);
      // Inside the tree's own box, and reaching most of the way up its crown.
      const leaves = summer.filter((p) => FOLIAGE.includes(p.model!.role));
      const top = Math.max(...leaves.map((p) => p.bbox.max[2]));
      const bottom = Math.min(...leaves.map((p) => p.bbox.min[2]));
      for (const k of [0, 1] as const) {
        expect(crown.bbox.min[k]).toBeGreaterThanOrEqual(Math.min(...leaves.map((p) => p.bbox.min[k])) - 1280 * 100);
        expect(crown.bbox.max[k]).toBeLessThanOrEqual(Math.max(...leaves.map((p) => p.bbox.max[k])) + 1280 * 100);
      }
      expect(crown.bbox.max[2]).toBeGreaterThan(bottom + (top - bottom) * 0.7);
      expect(crown.bbox.max[2]).toBeLessThanOrEqual(top + 1280 * 50);
    }
    // Evergreens and plants whose foliage is not stated keep their leaves.
    for (const id of ['LS-S2', 'LS-G1', 'LS-G4', 'LS-R1']) expect(roles(plantParts(winter, id))).toEqual(roles(plantParts(house, id)));
    // The lawns are dormant.
    expect(roles(winter.parts.filter((p) => p.extension?.collection === 'lawns'))).toEqual(['lawnWinter']);
  });

  it('colours the maples red and the hornbeam gold in autumn, and drops their leaves on the beds and the lawn', () => {
    const autumn = lookMesh(house, doc, { season: 'autumn' });
    const own = (id: string) => plantParts(autumn, id).filter((p) => !p.key.includes(':litter'));
    expect(roles(own('LS-T1'))).toEqual(['autumnBrown', 'autumnOrange', 'autumnRed', 'trunk']);
    expect(roles(own('LS-T3')).filter((r) => r !== 'trunk').every((r) => r === 'autumnGold' || r === 'autumnOrange')).toBe(true);
    for (const id of ['LS-T1', 'LS-T2', 'LS-T3']) {
      const litter = plantParts(autumn, id).filter((p) => p.key.includes(':litter'));
      expect(litter.length, id).toBeGreaterThan(0);
      for (const p of litter) {
        expect(p.closed).toBe(false);
        expect(p.facing).toBe('up');
      }
    }
    // The red maple's leaves lie on the lawn it stands in, a few millimetres over it.
    const lawnTop = Math.max(...house.parts.filter((p) => p.id === 'LS-L1').map((p) => p.bbox.max[2]));
    const fallen = plantParts(autumn, 'LS-T2').filter((p) => p.key.includes(':litter'));
    expect(Math.min(...fallen.map((p) => p.bbox.min[2]))).toBeGreaterThanOrEqual(lawnTop);
    expect(Math.max(...fallen.map((p) => p.bbox.max[2]))).toBeLessThan(lawnTop + 1280 * 200);
  });

  it('lays a light snow on the roofs, the lawns, the beds and the evergreens, and leaves the walk cleared', () => {
    const snow = lookMesh(house, doc, { weather: 'snow' });
    const covered = snow.parts.filter((p) => p.model?.role === 'snow');
    const kinds = new Set(covered.map((p) => (p.kind === 'roof' ? 'roof' : (p.extension?.collection ?? p.kind))));
    expect([...kinds].sort()).toEqual(['beds', 'lawns', 'plants', 'roof']);
    // Every roof holds snow on its slopes, and its snow faces up.
    const roofs = house.parts.filter((p) => p.kind === 'roof');
    expect(roofs.length).toBeGreaterThan(0);
    for (const r of roofs) {
      const s = snow.parts.find((p) => p.key === `${r.key}:snow`);
      expect(s, r.key).toBeDefined();
      expect(s!.kind).toBe('roof');
      expect(s!.id).toBe(r.id);
      // What is left and the snow are the roof's triangles, split.
      const left = snow.parts.find((p) => p.key === r.key);
      expect((left?.mesh.indices.length ?? 0) + s!.mesh.indices.length).toBe(r.mesh.indices.length);
    }
    expect(snow.parts.some((p) => p.extension?.collection === 'hardscape' && p.model?.role === 'snow')).toBe(false);
    expect(snow.parts.some((p) => p.model?.role === 'snow' && p.kind === 'wall')).toBe(false);
    expect(snowHold({ kind: 'extension', key: 'x', extension: { name: 'FS_landscape', collection: 'hardscape' }, model: { kind: 'path', role: 'paver' } })).toBeNull();
    expect(snowHold({ kind: 'floor', key: 'x' })).toBeNull();
  });

  it('wets what stands outside when it rains: the roofs and the landscape, not the house within', () => {
    expect(wetPart({ kind: 'roof' })).toBe(true);
    expect(wetPart({ kind: 'roofGable' })).toBe(true);
    expect(wetPart({ kind: 'extension', extension: { name: 'FS_landscape', collection: 'hardscape' } })).toBe(true);
    expect(wetPart({ kind: 'floor' })).toBe(false);
    expect(wetPart({ kind: 'extension', extension: { name: 'FS_furniture', collection: 'furniture' } })).toBe(false);
  });
});
