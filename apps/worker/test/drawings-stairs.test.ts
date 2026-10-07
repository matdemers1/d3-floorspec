/**
 * FLR-T-12.10: the worker's PDF sheets and DXF files draw a stair as the editor's plan does
 * (render2d, FLR-T-12.9): a winder stair's winders tinted, its newel solid, a spiral's column solid,
 * and where the floor above must be open from (Core 0.4, 17.6). In the DXF each is on a National CAD
 * Standard layer of its own: A-FLOR-STRS-PATT, A-FLOR-HRAL and A-FLOR-OVHD.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dxfParser from 'dxf-parser';
import { buildScene, newelOutline, stairSymbol, type NewelSource } from '@floorspec/render2d';
import { describe, expect, it } from 'vitest';
import { exportDxf, exportPdf, isNcsName, levelPlan, type Sheet } from '../src/export/drawings/index.js';
import { mm, triangles } from '../src/export/drawings/dxf.js';
import type { PathPrim } from '../src/export/drawings/sheet.js';

// dxf-parser is CommonJS: Node's ESM loader names its export, Vite's interop hands over the default.
const DxfParser: typeof dxfParser.DxfParser =
  typeof dxfParser.DxfParser === 'function' ? dxfParser.DxfParser : (dxfParser as unknown as { default: typeof dxfParser.DxfParser }).default;

interface Parsed {
  tables: { layer: { layers: Record<string, { name: string; color: number }> } };
  entities: { type: string; layer: string; vertices?: { x: number; y: number }[]; points?: { x: number; y: number }[] }[];
}
const parse = (bytes: Uint8Array): Parsed => new DxfParser().parseSync(new TextDecoder().decode(bytes)) as unknown as Parsed;

const stair04 = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../packages/engine/standard/conformance/core/0.4/stairs/${name}/input.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const VERSION = { hash: '3c9e1f0a71fe5b0c2d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c', seq: 3, at: new Date('2026-10-06T12:00:00Z') };
const fontDir = mkdtempSync(join(tmpdir(), 'floorspec-fonts-stairs-'));

const WINDER_TINT = '#e0daf3';
const OPENING = '#714e00';
const INK = '#000000';

const paths = (s: Sheet): PathPrim[] => s.prims.filter((p): p is PathPrim => p.t === 'path');
const texts = (s: Sheet): string[] => s.prims.flatMap((p) => (p.t === 'text' ? [p.text] : []));

describe('stair marks on the worker’s plans, as render2d draws them', () => {
  it('carries a winder stair’s winders and newel, the same as the editor’s, on both levels', () => {
    const d = stair04('050-winder-with-newel');
    const up = levelPlan(d, 'L1').stairs[0]!;
    const down = levelPlan(d, 'L2').stairs[0]!;
    const editor = buildScene(d, 'L1').stairs.get('ST1')!;
    const sym = stairSymbol(editor.derived, editor.form, editor.column, editor.newel);
    expect(up.steps.map((s) => s.winder)).toEqual(sym.steps.map((s) => s.winder && !s.landing));
    expect(up.steps.filter((s) => s.winder)).toHaveLength(3);
    expect(up.newel).toEqual(newelOutline((d as { stairs: Record<string, NewelSource> }).stairs['ST1']!));
    expect(up.newel).toEqual(sym.newel);
    // Looking down the stairwell, the same winders and newel; the opening mark is the rising level's.
    expect(down.steps.filter((s) => s.winder)).toHaveLength(3);
    expect(down.newel).toEqual(up.newel);
    expect(down.opening).toBeNull();
    // A straight stair has neither.
    const straight = levelPlan(stair04('058-opening'), 'L1').stairs[0]!;
    expect(straight.steps.some((s) => s.winder)).toBe(false);
    expect(straight.newel).toBeNull();
  });

  it('carries where the floor above must be open from, at render2d’s edge', () => {
    for (const name of ['058-opening', '061-winder-opening']) {
      const d = stair04(name);
      const st = levelPlan(d, 'L1').stairs[0]!;
      const editor = buildScene(d, 'L1').stairs.get('ST1')!;
      expect(st.opening, name).not.toBeNull();
      expect(st.opening).toEqual(stairSymbol(editor.derived, editor.form, editor.column, editor.newel).opening);
    }
    expect(levelPlan(stair04('001-straight-stair'), 'L1').stairs[0]!.opening).toBeNull();
  });

  it('carries a spiral’s column', () => {
    const d = stair04('016-spiral');
    const st = levelPlan(d, 'L1').stairs[0]!;
    const editor = buildScene(d, 'L1').stairs.get('ST1')!;
    expect(st.column).not.toBeNull();
    expect(st.column).toEqual(stairSymbol(editor.derived, editor.form, editor.column, editor.newel).column);
  });
});

describe('the PDF sheet', () => {
  it('tints the winders, fills the newel, marks the opening dash-dot, and says so in the legend', async () => {
    const pdf = await exportPdf(stair04('061-winder-opening'), { version: VERSION, fontDir, levels: ['L1'], viewDpi: 72 });
    const sheet = pdf.sheets[0]!;
    const all = paths(sheet);
    // One tint path for the stair's three winders, and the legend's swatch.
    const tints = all.filter((p) => p.fill === WINDER_TINT);
    expect(tints.length).toBe(2);
    expect((tints[0]!.d.match(/Z/g) ?? []).length).toBe(3);
    // The tint is drawn before the treads' lines, so they read through it.
    const firstTread = all.findIndex((p) => p.stroke === INK && p.width === 0.35 && p.fill === undefined);
    expect(all.indexOf(tints[0]!)).toBeLessThan(firstTread);
    expect(all.some((p) => p.fill === INK && p.stroke === INK && p.join === 'miter')).toBe(true);
    const opening = all.filter((p) => p.stroke === OPENING);
    expect(opening.length).toBe(2); // the mark and its legend line
    expect(opening[0]!.dash).toEqual([4, 1, 1, 1]);
    for (const label of ['Winder (tapered tread), tinted', 'Newel post or spiral column', 'Floor above open from here (headroom)']) expect(texts(sheet)).toContain(label);
  });

  it('leaves the marks and their legend lines off a stair that has none', async () => {
    const pdf = await exportPdf(stair04('001-straight-stair'), { version: VERSION, fontDir, levels: ['L1'], viewDpi: 72 });
    const sheet = pdf.sheets[0]!;
    expect(paths(sheet).some((p) => p.fill === WINDER_TINT || p.stroke === OPENING)).toBe(false);
    expect(texts(sheet)).not.toContain('Winder (tapered tread), tinted');
    expect(texts(sheet)).not.toContain('Floor above open from here (headroom)');
  });
});

describe('the DXF', () => {
  it('puts the tint, the newel and the opening on NCS layers of their own, at the model’s coordinates', () => {
    const d = stair04('061-winder-opening');
    const dxf = exportDxf(d, { version: VERSION, levels: ['L1'] });
    const doc = parse(dxf.bytes);
    const declared = doc.tables.layer.layers;
    for (const name of ['A-FLOR-STRS-PATT', 'A-FLOR-HRAL', 'A-FLOR-OVHD']) {
      expect(isNcsName(name), name).toBe(true);
      expect(declared[name], name).toBeDefined();
    }
    const on = (layer: string): Parsed['entities'] => doc.entities.filter((e) => e.layer === layer);
    // Three winders as SOLID triangles, drawn before the treads.
    const tint = on('A-FLOR-STRS-PATT');
    expect(tint.length).toBeGreaterThanOrEqual(3);
    expect(tint.every((e) => e.type === 'SOLID')).toBe(true);
    const firstTread = doc.entities.findIndex((e) => e.layer === 'A-FLOR-STRS' && e.type === 'LWPOLYLINE');
    expect(doc.entities.indexOf(tint[0]!)).toBeLessThan(firstTread);
    // The newel: filled and outlined.
    expect(on('A-FLOR-HRAL').map((e) => e.type).sort()).toEqual(['LWPOLYLINE', 'SOLID', 'SOLID']);
    // The opening: one line, the edge render2d draws, exactly.
    const text = new TextDecoder().decode(dxf.bytes);
    const st = levelPlan(d, 'L1').stairs[0]!;
    const [a, b] = st.opening!;
    expect(on('A-FLOR-OVHD').map((e) => e.type)).toEqual(['LINE']);
    expect(text).toContain(`A-FLOR-OVHD\r\n100\r\nAcDbLine\r\n 10\r\n${mm(a[0])}\r\n 20\r\n${mm(a[1])}\r\n 30\r\n0.0\r\n 11\r\n${mm(b[0])}\r\n 21\r\n${mm(b[1])}`);
  });

  it('puts a spiral’s column on A-FLOR-HRAL, and nothing new on a plain straight stair', () => {
    const spiral = parse(exportDxf(stair04('016-spiral'), { version: VERSION, levels: ['L1'] }).bytes);
    expect(spiral.entities.filter((e) => e.layer === 'A-FLOR-HRAL').map((e) => e.type)).toEqual(['CIRCLE']);
    const plain = parse(exportDxf(stair04('001-straight-stair'), { version: VERSION, levels: ['L1'] }).bytes);
    expect(plain.entities.filter((e) => ['A-FLOR-STRS-PATT', 'A-FLOR-HRAL', 'A-FLOR-OVHD'].includes(e.layer))).toEqual([]);
  });

  it('fills a polygon with triangles that cover it exactly', () => {
    const area = (t: readonly (readonly [number, number])[]): number => Math.abs(t.reduce((s, p, i) => s + p[0] * t[(i + 1) % t.length]![1] - t[(i + 1) % t.length]![0] * p[1], 0)) / 2;
    const l: [number, number][] = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]];
    const ts = triangles(l);
    expect(ts).toHaveLength(4);
    expect(ts.reduce((s, t) => s + area(t), 0)).toBe(area(l));
    // Clockwise, closed, and with a vertex on a straight run: the same cover, no sliver.
    expect(triangles([[0, 0], [0, 2], [2, 2], [2, 1], [2, 0], [0, 0]]).reduce((s, t) => s + area(t), 0)).toBe(4);
  });
});
