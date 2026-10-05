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

/**
 * The editor's state and its one write path. Every edit is a batch handed to `apply`, which posts
 * it with `If-Match` on the head, then re-reads the version the server committed and re-derives
 * it with the engine — the editor never edits the document itself (FLR-ADR-008). A rejection
 * keeps the model exactly as it was and holds the coded diagnostics for the banner (FLR-T-3.8).
 *
 * The store is a plain external store (useSyncExternalStore), so the canvas's tools can read and
 * write it between renders without threading callbacks through every component.
 */

export type ToolId = 'select' | 'wall' | 'separator' | 'slab' | 'door' | 'window' | 'room' | 'device';

/** The tools that draw a chain of points: walls and separators (a polyline), and a slab's outline (Core 0.3, 6.7). */
export type ChainTool = 'wall' | 'separator' | 'slab';
export const isChainTool = (t: unknown): t is ChainTool => t === 'wall' || t === 'separator' || t === 'slab';

export type ChainDraft = { tool: ChainTool; chain: ChainVertex[]; cursor: Snap | null; typed: string };
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
}

export type Draft =
  | ChainDraft
  | {
      tool: 'door' | 'window';
      hover: { wall: string; offset: number; centered: boolean; width: number; side: 'left' | 'right'; nearer: 'start' | 'end'; fits: boolean } | null;
      typed: string;
    }
  | { tool: 'room'; hover: { point: Point; free: boolean } | null }
  | { tool: 'device'; hover: DeviceHover | null; typed: string }
  | {
      tool: 'select';
      drag:
        | { kind: 'junction'; id: string; to: Point; snap: Snap }
        | { kind: 'wall'; id: string; by: number }
        | { kind: 'opening'; id: string; offset: number; centered: boolean }
        | { kind: 'device'; id: string; hover: DeviceHover }
        | null;
      typed: string;
    };

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
}

export interface DrawSettings {
  wallType: string | null;
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
}

/** Two versions compared on the canvas (FLR-T-3.6). */
export interface Compare {
  from: string;
  to: string;
  fromModel: EditorModel | null;
  toModel: EditorModel | null;
  loading: boolean;
  error: string | null;
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
  selection: string | null;
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
  prompt: Prompt | null;
  /** The live event stream (FLR-T-3.5). */
  live: 'connecting' | 'live' | 'reconnecting';
  /** Pending changesets: what agents have proposed. */
  proposals: ChangesetRow[];
  review: Review | null;
  /** The right column: the inspector, or the review of a proposal. */
  side: 'inspector' | 'review';
  /** The left column: the project tree, or the history (FLR-T-3.6). */
  left: 'tree' | 'history';
  log: HistoryEntry[] | null;
  tokenNames: ReadonlyMap<string, string>;
  compare: Compare | null;
  /** The arrow keys' step, base units; null for the units' default (1" or 10 mm). */
  nudge: number | null;
  palette: boolean;
  /** The element being renamed in the tree (F2). */
  renaming: string | null;
  /** Picking on the plan what a switch controls (FLR-T-5.7): clicks toggle devices in its `controls`. */
  /**
   * Picking on the plan: a switch's lights (FLR-T-5.7), or a vaulted ceiling's ridge (Core 0.3, 15.3)
   * — two points, the first kept until the second is clicked.
   */
  picking: { switch: string } | { ridge: string; first: Point | null } | null;
}

const initial: EditorState = {
  status: 'loading',
  error: null,
  project: null,
  model: null,
  history: { head: null, undo: null, redo: null, seq: null },
  level: null,
  selection: null,
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
  layers: { walls: true, openings: true, rooms: true, dimensions: true, findings: true, electrical: true, plumbing: true, mechanical: true, lowvoltage: true, clearances: false, coreOnly: false },
  draw: { wallType: null, justification: 'center', chain: true, doorType: null, windowType: null, device: 'receptacle', receptacle: NO_OPTIONS, height: null, slab: { thickness: 130_048, offset: 0, purpose: null } },
  focus: null,
  treeOpen: false,
  findingsOpen: false,
  prompt: null,
  live: 'connecting',
  proposals: [],
  review: null,
  side: 'inspector',
  left: 'tree',
  log: null,
  tokenNames: new Map(),
  compare: null,
  nudge: readNudge(),
  palette: false,
  renaming: null,
  picking: null,
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
  /** A field to focus after the selection changes. */
  focus?: string;
}

export class EditorStore {
  private state: EditorState = initial;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private previewFrame = 0;
  private previewBatch: Batch | null = null;

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
    this.state = { ...this.state, ...next };
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
      const model = readModel(head.hash, head.text);
      const history = await fetchHistory(this.projectId).catch(() => this.state.history);
      this.set({
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
  /** Called after the model moves, by whoever needs to follow it (the review, the history). */
  onModel: (() => void) | null = null;

  /** Read a committed version and make it the editor's model. The newest request wins. */
  private async adopt(hash: string): Promise<void> {
    const ticket = ++this.adopting;
    const text = await fetchVersion(this.projectId, hash);
    const model = readModel(hash, text);
    const history = await fetchHistory(this.projectId).catch(() => this.state.history);
    if (ticket !== this.adopting) return;
    this.set((s) => ({
      model,
      history,
      level: this.pickLevel(model, s.level),
      selection: s.selection !== null && model.index.has(s.selection) ? s.selection : null,
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
          const sent = typeof batch === 'function' ? batch(attempt) : batch;
          if (sent.length === 0) return false;
          const answer = await postBatch(this.projectId, this.state.model?.hash ?? model.hash, sent);
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
        this.set({
          rejection: null,
          ...(selected === undefined ? {} : { selection: selected }),
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

  /** Show what a batch would make, applied locally, at most once a frame. */
  preview(batch: Batch | null): void {
    this.previewBatch = batch;
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
      const result = applyLocally(model.document, { batch: pending }, OFFICIAL_READER);
      if (result.status === 'committed') this.set({ preview: { model: readModel(result.hash, result.document), diagnostics: [] } });
      else this.set({ preview: { model: null, diagnostics: result.diagnostics } });
    });
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
    this.set({ selection: id, ...(level === undefined ? {} : { level }), ...(options.keepSide === true ? {} : { side: 'inspector' as const }) });
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
    return compare === null ? model : compare.toModel;
  }

  /** The type the draw panel has chosen, as a choice (a document type or a starter). */
  chosenType(choices: TypeChoice[], id: string | null): TypeChoice | undefined {
    return choices.find((c) => c.id === id) ?? choices[0];
  }
}

const withFix = (label: string) => (label.endsWith(' (with fix)') ? label : `${label} (with fix)`);

export function useEditor<T>(store: EditorStore, selector: (s: EditorState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
