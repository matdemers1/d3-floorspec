import { orphaned, removedWith } from '../annotate/ops';
import type { EditorState, EditorStore } from '../store';
import { kindOf, labelOf, readModel, sortedLevels, type EditorModel, type Kind, type LevelView, type Point } from '../model';
import { roomsBeside } from '../geometry';
import { fetchHead, postBatch } from '../api';
import { removeOps, type Batch } from '../ops';
import { referenceCleanup } from '../systems/ops';
import { formatLen } from '../units';
import { assetUrl } from '../../lib/assets';
import { uploadAsset } from '../../furniture/api';
import { alignBatch, distributeBatch, middleOf, mirror, quarterTurn, transformBatch, translation, type Alignment, type Transformed } from './transform';
import { copyClip, pasteBatch, readClip, type Clip } from './clipboard';
import { boundsOfIds, selectableShapes } from './shapes';

/**
 * The multi-selection's actions (FLR-T-18.8), as the toolbar, the inspector, the keyboard and the
 * command palette all run them: each builds its batch when the edit runs — against the model as it
 * is then — and hands it to the store as one edit, so each is one undo step.
 */

const FOOT = 390_144;

export const editable = (s: EditorState): boolean => s.readOnly === null && s.model !== null && s.compare === null && s.level !== null;

/** The selection on the level shown: what the plan's actions act on. */
export function selectedHere(store: EditorStore): string[] {
  const s = store.get();
  const level = store.levelView;
  if (level === undefined) return [];
  return s.selected.filter((id) => boundsOfIds(level, [id]) !== null);
}

// ─── Words ──────────────────────────────────────────────────────────────────────────────────

