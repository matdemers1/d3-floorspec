/**
 * The DXF writer (FLR-T-9.3, FLR-REQ-130): one level's plan as an AutoCAD 2000 (AC1015) ASCII DXF —
 * the release every CAD program and viewer reads — with layers named in the National CAD
 * Standard's pattern (layers.ts).
 *
 * Units are millimetres (`$INSUNITS` 4). A base unit is 1/1280 mm and 1280 = 2⁸·5, so every
 * coordinate the engine derived is written as an exact decimal: the DXF carries the model's own
 * numbers, not a rounding of them. Points placed by drafting (a door's open leaf, a label) are
 * rounded to the base unit first and are exact from there.
 *
 * Entities: LINE (walls, jambs, glazing, door leaves, dimension lines and ticks), ARC (door
 * swings), LWPOLYLINE (rooms, slabs, devices, window tags), CIRCLE (door tags) and TEXT. Dimension
 * strings are drawn as lines and text on A-ANNO-DIMS rather than as DIMENSION entities: a
 * DIMENSION needs an anonymous block of its own rendering for most readers to show it, and plain
 * geometry reads the same in every one.
 *
 * Deterministic: handles are allocated in a fixed order, entities are written in plan order, and
 * nothing reads a clock.
 */
import type { DimString } from './dimensions.js';
import { LAYER_DEFS, LAYERS } from './layers.js';
import type { LevelPlan, XY } from './plan.js';
import { planTitle } from './sheet.js';
import { areaText, BU_PER_MM, lengthText, type UnitSystem } from './units.js';

export interface DxfMeta {
  readonly projectName: string;
  readonly levelName: string;
  readonly version: string;
  readonly date: string;
  readonly units: UnitSystem;
}

/** The annotation scale text and dimension offsets are sized for: 1/4" = 1'-0" (48) or 1:50. */
export const annotationRatio = (units: UnitSystem): number => (units === 'metric' ? 50 : 48);

