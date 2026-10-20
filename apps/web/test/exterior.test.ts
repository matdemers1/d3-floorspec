/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMesher, sceneNamed, type HouseMesh } from '@floorspec/mesh';
import { beamOf, EXTERIOR_DEFS, exteriorOf } from '@floorspec/render2d';
import { readModel, type EditorModel, type LevelView } from '../src/editor/model';
import { DEVICE_KINDS, kindById, kindOfElement, kindLabel } from '../src/editor/systems/catalog';
import { beamLabel, exteriorHover, levelWalks } from '../src/editor/systems/exterior';
import { placeDevice } from '../src/editor/systems/ops';
import { RAILS } from '../src/editor/modes';
import { levelOrder } from '../src/editor/three/parts';
import { exteriorFirst, MAX_LIGHTS, viewLights } from '../src/editor/three/lights';
import { lightsOf } from '@floorspec/mesh';

/**
 * FLR-T-15.5: placing exterior lights in the editor — the Electrical rail's exterior group, the kinds
 * the catalogue knows them by, where each snaps (a path light to a walk's edge at the spacing from the
 * one before it, alternating sides; an uplight into a tree's canopy; a string between two points),
 * every placement one placeElement — and the 3D view lighting the grounds first under an exterior scene.
 */

const IN = 32_512;
const FT = 12 * IN;
const COURTYARD = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const NIGHT = readFileSync(new URL('../../worker/test/fixtures/courtyard-night.json', import.meta.url), 'utf8');

let model: EditorModel;
let level: LevelView;
beforeAll(() => {
  model = readModel('courtyard', COURTYARD);
  level = model.levels.find((l) => l.id === 'L1')!;
});

const o = { grid: IN, tol: 6 * IN, units: 'imperial' as const };

describe('the exterior kinds in the editor', () => {
  it('are a group of their own on the Electrical rail, under a rule', () => {
    const rail = RAILS.electrical;
    const rule = rail.findIndex((r) => 'rule' in r);
    expect(rule).toBeGreaterThan(0);
    expect(rail.slice(rule + 1).map((r) => ('device' in r ? r.device : ''))).toEqual(['pathLight', 'uplight', 'wallWash', 'stepLight', 'stringLight']);
    for (const id of ['pathLight', 'uplight', 'wallWash', 'stepLight', 'stringLight']) expect(kindById(id)?.collection).toBe('lights');
  });

  it('knows an exterior light by its kind, and a lantern as the light it always was', () => {
    for (const k of DEVICE_KINDS.filter((x) => x.exterior !== undefined)) expect(kindOfElement('FS_electrical', 'lights', k.members)?.id).toBe(k.id);
    expect(kindOfElement('FS_electrical', 'lights', { fixture: 'exterior' })?.id).toBe('light');
    expect(kindLabel('FS_electrical', 'lights', { fixture: 'exterior' })).toBe('Exterior light');
    expect(kindOfElement('FS_electrical', 'lights', { fixture: 'recessed' })?.id).toBe('light');
  });
});

