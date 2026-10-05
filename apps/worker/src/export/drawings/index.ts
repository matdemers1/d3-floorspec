/**
 * PDF and DXF drawings (FLR-T-9.3; FLR-REQ-129, FLR-REQ-130).
 *
 * `exportPdf`: one sheet per level — the plan at a true architectural scale, dimensioned, with room
 * labels, door and window marks, a 3D view and a NOT FOR CONSTRUCTION mark — plus a schedule
 * sheet when a level's door and window schedule fits beside none of its plans.
 * `exportDxf`: one AutoCAD 2000 DXF per level on NCS-pattern layers; several levels come as a ZIP.
 *
 * Both are pure functions of the document and the version's facts (hash, number, time): the same
 * inputs give the same bytes, and nothing reads the clock.
 */
import { deriveFrom, evaluate, InvalidDocumentError, openingDimensions, type FloorspecDocument } from '@floorspec/engine';
import { buildScene, type Scene } from '@floorspec/render2d';
import { axonometric } from './axo.js';
import { dimensionStrings, type DimString } from './dimensions.js';
import { levelDxf } from './dxf.js';
import { openPdf } from './pdf.js';
import { openingMarks, planOf, union, type Box, type LevelPlan } from './plan.js';
import { composePlanSheet, composeScheduleSheet, DEFAULT_PAGE, layoutSet, PAGES, type PageName, type ScheduleRow, type Sheet } from './sheet.js';
import { lengthText, unitsOf, type UnitSystem } from './units.js';
import { storedZip } from './zip.js';

export { PAGES, DEFAULT_PAGE, type PageName, type Sheet } from './sheet.js';
export { LAYER_DEFS, LAYERS, isNcsName, layerForDevice } from './layers.js';
export { lengthText, areaText, unitsOf, type UnitSystem } from './units.js';
export { dimensionStrings, type DimString } from './dimensions.js';
export { openingMarks, planOf, levelPlan, type LevelPlan } from './plan.js';
export { sheetToSvg } from './svg.js';
export { NOT_FOR_CONSTRUCTION, NOT_A_PLAN_REVIEW } from './sheet.js';

/** The version a drawing is made from: what its title block says and what its dates are. */
export interface VersionFacts {
  /** The version's content hash (64 hex). */
  readonly hash: string;
  /** Its number on main (`v42`), when it has one. */
  readonly seq?: number | null;
  /** When the version was made. */
  readonly at: Date;
}

export interface DrawingOptions {
  readonly version: VersionFacts;
  /** Level IDs to draw; default every level, lowest first. */
  readonly levels?: readonly string[];
  /** PDF only. Default tabloid. */
  readonly page?: PageName;
  /** Where the font cache lives (default `FLOORSPEC_FONT_DIR` or the OS temp dir). */
  readonly fontDir?: string;
}

export interface DrawingFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface PdfResult extends DrawingFile {
  readonly sheets: readonly Sheet[];
}

export interface DxfResult extends DrawingFile {
  /** The DXF files, one per level (inside the ZIP when there are several). */
  readonly files: readonly DrawingFile[];
}

interface Prepared {
  readonly doc: FloorspecDocument;
  readonly units: UnitSystem;
  readonly all: readonly LevelPlan[];
  readonly chosen: readonly LevelPlan[];
  readonly dims: ReadonlyMap<string, readonly DimString[]>;
  readonly derived: ReturnType<typeof deriveFrom>;
}

/** Levels by elevation, then ID. */
function levelOrder(doc: FloorspecDocument): string[] {
  const levels = doc.levels ?? {};
  return Object.keys(levels).sort((a, b) => {
    const ea = levels[a]?.elevation ?? 0;
    const eb = levels[b]?.elevation ?? 0;
    return ea !== eb ? ea - eb : a < b ? -1 : a > b ? 1 : 0;
  });
}

function prepare(document: object, options: DrawingOptions): Prepared {
  const ev = evaluate(document);
  if (!ev.valid || !ev.document || !ev.analysis) throw new InvalidDocumentError(ev.diagnostics);
  const doc = ev.document;
  const derived = deriveFrom(doc, ev.analysis);
  const order = levelOrder(doc);
  if (order.length === 0) throw new RangeError('the model has no levels to draw');
  const wanted = options.levels ?? order;
  for (const l of wanted) if (!order.includes(l)) throw new RangeError(`the model has no level ${l}`);
  const scenes: Scene[] = order.map((l) => buildScene(doc, l));
  // Marks number the whole model, so a door is D3 whichever levels are drawn.
  const marks = openingMarks(scenes);
  const all = scenes.map((s) => planOf(s, marks));
  const chosen = all.filter((p) => wanted.includes(p.levelId));
  const dims = new Map(chosen.map((p) => [p.levelId, dimensionStrings(p)]));
  return { doc, units: unitsOf(doc), all, chosen, dims, derived };
}

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60) || 'floorspec';

