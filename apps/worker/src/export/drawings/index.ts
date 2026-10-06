/**
 * PDF and DXF drawings (FLR-T-9.3, FLR-T-9.7; FLR-REQ-129, FLR-REQ-130).
 *
 * `exportPdf`: one sheet per level — the plan at a true architectural scale, dimensioned, with room
 * labels, door and window marks, stairs (treads, the cut line with its break, UP and DN) and the
 * roof's eave above, a 3D view rendered from the mesh, and a NOT FOR CONSTRUCTION mark — then a
 * roof plan sheet when a drawn level carries a roof, and a schedule sheet when a level's door and
 * window schedule fits beside none of its plans.
 * `exportDxf`: one AutoCAD 2000 DXF per level on NCS-pattern layers, and the roof plan as a DXF of
 * its own; several files come as a ZIP.
 *
 * Both draw one design of a model with design options (Core 19): the primary unless `design`
 * chooses another, and the title block says which. Both are pure functions of the document and the
 * version's facts (hash, number, time): the same inputs give the same bytes, and nothing reads the
 * clock.
 */
import { deriveFrom, evaluate, InvalidDocumentError, OFFICIAL_READER, openingDimensions, type Evaluation, type FloorspecDocument } from '@floorspec/engine';
import { sceneOf, type ReaderOptions, type Scene } from '@floorspec/render2d';
import { buildSceneFrom as buildModel, type Scene as ModelScene } from '../gltf/scene.js';
import { MAX_WIDTH, renderView } from '../../render3d/index.js';
import { dimensionStrings, type DimString } from './dimensions.js';
import { levelDxf, roofDxf } from './dxf.js';
import { openPdf } from './pdf.js';
import { openingMarks, planOf, union, type Box, type LevelPlan, type Segment } from './plan.js';
import {
  composePlanSheet,
  composeRoofSheet,
  composeScheduleSheet,
  DEFAULT_PAGE,
  layoutSet,
  PAGES,
  ROOF_PLAN_TITLE,
  type PageName,
  type ScheduleRow,
  type Sheet,
  type View3d,
} from './sheet.js';
import type { PlanRoof } from './symbols.js';
import { lengthText, unitsOf, type UnitSystem } from './units.js';
import { storedZip } from './zip.js';

export { PAGES, DEFAULT_PAGE, type PageName, type Sheet } from './sheet.js';
export { LAYER_DEFS, LAYERS, isNcsName, layerForDevice } from './layers.js';
export { lengthText, areaText, unitsOf, type UnitSystem } from './units.js';
export { dimensionStrings, type DimString } from './dimensions.js';
export { openingMarks, planOf, levelPlan, type LevelPlan } from './plan.js';
export { sheetToSvg } from './svg.js';
export { NOT_FOR_CONSTRUCTION, NOT_A_PLAN_REVIEW, ROOF_PLAN_TITLE } from './sheet.js';
export { breakLine, pitchText, planRoof, planStair, type PlanRoof, type PlanStair, type RoofSlope } from './symbols.js';

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
  /** The design to draw (Core 19.6): option set → option. Default the primary design. */
  readonly design?: Readonly<Record<string, string>>;
  /** PDF only: the 3D view's resolution, dots per inch of the sheet. Default 300. */
  readonly viewDpi?: number;
  /**
   * The reader the model is validated with (Core 1.6.4, 12.2) — once, for the plans and the 3D
   * views alike. Default `OFFICIAL_READER`, the reader the api runs, so a model that requires an
   * official extension is drawn.
   */
  readonly reader?: ReaderOptions;
}

export interface DrawingFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface PdfResult extends DrawingFile {
  readonly sheets: readonly Sheet[];
  /** The design drawn (every option set's choice), or null for a model without design options. */
  readonly design: Record<string, string> | null;
}

export interface DxfResult extends DrawingFile {
  /** The DXF files, one per level and one for the roof plan (inside the ZIP when there are several). */
  readonly files: readonly DrawingFile[];
  readonly design: Record<string, string> | null;
}

