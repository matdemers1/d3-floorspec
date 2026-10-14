import { useMemo } from 'react';
import { useEditor, type EditorStore, type Viewport } from '../store';
import { labelOf, type EditorModel, type LevelView, type Point, type Ring } from '../model';
import { toScreen } from '../viewport';
import { prettyLen, type UnitSystem } from '../units';
import { useArrange } from '../arrange/state';
import { entryOf, usePlacing } from '../../placing/state';
import type { Ghost } from '../../placing/ghost';
import type { Entry } from '../../placing/catalog';
import { boxOf, haloFrame, headline, indexOf, movingFrom, purposeLabel, type Halo, type Moving, type Purpose } from './halos';
import './halos.css';

/**
 * Clearance halos on the plan (FLR-T-18.14): while an item is dragged, resized, turned or placed,
 * its envelopes and its neighbours' as faint halos — green clear, amber tight, red in conflict —
 * with a card saying what is too close to what, a dimension to it, and a legend. Advisory only
 * (FLR-ADR-011): letting go places the item wherever it is.
 */

/** The ghost of a library entry as a moving part: its footprint and envelopes where it would go. */
export const GHOST_ID = '(placing)';

function fromGhost(ghost: Ghost, entry: Entry, level: LevelView): Moving | null {
  if (ghost.footprint.length < 3 || ghost.envelopes.length === 0 && entry.clearances.length === 0) return null;
  const base = level.elevation;
  const env = new Map(entry.clearances.map((c) => [c.name, c]));
  return {
    id: GHOST_ID,
    footprint: ghost.footprint,
    bottom: base + entry.box.min[2],
    top: base + entry.box.max[2],
    shape: ghost.footprint,
    hostWall: ghost.host?.mode === 'wallFace' ? ghost.host.wall : null,
    with: null,
    zones: ghost.envelopes.map((e) => {
      const c = env.get(e.name);
      return { owner: GHOST_ID, name: e.name, purpose: (c?.purpose ?? 'access') as Purpose, ring: e.ring, bottom: base + (c?.min[2] ?? entry.box.min[2]), top: base + (c?.max[2] ?? entry.box.max[2]) };
    }),
  };
}

export interface HaloView {
  halos: Halo[];
  head: Halo | null;
  moving: ReadonlySet<string>;
  /** The moving parts' extent in plan, for the card. */
  extent: Ring;
  /** The moving items' footprints where the frame has them, outlined over their halos. */
  footprints: Ring[];
  /** Names to speak of, by ID. */
  name: (id: string) => string;
}

interface HaloStats {
  frames: number;
  totalMs: number;
  maxMs: number;
  last: { halos: number; tone: string | null };
}

/** The frames computed and how long they took — read by the e2e suite to report the cost per frame. */
function record(ms: number, halos: Halo[], head: Halo | null): void {
  const w = window as unknown as { __floorspecHalos?: HaloStats };
  const s = w.__floorspecHalos ?? { frames: 0, totalMs: 0, maxMs: 0, last: { halos: 0, tone: null } };
  s.frames += 1;
  s.totalMs += ms;
  s.maxMs = Math.max(s.maxMs, ms);
  s.last = { halos: halos.length, tone: head?.tone ?? null };
  w.__floorspecHalos = s;
}

const DRAGS = new Set(['device', 'resize', 'rotate', 'opening']);

