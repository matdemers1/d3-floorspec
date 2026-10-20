import type { ChangesetRow, HistoryEntry } from '../../api';
import type { EditorModel } from '../../model';

/**
 * Compare in 3D (FLR-T-14.4, the board's "14.4 · Compare in 3D" frames): the same view of two designs
 * — A and B — from one camera, either with a swipe divider across the view or side by side. Each side
 * is a source: main as the editor shows it, a pending changeset, another option of one of the
 * document's option sets (Core chapter 19), or an earlier version. This module is the pure part:
 * the state, where each side is drawn on the canvas, the divider's keys, and the choices a side can
 * take — nothing here touches three.js or the network.
 */

/** What a side of the comparison shows. */
export type CompareSource =
  | { readonly kind: 'main' }
  | { readonly kind: 'changeset'; readonly id: string }
  | { readonly kind: 'option'; readonly set: string; readonly option: string }
  | { readonly kind: 'version'; readonly hash: string; readonly seq: number };

export type CompareMode = 'swipe' | 'side';

/** How a side of the comparison stands: nothing chosen, read and built, on its way, or why not. */
export type SideStatus = { readonly status: 'none' } | { readonly status: 'ready' } | { readonly status: 'loading'; readonly doing: 'Reading' | 'Building' } | { readonly status: 'error'; readonly message: string };
export type Side = 'a' | 'b';

export interface CompareState {
  /** The Compare bar is up. */
  readonly open: boolean;
  readonly mode: CompareMode;
  readonly a: CompareSource;
  /** Null until a B is chosen: the view draws A alone. */
  readonly b: CompareSource | null;
  /** The swipe divider, as a fraction of the view's width from its left edge. */
  readonly divider: number;
  /** Flip: B on the left (of the divider, or the left half), A on the right. */
  readonly flipped: boolean;
  /** Side by side: one camera drives both halves (the default), or each half its own. */
  readonly linked: boolean;
  /** An element of the comparison's changes the panel points at: lit in both sides. */
  readonly focus: string | null;
}

export const MAIN: CompareSource = { kind: 'main' };

/** The name of the section's own group in the scene (SectionScene): its caps and ghost are main's, drawn on main's side only. */
export const SECTION_ROOT = 'fs-section-root';

export const DEFAULT_COMPARE: CompareState = { open: false, mode: 'swipe', a: MAIN, b: null, divider: 0.5, flipped: false, linked: true, focus: null };

/** A source as one string: the same source, the same key. */
export function sourceKey(s: CompareSource): string {
  switch (s.kind) {
    case 'main':
      return 'main';
    case 'changeset':
      return `changeset:${s.id}`;
    case 'option':
      return `option:${s.set}:${s.option}`;
    case 'version':
      return `version:${s.hash}`;
  }
}

export const sameSource = (x: CompareSource | null, y: CompareSource | null): boolean => (x === null || y === null ? x === y : sourceKey(x) === sourceKey(y));

// ─── Where each side is drawn ────────────────────────────────────────────────────────────────

/** A rectangle of the canvas, CSS pixels, from its bottom-left corner — WebGL's viewport and scissor. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One drawing of the scene: a side, the viewport its camera projects into and the scissor that keeps it there. */
export interface Pass {
  readonly side: Side;
  readonly viewport: Rect;
  readonly scissor: Rect;
}

/** The side on the left: A, unless flipped. */
export const leftSide = (flipped: boolean): Side => (flipped ? 'b' : 'a');
const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

/** Where the divider stands, CSS pixels from the view's left edge. */
export const dividerX = (divider: number, width: number): number => Math.round(clamp01(divider) * width);

/**
 * The passes a frame is drawn in. Swipe: one camera over the whole view, A's picture left of the
 * divider and B's right of it (flipped, the other way round) — two scissored draws. Side by side: each
 * side in its own half, through a camera of that half's shape. A side with no width is not drawn.
 */