interface Prepared {
  /** The one evaluation everything is drawn from. */
  readonly ev: Evaluation;
  readonly doc: FloorspecDocument;
  readonly units: UnitSystem;
  readonly all: readonly LevelPlan[];
  readonly chosen: readonly LevelPlan[];
  readonly dims: ReadonlyMap<string, readonly DimString[]>;
  readonly derived: ReturnType<typeof deriveFrom>;
  /** The roofs on the drawn levels: the roof plan, when there are any. */
  readonly roofs: readonly PlanRoof[];
  /** The exterior walls of the levels those roofs are on, drawn dashed under them. */
  readonly wallsBelow: readonly Segment[];
  readonly design: Record<string, string> | null;
  /** The design in words for the title block: `Kitchen — B: open · Deck — Deck`. */
  readonly designText: string | undefined;
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

/** A design in words, set by set in ID order: each set's name, then its option's. */
function designWords(original: FloorspecDocument, design: Readonly<Record<string, string>>): string {
  const sets = original.optionSets ?? {};
  const options = original.options ?? {};
  const primary = Object.keys(sets).every((k) => sets[k]?.primary === design[k]);
  const words = Object.keys(design)
    .sort()
    .map((k) => `${sets[k]?.name ?? k} — ${options[design[k]!]?.name ?? design[k]!}`)
    .join(' · ');
  return primary ? `${words} (primary)` : words;
}

function prepare(document: object, options: DrawingOptions): Prepared {
  const reader = options.reader ?? OFFICIAL_READER;
  const ev = evaluate(document, options.design === undefined ? reader : { ...reader, design: options.design });
  if (!ev.valid || !ev.document) throw new InvalidDocumentError(ev.diagnostics);
  if (!ev.view || !ev.analysis) throw new RangeError('the model has no such design, or that design is not valid (Core 19.6.2)');
  const doc = ev.view;
  const derived = deriveFrom(doc, ev.analysis);
  const design = ev.design ?? null;
  const order = levelOrder(doc);
  if (order.length === 0) throw new RangeError('the model has no levels to draw');
  const wanted = options.levels ?? order;
  for (const l of wanted) if (!order.includes(l)) throw new RangeError(`the model has no level ${l}`);
  // Every level from the one evaluation and its derived values: nothing is validated again.
  const scenes: Scene[] = order.map((l) => sceneOf(ev, l, derived));
  // Marks number the whole model, so a door is D3 whichever levels are drawn.
  const marks = openingMarks(scenes);
  const all = scenes.map((s) => planOf(s, marks, { doc, derived }));
  const chosen = all.filter((p) => wanted.includes(p.levelId));
  const dims = new Map(chosen.map((p) => [p.levelId, dimensionStrings(p)]));
  const roofs = chosen.flatMap((p) => p.roofs);
  const wallsBelow = chosen.filter((p) => p.roofs.length > 0).flatMap((p) => p.wallLines.filter((l) => l.layer === 'A-WALL-EXTR'));
  return { ev, doc, units: unitsOf(doc), all, chosen, dims, derived, roofs, wallsBelow, design: design === null ? null : { ...design }, designText: design === null ? undefined : designWords(ev.document, design) };
}

/**
 * The sheets' 3D views, from the mesh (FLR-T-9.7): the model of the drawn design, cut away above a
 * level or whole, rendered at the panel's shape and `dpi`. Renders are kept by what they show, so
 * the whole model drawn on three sheets is drawn once.
 */
function viewsOf(model: ModelScene, doc: FloorspecDocument, dpi: number): (level: string | undefined) => View3d {
  const cache = new Map<string, { png: Uint8Array } | null>();
  const elevation = (id: string): number => doc.levels?.[id]?.elevation ?? 0;
  const present = new Set(model.levels.map((l) => l.id));
  // A level with nothing meshed on it is cut at the highest level below it that has something.
  const cutAt = (level: string): string | null | undefined => {
    if (present.has(level)) return level;
    const below = model.levels.filter((l) => l.elevation * 1_280_000 <= elevation(level));
    return below.length === 0 ? null : below[below.length - 1]!.id;
  };
  return (level) => (wPt, hPt) => {
    const cut = level === undefined ? undefined : cutAt(level);
    if (cut === null) return null;
    const width = Math.max(16, Math.min(MAX_WIDTH, Math.round((wPt / 72) * dpi)));
    const height = Math.max(16, Math.min(MAX_WIDTH, Math.round((width * hPt) / wPt)));
    const key = `${cut ?? '*'}:${String(width)}x${String(height)}`;
    if (!cache.has(key)) {
      const r = renderView(model, { width, height, ...(cut === undefined ? {} : { level: cut }) });
      cache.set(key, r === null ? null : { png: r.png });
    }
    return cache.get(key) ?? null;
  };
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
  const model = await buildModel(p.ev);
  const views = viewsOf(model, p.doc, options.viewDpi ?? 300);
  const pdf = openPdf(
    {
      title: `${name} — floor plans`,
      subject: `Floor plans drawn from Floorspec model ${versionLabel(options.version)}${p.designText === undefined ? '' : `, design ${p.designText}`}. NOT FOR CONSTRUCTION; not a plan review.`,
      keywords: `floorspec ${options.version.hash}`,
      date: options.version.at,
    },
    options.fontDir,
  );
  const roofSheet = p.roofs.length > 0 ? 1 : 0;
  const extra = layout.schedule === 'sheet' ? 1 : 0;
  const count = p.chosen.length + roofSheet + extra;
  const common = {
    projectName: name,
    date: isoDate(options.version.at),
    version: versionLabel(options.version),
    units: p.units,
    sheetCount: count,
    ...(p.designText === undefined ? {} : { design: p.designText }),
  };
  const top = p.all[p.all.length - 1]!;
  const sheets: Sheet[] = p.chosen.map((plan, i) =>
    composePlanSheet(
      layout,
      plan,
      p.dims.get(plan.levelId) ?? [],
      views(plan.levelId),
      rows.get(plan.levelId) ?? [],
      { ...common, levelName: plan.levelName, sheetNumber: `A-${String(101 + i)}`, sheetIndex: i, viewCaption: `Cut above ${plan.levelName}` },
      pdf.measure,
    ),
  );
  if (roofSheet === 1) {
    const i = p.chosen.length;
    sheets.push(
      composeRoofSheet(layout, p.roofs, p.wallsBelow, top.trueNorth, views(undefined), { ...common, levelName: ROOF_PLAN_TITLE, sheetNumber: `A-${String(101 + i)}`, sheetIndex: i, viewCaption: 'Whole model' }, pdf.measure),
    );
  }
  if (extra === 1) {
    sheets.push(
      composeScheduleSheet(
        layout,
        p.chosen.map((plan) => ({ title: `${plan.levelName} — doors and windows`, rows: rows.get(plan.levelId) ?? [] })),
        views(undefined),
        { ...common, levelName: top.levelName, sheetNumber: 'A-601', sheetIndex: p.chosen.length + roofSheet, viewCaption: 'Whole model' },
        pdf.measure,
      ),
    );
  }
  const bytes = await pdf.write(sheets);
  const v = options.version.seq === undefined || options.version.seq === null ? options.version.hash.slice(0, 8) : `v${String(options.version.seq)}`;
  return { name: `${slug(name)}-${v}-plans.pdf`, contentType: 'application/pdf', bytes, sheets, design: p.design };
}

/** The DXF drawings: one file per level; a ZIP of them when there are several. */
export function exportDxf(document: object, options: DrawingOptions): DxfResult {
  const p = prepare(document, options);
  const name = p.doc.project.name;
  const enc = new TextEncoder();
  const v = options.version.seq === undefined || options.version.seq === null ? options.version.hash.slice(0, 8) : `v${String(options.version.seq)}`;
  const meta = (levelName: string) => ({
    projectName: name,
    levelName,
    version: versionLabel(options.version).replace('·', '-'),
    date: isoDate(options.version.at),
    units: p.units,
    ...(p.designText === undefined ? {} : { design: p.designText }),
  });
  const files: DrawingFile[] = p.chosen.map((plan) => ({
    name: `${slug(name)}-${v}-${slug(plan.levelName)}.dxf`,
    contentType: 'image/vnd.dxf',
    bytes: enc.encode(levelDxf(plan, p.dims.get(plan.levelId) ?? [], meta(plan.levelName))),
  }));
  if (p.roofs.length > 0)
    files.push({ name: `${slug(name)}-${v}-roof-plan.dxf`, contentType: 'image/vnd.dxf', bytes: enc.encode(roofDxf(p.roofs, p.all[0]!.trueNorth, meta(ROOF_PLAN_TITLE))) });
  // Two levels with the same name would collide in the archive: the later one gets its ID too.
  const seen = new Set<string>();
  const unique = files.map((f, i) => {
    let n = f.name;
    if (seen.has(n)) n = n.replace(/\.dxf$/, `-${slug(p.chosen[i]?.levelId ?? 'roof')}.dxf`);
    seen.add(n);
    return { ...f, name: n };
  });
  if (unique.length === 1) return { ...unique[0]!, files: unique, design: p.design };
  return {
    name: `${slug(name)}-${v}-dxf.zip`,
    contentType: 'application/zip',
    bytes: storedZip(unique.map((f) => ({ name: f.name, bytes: f.bytes })), options.version.at),
    files: unique,
    design: p.design,
  };
}
