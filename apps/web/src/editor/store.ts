import { useSyncExternalStore } from 'react';
import { OFFICIAL_READER, type Diagnostic } from '@floorspec/engine';
import { apply as applyLocally } from '@floorspec/ops';
import {
  fetchHead,
  fetchHistory,
  fetchProject,
  fetchVersion,
  HttpFailure,
  postBatch,
  postRestore,
  postUndo,
  type ApplyAnswer,
  type ChangesetLogEntry,
  type ChangesetRow,
  type History,
  type HistoryEntry,
  type ProjectInfo,
} from './api';
import { readModel, sortedLevels, levelOfElement, type EditorModel, type LevelView, type Point } from './model';
import { fixToOps, type Batch, type BatchBuilder, type ChainVertex, type TypeChoice } from './ops';
import type { Snap } from './snap';
import { unitsOf, type UnitSystem } from './units';
import { NO_OPTIONS, type ReceptacleOptions } from './systems/catalog';
import type { DeviceHover } from './systems/placement';
import type { ResizeAnchor } from '@floorspec/ops';
import type { HandleSide, Size } from '../furniture/resize';
import type { Side as RoomSideName } from './rooms/edit';
import type { ImportReport } from '../exports/ifcImport';
import { carryRiders } from './arrange/carry';
import { rigidPreview } from './rigid';

/**
 * The editor's state and its one write path. Every edit is a batch handed to `apply`, which posts
 * it with `If-Match` on the head, then re-reads the version the server committed and re-derives
 * it with the engine — the editor never edits the document itself (FLR-ADR-008). A rejection
 * keeps the model exactly as it was and holds the coded diagnostics for the banner (FLR-T-3.8).
 *
 * The store is a plain external store (useSyncExternalStore), so the canvas's tools can read and
 * write it between renders without threading callbacks through every component.
 */

/** The forms the stair tool draws (Core 17.2). */
export type StairForm = 'straight' | 'lShaped' | 'uShaped' | 'winder' | 'spiral';

/**
 * `hand` drags the plan (FLR-T-18.6); `wand` makes a room of the space clicked (FLR-T-18.10); `place`
 * places the library's item under the pointer, click after click (FLR-T-18.7); `measure` measures the
 * plan, point to point, chained, an area (FLR-T-18.9).
 */
export type ToolId = 'select' | 'hand' | 'wall' | 'arc' | 'separator' | 'slab' | 'roof' | 'stair' | 'door' | 'window' | 'room' | 'wand' | 'device' | 'place' | 'measure' | 'dimension' | 'note' | 'lot' | 'setback' | 'spot' | 'contour' | 'pad' | 'fence' | 'context' | 'tree' | 'neighbour' | 'street' | 'solar';

/**
 * The tools that draw a chain of points: walls and separators (a polyline), and the outlines of a
 * slab (Core 0.3, 6.7) and a roof's footprint (Core 0.3, 16.1).
 */
export type ChainTool = 'wall' | 'separator' | 'slab' | 'roof' | 'lot' | 'pad' | 'contour' | 'fence' | 'neighbour' | 'street';
export const isChainTool = (t: unknown): t is ChainTool => t === 'wall' || t === 'separator' || t === 'slab' || t === 'roof' || t === 'lot' || t === 'pad' || t === 'contour' || t === 'fence' || t === 'neighbour' || t === 'street';
/** The chain tools that draw a closed outline (at least three corners) rather than a polyline. */
export const isOutlineTool = (t: unknown): t is 'slab' | 'roof' | 'lot' | 'pad' | 'neighbour' => t === 'slab' || t === 'roof' || t === 'lot' || t === 'pad' || t === 'neighbour';
/** FLR-T-15.1: a contour line is a polyline that goes on until it is finished, whatever the chain setting. */
export const keepsChaining = (t: unknown): boolean => isOutlineTool(t) || t === 'contour' || t === 'fence' || t === 'street';

export type ChainDraft = { tool: ChainTool; chain: ChainVertex[]; cursor: Snap | null; typed: string };

/**
 * The arc-wall tool (Core 0.4, chapter 21): its start, then its end — clicked, or a chord length typed and
 * aimed with the arrows — then its bulge: the sagitta, or a radius (Tab switches), typed, or where the
 * pointer is; Shift+F flips it. In three-point mode the third click is a point the arc passes through.
 */
export interface ArcDraft {
  tool: 'arc';
  start: ChainVertex | null;
  end: ChainVertex | null;
  cursor: Snap | null;
  typed: string;
  /** What a typed length sets in the bulge step. */
  field: 'sagitta' | 'radius';
  /** The bulge so far, signed: positive bulges to the left of start → end (Core 21.1). */
  sagitta: number;
}
export const isArcDraft = (d: Draft | null | undefined): d is ArcDraft => d !== null && d !== undefined && d.tool === 'arc';
export const isChainDraft = (d: Draft | null | undefined): d is ChainDraft => d !== null && d !== undefined && isChainTool(d.tool);

