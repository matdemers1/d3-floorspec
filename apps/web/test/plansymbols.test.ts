/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { DOOR_OPERATIONS, OFFICIAL_READER, type DoorOperation, type FloorspecDocument } from '@floorspec/engine';
import { buildScene, doorSymbol, fixtureSymbol } from '@floorspec/render2d';
import { readModel, type EditorModel, type LevelView } from '../src/editor/model';
import { Plan } from '../src/editor/Canvas';
import { doorParts, fixtureParts, partPath } from '../src/editor/plansymbols';
import { SystemsLayer } from '../src/editor/systems/Symbols';
import { kindById, type DeviceKind } from '../src/editor/systems/catalog';
import { placeDevice } from '../src/editor/systems/ops';
import { FurnitureItem, FurnitureLayer, symbolSources } from '../src/furniture/Plan';
import { libraryItem, type LibraryItem } from '../src/furniture/library';
import { placeFurniture, type StoredFile } from '../src/furniture/ops';
import { spotIn } from '../src/furniture/placement';
import type { Layers, Viewport } from '../src/editor/store';
import type { Batch } from '../src/editor/ops';

/**
 * The editor's plan canvas draws doors, furniture and plumbing fixtures from render2d's plan symbols
 * (FLR-T-12.27): every door by its type's operation, and every item by its symbol image or its kind's
 * outline — the same parts the SVG plan, MCP's render and the worker's drawings draw.
 */

const IN = 32_512;
const FT = 12 * IN;
const HOUSE = readFileSync(new URL('../src/projects/templates/three-room-house.floorspec.json', import.meta.url), 'utf8');
const LAYERS: Layers = { walls: true, openings: true, rooms: true, dimensions: false, findings: true, electrical: true, plumbing: true, mechanical: true, lowvoltage: true, clearances: false, coreOnly: false, roof: false };
const VIEW: Viewport = { cx: 20 * FT, cy: 15 * FT, s: 0.0001, w: 1200, h: 900 };