const plural = (noun: string): string => (/(s|x|ch|sh)$/.test(noun) ? `${noun}es` : /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`);

/** What one element is called in a count: "dining chair", "wall", "recessed downlight". */
export function nounOf(model: EditorModel, id: string): string {
  const kind = kindOf(model, id);
  if (kind === 'extensionElement') {
    const d = model.levels.flatMap((l) => l.devices).find((x) => x.id === id);
    const name = typeof d?.element['name'] === 'string' ? d.element['name'] : d?.kindLabel;
    return (name ?? 'item').toLowerCase();
  }
  if (kind === 'opening') return labelOf(model, id).startsWith('Door') || /door/i.test((model.document.openings?.[id] as { fill?: string } | undefined)?.fill ?? '') ? 'door' : 'window';
  return kind ?? 'element';
}

/** "3 dining chairs", "2 walls", "5 elements". */
export function describeMany(model: EditorModel, ids: readonly string[]): string {
  if (ids.length === 1) return labelOf(model, ids[0] as string);
  const nouns = new Set(ids.map((id) => nounOf(model, id)));
  const noun = nouns.size === 1 ? ([...nouns][0] as string) : 'element';
  return `${String(ids.length)} ${plural(noun)}`;
}

/** The toolbar's short count: the last word of the noun, "3 chairs". */
export function shortCount(model: EditorModel, ids: readonly string[]): string {
  const nouns = new Set(ids.map((id) => nounOf(model, id).split(' ').pop() ?? 'element'));
  const noun = nouns.size === 1 ? ([...nouns][0] as string) : 'element';
  return ids.length === 1 ? `1 ${noun}` : `${String(ids.length)} ${plural(noun)}`;
}

// ─── Moving, turning, mirroring, aligning ───────────────────────────────────────────────────

function run(store: EditorStore, label: string, build: (model: EditorModel, level: LevelView, ids: string[]) => Transformed, ids = selectedHere(store)): void {
  const s = store.get();
  if (!editable(s) || ids.length === 0) return;
  const primary = s.selection;
  const keep = [...ids];
  let skipped: Transformed['skipped'] = [];
  void store
    .apply(label, () => {
      const model = store.get().model;
      const level = store.levelView;
      if (model === null || level === undefined) return [];
      const t = build(model, level, keep);
      skipped = t.skipped;
      return t.batch;
    }, { selectMany: () => keep, ...(primary === null ? {} : { select: () => primary }) })
    .then((ok) => {
      const model = store.get().model;
      if (ok && skipped.length > 0 && model !== null) store.set({ notice: { tone: 'info', text: `${describeMany(model, skipped.map((x) => x.id))} stayed where ${skipped.length === 1 ? 'it was' : 'they were'}: ${skipped[0]?.why ?? ''}.` } });
    });
}

export function moveSelection(store: EditorStore, d: Point, how = 'Move'): void {
  const model = store.get().model;
  const ids = selectedHere(store);
  if (model === null || ids.length === 0) return;
  const r: Point = [Math.round(d[0]), Math.round(d[1])];
  if (r[0] === 0 && r[1] === 0) return;
  const dist = Math.hypot(r[0], r[1]);
  run(store, `${how} ${describeMany(model, ids)} ${formatLen(Math.round(dist), store.units)}`, (m, level, keep) => transformBatch(m, level, keep, translation(r)), ids);
}

const ARROWS: Record<string, Point> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

/** The arrows with several selected: all of them, one step that way (FLR-T-3.7's step), as one batch. */
export function nudgeSelection(store: EditorStore, arrow: string, big: boolean): boolean {
  const d = ARROWS[arrow];
  if (d === undefined || !editable(store.get()) || selectedHere(store).length < 2) return false;
  const step = store.nudgeStep * (big ? (store.units === 'metric' ? 10 : 12) : 1);
  moveSelection(store, [d[0] * step, d[1] * step], 'Nudge');
  return true;
}

/** Turn the selection a quarter about its middle: `1` left (counter-clockwise), `-1` right. */
export function turnSelection(store: EditorStore, quarters: 1 | -1): void {
  const model = store.get().model;
  const level = store.levelView;
  const ids = selectedHere(store);
  const c = level === undefined ? null : middleOf(level, ids);
  if (model === null || c === null) return;
  run(store, `Turn ${describeMany(model, ids)} ${quarters === 1 ? 'left' : 'right'} 90°`, (m, lv, keep) => transformBatch(m, lv, keep, quarterTurn(c, quarters)), ids);
}

/** Mirror the selection about its middle: `h` left ↔ right, `v` up ↔ down. */
export function mirrorSelection(store: EditorStore, flip: 'h' | 'v'): void {
  const model = store.get().model;
  const level = store.levelView;
  const ids = selectedHere(store);
  const c = level === undefined ? null : middleOf(level, ids);
  if (model === null || c === null) return;
  run(store, `Mirror ${describeMany(model, ids)} ${flip === 'h' ? 'left to right' : 'top to bottom'}`, (m, lv, keep) => transformBatch(m, lv, keep, mirror(c, flip)), ids);
}

const ALIGN_WORDS: Record<Alignment, string> = { left: 'left edges', centre: 'centres', right: 'right edges', top: 'tops', middle: 'middles', bottom: 'bottoms' };

export function alignSelection(store: EditorStore, how: Alignment): void {
  const model = store.get().model;
  const ids = selectedHere(store);
  if (model === null || ids.length < 2) return;
  run(store, `Align the ${ALIGN_WORDS[how]} of ${describeMany(model, ids)}`, (m, lv, keep) => alignBatch(m, lv, keep, how), ids);
}

export function distributeSelection(store: EditorStore, axis: 'x' | 'y'): void {
  const model = store.get().model;
  const ids = selectedHere(store);
  if (model === null || ids.length < 3) return;
  run(store, `Distribute ${describeMany(model, ids)} ${axis === 'x' ? 'across' : 'up and down'}`, (m, lv, keep) => distributeBatch(m, lv, keep, axis), ids);
}

/** Set the centre-to-centre spacing of a row of elements along its longer axis, the first staying put. */
export function respaceSelection(store: EditorStore, spacing: number): void {
  const model = store.get().model;
  const ids = selectedHere(store);
  if (model === null || ids.length < 2) return;
  run(store, `Space ${describeMany(model, ids)} ${formatLen(spacing, store.units)} apart`, (m, lv, keep) => {
    const row = rowOf(lv, keep);
    if (row === null) return { batch: [], moved: [], skipped: [] };
    const out: Transformed = { batch: [], moved: [], skipped: [] };
    row.items.forEach((x, i) => {
      const want = (row.items[0]?.at ?? 0) + i * spacing * row.sign;
      const d = want - x.at;
      const t = transformBatch(m, lv, [x.id], translation(row.axis === 'x' ? [Math.round(d), 0] : [0, Math.round(d)]));
      out.batch.push(...t.batch);
      out.moved.push(...t.moved);
    });
    return out;
  }, ids);
}

/** A selection read as a row: its axis (the longer spread), its items in order along it, and their centres. */
export function rowOf(level: LevelView, ids: readonly string[]): { axis: 'x' | 'y'; sign: 1 | -1; items: { id: string; at: number }[]; spacing: number | null } | null {
  const centres = ids
    .map((id) => ({ id, b: boundsOfIds(level, [id]) }))
    .filter((x): x is { id: string; b: NonNullable<ReturnType<typeof boundsOfIds>> } => x.b !== null)
    .map((x) => ({ id: x.id, c: [(x.b.minX + x.b.maxX) / 2, (x.b.minY + x.b.maxY) / 2] as Point }));
  if (centres.length < 2) return null;
  const xs = centres.map((c) => c.c[0]);
  const ys = centres.map((c) => c.c[1]);
  const axis = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys) ? 'x' : 'y';
  // Rows read west to east, and north to south (as a plan is read).
  const sign: 1 | -1 = axis === 'x' ? 1 : -1;
  const items = centres.map((c) => ({ id: c.id, at: axis === 'x' ? c.c[0] : c.c[1] })).sort((a, b) => (a.at - b.at) * sign);
  const gaps = items.slice(1).map((x, i) => Math.abs(x.at - (items[i]?.at ?? 0)));
  const first = gaps[0] ?? 0;
  const spacing = gaps.every((g) => Math.abs(g - first) <= 2) ? Math.round(first) : null;
  return { axis, sign, items, spacing };
}

// ─── Removing ───────────────────────────────────────────────────────────────────────────────

/** Remove everything selected as one batch: references to removed devices cleared, a wall's surviving room kept. */
export function deleteSelection(store: EditorStore): void {
  const s = store.get();
  const model = s.model;
  const ids = s.selected;
  if (model === null || !editable(s) || ids.length === 0) return;
  void store.apply(`Remove ${describeMany(model, ids)}`, () => {
    const m = store.get().model;
    return m === null ? [] : removeBatch(m, ids);
  }, { select: () => null });
}

export function removeBatch(model: EditorModel, ids: readonly string[]): Batch {
  const gone = new Set(ids);
  const kindOfId = new Map(ids.map((id) => [id, kindOf(model, id)] as [string, Kind | null]));
  const of = (k: Kind) => ids.filter((id) => kindOfId.get(id) === k);
  const ops: Batch = [];
  // Devices, with every reference to them (a circuit's loads, a switch's controls) in the same batch.
  const devices = of('extensionElement');
  if (devices.length > 0) {
    const cleanup = referenceCleanup(model.document, new Set(devices));
    ops.push(...cleanup.ops);
    for (const cid of cleanup.alsoRecords) ops.push({ op: 'unsetProperty', id: '$document', path: `/extensions/FS_electrical/circuits/${cid}` });
    for (const id of [...cleanup.alsoRemove.filter((x) => !gone.has(x)), ...devices]) ops.push({ op: 'removeElement', id });
  }
  const walls = new Set(of('wall'));
  // Openings on a wall that goes are taken by its removeWall.
  for (const id of of('opening')) {
    const wall = (model.document.openings?.[id] as { wall?: string } | undefined)?.wall;
    if (wall === undefined || !walls.has(wall)) ops.push(...removeOps(id, 'opening'));
  }
  for (const id of of('room')) ops.push(...removeOps(id, 'room'));
  for (const id of walls) {
    const level = model.levels.find((l) => l.walls.some((w) => w.id === id));
    const sides = level === undefined ? { left: null, right: null } : roomsBeside(level, id);
    const survivors = [sides.left, sides.right].filter((r): r is string => r !== null && !gone.has(r));
    const keep = sides.left !== null && sides.right !== null && sides.left !== sides.right ? survivors[0] : undefined;
    ops.push(...removeOps(id, 'wall', keep));
  }
  for (const id of of('separator')) ops.push(...removeOps(id, 'separator'));
  for (const kind of ['slab', 'roof', 'stair'] as const) for (const id of of(kind)) ops.push(...removeOps(id, 'other'));
  // A junction last: a wall removed above may already have taken it.
  for (const id of of('junction')) if (!model.levels.some((l) => l.walls.some((w) => walls.has(w.id) && (w.start === id || w.end === id)))) ops.push(...removeOps(id, 'junction'));
  // FLR-T-18.11: the person's strings that measured to what goes, with it.
  ops.push(...orphaned(model, removedWith(model, gone)));
  return ops;
}

// ─── Selecting ──────────────────────────────────────────────────────────────────────────────

export type Similar = 'item' | 'kind' | 'level';

/** What makes two elements "the same item": a catalogue item, a door or window type, a wall type, or else the kind of thing. */
export function similarKey(model: EditorModel, id: string, how: Similar): string | null {
  const kind = kindOf(model, id);
  if (kind === null) return null;
  if (how === 'level') return 'any';
  const ext = model.ext.get(id);
  const kindKey = ext === undefined ? kind : `${ext.extension}/${ext.collection}`;
  if (how === 'kind') return kindKey;
  const element = model.levels.flatMap((l) => l.devices).find((d) => d.id === id)?.element;
  if (ext !== undefined) {
    const catalogue = element?.['catalogue'];
    if (typeof catalogue === 'string') return `${kindKey}#${catalogue}`;
    const fixture = element?.['fixture'] ?? element?.['kind'] ?? element?.['appliance'];
    return typeof fixture === 'string' ? `${kindKey}#${fixture}` : kindKey;
  }
  if (kind === 'opening') return `opening#${(model.document.openings?.[id] as { fill?: string } | undefined)?.fill ?? ''}`;
  if (kind === 'wall') return `wall#${(model.document.walls?.[id] as { type?: string } | undefined)?.type ?? ''}`;
  if (kind === 'room') return `room#${(model.document.rooms?.[id] as { function?: string } | undefined)?.function ?? ''}`;
  return kindKey;
}