export interface Rejection {
  /** What the person tried: "Draw walls", "Move W3". */
  label: string;
  diagnostics: Diagnostic[];
  /** The batch as sent, so a fix can be applied together with it. */
  batch: Batch;
}

/** The ghost overlay: what a batch would make, applied locally by @floorspec/ops for preview. */
export interface Preview {
  model: EditorModel | null;
  diagnostics: Diagnostic[];
  /**
   * FLR-T-18.18: the batch only moves and turns devices — nothing the ghost layer draws (walls,
   * openings, slabs) changes. While the pointer moves, `model` is the rigid preview (rigid.ts), with
   * no derive; `exact` once the full apply has run, the pointer at rest.
   */
  rigid?: { exact: boolean };
}

/** How long the pointer rests on a rigid preview before the full apply runs for its findings. */
export const EXACT_AFTER_MS = 160;

export type Draft =
  | ChainDraft
  | ArcDraft
  | {
      tool: 'door' | 'window';
      hover: { wall: string; offset: number; centered: boolean; width: number; side: 'left' | 'right'; nearer: 'start' | 'end'; fits: boolean } | null;
      typed: string;
    }
  | { tool: 'room'; hover: { point: Point; free: boolean } | null }
  | WandDraft
  /** The stair tool (Core 0.3, 17): its foot clicked, then the direction it rises in. */
  | { tool: 'stair'; foot: Point | null; cursor: Point | null }
  | { tool: 'device'; hover: DeviceHover | null; typed: string; /** A string light's first point (FLR-T-15.5), once chosen. */ from?: Point | null }
  | {
      tool: 'select';
      drag:
        | { kind: 'junction'; id: string; to: Point; snap: Snap }
        | { kind: 'wall'; id: string; by: number }
        | { kind: 'opening'; id: string; offset: number; centered: boolean }
        | { kind: 'device'; id: string; hover: DeviceHover }
        /** FLR-T-18.4: a handle of an item's footprint dragged — the resizeElement it would be. */
        | { kind: 'resize'; id: string; side: HandleSide; anchor: ResizeAnchor; size: Partial<Size>; hint: string }
        /** FLR-T-18.4: the rotate handle dragged — the facing, and the position that keeps the item's middle. */
        | { kind: 'rotate'; id: string; rotation: number }
        /** FLR-T-18.10: a room's edge handle dragged — the resizeRoom it would be. */
        | { kind: 'roomSide'; id: string; side: RoomSideName; by: number }
        /** FLR-T-18.10: a selected room dragged by its floor — the moveRoom it would be. */
        | { kind: 'room'; id: string; by: Point }
        | null;
      typed: string;
    };

/**
 * The magic wand (FLR-T-18.10): the face under the pointer, and once clicked the faces the click could
 * mean (Tab cycles them), with the name and the function the room will be made with — each candidate
 * kept as the point addRoom would anchor it at, so a model read back in between still finds its face.
 */
export interface WandDraft {
  tool: 'wand';
  hover: Point | null;
  pick: {
    candidates: { at: Point; how: 'here' | 'around' | 'inside' | 'beside' }[];
    index: number;
    name: string;
    /** A room function (Core 6.3), or 'unspecified'. */
    fn: string;
    /** The function was chosen, not guessed from the name. */
    fnChosen: boolean;
    /** The name field should take focus (a key typed on the plan starts the name). */
    focusName: boolean;
  } | null;
}

export interface Viewport {
  /** World point at the centre of the canvas, base units. */
  cx: number;
  cy: number;
  /** Pixels per base unit. */
  s: number;
  w: number;
  h: number;
}

export interface Layers {
  walls: boolean;
  openings: boolean;
  rooms: boolean;
  dimensions: boolean;
  findings: boolean;
  /** The building systems (FLR-T-5.7), one eye each. */
  electrical: boolean;
  plumbing: boolean;
  mechanical: boolean;
  lowvoltage: boolean;
  /** Clearance envelopes (Core 13.5): working space, fixture clearances, door swings' boxes. */
  clearances: boolean;
  /** Draw every extension element as a reader without its extension does: its fallback box (Core 1.6.9, 12.6). */
  coreOnly: boolean;
  /** The roof layer (Core 0.3, 16): each roof's eave outline, ridges, hips and valleys over the plan. */
  roof: boolean;
  /** FS_furniture's items (FLR-T-8.3); absent: shown. */
  furniture?: boolean;
  /** FLR-T-18.3: FS_furniture's casework and appliances, and FS_landscape's garden; absent: shown. */
  casework?: boolean;
  landscape?: boolean;
  /** FLR-T-15.2, FS_outdoor: pools, fences, shelters, outdoor kitchens and fires; absent: shown. */
  outdoor?: boolean;
  /** FLR-T-15.1, FS_site: the lot and its setbacks, the contours, cut and fill, and the spot elevations; absent: shown. */
  site?: boolean;
  contours?: boolean;
  grading?: boolean;
  spots?: boolean;
  /** FLR-T-15.5: where exterior lights' light lands, drawn under them; absent: shown. */
  beams?: boolean;
  /** FLR-T-15.3, FS_context: the street, the neighbours and the trees beyond the lot; absent: shown. */
  context?: boolean;
  /** FLR-T-16.1, FS_energy: the solar arrays on each level's roofs and the setbacks they keep; absent: shown. */
  solar?: boolean;
}