function commit(doc: string, batch: Batch): string {
  const r = apply(doc, { batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}
const model = (doc: string): EditorModel => readModel('p', doc);
const json = (doc: string) => JSON.parse(doc) as FloorspecDocument;
const levelOf = (m: EditorModel): LevelView => m.levels[0]!;

/** The template house with its bedroom door's type (D32) of `operation`. */
const withOperation = (operation: DoorOperation): string => commit(HOUSE, [{ op: 'setProperty', id: 'D32', path: '/operation', value: operation }]);

/** One opening's group on the plan, as markup. */
function openingMarkup(doc: string, id: string): string {
  const m = model(doc);
  const html = renderToStaticMarkup(createElement('svg', null, createElement(Plan, { view: VIEW, level: levelOf(m), document: m.document, layers: LAYERS, units: 'imperial', labels: false })));
  const at = html.indexOf(`data-opening="${id}"`);
  expect(at, `no group for ${id}`).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf('</g>', at));
}
const count = (html: string, cls: string) => html.split(`class="${cls}"`).length - 1;

describe('doors on the plan, by operation (Core 8.4)', () => {
  it('reads each door’s operation from its type, and none for a type that declares none', () => {
    const m = model(withOperation('pocket'));
    const ops = Object.fromEntries(levelOf(m).openings.map((o) => [o.id, o.operation]));
    expect(ops['BD']).toBe('pocket');
    expect(ops['FD']).toBeUndefined();
    expect(ops['BW']).toBeUndefined();
  });

  it('draws render2d’s parts for every operation, exactly', () => {
    for (const operation of DOOR_OPERATIONS) {
      const doc = withOperation(operation);
      const level = levelOf(model(doc));
      const scene = buildScene(doc, 'MAIN');
      for (const o of level.openings.filter((x) => x.kind === 'door')) {
        const wall = level.walls.find((w) => w.id === o.wall)!;
        const so = scene.openings.get(o.id)!;
        expect(doorParts(o, wall), `${operation} ${o.id}`).toEqual(doorSymbol(so, scene.walls.get(o.wall)!).parts);
      }
    }
  });

  it('draws a single swing as one leaf and its swing, as the plan always has', () => {
    const g = openingMarkup(HOUSE, 'BD');
    expect(g).toContain('data-operation="swing"');
    expect(count(g, 'fs-plan2__leaf')).toBe(1);
    expect(count(g, 'fs-plan2__swing')).toBe(1);
  });

  it('draws a pair’s two leaves and two swings meeting at the middle', () => {
    const g = openingMarkup(withOperation('doubleSwing'), 'BD');
    expect(g).toContain('data-operation="doubleSwing"');
    expect(count(g, 'fs-plan2__leaf')).toBe(2);
    expect(count(g, 'fs-plan2__swing')).toBe(2);
  });

  it('draws a pocket door’s leaf half out of its pocket, the pocket and the leaf in it dashed in the wall', () => {
    const g = openingMarkup(withOperation('pocket'), 'BD');
    expect(count(g, 'fs-plan2__leaf')).toBe(1);
    expect(count(g, 'fs-plan2__inwall')).toBe(2);
    expect(count(g, 'fs-plan2__swing')).toBe(0);
  });

  it('draws bypass leaves, a barn door, a bifold, an overhead door and a cased opening', () => {
    const bypass = openingMarkup(withOperation('bypassSlide'), 'BD');
    expect(count(bypass, 'fs-plan2__leaf')).toBe(2);
    const barn = openingMarkup(withOperation('surfaceSlide'), 'BD');
    expect([count(barn, 'fs-plan2__leaf'), count(barn, 'fs-plan2__hidden')]).toEqual([1, 1]);
    const bifold = openingMarkup(withOperation('bifold'), 'BD');
    expect(count(bifold, 'fs-plan2__leaf')).toBeGreaterThanOrEqual(1);
    const overhead = openingMarkup(withOperation('overhead'), 'BD');
    expect([count(overhead, 'fs-plan2__leaf'), count(overhead, 'fs-plan2__hidden')]).toEqual([0, 1]);
    const cased = openingMarkup(withOperation('cased'), 'BD');
    expect(cased).not.toContain('<path');
  });
});

describe('symbol parts on screen', () => {
  it('draws a polyline through the screen points, closed when the part is', () => {
    const view: Viewport = { cx: 0, cy: 0, s: 1, w: 100, h: 100 };
    expect(partPath(view, { kind: 'path', pts: [[0, 0], [10, 0], [10, 10]], closed: true, stroke: 'leaf' })).toBe('M50.0,50.0L60.0,50.0L60.0,40.0Z');
    expect(partPath(view, { kind: 'path', pts: [[0, 0], [10, 0]], closed: false, stroke: 'leaf' })).toBe('M50.0,50.0L60.0,50.0');
  });

  it('turns an arc the short way, as render2d does: y runs down the screen', () => {
    const view: Viewport = { cx: 0, cy: 0, s: 1, w: 100, h: 100 };
    // From (10, 0) to (0, 10) about the origin: counter-clockwise in plan, clockwise on screen.
    expect(partPath(view, { kind: 'arc', centre: [0, 0], radius: 10, from: [10, 0], to: [0, 10], stroke: 'swing' })).toBe('M60.0,50.0A10.0,10.0 0 0 0 50.0,40.0');
    expect(partPath(view, { kind: 'arc', centre: [0, 0], radius: 10, from: [0, 10], to: [10, 0], stroke: 'swing' })).toBe('M50.0,40.0A10.0,10.0 0 0 1 60.0,50.0');
  });
});

const kind = (id: string): DeviceKind => kindById(id) as DeviceKind;

describe('plumbing fixtures on the plan', () => {
  const doc = commit(HOUSE, placeDevice(json(HOUSE), kind('toilet'), { mode: 'surface', room: 'BED', surface: 'floor', at: [30 * FT, 6 * FT] }));
  const m = model(doc);
  const toilet = levelOf(m).devices.find((d) => d.kind?.id === 'toilet')!;

  it('outlines a toilet as render2d does: its tank and its bowl, on its box', () => {
    const scene = buildScene(doc, 'MAIN');
    const parts = fixtureParts(toilet);
    expect(parts).not.toBeNull();
    expect(parts).toEqual(fixtureSymbol(scene.fallbacks.get(toilet.id)!));
  });

  it('draws them in the systems layer, in the plumbing tone, at a scale where it is outlined', () => {
    const view: Viewport = { ...VIEW, s: 0.0004 };
    const html = renderToStaticMarkup(createElement('svg', null, createElement(SystemsLayer, { view, level: levelOf(m), document: m.document, derived: m.derived, layers: LAYERS, selection: null })));
    expect(html).toContain(`data-fixture="${toilet.id}"`);
    expect(count(html, 'fs-fixture__outline')).toBeGreaterThanOrEqual(2);
  });
});

/** A library item's files as the asset route would answer them. */
function stored(item: LibraryItem): { model: StoredFile; symbol: StoredFile } {
  return {
    model: { sha256: item.model.sha256, mediaType: item.model.mediaType, byteLength: item.model.byteLength, path: `assets/${item.model.sha256}.glb`, name: `${item.id}.glb` },
    symbol: { sha256: item.symbol.sha256, mediaType: item.symbol.mediaType, byteLength: item.symbol.byteLength, path: `assets/${item.symbol.sha256}.svg`, name: `${item.id}.svg` },
  };
}

const BED = libraryItem('bed-queen-1600')!;

/** The template house with the library's queen bed in its bedroom: an FS_furniture piece always carries its symbol (FS-INV-603). */
function placeBed(): string {
  const m = model(HOUSE);
  const spot = spotIn(levelOf(m), 'BED', { box: BED.box, mounting: BED.mounting, category: BED.category, clearances: BED.clearances, height: 1_756_160 });
  return commit(HOUSE, placeFurniture(m, { kind: BED.kind, category: BED.category, name: BED.name, box: BED.box, clearances: BED.clearances, ...stored(BED), host: spot!.host })(0));
}

describe('furniture on the plan', () => {
  const doc = placeBed();
  const m = model(doc);
  const bed = levelOf(m).devices.find((d) => d.extension === 'FS_furniture')!;

  it('draws an item as its symbol image from the asset store, with the library’s copy of it next in line', () => {
    const html = renderToStaticMarkup(createElement('svg', null, createElement(FurnitureLayer, { view: VIEW, level: levelOf(m), model: m, layers: LAYERS, projectId: 'p1' })));
    expect(html).toContain('data-drawn="symbol"');
    const sources = symbolSources('p1', BED.symbol.sha256);
    expect(html).toContain(`href="${sources[0]!}"`);
    expect(sources).toHaveLength(2);
    expect(sources[1]).toBe(BED.symbol.url);
    expect(symbolSources('p1', 'f'.repeat(64))).toHaveLength(1);
    expect(symbolSources('p1', null)).toEqual([]);
  });

  it('draws an item whose symbol bytes are not there as its kind’s outline — a bed and its pillows — the parts render2d draws', () => {
    expect(fixtureParts(bed)).toEqual(fixtureSymbol(buildScene(doc, 'MAIN').fallbacks.get(bed.id)!));
    const html = renderToStaticMarkup(createElement('svg', null, createElement(FurnitureItem, { view: VIEW, d: bed, symbol: null, blocked: false, projectId: 'p1' })));
    expect(html).toContain('data-drawn="outline"');
    expect(html).not.toContain('<image');
    expect(count(html, 'fs-fixture__detail')).toBeGreaterThanOrEqual(2);
    // An outline draws its own edge: the box is not edged over it, unless it is in the warning tone.
    expect(count(html, 'fs-furn-item__outline')).toBe(0);
    const warned = renderToStaticMarkup(createElement('svg', null, createElement(FurnitureItem, { view: VIEW, d: bed, symbol: null, blocked: true, projectId: 'p1' })));
    expect(count(warned, 'fs-furn-item__outline')).toBe(1);
  });
});
