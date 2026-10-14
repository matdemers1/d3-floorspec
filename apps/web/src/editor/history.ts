import { fetchHistoryLog, fetchTokenNames, fetchVersion, postBranch, type HistoryEntry } from './api';
import { readModel, type EditorModel } from './model';
import type { EditorStore } from './store';

/**
 * The history and the version diff (FLR-T-3.6). The history is main's op log, newest first, from
 * `/history`: who wrote each op (you, a token, an agent), what kind it was (apply, undo, redo,
 * merge), when, and what it did. Any two versions can be compared: both are fetched by hash
 * (immutable, so the browser keeps them), derived by the engine, and diffed by element ID.
 *
 * Undo from the history is the server's undo — it appends the inverse of the newest op still in
 * effect as a new op. The log is append-only; nothing here rewrites it.
 */

const cache = new Map<string, Promise<EditorModel>>();

/** A version, read and derived once per page. */
export function versionModel(projectId: string, hash: string): Promise<EditorModel> {
  const key = `${projectId}:${hash}`;
  let hit = cache.get(key);
  if (hit === undefined) {
    hit = fetchVersion(projectId, hash).then((text) => readModel(hash, text));
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}

export async function refreshLog(store: EditorStore): Promise<void> {
  try {
    const [log, names] = await Promise.all([fetchHistoryLog(store.projectId), store.get().tokenNames.size > 0 ? Promise.resolve(store.get().tokenNames) : fetchTokenNames().catch(() => new Map<string, string>())]);
    store.set({ log: log.ops, tokenNames: names, history: { head: log.head, undo: log.undo, redo: log.redo, seq: log.seq } });
  } catch {
    store.set((s) => ({ log: s.log ?? [], notice: { tone: 'danger', text: 'The history did not load.' } }));
  }
}

export function openHistory(store: EditorStore): void {
  store.set({ left: 'history', treeOpen: true });
  void refreshLog(store);
}

export function closeHistory(store: EditorStore): void {
  store.set({ left: 'tree', compare: null });
}

// ─── The scrubber (FLR-T-18.14) ──────────────────────────────────────────────────────────────

/**
 * Scrub to the version after `entry`: the plan drawn as it was then, what was added since green and
 * what was removed since red, against main now. `null` is now: the comparison ends.
 */
export async function scrubTo(store: EditorStore, entry: HistoryEntry | null): Promise<void> {
  const now = store.get().model;
  if (entry === null || now === null || entry.after === now.hash) {
    if (store.get().compare?.scrub === true) endCompare(store);
    return;
  }
  const from = entry.after;
  store.preview(null);
  store.set((s) => ({
    compare: { from, to: now.hash, fromModel: s.compare?.scrub === true && s.compare.from === from ? s.compare.fromModel : null, toModel: now, loading: true, error: null, scrub: true },
    tool: 'select',
    draft: null,
    hover: null,
  }));
  try {
    const a = await versionModel(store.projectId, from);
    const c = store.get().compare;
    if (c?.from !== from || c.scrub !== true) return;
    store.set((s) => ({
      compare: { from, to: now.hash, fromModel: a, toModel: now, loading: false, error: null, scrub: true },
      level: a.levels.some((l) => l.id === s.level) ? s.level : (a.levels[0]?.id ?? s.level),
    }));
  } catch {
    store.set((s) => ({ compare: s.compare === null ? null : { ...s.compare, loading: false, error: 'That version did not load.' } }));
  }
}

/** Restore the version scrubbed to: one new op on main (the server's restore); the scrubber goes back to now. */
export async function restoreTo(store: EditorStore, seq: number): Promise<boolean> {
  endCompare(store);
  const ok = await store.restore(seq);
  if (ok) {
    store.set({ notice: { tone: 'info', text: `Restored v${String(seq)} as a new version — undo takes it back.` } });
    void refreshLog(store);
  }
  return ok;
}

/** Branch from the version scrubbed to: a changeset at that version, to review and accept or reject; main stays. */
export async function branchFrom(store: EditorStore, seq: number): Promise<string | null> {
  const answer = await postBranch(store.projectId, seq);
  if (answer.status === 'failed') {
    store.set({ notice: { tone: 'danger', text: answer.message.charAt(0).toUpperCase() + answer.message.slice(1) } });
    return null;
  }
  store.set({ notice: { tone: 'info', text: `Branched “${answer.name}” — a changeset at v${String(seq)}, in Proposals. Main is unchanged.` } });
  return answer.id;
}

/** "Restored v52": an edit that brought main back to a version it had been at, by the hash it arrived at. */
export function restoredFrom(entry: HistoryEntry, log: readonly HistoryEntry[]): number | null {
  if (entry.kind !== 'apply') return null;
  const earlier = log.find((e) => e.seq < entry.seq && e.after === entry.after);
  return earlier === undefined ? null : earlier.seq;
}

export function toggleHistory(store: EditorStore): void {
  if (store.get().left === 'history') closeHistory(store);
  else openHistory(store);
}

/** Compare two versions on the canvas. */
export async function compare(store: EditorStore, from: string, to: string): Promise<void> {
  store.preview(null);
  store.set({ compare: { from, to, fromModel: null, toModel: null, loading: true, error: null }, tool: 'select', draft: null, hover: null, left: 'history' });
  try {
    const [a, b] = await Promise.all([versionModel(store.projectId, from), versionModel(store.projectId, to)]);
    const c = store.get().compare;
    if (c?.from !== from || c.to !== to) return;
    store.set((s) => ({
      compare: { from, to, fromModel: a, toModel: b, loading: false, error: null },
      level: b.levels.some((l) => l.id === s.level) ? s.level : (b.levels[0]?.id ?? s.level),
    }));
  } catch {
    store.set((s) => ({ compare: s.compare === null ? null : { ...s.compare, loading: false, error: 'One of the versions did not load.' } }));
  }
}

export function endCompare(store: EditorStore): void {
  store.set((s) => ({ compare: null, level: s.model?.levels.some((l) => l.id === s.level) === true ? s.level : (s.model?.levels[0]?.id ?? null) }));
}

/** What one op did: the version before it against the version after it. */
export function compareOp(store: EditorStore, entry: HistoryEntry): void {
  if (entry.before === null) return;
  void compare(store, entry.before, entry.after);
}

/** The versions a comparison can pick from: every version main has been at, newest first. */
export function versionsOf(log: readonly HistoryEntry[]): { hash: string; label: string; seq: number }[] {
  const out: { hash: string; label: string; seq: number }[] = [];
  const seen = new Set<string>();
  for (const e of log) {
    if (!seen.has(e.after)) {
      seen.add(e.after);
      out.push({ hash: e.after, seq: e.seq, label: `v${String(e.seq)}` });
    }
  }
  const oldest = log[log.length - 1];
  if (oldest?.before !== null && oldest?.before !== undefined && !seen.has(oldest.before)) out.push({ hash: oldest.before, seq: oldest.seq - 1, label: 'before' });
  return out;
}

/** Who wrote an op, as the history says it: you, a token by name, or the agent by name. */
export function authorOf(entry: HistoryEntry, tokens: ReadonlyMap<string, string>): { name: string; kind: 'you' | 'token' | 'agent' } {
  if (entry.author.kind === 'agent') return { name: entry.author.name ?? 'Claude', kind: 'agent' };
  if (entry.author.kind === 'token') return { name: (entry.author.token !== null ? tokens.get(entry.author.token) : undefined) ?? 'A token', kind: 'token' };
  return { name: 'You', kind: 'you' };
}