/**
 * Select everything on the level like the selection (Figma's "select matching", Revit's "select all
 * instances"): the same catalogue item or type (`item`), the same kind (`kind`), or everything (`level`).
 */
export function selectSimilar(store: EditorStore, how: Similar, picking?: LevelView): number {
  const s = store.get();
  const model = s.model;
  const level = store.levelView;
  if (model === null || level === undefined) return 0;
  const keys = new Set(s.selected.map((id) => similarKey(model, id, how)).filter((k): k is string => k !== null));
  if (keys.size === 0 && how !== 'level') return 0;
  // A mode's ghosted layers are not selected (FLR-T-18.3): `picking` is the level as the plan picks from it.
  const ids = selectableShapes(picking ?? level, s.layers)
    .map((x) => x.id)
    .filter((id) => how === 'level' || keys.has(similarKey(model, id, how) ?? ''));
  store.selectMany(ids, s.selection !== null && ids.includes(s.selection) ? { primary: s.selection } : {});
  return ids.length;
}

/** Fit the view to the selection: FLR-T-18.6's ⇧2, animated, framing every element selected. */
export { zoomToSelection } from '../panzoom';

// ─── Copy, paste, duplicate ─────────────────────────────────────────────────────────────────

/** The last copy made in this tab: what the toolbar's and the palette's Paste use (⌘V reads the system clipboard). */
const clips = new WeakMap<EditorStore, Clip>();

