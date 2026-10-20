import { useEffect, useSyncExternalStore } from 'react';
import { fetchChangesetModel } from '../../api';
import { versionModel } from '../../history';
import { readModel, type EditorModel } from '../../model';
import { diffModels, type ModelDiff } from '../../diff';
import type { UnitSystem } from '../../units';
import type { EditorStore } from '../../store';
import { sourceKey, type CompareSource } from './compare';

/**
 * A comparison's sides as models (FLR-T-14.4): main is the editor's own; another option is main read
 * again in that design (Core 19.6) — at once, no request; a pending changeset is its scratch head,
 * read in main's design, and fetched again when the changeset grows; a version is fetched by hash
 * (immutable, so once per page). Shared by the 3D view, which meshes them, and the Comparing panel,
 * which diffs them — one request and one read each.
 */

export type SourceModel = { readonly status: 'loading' } | { readonly status: 'ready'; readonly model: EditorModel } | { readonly status: 'error'; readonly message: string };

const LOADING: SourceModel = { status: 'loading' };

class CompareModels {
  private readonly cache = new Map<string, SourceModel>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: EditorStore) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private changed(): void {
    for (const l of this.listeners) l();
  }

  /** What makes a source's model this one: main's hash for an option, a changeset's head now. */
  private keyOf(source: CompareSource): string {
    const s = this.store.get();
    if (source.kind === 'option') return `${sourceKey(source)}@${s.model?.hash ?? ''}`;
    if (source.kind === 'changeset') return `${sourceKey(source)}@${s.proposals.find((p) => p.id === source.id)?.head ?? ''}`;
    return sourceKey(source);
  }

  get(source: CompareSource): SourceModel {
    const s = this.store.get();
    if (source.kind === 'main') return s.model === null ? LOADING : this.ready(`main@${s.model.hash}`, s.model);
    const key = this.keyOf(source);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    if (source.kind === 'option' && s.model !== null) {
      const model = s.model;
      let read: SourceModel;
      try {
        read = { status: 'ready', model: readModel(model.hash, model.document, { ...model.design, [source.set]: source.option }) };
      } catch (error) {
        read = { status: 'error', message: error instanceof Error ? error.message : String(error) };
      }
      this.cache.set(key, read);
      return read;
    }
    return LOADING;
  }

  private readonly readies = new Map<string, SourceModel>();
  private ready(key: string, model: EditorModel): SourceModel {
    let r = this.readies.get(key);
    if (r === undefined || (r.status === 'ready' && r.model !== model)) {
      this.readies.clear();
      r = { status: 'ready', model };
      this.readies.set(key, r);
    }
    return r;
  }

  /** Start reading a source that needs a request; nothing for one already read or reading. */
  ensure(source: CompareSource): void {
    if (source.kind === 'main' || source.kind === 'option') return;
    const key = this.keyOf(source);
    if (this.cache.has(key)) return;
    this.cache.set(key, LOADING);
    const projectId = this.store.projectId;
    const read = async (): Promise<EditorModel> => {
      if (source.kind === 'version') return versionModel(projectId, source.hash);
      const head = await fetchChangesetModel(projectId, source.id);
      if (head === null) throw new Error('This changeset is no longer pending: it was accepted or rejected.');
      return readModel(head.hash, head.text, this.store.get().model?.design ?? {});
    };
    read().then(
      (model) => {
        this.cache.set(key, { status: 'ready', model });
        this.changed();
      },
      (error: unknown) => {
        this.cache.set(key, { status: 'error', message: error instanceof Error ? error.message : 'It did not load.' });
        this.changed();
      },
    );
    this.changed();
  }

  /** Forget what was read: the comparison closed, so its models are let go. */
  clear(): void {
    this.cache.clear();
    this.readies.clear();
  }
}

const stores = new WeakMap<EditorStore, CompareModels>();

export function compareModels(store: EditorStore): CompareModels {
  let m = stores.get(store);
  if (m === undefined) {
    m = new CompareModels(store);
    stores.set(store, m);
  }
  return m;
}

const NONE: SourceModel = { status: 'loading' };

/** A side's model as it is read: loading, ready or failed; `null` asks for nothing. */
export function useSourceModel(store: EditorStore, source: CompareSource | null): SourceModel | null {
  const models = compareModels(store);
  const subscribe = (l: () => void) => {
    const a = store.subscribe(l);
    const b = models.subscribe(l);
    return () => {
      a();
      b();
    };
  };
  const snapshot = () => (source === null ? null : models.get(source));
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const key = source === null ? null : sourceKey(source);
  const head = useSyncExternalStore(store.subscribe, () => (source?.kind === 'changeset' ? (store.get().proposals.find((p) => p.id === source.id)?.head ?? null) : null));
  useEffect(() => {
    // The source is its key; a changeset's head moving reads it again.
    if (source !== null) models.ensure(source);
  }, [key, head, models]);
  return value ?? (source === null ? null : NONE);
}

const diffs = new WeakMap<EditorModel, WeakMap<EditorModel, { units: UnitSystem; diff: ModelDiff }>>();

/** What B changes from A (diff.ts), worked out once per pair of models: the panel lists it, the view outlines it. */
export function comparisonDiff(a: EditorModel, b: EditorModel, units: UnitSystem): ModelDiff {
  let byB = diffs.get(a);
  if (byB === undefined) {
    byB = new WeakMap();
    diffs.set(a, byB);
  }
  const hit = byB.get(b);
  if (hit !== undefined && hit.units === units) return hit.diff;
  const diff = diffModels(a, b, units);
  byB.set(b, { units, diff });
  return diff;
}

/** The elements B adds, moves or changes: what is outlined in B's house. */
export function changedInB(diff: ModelDiff): ReadonlySet<string> {
  return new Set([...diff.ids.added, ...diff.ids.moved, ...diff.ids.changed]);
}