function versionLabel(v: VersionFacts): string {
  return `${v.seq === undefined || v.seq === null ? '' : `v${String(v.seq)} · `}${v.hash.slice(0, 12)}`;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

function scheduleRows(doc: FloorspecDocument, plan: LevelPlan, units: UnitSystem): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const markOf = new Map([...plan.doors, ...plan.windows].map((o) => [o.id, o.mark]));
  for (const o of plan.scene.openings.values()) {
    if (o.kind === 'opening') continue;
    const opening = doc.openings?.[o.id];
    if (opening === undefined) continue;
    const mark = markOf.get(o.id);
    if (mark === undefined) continue;
    const dims = openingDimensions(doc, opening);
    const type = opening.fill === undefined ? undefined : doc.types?.[opening.fill];
    rows.push({
      mark,
      kind: o.kind,
      type: type?.name ?? opening.fill ?? '—',
      size: dims.width !== undefined && dims.height !== undefined ? `${lengthText(dims.width, units)} × ${lengthText(dims.height, units)}` : '—',
      sill: o.kind === 'window' ? lengthText(dims.sill, units) : '—',
      name: opening.name ?? o.id,
    });
  }
  const n = (m: string): number => Number(m.slice(1));
  return rows.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'door' ? -1 : 1) : n(a.mark) - n(b.mark)));
}

/** The dimensioned PDF: a sheet per level (and a schedule sheet when one is needed). */
export async function exportPdf(document: object, options: DrawingOptions): Promise<PdfResult> {
  const p = prepare(document, options);
  const page = PAGES[options.page ?? DEFAULT_PAGE];
  let frame: Box | undefined;
  for (const plan of p.chosen) frame = union(frame, plan.extent);
  frame ??= { minX: 0, minY: 0, maxX: 3_901_440, maxY: 3_901_440 };
  const rows = new Map(p.chosen.map((plan) => [plan.levelId, scheduleRows(p.doc, plan, p.units)]));
  const maxRows = Math.max(0, ...[...rows.values()].map((r) => r.length));
  const allDims = [...p.dims.values()].flat();
  const layout = layoutSet(page, frame, allDims, p.units, maxRows);
  const name = p.doc.project.name;
  const pdf = openPdf(
    {
      title: `${name} — floor plans`,
      subject: `Floor plans drawn from Floorspec model ${versionLabel(options.version)}. NOT FOR CONSTRUCTION; not a plan review.`,
      keywords: `floorspec ${options.version.hash}`,
      date: options.version.at,
    },
    options.fontDir,
  );
  const extra = layout.schedule === 'sheet' ? 1 : 0;
  const count = p.chosen.length + extra;
  const common = { projectName: name, date: isoDate(options.version.at), version: versionLabel(options.version), units: p.units, sheetCount: count };
  const sheets: Sheet[] = p.chosen.map((plan, i) =>
    composePlanSheet(
      layout,
      plan,
      p.dims.get(plan.levelId) ?? [],
      axonometric(p.doc, p.derived, p.all, plan.levelId),
      rows.get(plan.levelId) ?? [],
      {
        ...common,
        levelName: plan.levelName,
        sheetNumber: `A-${String(101 + i)}`,
        sheetIndex: i,
        viewCaption: plan.levelId === p.all[p.all.length - 1]!.levelId ? 'Whole model' : `Cut above ${plan.levelName}`,
      },
      pdf.measure,
    ),
  );
  if (extra === 1) {
    const top = p.all[p.all.length - 1]!;
    sheets.push(
      composeScheduleSheet(
        layout,
        p.chosen.map((plan) => ({ title: `${plan.levelName} — doors and windows`, rows: rows.get(plan.levelId) ?? [] })),
        axonometric(p.doc, p.derived, p.all, top.levelId),
        { ...common, levelName: top.levelName, sheetNumber: 'A-601', sheetIndex: p.chosen.length, viewCaption: 'Whole model' },
        pdf.measure,
      ),
    );
  }
  const bytes = await pdf.write(sheets);
  const v = options.version.seq === undefined || options.version.seq === null ? options.version.hash.slice(0, 8) : `v${String(options.version.seq)}`;
  return { name: `${slug(name)}-${v}-plans.pdf`, contentType: 'application/pdf', bytes, sheets };
}

/** The DXF drawings: one file per level; a ZIP of them when there are several. */
export function exportDxf(document: object, options: DrawingOptions): DxfResult {
  const p = prepare(document, options);
  const name = p.doc.project.name;
  const enc = new TextEncoder();
  const v = options.version.seq === undefined || options.version.seq === null ? options.version.hash.slice(0, 8) : `v${String(options.version.seq)}`;
  const files: DrawingFile[] = p.chosen.map((plan) => ({
    name: `${slug(name)}-${v}-${slug(plan.levelName)}.dxf`,
    contentType: 'image/vnd.dxf',
    bytes: enc.encode(
      levelDxf(plan, p.dims.get(plan.levelId) ?? [], {
        projectName: name,
        levelName: plan.levelName,
        version: versionLabel(options.version).replace('·', '-'),
        date: isoDate(options.version.at),
        units: p.units,
      }),
    ),
  }));
  // Two levels with the same name would collide in the archive: the later one gets its ID too.
  const seen = new Set<string>();
  const unique = files.map((f, i) => {
    let n = f.name;
    if (seen.has(n)) n = n.replace(/\.dxf$/, `-${slug(p.chosen[i]!.levelId)}.dxf`);
    seen.add(n);
    return { ...f, name: n };
  });
  if (unique.length === 1) return { ...unique[0]!, files: unique };
  return {
    name: `${slug(name)}-${v}-dxf.zip`,
    contentType: 'application/zip',
    bytes: storedZip(unique.map((f) => ({ name: f.name, bytes: f.bytes })), options.version.at),
    files: unique,
  };
}