export interface DrawSettings {
  wallType: string | null;
  /** The arc-wall tool's mode (Core 0.4, 21): a chord and its sagitta, or three points. */
  arcMode: 'chord' | 'three';
  justification: 'center' | 'exteriorFace' | 'interiorFace';
  chain: boolean;
  doorType: string | null;
  windowType: string | null;
  /** The device tool's kind (systems/catalog.ts), and a receptacle's options. */
  device: string;
  receptacle: ReceptacleOptions;
  /** A wall mount's height; null for the kind's default. */
  height: number | null;
  /** The slab tool (Core 6.7): a new slab's thickness, its top above the level, and its purpose (Core 0.3). */
  slab: { thickness: number; offset: number; purpose: string | null };
  /** The roof tool (Core 0.3, 16.1): a new roof's pitch and overhang, and whether its two short ends are gables. */
  roof: { rise: number; run: number; overhang: number; gables: boolean };
  /** The stair tool (Core 17.1): a new stair's form, the way it turns, width, tread and greatest riser. */
  stair: { form: StairForm; turn: 'left' | 'right'; width: number; tread: number; maxRiser: number };
}

/**
 * A changeset under review (FLR-T-3.5): what an agent proposed, drawn over main. When main has moved
 * since the changeset's base, its batches are replayed onto main locally with @floorspec/ops —
 * the same applier the server's accept runs — and that rebased result is what is reviewed.
 */
export interface Review {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  base: string;
  log: ChangesetLogEntry[];
  /** The scratch head as proposed (against its base). */
  proposed: EditorModel | null;
  /** The replay onto main, when main has moved: against which main, and its result. */
  rebased: { against: string; model: EditorModel; differs: number[] } | null;
  /** A replay that failed — predicted here, or answered by the server's accept — and why. */
  failure: { against: string; detail: string; diagnostics: Diagnostic[]; failedIndex: number | null; source: 'preview' | 'server' } | null;
  loading: boolean;
  /** Accept or reject in flight. */
  busy: 'accept' | 'reject' | null;
  /** The second confirmation a rebased accept asks for is showing. */
  confirming: boolean;
  /** What an IFC import could not bring across, when the changeset is one (FLR-T-9.5). */
  report?: ImportReport | null;
  /**
   * FLR-T-18.18: a branch from an earlier version — main as it was opened on and the version its first
   * op returns to — so a replay makes that return again against main, as the server's accept does.
   */
  branch?: ReplayBranch | null;
}

/** A branch's return: the two documents its first op is rebased between (review.ts `replay`). */
export interface ReplayBranch {
  base: Record<string, unknown>;
  target: Record<string, unknown>;
}

/** Two versions compared on the canvas (FLR-T-3.6). */
export interface Compare {
  from: string;
  to: string;
  fromModel: EditorModel | null;
  toModel: EditorModel | null;
  loading: boolean;
  error: string | null;
  /**
   * FLR-T-18.14: the history scrubber's comparison — the plan drawn at `from` (the version scrubbed
   * to), what was added since green and what was removed since red, against `to`, main now.
   */
  scrub?: boolean;
}

/** A question the editor must ask before it can build a batch. */
export type Prompt =
  | { kind: 'keep'; wall: string; rooms: [string, string] }
  | { kind: 'remove'; id: string; title: string; detail: string };