export function copySelection(store: EditorStore): Clip | null {
  const s = store.get();
  const level = store.levelView;
  if (s.model === null || level === undefined) return null;
  const clip = copyClip(s.model, level, selectedHere(store), store.projectId);
  if (clip !== null) {
    clips.set(store, clip);
    store.set({ notice: { tone: 'info', text: `Copied ${describeMany(s.model, clip.items.filter((i) => i.rider !== true).map((i) => i.id))}. Paste with ⌘V here, on another level or in another project.` } });
  }
  return clip;
}

export const lastClip = (store: EditorStore): Clip | null => clips.get(store) ?? null;

/** The offset a paste or a duplicate lands at: in place on another level or project; beside the original here. */
function besideOffset(store: EditorStore, clip: Clip): Point {
  const level = store.levelView;
  if (clip.project !== store.projectId || level === undefined || clip.level !== level.id) return [0, 0];
  const structural = clip.items.some((i) => i.kind === 'wall' || i.kind === 'separator' || i.kind === 'room' || i.kind === 'slab' || i.kind === 'roof' || i.kind === 'stair');
  if (!structural) return [FOOT, -FOOT];
  // Walls cannot overlap their originals: beside them, a foot clear.
  const xs = clip.items.flatMap((i) => (i.line ?? []).map((p) => p[0]));
  const width = xs.length === 0 ? 4 * FOOT : Math.max(...xs) - Math.min(...xs);
  return [Math.ceil((width + 2 * FOOT) / FOOT) * FOOT, 0];
}

