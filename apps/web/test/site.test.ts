/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
/**
 * FLR-T-15.1: the site's Ops as the editor writes them — the lot on $site, FS_site's setbacks, spots,
 * contour lines and pads on $document, declared once; heights typed in the survey's feet; the house's
 * pad fitted to its walls; and the plan's site layers on the lowest level only.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_READER } from '@floorspec/engine';
import { apply as applyLocally } from '@floorspec/ops';
import { readModel, type EditorModel } from '../src/editor/model';
import { addContour, addPad, addSpot, benchmarkOf, fitHousePad, FT, heightText, housePadOf, parseHeight, removeLot, setLot, setSetback, setStreet } from '../src/editor/site/ops';
import { siteDrawingOf } from '../src/editor/site/Layer';
import type { Batch } from '../src/editor/ops';

const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const LOT = readFileSync(new URL('../../worker/test/fixtures/courtyard-house-on-its-lot.json', import.meta.url), 'utf8');

/** Apply a batch as the server's applier does (Ops 0.4, the official reader), and read the result back. */
function applied(model: EditorModel, batch: Batch | ((n: number) => Batch)): EditorModel {
  const b = typeof batch === 'function' ? batch(0) : batch;
  const r = applyLocally(model.document, { batch: b }, OFFICIAL_READER);
  expect(r.status, JSON.stringify(r.status === 'committed' ? [] : r.diagnostics)).toBe('committed');
  if (r.status !== 'committed') throw new Error('rejected');
  return readModel(r.hash, r.document);
}

describe('the site in the editor', () => {
  it('reads heights in the survey’s feet, against the benchmark', () => {
    expect(parseHeight('811.25', 0)).toBe(Math.round(811.25 * FT));
    expect(parseHeight("811.25'", 814 * FT)).toBe(Math.round(811.25 * FT) - 814 * FT);
    expect(parseHeight('811.25 ft', 0)).toBe(Math.round(811.25 * FT));
    expect(parseHeight('eleven', 0)).toBeNull();
    expect(heightText(-FT / 2, 814 * FT)).toBe('813.50');
  });

  it('draws a lot, sets the street, surveys it and grades the house — each a batch the applier commits', () => {
    let m = readModel('h', HOUSE);
    const ft = (x: number, y: number): [number, number] => [x * FT, y * FT];
    m = applied(m, setLot(m, [ft(-34, 92), ft(-33, -27), ft(114, -30), ft(113, 93)]));
    expect(m.document.site?.boundary).toHaveLength(4);
    m = applied(m, setStreet(m, 0));
    expect(m.document.extensionsUsed?.['FS_site']).toBe('0.1.0');
    m = applied(m, setSetback(m, 'rear', 20 * FT));
    m = applied(m, addSpot(m, ft(-30, -20), -5 * FT));
    m = applied(m, addSpot(m, ft(110, -20), 2 * FT));
    m = applied(m, addSpot(m, ft(110, 90), 3 * FT));
    m = applied(m, addContour(m, [ft(-30, 90), ft(-30, 90), ft(0, 40)], -4 * FT));
    expect(Object.keys((m.document.extensions as { FS_site: { spots: object } }).FS_site.spots)).toEqual(['SP1', 'SP2', 'SP3']);
    expect(siteDrawingOf(m).surface?.points).toHaveLength(5);
    const level = m.levels.find((l) => l.id === 'L1')!;
    const fit = fitHousePad(m, level);
    expect(fit).not.toBeNull();
    m = applied(m, fit!);
    expect(housePadOf(m)?.elevation).toBe(-8 * 32_512);
    const x = (m.derived?.extensions as { FS_site: { grading: Record<string, { cut: string | null }> } }).FS_site;
    expect(Object.keys(x.grading)).toEqual(expect.arrayContaining(['PAD1', 'SL1', 'SL2', 'SL3', 'SL4']));
    expect(BigInt(x.grading.PAD1!.cut ?? '0')).toBeGreaterThan(0n);
    // a second fit moves the pad, never a second one
    expect(Array.isArray(fitHousePad(m, level))).toBe(true);
    // a lot of three corners keeps its street on an edge it has; removing the lot removes its setbacks
    const three = applied(m, setLot(m, [ft(-34, 92), ft(-33, -27), ft(114, -30)]));
    expect((three.document.extensions as { FS_site: { setbacks: { street: number[] } } }).FS_site.setbacks.street).toEqual([0]);
    const none = applied(m, removeLot(m));
    expect(none.document.site?.boundary).toBeUndefined();
    expect((none.document.extensions as { FS_site: { setbacks?: unknown } }).FS_site.setbacks).toBeUndefined();
    expect(applied(m, addPad(m, [ft(80, 0), ft(90, 0), ft(90, 10)], 0)).document).toBeDefined();
  });

  it('reads the Courtyard House on its lot: the benchmark, the house pad, the site drawn', () => {
    const m = readModel('l', LOT);
    expect(benchmarkOf(m)).toBe(Math.round(814.5 * FT));
    expect(housePadOf(m)?.id).toBe('PAD1');
    const d = siteDrawingOf(m);
    expect(d.edges.map((e) => e.kind)).toEqual(['front', 'side', 'rear', 'side']);
    expect(d.surface?.triangles.length).toBeGreaterThan(40);
  });
});
