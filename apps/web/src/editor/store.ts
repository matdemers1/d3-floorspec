import { useSyncExternalStore } from 'react';
import type { Diagnostic } from '@floorspec/engine';
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
  type History,
  type ProjectInfo,
} from './api';
import { readModel, sortedLevels, levelOfElement, type EditorModel, type LevelView, type Point } from './model';
import { fixToOps, type Batch, type BatchBuilder, type ChainVertex, type TypeChoice } from './ops';
import type { Snap } from './snap';
import { unitsOf, type UnitSystem } from './units';

/**
 * The editor's state and its one write path. Every edit is a batch handed to `apply`, which posts
 * it with `If-Match` on the head, then re-reads the version the server committed and re-derives
 * it with the engine — the editor never edits the document itself (FLR-ADR-008). A rejection
 * keeps the model exactly as it was and holds the coded diagnostics for the banner (FLR-T-3.8).
 *
 * The store is a plain external store (useSyncExternalStore), so the canvas's tools can read and
 * write it between renders without threading callbacks through every component.
 */

export type ToolId = 'select' | 'wall' | 'separator' | 'door' | 'window' | 'room';

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
  | { tool: 'wall' | 'separator'; chain: ChainVertex[]; cursor: Snap | null; typed: string }
  | {
      tool: 'door' | 'window';
      hover: { wall: string; offset: number; centered: boolean; width: number; side: 'left' | 'right'; nearer: 'start' | 'end'; fits: boolean } | null;
      typed: string;
    }
  | { tool: 'room'; hover: { point: Point; free: boolean } | null }
  | {
      tool: 'select';
      drag:
        | { kind: 'junction'; id: string; to: Point; snap: Snap }
        | { kind: 'wall'; id: string; by: number }
        | { kind: 'opening'; id: string; offset: number; centered: boolean }
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
}

export interface DrawSettings {
  wallType: string | null;
  justification: 'center' | 'exteriorFace' | 'interiorFace';
  chain: boolean;
  doorType: string | null;
  windowType: string | null;
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
  layers: { walls: true, openings: true, rooms: true, dimensions: true, findings: true },
  draw: { wallType: null, justification: 'center', chain: true, doorType: null, windowType: null },
  focus: null,
  treeOpen: false,
  findingsOpen: false,
  prompt: null,
};

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
        level: this.pickLevel(model, this.state.level),
        readOnly: model.valid ? null : 'This version of the model does not validate, so it cannot be edited here. Undo the change that broke it, or fix it in the file.',
      });
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 404) this.set({ status: 'missing', error: 'This project does not exist, or it is not yours.' });
      else this.set({ status: 'error', error: error instanceof Error ? error.message : 'The editor could not load the model.' });
    }
  }

  private pickLevel(model: EditorModel, wanted: string | null): string | null {
    if (wanted !== null && model.levels.some((l) => l.id === wanted)) return wanted;
    return sortedLevels(model.document)[0]?.id ?? null;
  }

  /** Read a committed version and make it the editor's model. */
  private async adopt(hash: string): Promise<void> {
    const text = await fetchVersion(this.projectId, hash);
    const model = readModel(hash, text);
    const history = await fetchHistory(this.projectId).catch(() => this.state.history);
    this.set((s) => ({
      model,
      history,
      level: this.pickLevel(model, s.level),
      selection: s.selection !== null && model.index.has(s.selection) ? s.selection : null,
      hover: null,
      preview: null,
      readOnly: model.valid ? null : s.readOnly,
    }));
  }

  // ─── Writing ─────────────────────────────────────────────────────────────────────────────

  /**
   * Apply a batch to main. Edits are serialised: each waits for the one before it, so each is sent
   * against the head the previous one produced.
   */
  apply(label: string, batch: Batch | BatchBuilder, options: ApplyOptions = {}): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const { model, readOnly } = this.state;
      if (model === null || readOnly !== null) return false;
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
        this.set({ readOnly: 'You can view this project but not change it.', notice: { tone: 'danger', text: answer.message } });
        return false;
      case 'nothing':
        this.set({ notice: { tone: 'info', text: answer.message.charAt(0).toUpperCase() + answer.message.slice(1) } });
        return false;
      case 'failed':
        this.set({ notice: { tone: 'danger', text: answer.message } });
        return false;
    }
  }

  private async reloadHead(): Promise<void> {
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
      const result = applyLocally(model.document, { batch: pending });
      if (result.status === 'committed') this.set({ preview: { model: readModel(result.hash, result.document), diagnostics: [] } });
      else this.set({ preview: { model: null, diagnostics: result.diagnostics } });
    });
  }

  // ─── Selection and tools ─────────────────────────────────────────────────────────────────

  select(id: string | null): void {
    if (id === null) {
      this.set({ selection: null });
      return;
    }
    const model = this.state.model;
    const level = model === null ? undefined : levelOfElement(model, id);
    this.set({ selection: id, ...(level === undefined ? {} : { level }) });
  }

  setTool(tool: ToolId): void {
    this.preview(null);
    this.set({ tool, draft: null, hover: null });
  }

  setLevel(level: string): void {
    this.preview(null);
    this.set({ level, selection: null, hover: null, draft: null });
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