/** Paste a clip on the level shown (or `level`), at `offsets` (default: beside its original here, in place elsewhere). */
export function pasteClip(store: EditorStore, clip: Clip, o: { level?: string; offsets?: Point[]; label?: string } = {}): Promise<boolean> {
  const s = store.get();
  if (!editable(s) || s.model === null) return Promise.resolve(false);
  const levelId = o.level ?? s.level;
  const offsets = o.offsets ?? [besideOffset(store, clip)];
  const sameProject = clip.project === store.projectId;
  const count = clip.items.filter((i) => i.rider !== true).length;
  let skipped: string[] = [];
  const label = o.label ?? `Paste ${String(count)} ${count === 1 ? 'element' : 'elements'}`;
  let named: string[] = [];
  return store
    .apply(label, (attempt) => {
      const model = store.get().model;
      const level = model?.levels.find((l) => l.id === levelId);
      if (model === null || level === undefined) return [];
      const p = pasteBatch(model, level, clip, { offsets, attempt, sameProject });
      skipped = p.skipped;
      named = p.ids;
      return p.batch;
    }, { selectMany: () => named })
    .then((ok) => {
      if (ok && levelId !== null && store.get().level !== levelId) store.set({ level: levelId });
      if (skipped.length > 0) store.set({ notice: { tone: 'info', text: `${String(skipped.length)} of what was copied had nowhere to go on this level — a device on a wall, or a ceiling light, with no wall or room under it.` } });
      return ok;
    });
}

export function duplicateSelection(store: EditorStore): void {
  const s = store.get();
  const level = store.levelView;
  if (s.model === null || level === undefined || !editable(s)) return;
  const clip = copyClip(s.model, level, selectedHere(store), store.projectId);
  if (clip === null) return;
  void pasteClip(store, clip, { label: `Duplicate ${describeMany(s.model, selectedHere(store))}` });
}

/** Copy the selection to another level of this project, in place (the inspector's "Copy to Upper floor"). */
export function copyToLevel(store: EditorStore, level: string): void {
  const s = store.get();
  const here = store.levelView;
  if (s.model === null || here === undefined || !editable(s)) return;
  const clip = copyClip(s.model, here, selectedHere(store), store.projectId);
  if (clip === null) return;
  void pasteClip(store, clip, { level, offsets: [[0, 0]], label: `Copy ${describeMany(s.model, clip.items.filter((i) => i.rider !== true).map((i) => i.id))} to ${labelOf(s.model, level)}` });
}