export function passes(state: Pick<CompareState, 'mode' | 'divider' | 'flipped'>, width: number, height: number): Pass[] {
  const w = Math.max(0, Math.round(width));
  const h = Math.max(0, Math.round(height));
  const left = leftSide(state.flipped);
  const right = other(left);
  if (state.mode === 'side') {
    const half = Math.floor(w / 2);
    const l: Rect = { x: 0, y: 0, width: half, height: h };
    const r: Rect = { x: half, y: 0, width: w - half, height: h };
    return [
      { side: left, viewport: l, scissor: l },
      { side: right, viewport: r, scissor: r },
    ].filter((p) => p.scissor.width > 0 && h > 0);
  }
  const x = dividerX(state.divider, w);
  const whole: Rect = { x: 0, y: 0, width: w, height: h };
  return [
    { side: left, viewport: whole, scissor: { x: 0, y: 0, width: x, height: h } },
    { side: right, viewport: whole, scissor: { x, y: 0, width: w - x, height: h } },
  ].filter((p) => p.scissor.width > 0 && h > 0);
}

/** The shape (width over height) each side is drawn at: the whole view's, or half of it side by side. */
export function sideAspect(mode: CompareMode, width: number, height: number): number {
  const h = Math.max(1, height);
  return mode === 'side' ? Math.max(1, Math.floor(width / 2)) / h : Math.max(1, width) / h;
}

/** Which side a point of the view (CSS pixels from its left edge) is on. */
export function sideAt(state: Pick<CompareState, 'mode' | 'divider' | 'flipped'>, x: number, width: number): Side {
  const edge = state.mode === 'side' ? Math.floor(width / 2) : dividerX(state.divider, width);
  return x < edge ? leftSide(state.flipped) : other(leftSide(state.flipped));
}

// ─── The divider ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

/** The divider under a pointer, CSS pixels from the view's left edge. */
export const dividerAt = (x: number, width: number): number => clamp01(width <= 0 ? 0.5 : x / width);

/** A step of the divider's keys: 2 % of the view, ten times that with Shift or Page Up and Down. */
export const DIVIDER_STEP = 0.02;

/**
 * The divider moved by a key, as a slider is (WAI-ARIA): the arrows by a step — Shift, ten — Page Up
 * and Page Down by ten, Home and End to either edge. Null for a key that does not move it.
 */
export function dividerByKey(value: number, key: string, shift = false): number | null {
  const step = shift ? DIVIDER_STEP * 10 : DIVIDER_STEP;
  const round = (v: number) => Math.round(clamp01(v) * 1000) / 1000;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return round(value - step);
    case 'ArrowRight':
    case 'ArrowUp':
      return round(value + step);
    case 'PageDown':
      return round(value - DIVIDER_STEP * 10);
    case 'PageUp':
      return round(value + DIVIDER_STEP * 10);
    case 'Home':
      return 0;
    case 'End':
      return 1;
    default:
      return null;
  }
}

// ─── What a side can show ────────────────────────────────────────────────────────────────────

export type ChoiceGroup = 'main' | 'changesets' | 'options' | 'versions';

/** A source as the B picker lists it: its group, its name and a line about it. */
export interface SourceChoice {
  readonly source: CompareSource;
  readonly key: string;
  readonly group: ChoiceGroup;
  /** "#2 · Bigger island", "Kitchen · Option B", "v41". */
  readonly label: string;
  /** "Claude · 3 ops · 12 min ago". */
  readonly detail: string;
  /** What the chip over the view says: "Changeset · Bigger island". */
  readonly chip: string;
}

export const GROUP_LABELS: Readonly<Record<ChoiceGroup, string>> = { main: 'Main', changesets: 'Pending changesets', options: 'Option sets', versions: 'Versions' };

/** How many earlier versions the picker offers. */
export const MAX_VERSIONS = 12;