export interface EditorState {
  status: 'loading' | 'ready' | 'error' | 'missing';
  error: string | null;
  project: ProjectInfo | null;
  model: EditorModel | null;
  history: History;
  level: string | null;
  /**
   * The primary selection: the element the inspector, the handles and every single-element action
   * read — the last one picked. Null exactly when `selected` is empty.
   */
  selection: string | null;
  /**
   * FLR-T-18.8: everything selected, in the order it was picked, the primary (`selection`) last.
   * The store keeps the two in step: a patch that sets only `selection` makes it the whole
   * selection, and one that sets only `selected` makes its last element the primary.
   */
  selected: readonly string[];
  hover: string | null;
  tool: ToolId;
  draft: Draft | null;
  /** The label of the edit in flight. */
  pending: string | null;
  rejection: Rejection | null;
  readOnly: string | null;
  preview: Preview | null;
  notice: { tone: 'info' | 'danger'; text: string } | null;
  view: Viewport | null;
  cursor: Point | null;
  layers: Layers;
  draw: DrawSettings;
  /** A field the inspector should focus once the selection renders (a new room's name). */
  focus: string | null;
  /** Panels shown on narrow screens. */
  treeOpen: boolean;
  findingsOpen: boolean;
  /** FLR-T-15.5: the exterior assistant's path-light spacing along a walk, base units; absent, Floorspec's default. */
  exteriorSpacing?: number;
  prompt: Prompt | null;
  /** The live event stream (FLR-T-3.5). */
  live: 'connecting' | 'live' | 'reconnecting';
  /** Pending changesets: what agents have proposed. */
  proposals: ChangesetRow[];
  review: Review | null;
  /** The right column: the inspector, or the review of a proposal. */
  side: 'inspector' | 'review' | 'options';
  /** The left column: the project tree, or the history (FLR-T-3.6). */
  left: 'tree' | 'history';
  /** FLR-T-18.16: the left drawer's tab beside the library: the project tree, or the elements on the plan. */
  leftTab: 'tree' | 'elements';
  log: HistoryEntry[] | null;
  tokenNames: ReadonlyMap<string, string>;
  compare: Compare | null;
  /** The arrow keys' step, base units; null for the units' default (1" or 10 mm). */
  nudge: number | null;
  palette: boolean;
  /** FLR-T-18.16: the keyboard shortcut sheet (?) is open. */
  shortcuts: boolean;
  /** The element being renamed in the tree (F2). */
  renaming: string | null;
  /** Picking on the plan what a switch controls (FLR-T-5.7): clicks toggle devices in its `controls`. */
  /**
   * Picking on the plan: a switch's lights (FLR-T-5.7), or a vaulted ceiling's ridge (Core 0.3, 15.3)
   * — two points, the first kept until the second is clicked.
   */
  picking: { switch: string } | { ridge: string; first: Point | null } | null;
  /**
   * Core 0.3, chapter 19: the design shown — option set → option, every set not named showing its
   * primary — and the option the editor edits in (Ops 0.3, 2.8: every batch is sent with it as
   * `context.option`), null for the common design.
   */
  design: Record<string, string>;
  editOption: string | null;
  /** Two options of one set compared side by side (FLR-T-8.4). */
  optionCompare: { set: string; a: string; b: string } | null;
  /** The materials list is open (FLR-T-8.1). */
  materialsOpen: boolean;
}

const initial: EditorState = {
  status: 'loading',
  error: null,
  project: null,
  model: null,
  history: { head: null, undo: null, redo: null, seq: null },
  level: null,
  selection: null,
  selected: [],
  hover: null,
  tool: 'select',
  draft: null,
  pending: null,
  rejection: null,
  readOnly: null,
  preview: null,
  notice: null,
  view: null,
  cursor: null,
  layers: { walls: true, openings: true, rooms: true, dimensions: true, findings: true, electrical: true, plumbing: true, mechanical: true, lowvoltage: true, clearances: false, coreOnly: false, roof: false },
  draw: { wallType: null, arcMode: 'chord', justification: 'center', chain: true, doorType: null, windowType: null, device: 'receptacle', receptacle: NO_OPTIONS, height: null, slab: { thickness: 130_048, offset: 0, purpose: null },
    // 6:12 with a 12" overhang; a 36" stair with 10" treads and risers no higher than 7 3/4".
    roof: { rise: 6, run: 12, overhang: 390_144, gables: false },
    stair: { form: 'straight', turn: 'left', width: 1_170_432, tread: 325_120, maxRiser: 251_968 } },
  focus: null,
  treeOpen: false,
  findingsOpen: false,
  prompt: null,
  live: 'connecting',
  proposals: [],
  review: null,
  side: 'inspector',
  left: 'tree',
  leftTab: 'tree',
  log: null,
  tokenNames: new Map(),
  compare: null,
  nudge: readNudge(),
  palette: false,
  shortcuts: false,
  renaming: null,
  picking: null,
  design: {},
  editOption: null,
  optionCompare: null,
  materialsOpen: false,
};

function readNudge(): number | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem('floorspec.nudge');
    const n = raw === null ? NaN : Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export interface ApplyOptions {
  /** Pick the element to select from the IDs the batch created. */
  select?: (created: string[]) => string | null | undefined;
  /** FLR-T-18.8: pick several to select (a paste, a duplicate, an array); the last is the primary. */
  selectMany?: (created: string[]) => string[];
  /** A field to focus after the selection changes. */
  focus?: string;
}

export class EditorStore {
  /**
   * What every batch passes through before it is sent: a view's rule for what it draws — FLR-T-18.13's
   * renovation plans mark what is drawn in the Proposed and Combined plans as new.
   */
  readonly batchFilters: ((batch: Batch) => Batch)[] = [];