/** The level a paste into another project lands on: the same name, else the same elevation, else the lowest. */
export function levelFor(model: EditorModel, clip: Clip): string | null {
  const levels = sortedLevels(model.document);
  const byName = levels.find((l) => typeof l.level['name'] === 'string' && l.level['name'].toLowerCase() === clip.levelName.toLowerCase());
  return byName?.id ?? levels[0]?.id ?? null;
}

/**
 * Copy the selection into another project: its head read, the paste built against it, posted there
 * as one batch — and the files of any asset the copy names that the project lacks uploaded to it
 * first, so a pasted chair still has its model.
 */
export async function copyToProject(store: EditorStore, target: { id: string; name: string }): Promise<boolean> {
  const s = store.get();
  const here = store.levelView;
  if (s.model === null || here === undefined) return false;
  const clip = copyClip(s.model, here, selectedHere(store), store.projectId);
  if (clip === null) return false;
  store.set({ pending: `Copy to ${target.name}` });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const head = await fetchHead(target.id);
      if (head === null) throw new Error(`${target.name} has no model yet.`);
      const model = readModel(head.hash, head.text);
      const levelId = levelFor(model, clip);
      const level = model.levels.find((l) => l.id === levelId);
      if (level === undefined) throw new Error(`${target.name} has no level to paste onto.`);
      if (attempt === 0) await carryAssets(clip, store.projectId, target.id, model);
      const p = pasteBatch(model, level, clip, { offsets: [[0, 0]], attempt, sameProject: false });
      if (p.batch.length === 0) throw new Error(`Nothing of what was copied has a place in ${target.name}.`);
      const answer = await postBatch(target.id, head.hash, p.batch);
      if (answer.status === 'committed') {
        store.set({ notice: { tone: 'info', text: `Copied ${String(p.ids.length)} ${p.ids.length === 1 ? 'element' : 'elements'} to ${target.name}${p.skipped.length > 0 ? ` (${String(p.skipped.length)} had nowhere to go)` : ''}.` } });
        return true;
      }
      if (answer.status === 'rejected' && answer.diagnostics.some((d) => d.code === 'FS-OPS-005')) continue;
      if (answer.status === 'stale') continue;
      const why = answer.status === 'rejected' ? answer.diagnostics.map((d) => d.message).slice(0, 2).join(' ') : answer.message;
      throw new Error(`${target.name} did not take the copy: ${why}`);
    }
    throw new Error(`${target.name} kept changing; try again.`);
  } catch (e) {
    store.set({ notice: { tone: 'danger', text: e instanceof Error ? e.message : String(e) } });
    return false;
  } finally {
    store.set({ pending: null });
  }
}

/** Upload to `to` the files of the assets a clip adds there, read from `from` (best effort: a model that fails shows as its box). */
async function carryAssets(clip: Clip, from: string, to: string, target: EditorModel): Promise<void> {
  for (const dep of clip.dependencies) {
    if (dep.collection !== 'assets' || target.index.has(dep.id)) continue;
    const sha = dep.element['sha256'];
    const media = typeof dep.element['mediaType'] === 'string' ? dep.element['mediaType'] : '';
    if (typeof sha !== 'string') continue;
    try {
      const res = await fetch(assetUrl(from, sha), { credentials: 'same-origin' });
      if (!res.ok) continue;
      await uploadAsset(to, await res.blob(), typeof dep.element['name'] === 'string' ? dep.element['name'] : sha, media.startsWith('model/') ? 'model' : 'symbol');
    } catch {
      // The element still pastes; its model or symbol falls back to its box.
    }
  }
}

/** A paste from the system clipboard's text: a Floorspec copy, from this project or another. */
export function pasteText(store: EditorStore, text: string): boolean {
  const clip = readClip(text);
  if (clip === null) return false;
  void (async () => {
    if (clip.project !== store.projectId) {
      const model = store.get().model;
      if (model !== null) await carryAssets(clip, clip.project, store.projectId, model);
    }
    await pasteClip(store, clip);
  })();
  return true;
}

export { type Alignment };