/** What is moving now, as one string (stable for the store's snapshot): `ids` joined, or the ghost. */
export function useHalos(store: EditorStore, level: LevelView | undefined, model: EditorModel | null): HaloView | null {
  const dragged = useEditor(store, (s) => {
    if (s.compare !== null) return null;
    const d = s.draft;
    if (d?.tool !== 'select' || d.drag === null || !DRAGS.has(d.drag.kind)) return null;
    return (d.drag as { id: string }).id;
  });
  const grouped = useArrange(store, (a) => a.dragging !== null);
  const selected = useEditor(store, (s) => (grouped ? s.selected.join('\n') : ''));
  const preview = useEditor(store, (s) => s.preview?.model ?? null);
  const ghost = usePlacing(store, (s) => s.ghost);
  const entryKey = usePlacing(store, (s) => s.dragging?.key ?? s.active ?? s.quickKey);
  return useMemo(() => {
    if (model === null || level === undefined) return null;
    const ids = dragged !== null ? [dragged] : selected !== '' ? selected.split('\n') : [];
    const index = indexOf(model, level.id);
    if (index === null) return null;
    let moving: Moving[] = [];
    let ghostEntry: Entry | undefined;
    if (ids.length > 0) moving = movingFrom(preview ?? model, level.id, ids);
    else if (ghost !== null) {
      ghostEntry = entryOf(store, entryKey);
      const m = ghostEntry === undefined ? null : fromGhost(ghost, ghostEntry, level);
      if (m !== null) moving = [m];
    }
    if (moving.length === 0 || moving.every((m) => m.zones.length === 0 && m.footprint === null)) return null;
    const t0 = performance.now();
    const halos = haloFrame(index, moving);
    const ids2 = new Set(moving.map((m) => m.id));
    const head = headline(halos, ids2);
    record(performance.now() - t0, halos, head);
    const extent = moving.flatMap((m) => [...m.shape, ...m.zones.flatMap((z) => z.ring)]);
    const label = ghostEntry?.name;
    // "Kitchen island", not "Kitchen island, 1800 mm": the card names things, the dimension says how far.
    const name = (id: string) => (id === GHOST_ID ? (label ?? 'the item') : model.index.has(id) ? (labelOf(model, id).split(',')[0] ?? id) : id);
    const footprints = moving.flatMap((m) => (m.footprint === null || m.id === GHOST_ID ? [] : [m.footprint]));
    return { halos, head, moving: ids2, extent, name, footprints };
  }, [dragged, selected, preview, ghost, entryKey, model, level, store]);
}

const f1 = (n: number) => n.toFixed(1);
const pts = (view: Viewport, ring: Ring) => ring.map((p) => toScreen(view, p).map(f1).join(',')).join(' ');

/** The halos, drawn under the ghost: each envelope a faint fill in its tone, neighbours fainter. */
export function HaloLayer({ view, halos }: { view: Viewport; halos: HaloView | null }) {
  if (halos === null) return null;
  const head = halos.head;
  const a = head?.against;
  const A = a === undefined ? null : toScreen(view, a.from);
  const B = a === undefined ? null : toScreen(view, a.to);
  return (
    <g className="fs-halos" aria-hidden="true" data-testid="halos">
      {halos.halos.map((h) => (
        <polygon
          key={`${h.owner}/${h.name}`}
          className={`fs-halo fs-halo--${h.tone}${h.moving ? ' fs-halo--moving' : ''}`}
          points={pts(view, h.ring)}
          data-owner={h.owner}
          data-envelope={h.name}
          data-tone={h.tone}
        />
      ))}
      {halos.footprints.map((r, i) => (
        <polygon key={`f${String(i)}`} className="fs-halo-item" points={pts(view, r)} />
      ))}
      {A !== null && B !== null && a !== undefined && a.clear > 0 ? <line className={`fs-halo__dim fs-halo__dim--${head?.tone ?? 'clear'}`} x1={f1(A[0])} y1={f1(A[1])} x2={f1(B[0])} y2={f1(B[1])} /> : null}
    </g>
  );
}

const SOURCE = (kind: 'item' | 'wall', furniture: boolean): string => (kind === 'wall' ? 'an obstruction (Rules 7.6)' : furniture ? 'FS-FURN-LINT-004' : 'an obstruction (Rules 7.6)');