  private state: EditorState = initial;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private previewFrame = 0;
  private previewBatch: Batch | null = null;
  private exactTimer: ReturnType<typeof setTimeout> | null = null;

  /** A changeset to open for review once the model loads, instead of the newest proposal. */
  wanted: string | null = null;

  constructor(readonly projectId: string) {}

  get = (): EditorState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next, ...selectionPatch(this.state, next) };
    for (const l of this.listeners) l();
  }

  // ─── Reading ─────────────────────────────────────────────────────────────────────────────

  get units(): UnitSystem {
    return unitsOf(this.state.model?.document);
  }

  get levelView(): LevelView | undefined {
    const { model, level } = this.state;
    return model?.levels.find((l) => l.id === level);
  }

  async load(): Promise<void> {
    this.set({ status: 'loading', error: null });
    try {
      const [project, head] = await Promise.all([fetchProject(this.projectId), fetchHead(this.projectId)]);
      if (head === null) {
        this.set({ status: 'error', project, error: 'This project has no model yet.' });
        return;
      }
      const model = readModel(head.hash, head.text, this.state.design);
      const history = await fetchHistory(this.projectId).catch(() => this.state.history);
      this.set({
        ...this.optionState(model),
        status: 'ready',
        project,
        model,
        history,
        compare: null,
        level: this.pickLevel(model, this.state.level),
        readOnly: model.valid ? null : 'This version of the model does not validate, so it cannot be edited here. Undo the change that broke it, or fix it in the file.',
      });
      this.onModel?.();
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 404) this.set({ status: 'missing', error: 'This project does not exist, or it is not yours.' });
      else this.set({ status: 'error', error: error instanceof Error ? error.message : 'The editor could not load the model.' });
    }
  }

  private pickLevel(model: EditorModel, wanted: string | null): string | null {
    if (wanted !== null && model.levels.some((l) => l.id === wanted)) return wanted;
    return sortedLevels(model.document)[0]?.id ?? null;
  }

  private adopting = 0;
  /** The newest read of a version: the model the editor is becoming. */
  private reading: Reading | null = null;
  /** Called after the model moves, by whoever needs to follow it (the review, the history). */
  onModel: (() => void) | null = null;

  /**
   * Read a committed version and make it the editor's model. The newest request wins — and none
   * returns before the newest has landed. An edit's own commit is read twice over: by `settle`, and by
   * `follow` on the live stream's word of it. When the stream's word comes second its read supersedes
   * the edit's, and if the edit's read returned there, the queue would send the next edit against the
   * head before the commit and the server would refuse it as stale (412): a key press on a handle,
   * pressed while the one before it was still being read back, lost (FLR-T-18.19). So a read already
   * under way for the same version is joined rather than repeated, and a superseded one waits for the
   * read that superseded it.
   */
  private adopt(hash: string): Promise<void> {
    const under = this.reading;
    if (under !== null && !under.done && under.hash === hash) return this.landed(under);
    const ticket = ++this.adopting;
    const read = this.read(hash, ticket);
    const reading: Reading = { hash, done: false, finished: read.then(() => undefined, () => undefined) };
    void reading.finished.then(() => {
      reading.done = true;
    });
    this.reading = reading;
    return read.then(() => this.landed(reading));
  }

  /** Once `from` has finished, and every read that superseded it. */
  private async landed(from: Reading): Promise<void> {
    let at = from;
    await at.finished;
    while (this.reading !== null && this.reading !== at) {
      at = this.reading;
      await at.finished;
    }
  }

  private async read(hash: string, ticket: number): Promise<void> {
    const text = await fetchVersion(this.projectId, hash);
    const model = readModel(hash, text, this.state.design);
    const history = await fetchHistory(this.projectId).catch(() => this.state.history);
    if (ticket !== this.adopting) return;
    this.set((s) => ({
      ...this.optionState(model),
      model,
      history,
      level: this.pickLevel(model, s.level),
      ...survivors(s, model),
      hover: null,
      preview: null,
      readOnly: model.valid ? null : s.readOnly,
    }));
    this.onModel?.();
  }

  /**
   * Main moved somewhere else — another tab, an undo, an accepted changeset (FLR-T-3.5): read the
   * new head. The tool, its draft and the view are left as they are; the selection survives if
   * the element does.
   */
  follow(hash: string, seq: number | null): Promise<void> {
    const { model, history } = this.state;
    if (model?.hash === hash) return Promise.resolve();
    if (seq !== null && history.seq !== null && seq < history.seq) return Promise.resolve();
    return this.adopt(hash).catch(() => this.reloadHead());
  }

  // ─── Writing ─────────────────────────────────────────────────────────────────────────────

  /**
   * Apply a batch to main. Edits are serialised: each waits for the one before it, so each is sent
   * against the head the previous one produced.
   */
  apply(label: string, batch: Batch | BatchBuilder, options: ApplyOptions = {}): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const { model, readOnly } = this.state;
      if (model === null || readOnly !== null || this.state.compare !== null) return false;
      this.set({ pending: label, notice: null });
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const built = typeof batch === 'function' ? batch(attempt) : batch;
          // FLR-T-18.18: what sits on what the batch moves goes with it, in the same batch; then each view's rule
          // for what it draws (FLR-T-18.13: what is drawn in the Proposed and Combined plans is new).
          const sent = this.batchFilters.reduce((b, f) => f(b), carryRiders(this.state.model ?? model, built));
          if (sent.length === 0) return false;
          const option = this.state.editOption;
          const answer = await postBatch(this.projectId, this.state.model?.hash ?? model.hash, sent, option === null ? undefined : option);
          // An ID the builder chose was used or retired: build again with the next one.
          if (answer.status === 'rejected' && typeof batch === 'function' && answer.diagnostics.some((d) => d.code === 'FS-OPS-005')) continue;
          return await this.settle(answer, label, sent, options);
        }
        return false;
      } finally {
        this.set({ pending: null });
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async settle(answer: ApplyAnswer, label: string, batch: Batch, options: ApplyOptions): Promise<boolean> {
    switch (answer.status) {
      case 'committed': {
        await this.adopt(answer.hash);
        const selected = options.select?.(answer.created);
        // What the batch made (the server's word for it — the model read back may already be a newer
        // one, or an older one if a live event's read won the race) and what was there before it.
        const many = options.selectMany?.(answer.created).filter((id) => answer.created.includes(id) || this.state.model?.index.has(id) === true);
        this.set({
          rejection: null,
          ...(selected === undefined ? {} : { selection: selected }),
          ...(many === undefined ? {} : { selected: many }),
          ...(selected !== undefined && selected !== null ? { level: levelOfElement(this.state.model as EditorModel, selected) ?? this.state.level } : {}),
          ...(options.focus === undefined ? {} : { focus: options.focus }),
        });
        return true;
      }
      case 'rejected':
        this.set({ rejection: { label, diagnostics: answer.diagnostics, batch }, preview: null });
        return false;
      case 'stale':
        await this.reloadHead();
        this.set({ notice: { tone: 'info', text: 'The model changed since you last read it, so nothing was applied. It has been reloaded — try again.' } });
        return false;
      case 'forbidden':
        this.preview(null);
        this.set({ readOnly: 'You can view this project but not change it.', notice: { tone: 'danger', text: answer.message }, tool: 'select', draft: null });
        return false;
      case 'nothing':
        this.set({ notice: { tone: 'info', text: answer.message.charAt(0).toUpperCase() + answer.message.slice(1) } });
        return false;
      case 'failed':
        this.set({ notice: { tone: 'danger', text: answer.message } });
        return false;
    }
  }

  async reloadHead(): Promise<void> {
    const head = await fetchHead(this.projectId);
    if (head !== null) await this.adopt(head.hash);
  }

  undo(mode: 'undo' | 'redo'): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const { model, readOnly } = this.state;
      if (model === null || readOnly !== null) return false;
      this.set({ pending: mode === 'undo' ? 'Undo' : 'Redo', notice: null, rejection: null });
      try {
        const answer = await postUndo(this.projectId, this.state.model?.hash ?? model.hash, mode);
        return await this.settle(answer, mode === 'undo' ? 'Undo' : 'Redo', [], {});
      } finally {
        this.set({ pending: null });
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * FLR-T-18.14: return main to the version after op `seq`, as one new op the server writes — the
   * inverses of every op after it. History is appended to, never rewritten; undo takes it back.
   */
  restore(seq: number): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const { model, readOnly } = this.state;
      if (model === null || readOnly !== null) return false;
      const label = `Restore v${String(seq)}`;
      this.set({ pending: label, notice: null, rejection: null });
      try {
        return await this.settle(await postRestore(this.projectId, this.state.model?.hash ?? model.hash, seq), label, [], {});
      } finally {
        this.set({ pending: null });
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Apply a diagnostic's fix. For a rejected batch the fix is about the document the batch tried
   * to make, so it is sent together with that batch — the edit and its repair as one transaction.
   * For one of the head's own findings, the fix is sent alone.
   */
  applyFix(diagnostic: Diagnostic): Promise<boolean> {
    const fix = diagnostic.fix ?? [];
    if (fix.length === 0) return Promise.resolve(false);
    const rejection = this.state.rejection;
    if (rejection !== null && rejection.diagnostics.includes(diagnostic)) {
      return this.apply(withFix(rejection.label), [...rejection.batch, ...fixToOps(fix)]);
    }
    return this.apply(`Fix ${diagnostic.code}`, fixToOps(fix));
  }

  /** Apply every fix the rejection's diagnostics offer, with the batch, as one transaction. */
  applyAllFixes(): Promise<boolean> {
    const rejection = this.state.rejection;
    if (rejection === null) return Promise.resolve(false);
    const fixes = rejection.diagnostics.flatMap((d) => d.fix ?? []);
    if (fixes.length === 0) return Promise.resolve(false);
    return this.apply(withFix(rejection.label), [...rejection.batch, ...fixToOps(fixes)]);
  }

  dismissRejection(): void {
    this.set({ rejection: null });
  }

  // ─── Preview (the ghost layer) ───────────────────────────────────────────────────────────

  /**
   * Show what a batch would make, at most once a frame. A batch that only moves and turns devices is
   * previewed rigidly (rigid.ts: no apply, no derive) while it keeps changing, and applied in full
   * once it has rested for EXACT_AFTER_MS — so its findings still show. Anything else is applied
   * locally and derived, as the server would.
   */
  preview(batch: Batch | null): void {
    this.previewBatch = batch;
    if (this.exactTimer !== null) {
      clearTimeout(this.exactTimer);
      this.exactTimer = null;
    }
    if (batch === null) {
      cancelAnimationFrame(this.previewFrame);
      this.previewFrame = 0;
      if (this.state.preview !== null) this.set({ preview: null });
      return;
    }
    if (this.previewFrame !== 0) return;
    this.previewFrame = requestAnimationFrame(() => {
      this.previewFrame = 0;
      const pending = this.previewBatch;
      const model = this.state.model;
      if (pending === null || model === null) return;
      const carried = carryRiders(model, pending);
      const rigid = rigidPreview(model, carried);
      if (rigid !== null) {
        this.set({ preview: { model: rigid, diagnostics: [], rigid: { exact: false } } });
        if (this.exactTimer !== null) clearTimeout(this.exactTimer);
        this.exactTimer = setTimeout(() => {
          this.exactTimer = null;
          if (this.previewBatch !== pending || this.state.model !== model) return;
          this.set({ preview: { ...this.applyPreview(model, carried), rigid: { exact: true } } });
        }, EXACT_AFTER_MS);
        return;
      }
      this.set({ preview: this.applyPreview(model, carried) });
    });
  }

  /** A batch applied locally by @floorspec/ops and derived: what the ghost draws, or why it would be refused. */
  private applyPreview(model: EditorModel, batch: Batch): Preview {
    const option = this.state.editOption;
    const result = applyLocally(model.document, { batch, ...(option === null ? {} : { context: { option } }) }, OFFICIAL_READER);
    if (result.status === 'committed') return { model: readModel(result.hash, result.document, this.state.design), diagnostics: [] };
    return { model: null, diagnostics: result.diagnostics };
  }

  // ─── Selection and tools ─────────────────────────────────────────────────────────────────

  /**
   * Select an element. Choosing one on the plan or in the tree brings the inspector back over a
   * proposal under review (the proposal stays, a click away in the top bar); a link inside the
   * proposal panel keeps the panel (`keepSide`).
   */
  select(id: string | null, options: { keepSide?: boolean } = {}): void {
    if (id === null) {
      this.set({ selection: null });
      return;
    }
    const model = this.state.model;
    const level = model === null ? undefined : levelOfElement(model, id);
    this.set({ selection: id, selected: [id], ...(level === undefined ? {} : { level }), ...(options.keepSide === true ? {} : { side: 'inspector' as const }) });
  }

  /**
   * FLR-T-18.8: select several elements at once — a marquee, "select similar", what a paste made.
   * The last is the primary. With `add`, they join the selection rather than replacing it.
   */
  selectMany(ids: readonly string[], options: { add?: boolean; primary?: string } = {}): void {
    const base = options.add === true ? this.state.selected.filter((id) => !ids.includes(id)) : [];
    const all = [...base, ...ids];
    const primary = options.primary !== undefined && all.includes(options.primary) ? options.primary : all[all.length - 1];
    const ordered = primary === undefined ? all : [...all.filter((id) => id !== primary), primary];
    this.set({ selected: ordered, ...(ordered.length > 0 ? { side: 'inspector' as const } : {}) });
  }

  /** FLR-T-18.8: ⇧- or ⌘-click — add an element to the selection, or take it out if it is in it. */
  toggleSelected(id: string): void {
    const { selected } = this.state;
    if (selected.includes(id)) this.set({ selected: selected.filter((x) => x !== id) });
    else this.selectMany([id], { add: true });
  }

  setTool(tool: ToolId): void {
    this.preview(null);
    this.set({ tool, draft: null, hover: null, picking: null });
  }

  setLevel(level: string): void {
    this.preview(null);
    this.set({ level, selection: null, hover: null, draft: null });
  }

  /** The arrow keys' step, base units (FLR-T-3.7): the setting, or 1" in ft-in and 10 mm in metric. */
  get nudgeStep(): number {
    return this.state.nudge ?? (this.units === 'metric' ? 12_800 : 32_512);
  }

  setNudge(step: number | null): void {
    this.set({ nudge: step });
    try {
      if (step === null) localStorage.removeItem('floorspec.nudge');
      else localStorage.setItem('floorspec.nudge', String(step));
    } catch {
      // Storage refused (a private window): the setting lasts for this session.
    }
  }

  /** The model the canvas shows: main, or the newer version of a comparison. */
  get shown(): EditorModel | null {
    const { compare, model } = this.state;
    return compare === null ? model : compare.scrub === true ? compare.fromModel : compare.toModel;
  }

  // ─── Design options (Core 0.3, chapter 19; FLR-T-8.4) ───────────────────────────────────

  /** What a newly read model keeps of the option state: choices and an edit option that still exist. */
  private optionState(model: EditorModel): Pick<EditorState, 'design' | 'editOption' | 'optionCompare'> {
    const { editOption, optionCompare } = this.state;
    const exists = (o: string) => model.optionSets.some((set) => set.options.some((x) => x.id === o));
    const compare = optionCompare !== null && exists(optionCompare.a) && exists(optionCompare.b) ? optionCompare : null;
    return { design: model.design, editOption: editOption !== null && exists(editOption) ? editOption : null, optionCompare: compare };
  }

  /** Show a design: `set` showing `option` (the shown design never hides the option being edited in). */
  showOption(set: string, option: string): void {
    const { model, editOption } = this.state;
    if (model === null) return;
    const design = { ...this.state.design, [set]: option };
    const editing = editOption !== null && model.optionSets.find((s) => s.id === set)?.options.some((o) => o.id === editOption) === true && editOption !== option ? null : editOption;
    this.preview(null);
    this.set({ design, editOption: editing, model: readModel(model.hash, model.document, design), draft: null });
  }

  /** Edit in an option (null: the common design). Shows it, so what is drawn is what is seen. */
  editIn(option: string | null): void {
    const model = this.state.model;
    if (model === null) return;
    if (option === null) {
      this.set({ editOption: null });
      return;
    }
    const set = model.optionSets.find((s) => s.options.some((o) => o.id === option));
    if (set === undefined) return;
    this.showOption(set.id, option);
    this.set({ editOption: option });
  }

  /** The type the draw panel has chosen, as a choice (a document type or a starter). */
  chosenType(choices: TypeChoice[], id: string | null): TypeChoice | undefined {
    return choices.find((c) => c.id === id) ?? choices[0];
  }
}

/**
 * FLR-T-18.8: keep `selection` (the primary) and `selected` (all of it) in step. A patch that names
 * only one of them sets the other from it; one that names both is trusted, its primary put last.
 */
function selectionPatch(state: EditorState, next: Partial<EditorState>): Partial<EditorState> {
  const hasPrimary = Object.hasOwn(next, 'selection');
  const hasAll = Object.hasOwn(next, 'selected');
  if (!hasPrimary && !hasAll) return {};
  if (hasPrimary && !hasAll) {
    const id = next.selection ?? null;
    // The primary moved within the selection (a click on one of several): the rest stay selected.
    if (id !== null && state.selected.length > 1 && state.selected.includes(id) && state.selection === id) return { selected: state.selected };
    return { selected: id === null ? [] : [id] };
  }
  const all = [...new Set(next.selected ?? [])];
  if (!hasPrimary) return { selected: all, selection: all[all.length - 1] ?? null };
  const primary = next.selection ?? null;
  if (primary === null) return { selected: [], selection: null };
  return { selected: [...all.filter((id) => id !== primary), primary], selection: primary };
}

/** What survives of the selection in a newly read model: the elements that still exist. */
function survivors(s: EditorState, model: EditorModel): Pick<EditorState, 'selection' | 'selected'> {
  const selected = s.selected.filter((id) => model.index.has(id));
  const selection = s.selection !== null && model.index.has(s.selection) ? s.selection : (selected[selected.length - 1] ?? null);
  return { selected: selection === null ? [] : [...selected.filter((id) => id !== selection), selection], selection };
}

const withFix = (label: string) => (label.endsWith(' (with fix)') ? label : `${label} (with fix)`);

export function useEditor<T>(store: EditorStore, selector: (s: EditorState) => T): T {
  const snapshot = (): T => selector(store.get());
  // The same snapshot server-side, so an inspector section renders to markup in a unit test.
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

/** A read of a committed version under way (EditorStore.adopt). */
interface Reading {
  hash: string;
  /** Finished, either way. */
  done: boolean;
  /** Resolves when it has finished, never rejects. */
  finished: Promise<void>;
}