/** A base-unit value as an exact decimal number of millimetres. */
export function mm(v: number): string {
  const bu = BigInt(Math.round(v));
  const neg = bu < 0n;
  const a = neg ? -bu : bu;
  const whole = a / 1280n;
  const frac = a % 1280n;
  if (frac === 0n) return `${neg && whole !== 0n ? '-' : ''}${whole.toString()}.0`;
  // frac/1280 = frac·78125 / 10⁸, exactly.
  const digits = (frac * 78125n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}.${digits}`;
}

const deg = (a: number): string => {
  const r = Math.round(a * 1e6) / 1e6;
  const s = (Object.is(r, -0) ? 0 : r).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
  return s;
};

/** Non-ASCII characters as DXF's \U+XXXX escapes; control characters dropped. */
function dxfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 32;
    if (c < 32) continue;
    out += c < 128 ? ch : `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

class Writer {
  private readonly lines: string[] = [];

  constructor(private next = 0x20) {}

  handle(): string {
    return (this.next++).toString(16).toUpperCase();
  }

  get seed(): string {
    return this.next.toString(16).toUpperCase();
  }

  pair(code: number, value: string | number): void {
    this.lines.push(String(code).padStart(3, ' '), typeof value === 'number' ? String(value) : value);
  }

  toString(): string {
    return `${this.lines.join('\r\n')}\r\n`;
  }
}

interface Entities {
  readonly w: Writer;
  readonly owner: string;
}

function common(e: Entities, type: string, layer: string, sub: string): void {
  e.w.pair(0, type);
  e.w.pair(5, e.w.handle());
  e.w.pair(330, e.owner);
  e.w.pair(100, 'AcDbEntity');
  e.w.pair(8, layer);
  e.w.pair(100, sub);
}

function lineE(e: Entities, layer: string, a: XY, b: XY): void {
  common(e, 'LINE', layer, 'AcDbLine');
  e.w.pair(10, mm(a[0]));
  e.w.pair(20, mm(a[1]));
  e.w.pair(30, '0.0');
  e.w.pair(11, mm(b[0]));
  e.w.pair(21, mm(b[1]));
  e.w.pair(31, '0.0');
}

function polyE(e: Entities, layer: string, pts: readonly XY[], closed: boolean): void {
  if (pts.length < 2) return;
  common(e, 'LWPOLYLINE', layer, 'AcDbPolyline');
  e.w.pair(90, pts.length);
  e.w.pair(70, closed ? 1 : 0);
  e.w.pair(43, '0.0');
  for (const p of pts) {
    e.w.pair(10, mm(p[0]));
    e.w.pair(20, mm(p[1]));
  }
}

function arcE(e: Entities, layer: string, c: XY, r: number, start: number, end: number): void {
  common(e, 'ARC', layer, 'AcDbCircle');
  e.w.pair(10, mm(c[0]));
  e.w.pair(20, mm(c[1]));
  e.w.pair(30, '0.0');
  e.w.pair(40, mm(r));
  e.w.pair(100, 'AcDbArc');
  e.w.pair(50, deg(start));
  e.w.pair(51, deg(end));
}

function circleE(e: Entities, layer: string, c: XY, r: number): void {
  common(e, 'CIRCLE', layer, 'AcDbCircle');
  e.w.pair(10, mm(c[0]));
  e.w.pair(20, mm(c[1]));
  e.w.pair(30, '0.0');
  e.w.pair(40, mm(r));
}

/** TEXT, centred on its point (horizontal centre, vertical middle), rotated `angle` degrees CCW. */
function textE(e: Entities, layer: string, at: XY, height: number, s: string, angle = 0): void {
  common(e, 'TEXT', layer, 'AcDbText');
  e.w.pair(10, mm(at[0]));
  e.w.pair(20, mm(at[1]));
  e.w.pair(30, '0.0');
  e.w.pair(40, mm(height));
  e.w.pair(1, dxfText(s));
  if (angle !== 0) e.w.pair(50, deg(angle));
  e.w.pair(7, 'Standard');
  e.w.pair(72, 1);
  e.w.pair(11, mm(at[0]));
  e.w.pair(21, mm(at[1]));
  e.w.pair(31, '0.0');
  e.w.pair(100, 'AcDbText');
  e.w.pair(73, 2);
}

const r = (p: XY): XY => [Math.round(p[0]), Math.round(p[1])];
const angleOf = (c: XY, p: XY): number => {
  const a = (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
};

/** Paper points → model base units at the annotation ratio. */
const paper = (pt: number, ratio: number): number => Math.round(((pt * 25.4) / 72) * ratio * BU_PER_MM);

function entities(e: Entities, plan: LevelPlan, dims: readonly DimString[], meta: DxfMeta): void {
  const ratio = annotationRatio(meta.units);
  const P = (pt: number): number => paper(pt, ratio);
  for (const s of plan.slabs) polyE(e, LAYERS.floor, s.outline, true);
  for (const [a, b] of plan.separators) lineE(e, LAYERS.separator, a, b);
  for (const room of plan.rooms) for (const ring of [room.outer, ...room.holes]) polyE(e, LAYERS.roomBoundary, ring, true);
  for (const s of plan.wallLines) lineE(e, s.layer, s.a, s.b);
  for (const w of plan.windows) for (const [a, b] of w.lines) lineE(e, LAYERS.glazing, a, b);
  for (const d of plan.doors) {
    lineE(e, LAYERS.door, d.hinge, d.leafEnd);
    // ARC runs counter-clockwise from its start angle to its end angle.
    const a0 = angleOf(d.hinge, d.leafEnd);
    const a1 = angleOf(d.hinge, d.closedEnd);
    const ccw = ((a1 - a0 + 360) % 360) <= 180;
    arcE(e, LAYERS.door, d.hinge, d.radius, ccw ? a0 : a1, ccw ? a1 : a0);
  }
  for (const dv of plan.devices) polyE(e, dv.layer, dv.footprint, true);

  // Room labels: name, area, size.
  for (const room of plan.rooms) {
    const h = P(7);
    textE(e, LAYERS.roomLabel, r([room.label[0], room.label[1] + P(9)]), h, room.title.toUpperCase());
    textE(e, LAYERS.roomLabel, r(room.label), P(6), areaText(room.area, meta.units));
    textE(e, LAYERS.roomLabel, r([room.label[0], room.label[1] - P(8.5)]), P(5.5), `${lengthText(room.width, meta.units)} x ${lengthText(room.depth, meta.units)}`);
  }

  // Tags.
  for (const t of plan.tags) {
    const rad = P(t.kind === 'door' ? 5.2 : 5.6);
    const c = r([t.base[0] + t.normal[0] * (rad + P(3)), t.base[1] + t.normal[1] * (rad + P(3))]);
    if (t.kind === 'door') circleE(e, LAYERS.doorTag, c, rad);
    else {
      const hx = (rad * Math.sqrt(3)) / 2;
      const hex: XY[] = [[c[0] - rad, c[1]], [c[0] - rad / 2, c[1] + hx], [c[0] + rad / 2, c[1] + hx], [c[0] + rad, c[1]], [c[0] + rad / 2, c[1] - hx], [c[0] - rad / 2, c[1] - hx]];
      polyE(e, LAYERS.glazingTag, hex.map(r), true);
    }
    textE(e, t.kind === 'door' ? LAYERS.doorTag : LAYERS.glazingTag, c, P(5), t.mark);
  }

  // Dimension strings: lines, ticks and text, the same strings the PDF prints.
  const ext = plan.extent;
  const body = plan.body;
  if (ext !== undefined && body !== undefined) {
    for (const d of dims) {
      const horizontal = d.side === 'N' || d.side === 'S';
      const off = P(22 + d.tier * 15);
      const out = d.side === 'N' || d.side === 'E' ? 1 : -1;
      const edge = d.side === 'N' ? ext.maxY + off : d.side === 'S' ? ext.minY - off : d.side === 'E' ? ext.maxX + off : ext.minX - off;
      const face = d.side === 'N' ? body.maxY : d.side === 'S' ? body.minY : d.side === 'E' ? body.maxX : body.minX;
      const at = (v: number): XY => (horizontal ? [v, edge] : [edge, v]);
      const first = d.points[0]!;
      const last = d.points[d.points.length - 1]!;
      const over = P(4);
      lineE(e, LAYERS.dims, at(first - over), at(last + over));
      const tick = P(2.6);
      d.points.forEach((v, i) => {
        const p = at(v);
        const gap = (d.reach[i] ?? face) + out * P(4);
        lineE(e, LAYERS.dims, horizontal ? [v, gap] : [gap, v], horizontal ? [v, edge + out * P(3)] : [edge + out * P(3), v]);
        lineE(e, LAYERS.dims, [p[0] - tick, p[1] - tick], [p[0] + tick, p[1] + tick]);
        const next = d.points[i + 1];
        if (next === undefined) return;
        const mid = Math.round((v + next) / 2);
        const lift = P(2) + P(3);
        const tp: XY = horizontal ? [mid, edge + (d.side === 'N' ? lift : -lift)] : [edge + (d.side === 'E' ? lift : -lift), mid];
        textE(e, LAYERS.dims, tp, P(6), lengthText(next - v, meta.units), horizontal ? 0 : 90);
      });
    }

    // The note, under the plan; the north arrow beside it.
    const below = ext.minY - P(22 + 3 * 15 + 30);
    const h = P(9);
    textE(e, LAYERS.note, [Math.round((ext.minX + ext.maxX) / 2), below], h, `${planTitle(meta.levelName).toUpperCase()} - ${meta.projectName}`);
    textE(e, LAYERS.note, [Math.round((ext.minX + ext.maxX) / 2), below - Math.round(h * 1.8)], P(12), 'NOT FOR CONSTRUCTION - NOT A PLAN REVIEW');
    textE(e, LAYERS.note, [Math.round((ext.minX + ext.maxX) / 2), below - Math.round(h * 3.4)], P(6), `${meta.version} - ${meta.date} - drawn by D3 Floorspec; verify every dimension`);
    const nc: XY = [ext.maxX + P(40), below];
    const nr = P(11);
    const rot = (-plan.trueNorth / 1_000_000) * (Math.PI / 180);
    const R = (p: XY): XY => r([nc[0] + p[0] * Math.cos(rot) + p[1] * Math.sin(rot), nc[1] - p[0] * Math.sin(rot) + p[1] * Math.cos(rot)]);
    circleE(e, LAYERS.symbol, nc, nr);
    polyE(e, LAYERS.symbol, [R([0, P(10)]), R([P(5), -P(7)]), R([0, -P(3.5)]), R([-P(5), -P(7)])], true);
    textE(e, LAYERS.symbol, R([0, P(16)]), P(7), 'N');
  }
}

/** One level's plan as a DXF file (ASCII, CRLF line ends). */
export function levelDxf(plan: LevelPlan, dims: readonly DimString[], meta: DxfMeta): string {
  const w = new Writer();
  // Fixed handles for the structure, allocated before any entity.
  const h = {
    vportTable: w.handle(),
    ltypeTable: w.handle(),
    layerTable: w.handle(),
    styleTable: w.handle(),
    viewTable: w.handle(),
    ucsTable: w.handle(),
    appidTable: w.handle(),
    dimstyleTable: w.handle(),
    blockRecordTable: w.handle(),
    vport: w.handle(),
    ltypes: [w.handle(), w.handle(), w.handle(), w.handle(), w.handle()],
    layers: [w.handle(), ...LAYER_DEFS.map(() => w.handle())],
    style: w.handle(),
    appid: w.handle(),
    dimstyle: w.handle(),
    modelRecord: w.handle(),
    paperRecord: w.handle(),
    modelBlock: w.handle(),
    modelEnd: w.handle(),
    paperBlock: w.handle(),
    paperEnd: w.handle(),
    root: w.handle(),
    groups: w.handle(),
    layouts: w.handle(),
    plotStyles: w.handle(),
    normal: w.handle(),
    modelLayout: w.handle(),
    paperLayout: w.handle(),
  };

  // Entities first, into a writer of their own, so the header can carry the final handle seed.
  const ents = new Writer(Number.parseInt(w.seed, 16));
  entities({ w: ents, owner: h.modelRecord }, plan, dims, meta);
  const seed = ents.seed;

  const ext = plan.extent ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const ratio = annotationRatio(meta.units);
  const pad = paper(110, ratio);

  const section = (name: string, body: () => void): void => {
    w.pair(0, 'SECTION');
    w.pair(2, name);
    body();
    w.pair(0, 'ENDSEC');
  };
  const table = (name: string, handle: string, count: number, body: () => void, extra?: () => void): void => {
    w.pair(0, 'TABLE');
    w.pair(2, name);
    w.pair(5, handle);
    w.pair(330, '0');
    w.pair(100, 'AcDbSymbolTable');
    w.pair(70, count);
    extra?.();
    body();
    w.pair(0, 'ENDTAB');
  };
  const record = (type: string, handleCode: 5 | 105, handle: string, owner: string, sub: string): void => {
    w.pair(0, type);
    w.pair(handleCode, handle);
    w.pair(330, owner);
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, sub);
  };

  section('HEADER', () => {
    const v = (name: string, code: number, value: string | number): void => {
      w.pair(9, name);
      w.pair(code, value);
    };
    v('$ACADVER', 1, 'AC1015');
    v('$DWGCODEPAGE', 3, 'ANSI_1252');
    v('$HANDSEED', 5, seed);
    v('$INSUNITS', 70, 4);
    v('$MEASUREMENT', 70, 1);
    v('$LUNITS', 70, 2);
    v('$LUPREC', 70, 2);
    v('$LTSCALE', 40, `${String(ratio)}.0`);
    v('$TEXTSTYLE', 7, 'Standard');
    v('$CLAYER', 8, '0');
    w.pair(9, '$EXTMIN');
    w.pair(10, mm(ext.minX - pad));
    w.pair(20, mm(ext.minY - pad));
    w.pair(30, '0.0');
    w.pair(9, '$EXTMAX');
    w.pair(10, mm(ext.maxX + pad));
    w.pair(20, mm(ext.maxY + pad));
    w.pair(30, '0.0');
  });

  section('CLASSES', () => undefined);

  section('TABLES', () => {
    table('VPORT', h.vportTable, 1, () => {
      record('VPORT', 5, h.vport, h.vportTable, 'AcDbViewportTableRecord');
      w.pair(2, '*Active');
      w.pair(70, 0);
      for (const [c, val] of [[10, '0.0'], [20, '0.0'], [11, '1.0'], [21, '1.0']] as const) w.pair(c, val);
      w.pair(12, mm((ext.minX + ext.maxX) / 2));
      w.pair(22, mm((ext.minY + ext.maxY) / 2));
      for (const [c, val] of [[13, '0.0'], [23, '0.0'], [14, '10.0'], [24, '10.0'], [15, '10.0'], [25, '10.0'], [16, '0.0'], [26, '0.0'], [36, '1.0'], [17, '0.0'], [27, '0.0'], [37, '0.0']] as const) w.pair(c, val);
      w.pair(40, mm(Math.max(ext.maxY - ext.minY, 1280) + 2 * pad));
      w.pair(41, '1.5');
      w.pair(42, '50.0');
      for (const [c, val] of [[43, '0.0'], [44, '0.0'], [50, '0.0'], [51, '0.0'], [71, 0], [72, 1000], [73, 1], [74, 3], [75, 0], [76, 0], [77, 0], [78, 0]] as const) w.pair(c, val);
    });
    table('LTYPE', h.ltypeTable, 5, () => {
      const lt = (handle: string, name: string, description: string, pattern: readonly number[]): void => {
        record('LTYPE', 5, handle, h.ltypeTable, 'AcDbLinetypeTableRecord');
        w.pair(2, name);
        w.pair(70, 0);
        w.pair(3, description);
        w.pair(72, 65);
        w.pair(73, pattern.length);
        w.pair(40, pattern.reduce((s, x) => s + Math.abs(x), 0).toFixed(1));
        for (const x of pattern) {
          w.pair(49, x.toFixed(1));
          w.pair(74, 0);
        }
      };
      lt(h.ltypes[0]!, 'ByBlock', '', []);
      lt(h.ltypes[1]!, 'ByLayer', '', []);
      lt(h.ltypes[2]!, 'Continuous', 'Solid line', []);
      // Patterns in paper millimetres; $LTSCALE carries them to the annotation scale.
      lt(h.ltypes[3]!, 'DASHED', 'Dashed __ __ __', [3.0, -1.5]);
      lt(h.ltypes[4]!, 'HIDDEN', 'Hidden _ _ _', [1.5, -1.0]);
    });
    table('LAYER', h.layerTable, LAYER_DEFS.length + 1, () => {
      const layer = (handle: string, name: string, color: number, linetype: string, weight: number): void => {
        record('LAYER', 5, handle, h.layerTable, 'AcDbLayerTableRecord');
        w.pair(2, name);
        w.pair(70, 0);
        w.pair(62, color);
        w.pair(6, linetype);
        w.pair(370, weight);
        w.pair(390, h.normal);
      };
      layer(h.layers[0]!, '0', 7, 'Continuous', -3);
      LAYER_DEFS.forEach((d, i) => {
        layer(h.layers[i + 1]!, d.name, d.color, d.linetype === 'CONTINUOUS' ? 'Continuous' : d.linetype, d.weight);
      });
    });
    table('STYLE', h.styleTable, 1, () => {
      record('STYLE', 5, h.style, h.styleTable, 'AcDbTextStyleTableRecord');
      w.pair(2, 'Standard');
      w.pair(70, 0);
      w.pair(40, '0.0');
      w.pair(41, '1.0');
      w.pair(50, '0.0');
      w.pair(71, 0);
      w.pair(42, '2.5');
      w.pair(3, 'txt');
      w.pair(4, '');
    });
    table('VIEW', h.viewTable, 0, () => undefined);
    table('UCS', h.ucsTable, 0, () => undefined);
    table('APPID', h.appidTable, 1, () => {
      record('APPID', 5, h.appid, h.appidTable, 'AcDbRegAppTableRecord');
      w.pair(2, 'ACAD');
      w.pair(70, 0);
    });
    table(
      'DIMSTYLE',
      h.dimstyleTable,
      1,
      () => {
        record('DIMSTYLE', 105, h.dimstyle, h.dimstyleTable, 'AcDbDimStyleTableRecord');
        w.pair(2, 'Standard');
        w.pair(70, 0);
      },
      () => {
        w.pair(100, 'AcDbDimStyleTable');
      },
    );
    table('BLOCK_RECORD', h.blockRecordTable, 2, () => {
      record('BLOCK_RECORD', 5, h.modelRecord, h.blockRecordTable, 'AcDbBlockTableRecord');
      w.pair(2, '*Model_Space');
      w.pair(340, h.modelLayout);
      record('BLOCK_RECORD', 5, h.paperRecord, h.blockRecordTable, 'AcDbBlockTableRecord');
      w.pair(2, '*Paper_Space');
      w.pair(340, h.paperLayout);
    });
  });

  section('BLOCKS', () => {
    const block = (begin: string, end: string, owner: string, name: string): void => {
      w.pair(0, 'BLOCK');
      w.pair(5, begin);
      w.pair(330, owner);
      w.pair(100, 'AcDbEntity');
      w.pair(8, '0');
      w.pair(100, 'AcDbBlockBegin');
      w.pair(2, name);
      w.pair(70, 0);
      w.pair(10, '0.0');
      w.pair(20, '0.0');
      w.pair(30, '0.0');
      w.pair(3, name);
      w.pair(1, '');
      w.pair(0, 'ENDBLK');
      w.pair(5, end);
      w.pair(330, owner);
      w.pair(100, 'AcDbEntity');
      w.pair(8, '0');
      w.pair(100, 'AcDbBlockEnd');
    };
    block(h.modelBlock, h.modelEnd, h.modelRecord, '*Model_Space');
    block(h.paperBlock, h.paperEnd, h.paperRecord, '*Paper_Space');
  });

  const text = w.toString();
  const tail = new Writer();
  const section2 = (name: string, body: () => void): void => {
    tail.pair(0, 'SECTION');
    tail.pair(2, name);
    body();
    tail.pair(0, 'ENDSEC');
  };
  section2('OBJECTS', () => {
    const dict = (handle: string, owner: string, entries: readonly [string, string][], type = 'DICTIONARY'): void => {
      tail.pair(0, type);
      tail.pair(5, handle);
      tail.pair(330, owner);
      tail.pair(100, 'AcDbDictionary');
      tail.pair(281, 1);
      for (const [name, ref] of entries) {
        tail.pair(3, name);
        tail.pair(350, ref);
      }
    };
    dict(h.root, '0', [
      ['ACAD_GROUP', h.groups],
      ['ACAD_LAYOUT', h.layouts],
      ['ACAD_PLOTSTYLENAME', h.plotStyles],
    ]);
    dict(h.groups, h.root, []);
    dict(h.layouts, h.root, [
      ['Model', h.modelLayout],
      ['Layout1', h.paperLayout],
    ]);
    dict(h.plotStyles, h.root, [['Normal', h.normal]], 'ACDBDICTIONARYWDFLT');
    tail.pair(100, 'AcDbDictionaryWithDefault');
    tail.pair(340, h.normal);
    tail.pair(0, 'ACDBPLACEHOLDER');
    tail.pair(5, h.normal);
    tail.pair(330, h.plotStyles);
    const layout = (handle: string, name: string, flag: number, tab: number, record: string): void => {
      tail.pair(0, 'LAYOUT');
      tail.pair(5, handle);
      tail.pair(330, h.layouts);
      tail.pair(100, 'AcDbPlotSettings');
      tail.pair(1, '');
      tail.pair(4, 'ANSI_B_(17.00_x_11.00_Inches)');
      tail.pair(6, '');
      for (const [c, v] of [[40, '7.5'], [41, '20.0'], [42, '7.5'], [43, '20.0'], [44, '431.8'], [45, '279.4'], [46, '0.0'], [47, '0.0'], [48, '0.0'], [49, '0.0'], [140, '0.0'], [141, '0.0'], [142, '1.0'], [143, '1.0']] as const) tail.pair(c, v);
      tail.pair(70, flag);
      tail.pair(72, 1);
      tail.pair(73, 1);
      tail.pair(74, 5);
      tail.pair(7, '');
      tail.pair(75, 16);
      tail.pair(76, 0);
      tail.pair(77, 2);
      tail.pair(78, 300);
      tail.pair(147, '1.0');
      tail.pair(148, '0.0');
      tail.pair(149, '0.0');
      tail.pair(100, 'AcDbLayout');
      tail.pair(1, name);
      tail.pair(70, 1);
      tail.pair(71, tab);
      for (const [c, v] of [[10, '0.0'], [20, '0.0'], [11, '431.8'], [21, '279.4'], [12, '0.0'], [22, '0.0'], [32, '0.0'], [14, mm(ext.minX)], [24, mm(ext.minY)], [34, '0.0'], [15, mm(ext.maxX)], [25, mm(ext.maxY)], [35, '0.0'], [146, '0.0'], [13, '0.0'], [23, '0.0'], [33, '0.0'], [16, '1.0'], [26, '0.0'], [36, '0.0'], [17, '0.0'], [27, '1.0'], [37, '0.0']] as const) tail.pair(c, v);
      tail.pair(76, 1);
      tail.pair(330, record);
    };
    layout(h.modelLayout, 'Model', 1024, 0, h.modelRecord);
    layout(h.paperLayout, 'Layout1', 0, 1, h.paperRecord);
  });
  tail.pair(0, 'EOF');

  return `${text}  0\r\nSECTION\r\n  2\r\nENTITIES\r\n${ents.toString()}  0\r\nENDSEC\r\n${tail.toString()}`;
}