/** The card that says what is too close, the clear distance on the plan, and the legend. */
export function HaloHtml({ view, halos, model, units }: { view: Viewport; halos: HaloView | null; model: EditorModel; units: UnitSystem }) {
  if (halos === null) return null;
  const head = halos.head;
  const a = head?.against;
  const box = boxOf(halos.extent.map((p) => toScreen(view, p)));
  const furniture = a !== undefined && model.ext.get(a.id)?.extension === 'FS_furniture';
  const opening = head !== null && model.index.get(head.owner) === 'openings';
  let card = null;
  if (head !== null && a !== undefined) {
    const what = purposeLabel(head.purpose, opening);
    const title = head.tone === 'conflict' ? `${what} ${prettyLen(Math.round(a.clear), units)} — needs ${prettyLen(Math.round(a.needs), units)}` : `${what} is tight — ${prettyLen(Math.round(a.spare), units)} to spare`;
    const owner = halos.name(head.owner);
    const other = halos.name(a.id);
    const between = `Between ${lowerFirst(owner)} and ${lowerFirst(other)}`;
    const note = head.tone === 'conflict' ? (furniture ? 'Release to place it anyway — it will be listed in Findings' : 'Advisory — release to place it anyway') : 'Advisory — it fits, with little to spare';
    // Beside what moves — right, else left — else below it, else above; kept on the canvas.
    const W = 340;
    const H = 96;
    const mid = Math.min(Math.max(8, (box.minY + box.maxY) / 2 - H / 2), view.h - H - 8);
    const centre = Math.min(Math.max(8, (box.minX + box.maxX) / 2 - W / 2), view.w - W - 8);
    const [left, top] =
      box.maxX + 16 + W < view.w - 8 ? [box.maxX + 16, mid]
        : box.minX - 16 - W > 8 ? [box.minX - 16 - W, mid]
          : box.maxY + 16 + H < view.h - 8 ? [centre, box.maxY + 16]
            : [centre, Math.max(8, box.minY - 16 - H)];
    card = (
      <div className={`fs-halo-card fs-halo-card--${head.tone}`} style={{ left, top }} data-testid="halo-card" data-tone={head.tone}>
        <p className="fs-halo-card__title">{title}</p>
        <p className="fs-halo-card__detail">
          {between} · {SOURCE(a.kind, furniture)}
        </p>
        <p className="fs-halo-card__note">{note}</p>
      </div>
    );
  }
  const chip = a !== undefined && a.clear > 0 && head !== null ? toScreen(view, [(a.from[0] + a.to[0]) / 2, (a.from[1] + a.to[1]) / 2] as Point) : null;
  return (
    <>
      {chip !== null && a !== undefined ? (
        <span className={`fs-halo-chip fs-halo-chip--${head?.tone ?? 'clear'}`} style={{ left: chip[0], top: chip[1] }} data-testid="halo-chip">
          {prettyLen(Math.round(a.clear), units)}
        </span>
      ) : null}
      {card}
      {/* What a screen reader hears: one sentence, as it changes. */}
      <p className="fs-halo-status" role="status" data-testid="halo-status">
        {head === null || a === undefined ? 'Clearances clear.' : `${head.tone === 'conflict' ? 'Clearance conflict' : 'Clearance tight'}: ${purposeLabel(head.purpose, opening).toLowerCase()} of ${lowerFirst(halos.name(head.owner))}, ${prettyLen(Math.round(a.clear), units)} from ${lowerFirst(halos.name(a.id))}, needs ${prettyLen(Math.round(a.needs), units)}.`}
      </p>
      <div className="fs-halo-legend" role="note" aria-label="Clearance halos">
        <span className="fs-halo-legend__item">
          <span className="fs-halo-legend__swatch fs-halo-legend__swatch--clear" aria-hidden="true" />
          Clear
        </span>
        <span className="fs-halo-legend__item">
          <span className="fs-halo-legend__swatch fs-halo-legend__swatch--tight" aria-hidden="true" />
          Tight (within 10 %)
        </span>
        <span className="fs-halo-legend__item">
          <span className="fs-halo-legend__swatch fs-halo-legend__swatch--conflict" aria-hidden="true" />
          Conflict
        </span>
      </div>
    </>
  );
}

const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? `the ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text);