export interface ChoiceInput {
  readonly model: EditorModel | null;
  readonly proposals: readonly ChangesetRow[];
  readonly log: readonly HistoryEntry[] | null;
  /** Main's version number, when known. */
  readonly seq: number | null;
  /** Who proposed a changeset, in words. */
  readonly proposer: (createdBy: string | null) => string;
  /** "12 min ago". */
  readonly ago: (iso: string) => string;
  /** Who wrote a version, in words. */
  readonly author?: (entry: HistoryEntry) => string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;

/**
 * Every source a side can show, in the picker's order: main; the pending changesets, oldest first
 * and numbered so; each option set's options other than the one the editor shows; then the versions
 * main has been at before now, newest first.
 */
export function choicesOf(input: ChoiceInput): SourceChoice[] {
  const out: SourceChoice[] = [];
  const main = input.seq === null ? 'Main' : `Main · v${String(input.seq)}`;
  out.push({ source: MAIN, key: 'main', group: 'main', label: main, detail: 'As the editor shows it now', chip: main });
  const proposals = [...input.proposals].filter((p) => p.status === 'pending').sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));
  proposals.forEach((p, i) => {
    const source: CompareSource = { kind: 'changeset', id: p.id };
    const ops = p.ops === null ? null : plural(p.ops, 'op');
    out.push({
      source,
      key: sourceKey(source),
      group: 'changesets',
      label: `#${String(i + 1)} · ${p.name}`,
      detail: [input.proposer(p.createdBy), ops, input.ago(p.createdAt)].filter((x) => x !== null).join(' · '),
      chip: `Changeset #${String(i + 1)} · ${p.name}`,
    });
  });
  for (const set of input.model?.optionSets ?? []) {
    const shown = input.model?.design[set.id] ?? set.primary;
    const now = set.options.find((o) => o.id === shown)?.name ?? shown;
    for (const o of set.options) {
      if (o.id === shown) continue;
      const source: CompareSource = { kind: 'option', set: set.id, option: o.id };
      out.push({ source, key: sourceKey(source), group: 'options', label: `${set.name} · ${o.name}`, detail: `Instead of ${now}${o.id === set.primary ? ' — the primary' : ''}`, chip: `${set.name} · ${o.name}` });
    }
  }
  const head = input.model?.hash;
  const seen = new Set<string>(head === undefined ? [] : [head]);
  let versions = 0;
  for (const e of input.log ?? []) {
    if (versions >= MAX_VERSIONS) break;
    if (seen.has(e.after)) continue;
    seen.add(e.after);
    const source: CompareSource = { kind: 'version', hash: e.after, seq: e.seq };
    const who = input.author?.(e);
    out.push({ source, key: sourceKey(source), group: 'versions', label: `v${String(e.seq)}`, detail: [who, input.ago(e.at)].filter((x) => x !== undefined).join(' · '), chip: `v${String(e.seq)}` });
    versions++;
  }
  return out;
}

/** The choice for a source, or one made up for a source the picker no longer lists (a changeset accepted meanwhile). */
export function choiceOf(choices: readonly SourceChoice[], source: CompareSource): SourceChoice {
  const key = sourceKey(source);
  const found = choices.find((c) => c.key === key);
  if (found !== undefined) return found;
  const label = source.kind === 'main' ? 'Main' : source.kind === 'changeset' ? 'A changeset' : source.kind === 'option' ? `${source.set} · ${source.option}` : `v${String(source.seq)}`;
  return { source, key, group: source.kind === 'main' ? 'main' : source.kind === 'changeset' ? 'changesets' : source.kind === 'option' ? 'options' : 'versions', label, detail: '', chip: label };
}

/**
 * The B a comparison opens with when none is chosen yet: the newest pending changeset, else another
 * option of the first option set, else the version before now — whatever is not A. Null with none.
 */
export function defaultB(choices: readonly SourceChoice[], a: CompareSource): CompareSource | null {
  const not = choices.filter((c) => !sameSource(c.source, a) && c.group !== 'main');
  const changesets = not.filter((c) => c.group === 'changesets');
  return (changesets[changesets.length - 1] ?? not.find((c) => c.group === 'options') ?? not.find((c) => c.group === 'versions'))?.source ?? (a.kind === 'main' ? null : MAIN);
}

/** Where a side's chip says it is: "A · Main v42". */
export const chipText = (side: Side, choice: SourceChoice): string => `${side.toUpperCase()} · ${choice.chip}`;
