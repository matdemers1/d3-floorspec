import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import * as dxfParser from 'dxf-parser';

// dxf-parser is CommonJS: Node's ESM loader names its export, Vite's interop hands over the default.
const DxfParser: typeof dxfParser.DxfParser =
  typeof dxfParser.DxfParser === 'function' ? dxfParser.DxfParser : (dxfParser as unknown as { default: typeof dxfParser.DxfParser }).default;
import { describe, expect, it } from 'vitest';
import {
  areaText,
  dimensionStrings,
  exportDxf,
  exportPdf,
  isNcsName,
  LAYER_DEFS,
  layerForDevice,
  lengthText,
  levelPlan,
  NOT_FOR_CONSTRUCTION,
  openingMarks,
  pitchText,
  ROOF_PLAN_TITLE,
  sheetToSvg,
  type Sheet,
} from '../src/export/drawings/index.js';
import type { ImagePrim } from '../src/export/drawings/sheet.js';
import { mm } from '../src/export/drawings/dxf.js';
import { unionOutline } from '../src/export/drawings/plan.js';
import { storedZip } from '../src/export/drawings/zip.js';
import { buildScene } from '@floorspec/render2d';
import { rasterize, pngSize } from '../src/render/index.js';

const fixture = (path: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, unknown>;
const RANCH = fixture('../../../packages/mcp/test/fixtures/two-bedroom-ranch.json');
const L_SHAPED = fixture('../../../packages/mcp/test/fixtures/l-shaped-house.json');
const TWO_STOREY = fixture('./fixtures/two-storey.json');
const L_STAIR = fixture('../../web/e2e/fixtures/l-stair-hip-roof.json');
const KITCHEN = fixture('../../../packages/engine/standard/conformance/core/0.3/examples/002-kitchen-options/input.json');
/** A core-only reader (Core 1.6.4): implements no extension, knows none. */
const CORE_ONLY = {};
const VERSION = { hash: '3c9e1f0a71fe5b0c2d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c', seq: 42, at: new Date('2026-10-04T18:30:00Z') };
const fontDir = mkdtempSync(join(tmpdir(), 'floorspec-fonts-drawings-'));

const texts = (s: Sheet): string[] => {
  const out: string[] = [];
  const walk = (prims: Sheet['prims']): void => {
    for (const p of prims) {
      if (p.t === 'text') out.push(p.text);
      if (p.t === 'clip') walk(p.children);
    }
  };
  walk(s.prims);
  return out;
};

/** The pages of a PDF, by its page objects (PDFKit writes them uncompressed). */
const pageCount = (pdf: Uint8Array): number => (Buffer.from(pdf).toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('lengths and areas as a drawing prints them', () => {
  it('formats feet, inches and sixteenths exactly, rounding once, ties to even', () => {
    expect(lengthText(4_893_056, 'imperial')).toBe(`12'-6 1/2"`); // 150.5 in
    expect(lengthText(3_121_152, 'imperial')).toBe(`8'-0"`);
    expect(lengthText(24_384, 'imperial')).toBe(`3/4"`);
    expect(lengthText(390_144 + 2_032, 'imperial')).toBe(`1'-0 1/16"`);
    // 1.5/16" is a tie: to the even sixteenth, 2/16 = 1/8"; 0.5/16" goes to 0.
    expect(lengthText(3_048, 'imperial')).toBe(`1/8"`);
    expect(lengthText(1_016, 'imperial')).toBe(`0"`);
  });

  it('formats metric as whole millimetres, ties to even', () => {
    expect(lengthText(4_876_800, 'metric')).toBe('3810');
    expect(lengthText(640, 'metric')).toBe('0');
    expect(lengthText(1_920, 'metric')).toBe('2');
  });

  it('formats net areas from the engine’s exact half-unit strings', () => {
    expect(areaText('152212340736', 'imperial')).toBe('1 SF');
    expect(areaText('76106170368', 'imperial')).toBe('0 SF'); // half a square foot: to even
    expect(areaText('228318511104', 'imperial')).toBe('2 SF'); // one and a half: to even
    expect(areaText('1638400000000', 'metric')).toBe('1.0 m²');
    expect(areaText('25559040000000.5', 'metric')).toBe('15.6 m²');
  });

  it('writes a DXF coordinate as the exact millimetres a base-unit integer is', () => {
    expect(mm(1280)).toBe('1.0');
    expect(mm(1)).toBe('0.00078125');
    expect(mm(-32_512)).toBe('-25.4');
    expect(mm(390_144)).toBe('304.8');
    expect(mm(0)).toBe('0.0');
  });
});

describe('layers', () => {
  it('names every layer in the National CAD Standard pattern', () => {
    for (const l of LAYER_DEFS) expect(isNcsName(l.name), l.name).toBe(true);
    expect(new Set(LAYER_DEFS.map((l) => l.name)).size).toBe(LAYER_DEFS.length);
    expect(isNcsName('Walls')).toBe(false);
    expect(isNcsName('A-WALL-EXTERIOR')).toBe(false);
  });

  it('puts extension elements on their discipline’s layer', () => {
    expect(layerForDevice('FS_electrical', 'receptacles')).toBe('E-POWR-DEVC');
    expect(layerForDevice('FS_electrical', 'lights')).toBe('E-LITE-FIXT');
    expect(layerForDevice('FS_plumbing', 'fixtures')).toBe('P-FIXT');
    expect(layerForDevice('FS_mechanical', 'terminals')).toBe('M-HVAC-DEVC');
    expect(layerForDevice('FS_lowvoltage', 'outlets')).toBe('T-COMM-DEVC');
    expect(layerForDevice('acme_widgets', 'widgets')).toBe('A-EQPM');
  });
});

describe('plan geometry', () => {
  it('outlines the union of wall pieces: shared edges cancel, outside and inside loops remain', () => {
    const square = (x: number, y: number, s: number) => [
      [x, y],
      [x + s, y],
      [x + s, y + s],
      [x, y + s],
    ] as [number, number][];
    // Two unit squares side by side: their shared edge cancels, leaving six edges.
    const edges = unionOutline([
      { ring: square(0, 0, 10), exterior: true },
      { ring: square(10, 0, 10), exterior: true },
    ]);
    expect(edges).toHaveLength(6);
    // A square beside a taller one: the shared edge is split at the shorter's corner first.
    const split = unionOutline([
      { ring: square(0, 0, 10), exterior: true },
      { ring: [[10, -5], [20, -5], [20, 15], [10, 15]], exterior: true },
    ]);
    expect(split.some((e) => e.a[0] === 10 && e.b[0] === 10 && e.a[1] === 0 && e.b[1] === 10)).toBe(false);
  });

  it('numbers doors and windows over the whole model, level by level, in reading order', () => {
    const scenes = ['MAIN', 'UPPER'].map((l) => buildScene(TWO_STOREY, l));
    const marks = openingMarks(scenes);
    const doors = [...marks].filter(([, m]) => m.startsWith('D'));
    const windows = [...marks].filter(([, m]) => m.startsWith('W'));
    expect(doors.map(([, m]) => m)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']);
    expect(windows).toHaveLength(17);
    // The front door, on the south wall of the lower level, is the last door of that level.
    expect(marks.get('FD')).toBe('D4');
    // A cased opening is not a door or a window and has no mark.
    expect(marks.has('LH')).toBe(false);
  });

  it('dimensions a rectangle with an overall string and an openings string, and no jog string', () => {
    const plan = levelPlan(RANCH, 'MAIN', openingMarks([buildScene(RANCH, 'MAIN')]));
    const dims = dimensionStrings(plan);
    const north = dims.filter((d) => d.side === 'N');
    expect(north.map((d) => d.kind)).toEqual(['openings', 'overall']);
    const overall = north.find((d) => d.kind === 'overall')!;
    expect(overall.points).toEqual([plan.body!.minX, plan.body!.maxX]);
    // The overall string is the openings string's ends, and its pieces add up exactly.
    const openings = north.find((d) => d.kind === 'openings')!;
    expect(openings.points[0]).toBe(overall.points[0]);
    expect(openings.points.at(-1)).toBe(overall.points[1]);
    for (const d of dims) for (const p of d.points) expect(Number.isInteger(p)).toBe(true);
    // 44'-2 3/8": the ranch's outside, 44' between junctions plus half of two 2×6 walls' outer layers.
    expect(lengthText(overall.points[1]! - overall.points[0]!, 'imperial')).toBe(`44'-2 3/8"`);
  });

  it('dimensions the jogs of an L-shaped house', () => {
    const plan = levelPlan(L_SHAPED, 'MAIN');
    const kinds = dimensionStrings(plan).map((d) => `${d.side}:${d.kind}`);
    expect(kinds).toContain('N:segments');
    expect(kinds).toContain('E:segments');
    expect(kinds).not.toContain('S:segments');
  });
});

describe('PDF sheets', () => {
  it('draws a sheet per level, then a schedule sheet when the schedule fits beside no plan', async () => {
    const pdf = await exportPdf(TWO_STOREY, { version: VERSION, fontDir });
    expect(pdf.name).toBe('two-storey-ranch-v42-plans.pdf');
    expect(pdf.contentType).toBe('application/pdf');
    expect(Buffer.from(pdf.bytes.subarray(0, 8)).toString('latin1')).toBe('%PDF-1.7');
    expect(pdf.sheets.map((s) => [s.number, s.title])).toEqual([
      ['A-101', 'Main floor plan'],
      ['A-102', 'Upper floor plan'],
      ['A-601', 'Door and window schedule'],
    ]);
    expect(pageCount(pdf.bytes)).toBe(3);
  });

  it('keeps the schedule on the plan sheet when there is room for it', async () => {
    const pdf = await exportPdf(L_SHAPED, { version: VERSION, fontDir });
    expect(pdf.sheets).toHaveLength(1);
    expect(texts(pdf.sheets[0]!)).toContain('MAIN FLOOR — DOOR AND WINDOW SCHEDULE');
  });

  it('carries the title block, the mark, dimensions, room labels and door and window marks', async () => {
    const pdf = await exportPdf(TWO_STOREY, { version: VERSION, fontDir, levels: ['UPPER'] });
    expect(pdf.sheets).toHaveLength(2);
    const t = texts(pdf.sheets[0]!);
    expect(t).toContain(NOT_FOR_CONSTRUCTION);
    expect(t.some((s) => s.startsWith('Not a plan review.'))).toBe(true);
    expect(t).toContain('Two-storey ranch');
    expect(t).toContain('UPPER FLOOR PLAN');
    expect(t).toContain('v42 · 3c9e1f0a71fe');
    // The version's own date, never the day the export ran.
    expect(t).toContain('2026-10-04');
    expect(t).toContain('3/16" = 1\'-0"');
    expect(t).toContain('A-101');
    expect(t).toContain(`44'-2 3/8"`);
    expect(t).toContain('FAMILY ROOM');
    expect(t).toContain('361 SF');
    // Marks number the whole model: the upper level's doors follow the lower level's four.
    expect(t).toContain('D5');
    expect(t).not.toContain('D1');
    // Rules advise; a drawing never says a design meets a code (FLR-ADR-011).
    expect(t.join(' ').toLowerCase()).not.toContain('compliant');
  });

  it('is the same bytes for the same version, whenever it is made', async () => {
    const a = await exportPdf(TWO_STOREY, { version: VERSION, fontDir });
    const b = await exportPdf(TWO_STOREY, { version: VERSION, fontDir });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    const latin = Buffer.from(a.bytes).toString('latin1');
    expect(latin).toContain('D:20261004183000Z');
  });

  it('prints metric dimensions in millimetres at a metric scale for a metric project', async () => {
    const metric = { ...RANCH, extras: { d3floorspec: { units: 'metric' } } };
    const pdf = await exportPdf(metric, { version: VERSION, fontDir });
    const t = texts(pdf.sheets[0]!);
    expect(t.some((s) => /^1:\d+$/.test(s))).toBe(true);
    const body = levelPlan(RANCH, 'MAIN').body!;
    const overall = lengthText(body.maxX - body.minX, 'metric');
    expect(overall).toMatch(/^\d+$/);
    expect(t).toContain(overall);
    expect(t.some((s) => s.endsWith(' m²'))).toBe(true);
  });

  it('fits a larger page at a larger scale', async () => {
    const small = await exportPdf(TWO_STOREY, { version: VERSION, fontDir, page: 'letter', levels: ['MAIN'] });
    const large = await exportPdf(TWO_STOREY, { version: VERSION, fontDir, page: 'arch-d', levels: ['MAIN'] });
    expect(texts(small.sheets[0]!)).toContain('1/8" = 1\'-0"');
    expect(texts(large.sheets[0]!)).toContain('1/4" = 1\'-0"');
    // ARCH D has room for the schedule beside the plan.
    expect(large.sheets).toHaveLength(1);
  });

  it('renders as a legible sheet (SVG preview through the plan fonts)', async () => {
    const pdf = await exportPdf(TWO_STOREY, { version: VERSION, fontDir, levels: ['MAIN'] });
    const { openPdf } = await import('../src/export/drawings/pdf.js');
    const svg = sheetToSvg(pdf.sheets[0]!, openPdf({ title: '', subject: '', date: VERSION.at }, fontDir).measure);
    const png = rasterize(svg, { width: 1700, fontDir });
    expect(pngSize(png)).toEqual({ width: 1700, height: 1100 });
  });

  it('refuses a level the model does not have', async () => {
    await expect(exportPdf(RANCH, { version: VERSION, fontDir, levels: ['ATTIC'] })).rejects.toThrow(/no level ATTIC/);
  });
});

describe('stairs, roofs, designs and the 3D view (FLR-T-9.7)', () => {
  const images = (s: Sheet): ImagePrim[] => s.prims.filter((p): p is ImagePrim => p.t === 'image');
  const pngWidth = (png: Uint8Array): number => new DataView(png.buffer, png.byteOffset).getUint32(16);

  it('draws a stair on the level it rises from: treads below the cut solid, above it dashed, the cut with its break, UP from the foot', () => {
    const plan = levelPlan(L_STAIR, 'L1');
    expect(plan.stairs).toHaveLength(1);
    const st = plan.stairs[0]!;
    expect(st).toMatchObject({ id: 'ST1', direction: 'up', form: 'lShaped', label: 'UP' });
    // 13 treads and the landing; the cut plane is 4 ft (1,560,576) above the floor: six treads are under it.
    expect(st.steps).toHaveLength(13);
    expect(st.steps.filter((s) => !s.hidden)).toHaveLength(6);
    expect(st.steps.filter((s) => s.landing)).toHaveLength(1);
    // The walkline from the foot to the head, and UP written at the foot.
    expect(st.arrow[0]).toEqual([1280000, 768000]);
    expect(st.arrow[st.arrow.length - 1]).toEqual([3776000, 3264000]);
    expect(st.labelAt).toEqual([1280000, 768000]);
    // The cut line runs corner to corner across the first tread above the cut (render2d's choice,
    // so the editor and the sheet agree), with a Z in its middle.
    const cut = st.cut!;
    expect(cut).toHaveLength(6);
    expect(cut[0]).toEqual([3200000, 1344000]);
    expect(cut[5]).toEqual([4352000, 1664000]);
  });

  it('draws it again on the level it arrives at, looking down the stairwell: every tread, DN from the head', () => {
    const plan = levelPlan(L_STAIR, 'L2');
    const st = plan.stairs[0]!;
    expect(st).toMatchObject({ id: 'ST1', direction: 'down', label: 'DN', cut: null });
    expect(st.steps.every((s) => !s.hidden)).toBe(true);
    expect(st.labelAt).toEqual([3776000, 3264000]);
    expect(st.arrow[st.arrow.length - 1]).toEqual([1280000, 768000]);
  });

  it('carries the roof on its level with a slope arrow downhill on every pitched face', () => {
    expect(levelPlan(L_STAIR, 'L1').roofs).toEqual([]);
    const plan = levelPlan(L_STAIR, 'L2');
    expect(plan.roofs).toHaveLength(1);
    const rf = plan.roofs[0]!;
    expect(rf.kind).toBe('hip');
    expect(rf.eave).toEqual([[-512000, -512000], [9728000, -512000], [9728000, 7424000], [-512000, 7424000]]);
    expect(rf.lines.map((l) => l.kind).sort()).toEqual(['hip', 'hip', 'hip', 'hip', 'ridge']);
    expect(rf.gables).toEqual([]);
    // Four faces at 6 in 12, each pointing away from the ridge, over its own eave.
    expect(rf.slopes).toHaveLength(4);
    for (const s of rf.slopes) expect([s.rise, s.run]).toEqual([6, 12]);
    const dirs = rf.slopes.map((s) => [Math.round(s.dir[0]), Math.round(s.dir[1])]);
    expect(dirs).toEqual(expect.arrayContaining([[0, -1], [1, 0], [0, 1], [-1, 0]]));
    // The plan's extent takes the overhang in.
    expect(plan.extent!.minX).toBe(-512000);
    expect(pitchText(6, 12, 'imperial')).toBe('6:12');
    expect(pitchText(5, 10, 'imperial')).toBe('6:12');
    expect(pitchText(7, 24, 'imperial')).toBe('3.5:12');
    expect(pitchText(6, 12, 'metric')).toBe('26.6°');
  });

  it('draws stairs on the plans, a roof plan sheet, and a 3D view rendered from the mesh at 300 dpi', async () => {
    const pdf = await exportPdf(L_STAIR, { version: VERSION, fontDir });
    expect(pdf.sheets.map((s) => [s.number, s.title])).toEqual([
      ['A-101', 'Level 1 floor plan'],
      ['A-102', 'Level 2 floor plan'],
      ['A-103', ROOF_PLAN_TITLE],
    ]);
    expect(pageCount(pdf.bytes)).toBe(3);
    expect(texts(pdf.sheets[0]!)).toContain('UP');
    expect(texts(pdf.sheets[0]!)).toContain('Cut line at 4\'-0" with break; above it dashed');
    expect(texts(pdf.sheets[1]!)).toContain('DN');
    expect(texts(pdf.sheets[1]!)).toContain('Roof eave above (see roof plan)');
    const roof = texts(pdf.sheets[2]!);
    expect(roof).toContain('ROOF PLAN');
    expect(roof.filter((t) => t === '6:12')).toHaveLength(4);
    expect(roof).toContain('Whole model');
    expect(roof.join(' ').toLowerCase()).not.toContain('compliant');
    // Each sheet's 3D view is one PNG, rendered at the panel's size — not polygons drawn on the page.
    for (const sheet of pdf.sheets) {
      const [img] = images(sheet);
      expect(images(sheet)).toHaveLength(1);
      expect([...img!.png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(pngWidth(img!.png)).toBe(Math.round((img!.w / 72) * 300));
    }
    // The panels differ: a level cut away, and the whole model with its roof.
    expect(Buffer.from(images(pdf.sheets[0]!)[0]!.png).equals(Buffer.from(images(pdf.sheets[2]!)[0]!.png))).toBe(false);
    expect(texts(pdf.sheets[0]!)).toContain('Cut above Level 1');
    // The PDF embeds them as images; and it is the same bytes again.
    expect(Buffer.from(pdf.bytes).toString('latin1')).toContain('/Subtype /Image');
    const again = await exportPdf(L_STAIR, { version: VERSION, fontDir });
    expect(Buffer.from(again.bytes).equals(Buffer.from(pdf.bytes))).toBe(true);
  });

  it('leaves the roof plan out when no drawn level has a roof', async () => {
    const pdf = await exportPdf(L_STAIR, { version: VERSION, fontDir, levels: ['L1'] });
    expect(pdf.sheets.map((s) => s.title)).toEqual(['Level 1 floor plan']);
    expect(exportDxf(L_STAIR, { version: VERSION, levels: ['L1'] }).files).toHaveLength(1);
  });

  it('draws the design asked for, the primary by default, and says which in the title block', async () => {
    const primary = await exportPdf(KITCHEN, { version: VERSION, fontDir, reader: CORE_ONLY });
    expect(primary.design).toEqual({ DS: 'DA', KS: 'KA' });
    expect(texts(primary.sheets[0]!)).toContain('DESIGN');
    expect(texts(primary.sheets[0]!)).toContain('Deck — Deck · Kitchen — A: closed (primary)');
    const b = await exportPdf(KITCHEN, { version: VERSION, fontDir, design: { KS: 'KB' }, reader: CORE_ONLY });
    expect(b.design).toEqual({ DS: 'DA', KS: 'KB' });
    expect(texts(b.sheets[0]!)).toContain('Deck — Deck · Kitchen — B: open');
    // Kitchen B is open: the wall between kitchen and dining (WA, option KA) is not drawn.
    expect(levelPlan(KITCHEN, 'L1', new Map(), { KS: 'KB' }, CORE_ONLY).pieces.length).toBeLessThan(levelPlan(KITCHEN, 'L1', new Map(), undefined, CORE_ONLY).pieces.length);
    expect(Buffer.from(b.bytes).equals(Buffer.from(primary.bytes))).toBe(false);
    const dxf = exportDxf(KITCHEN, { version: VERSION, design: { KS: 'KB' }, reader: CORE_ONLY });
    expect(dxf.design).toEqual({ DS: 'DA', KS: 'KB' });
    expect(new TextDecoder().decode(dxf.bytes)).toContain('DESIGN: Deck - Deck \\U+00B7 Kitchen - B: open'.replace(/ - /g, ' \\U+2014 '));
    await expect(exportPdf(KITCHEN, { version: VERSION, fontDir, design: { KS: 'NOPE' }, reader: CORE_ONLY })).rejects.toThrow(/no such design/);
    // A model without options has no design line.
    expect(texts((await exportPdf(RANCH, { version: VERSION, fontDir })).sheets[0]!)).not.toContain('DESIGN');
  });
});

describe('DXF drawings', () => {
  interface Parsed {
    header: Record<string, unknown>;
    tables: { layer: { layers: Record<string, { name: string; color: number }> } };
    entities: { type: string; layer: string; handle: string; text?: string }[];
  }
  const parse = (text: string): Parsed => new DxfParser().parseSync(text) as unknown as Parsed;

  it('writes one AutoCAD 2000 DXF per level, in millimetres, that a DXF reader parses', () => {
    const dxf = exportDxf(TWO_STOREY, { version: VERSION, levels: ['MAIN'] });
    expect(dxf.name).toBe('two-storey-ranch-v42-main-floor.dxf');
    expect(dxf.contentType).toBe('image/vnd.dxf');
    const text = new TextDecoder().decode(dxf.bytes);
    const doc = parse(text);
    expect(doc.header['$ACADVER']).toBe('AC1015');
    expect(doc.header['$INSUNITS']).toBe(4);
    // Every layer used is declared, and every declared name is NCS-pattern (or the default 0).
    const declared = Object.keys(doc.tables.layer.layers);
    for (const name of declared) expect(name === '0' || isNcsName(name), name).toBe(true);
    const used = new Set(doc.entities.map((e) => e.layer));
    for (const name of used) expect(declared).toContain(name);
    for (const l of ['A-WALL-EXTR', 'A-WALL-INTR', 'A-DOOR', 'A-GLAZ', 'A-AREA-IDEN', 'A-ANNO-DIMS', 'A-ANNO-NOTE']) expect(used, l).toContain(l);
    // Handles are unique, and the header's seed is past every one of them.
    const handles = doc.entities.map((e) => e.handle);
    expect(new Set(handles).size).toBe(handles.length);
    const seed = Number.parseInt(String(doc.header['$HANDSEED']), 16);
    for (const h of handles) expect(Number.parseInt(h, 16)).toBeLessThan(seed);
    // Entity kinds.
    expect(new Set(doc.entities.map((e) => e.type))).toEqual(new Set(['LINE', 'LWPOLYLINE', 'ARC', 'TEXT', 'CIRCLE']));
    const labels = doc.entities.filter((e) => e.type === 'TEXT').map((e) => e.text);
    expect(labels).toContain('LIVING ROOM');
    expect(labels).toContain('NOT FOR CONSTRUCTION - NOT A PLAN REVIEW');
    expect(labels).toContain(`44'-2 3/8"`);
  });

  it('carries the model’s exact coordinates: an outside corner, in millimetres, to the last digit', () => {
    const plan = levelPlan(RANCH, 'MAIN');
    const text = new TextDecoder().decode(exportDxf(RANCH, { version: VERSION }).bytes);
    const corner = plan.body!;
    expect(text).toContain(` 10\r\n${mm(corner.minX)}\r\n 20\r\n${mm(corner.minY)}\r\n`);
  });

  it('draws stairs and the roof on NCS layers, and the roof plan as a DXF of its own', () => {
    const dxf = exportDxf(L_STAIR, { version: VERSION });
    expect(dxf.files.map((f) => f.name)).toEqual([
      'stair-and-hip-roof-house-v42-level-1.dxf',
      'stair-and-hip-roof-house-v42-level-2.dxf',
      'stair-and-hip-roof-house-v42-roof-plan.dxf',
    ]);
    const [l1, l2, roof] = dxf.files.map((f) => parse(new TextDecoder().decode(f.bytes)));
    const layersOf = (d: Parsed): Set<string> => new Set(d.entities.map((e) => e.layer));
    const textsOf = (d: Parsed): (string | undefined)[] => d.entities.filter((e) => e.type === 'TEXT').map((e) => e.text);
    for (const d of [l1!, l2!, roof!]) {
      const declared = Object.keys(d.tables.layer.layers);
      for (const name of declared) expect(name === '0' || isNcsName(name), name).toBe(true);
      for (const name of layersOf(d)) expect(declared).toContain(name);
    }
    for (const l of ['A-FLOR-STRS', 'A-FLOR-STRS-OVHD', 'A-FLOR-STRS-IDEN']) expect(layersOf(l1!), l).toContain(l);
    expect(textsOf(l1!)).toContain('UP');
    expect(layersOf(l1!)).not.toContain('A-ROOF-OVHD');
    for (const l of ['A-FLOR-STRS', 'A-FLOR-STRS-IDEN', 'A-ROOF-OVHD']) expect(layersOf(l2!), l).toContain(l);
    expect(textsOf(l2!)).toContain('DN');
    for (const l of ['A-ROOF-OTLN', 'A-ROOF-RIDG', 'A-ROOF-IDEN']) expect(layersOf(roof!), l).toContain(l);
    expect(textsOf(roof!).filter((t) => t === '6:12')).toHaveLength(4);
    expect(textsOf(roof!)).toContain('ROOF PLAN - Stair and hip roof house');
    // The eave above Level 2 is dashed by its layer; the roof plan's is solid.
    expect(l2!.tables.layer.layers['A-ROOF-OVHD']).toBeDefined();
    const text = new TextDecoder().decode(dxf.files[2]!.bytes);
    expect(text).toContain(`A-ROOF-OVHD\r\n 70\r\n0\r\n 62\r\n8\r\n  6\r\nDASHED`);
    expect(text).toContain(`A-ROOF-OTLN\r\n 70\r\n0\r\n 62\r\n7\r\n  6\r\nContinuous`);
  });

  it('zips several levels, one DXF each, and is the same bytes every time', () => {
    const a = exportDxf(TWO_STOREY, { version: VERSION });
    const b = exportDxf(TWO_STOREY, { version: VERSION });
    expect(a.name).toBe('two-storey-ranch-v42-dxf.zip');
    expect(a.files.map((f) => f.name)).toEqual(['two-storey-ranch-v42-main-floor.dxf', 'two-storey-ranch-v42-upper-floor.dxf']);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    const entries = unzip(a.bytes);
    expect(entries.map((e) => e.name)).toEqual(a.files.map((f) => f.name));
    for (const e of entries) expect(parse(new TextDecoder().decode(e.bytes)).header['$ACADVER']).toBe('AC1015');
  });
});

/** Read a ZIP's local entries (stored or deflated). */
function unzip(zip: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: { name: string; bytes: Uint8Array }[] = [];
  let at = 0;
  while (v.getUint32(at, true) === 0x04034b50) {
    const method = v.getUint16(at + 8, true);
    const size = v.getUint32(at + 18, true);
    const nameLen = v.getUint16(at + 26, true);
    const extra = v.getUint16(at + 28, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen));
    const data = zip.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    out.push({ name, bytes: method === 0 ? data : new Uint8Array(inflateRawSync(data)) });
    at += 30 + nameLen + extra + size;
  }
  return out;
}

describe('stored ZIP', () => {
  it('round-trips its entries with their CRCs', () => {
    const files = [
      { name: 'a.dxf', bytes: new TextEncoder().encode('hello') },
      { name: 'b.dxf', bytes: new Uint8Array([0, 1, 2, 255]) },
    ];
    const zip = storedZip(files, VERSION.at);
    expect(unzip(zip)).toEqual(files);
    const tail = new DataView(zip.buffer, zip.byteLength - 22);
    expect(tail.getUint32(0, true)).toBe(0x06054b50);
    expect(tail.getUint16(10, true)).toBe(2);
  });
});