describe('placing them', () => {
  it('snaps a path light to the front walk’s edge, a foot off it, facing it', () => {
    const walk = levelWalks(model, 'L1').find((w) => w.id === 'SL4')!;
    const kind = kindById('pathLight')!;
    // Two feet south of the walk, west of the stepping stones that leave it.
    const mid = [-10_000_000, walk.line[0]![1] - walk.halfWidth - 2 * FT] as [number, number];
    const h = exteriorHover(model, level, kind, mid, o)!;
    expect(h.host.mode).toBe('free');
    expect(Math.abs(h.point[1] - (walk.line[0]![1] - walk.halfWidth - 12 * IN))).toBeLessThan(2);
    // Facing north, at the walk.
    expect(h.facing[1]).toBeCloseTo(1, 5);
    expect(h.hint).toBe('Along the walk · 8\'-0" apart · alternating sides');
  });

  it('spaces the next one 8′ along from the one before it, on the other side', () => {
    const kind = kindById('pathLight')!;
    const walk = levelWalks(model, 'L1').find((w) => w.id === 'SL4')!;
    const y0 = walk.line[0]![1];
    const first = exteriorHover(model, level, kind, [-10_000_000, y0 - walk.halfWidth - FT], o)!;
    const placed = readModel('courtyard', JSON.stringify(applyHost(JSON.parse(COURTYARD) as Doc, 'XP1', first.point, first.host.mode === 'free' ? (first.host.rotation ?? 0) : 0)));
    const lvl = placed.levels.find((l) => l.id === 'L1')!;
    const next = exteriorHover(placed, lvl, kind, [first.point[0] + 7 * FT, y0 - walk.halfWidth - FT], o)!;
    expect(Math.abs(next.point[0] - first.point[0] - 8 * FT)).toBeLessThan(2);
    expect(Math.sign(next.point[1] - y0)).toBe(-Math.sign(first.point[1] - y0));
    expect(next.tag).toBe('8\'-0" to XP1');
  });

  it('aims an uplight into a tree’s canopy from just outside it, and draws its cone to the trunk', () => {
    const tree = level.devices.find((d) => d.id === 'LS-T2')!;
    const kind = kindById('uplight')!;
    const h = exteriorHover(model, level, kind, [tree.placement!.point[0] + 3 * FT, tree.placement!.point[1]], o)!;
    expect(h.tag).toBe('into the canopy');
    expect(h.patch?.reach).toBeGreaterThan(10 * FT);
    expect(h.point[0]).toBeGreaterThan(tree.placement!.point[0]);
    // Facing west, at the trunk.
    expect(h.facing[0]).toBeCloseTo(-1, 5);
    const batch = placeDevice(model.document, kind, h.host, { ...(h.patch === undefined ? {} : { patch: h.patch }) });
    const el = (batch.at(-1) as { element: Record<string, unknown> }).element;
    expect(exteriorOf(el)).toMatchObject({ kind: 'uplight', reach: h.patch!.reach });
    const beam = beamOf('U', el, { point: h.point, facing: 180_000_000 })!;
    expect(Math.min(...beam.ring.map((p) => p[0]))).toBeLessThan(tree.placement!.point[0]);
  });

  it('strings lights between two points: a first click, then a run with its bulbs', () => {
    const kind = kindById('stringLight')!;
    const start = exteriorHover(model, level, kind, [1_000_000, 8_000_000], o)!;
    expect(start.hint).toContain('click where the run starts');
    const run = exteriorHover(model, level, kind, [1_000_000 + 24 * FT, 8_000_000], { ...o, from: start.point })!;
    expect(run.box?.max[0]).toBe(24 * FT);
    expect(run.patch?.bulbs).toBe(12);
    expect(run.tag).toBe('24\'-0" · 12 bulbs');
    const batch = placeDevice(model.document, kind, run.host, { box: run.box!, patch: run.patch! });
    expect((batch.at(-1) as { element: { watts: number } }).element.watts).toBe(12 * EXTERIOR_DEFS.string.watts);
  });

  it('says a beam by its kind and spread', () => {
    expect(beamLabel('uplight', 15, 0, 'imperial')).toBe('Uplight · 15° spot');
    expect(beamLabel('path', 360, 3 * FT, 'imperial')).toBe('Path light · 6\'-0" ⌀ pool');
  });
});

describe('the 3D view at night', () => {
  let night: EditorModel;
  let mesh: HouseMesh;
  beforeAll(async () => {
    night = readModel('night', NIGHT);
    mesh = (await loadMesher()).meshDerived(night.view, night.derived!, { origin: [0, 0, 0] });
  }, 120_000);

  it('lights the grounds first under an exterior scene, unshadowed, within its lamps', () => {
    const scene = sceneNamed(night.view, 'Night exterior')!.lighting;
    expect(exteriorFirst(lightsOf(night.view, night.derived!, scene))).toBe(true);
    const lamps = viewLights(night, mesh, { level: null, cutaway: false, order: levelOrder(night) }, scene, 4);
    expect(lamps.length).toBe(MAX_LIGHTS);
    const outside = lamps.filter((l) => night.ext.get(l.id) !== undefined && !['L-GR-PD', 'L-KIT-P1', 'L-KIT-P2', 'L-GR-R1', 'L-GR-R2', 'L-GR-R3', 'L-GR-R4'].includes(l.id));
    expect(outside.length).toBe(MAX_LIGHTS);
    expect(outside.every((l) => !l.shadow)).toBe(true);
    // Every key is its own: a string's bulbs are lamps of one light.
    expect(new Set(lamps.map((l) => l.key)).size).toBe(lamps.length);
    // An uplight's spot looks up.
    expect(lamps.some((l) => l.kind === 'spot' && (l.aim?.[2] ?? 0) > 0.5)).toBe(true);
  });

  it('keeps the rooms first with every light on', () => {
    expect(exteriorFirst(lightsOf(night.view, night.derived!))).toBe(false);
  });
});

type Doc = { extensions: { FS_electrical: { collections: { lights: Record<string, unknown> } } } };
function applyHost(doc: Doc, id: string, at: readonly [number, number], rotation: number): Doc {
  const k = kindById('pathLight')!;
  doc.extensions.FS_electrical.collections.lights[id] = { ...structuredClone(k.members), fallback: { level: 'L1', box: structuredClone(k.box) }, host: { mode: 'free', level: 'L1', position: [Math.round(at[0]), Math.round(at[1])], ...(rotation === 0 ? {} : { rotation }) } };
  return doc;
}
