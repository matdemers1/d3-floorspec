import type { EditorStore, ToolId } from './store';
import type { LevelView, Point } from './model';
import { dist, hitTest, faceAt, leftNormal, project, roomsBeside } from './geometry';
import { pointAtLength, snapOpening, snapPoint, type Snap } from './snap';
import { panBy, toWorld, zoomAt } from './viewport';
import {
  addOpening,
  addRoom,
  drawChain,
  isClosed,
  moveJunction,
  moveOpening,
  moveWall,
  nextRoomName,
  typeChoices,
  type ChainVertex,
} from './ops';
import { gridStep, lengthText, parseLen, parseSegment } from './units';
import { interiorPoint } from './geometry';
import type { FaceView } from './model';
import { kindOf, labelOf } from './model';
import { requestRemove } from './actions';

/**
 * Pointer and keyboard input on the plan (FLR-T-3.3). Pointer events throughout, so a mouse, a
 * Pencil and a finger all arrive here: a pen or a mouse acts with the current tool; one finger
 * pans when it drags and acts when it taps (so a tablet without a pen can still draw); two fingers
 * pinch to zoom. Every gesture ends as a batch handed to the store — nothing here edits a document.
 */

export interface PointerInfo {
  id: number;
  /** Position in the canvas, CSS pixels. */
  x: number;
  y: number;
  type: 'mouse' | 'pen' | 'touch';
  button: number;
  shift: boolean;
  alt: boolean;
  /** Click count, for a double click. */
  detail: number;
}

interface Tracked {
  type: PointerInfo['type'];
  x: number;
  y: number;
  downX: number;
  downY: number;
  moved: boolean;
}

/** How near counts as "on it", in CSS pixels, by pointer: a finger is not a cursor. */
const TOLERANCE_PX = { mouse: 8, pen: 10, touch: 22 } as const;
const DRAG_PX = { mouse: 4, pen: 4, touch: 10 } as const;

type Mode = 'idle' | 'pan' | 'pinch' | 'tool' | 'touch-pending';

export class ToolController {
  private readonly pointers = new Map<number, Tracked>();
  private mode: Mode = 'idle';
  private pinch: { d: number; mid: Point } | null = null;
  private dragStart: { world: Point; target: string; kind: 'junction' | 'wall' | 'opening' } | null = null;
  space = false;

  constructor(private readonly store: EditorStore) {}

  private get level(): LevelView | undefined {
    return this.store.levelView;
  }

  private world(p: PointerInfo): Point {
    const view = this.store.get().view;
    return view === null ? [0, 0] : toWorld(view, [p.x, p.y]);
  }

  private tol(type: PointerInfo['type']): number {
    const view = this.store.get().view;
    return view === null ? 0 : TOLERANCE_PX[type] / view.s;
  }

  private get editable(): boolean {
    const s = this.store.get();
    return s.readOnly === null && s.model !== null && s.level !== null && s.compare === null;
  }

  // ─── Pointer events ──────────────────────────────────────────────────────────────────────

  down(p: PointerInfo): void {
    this.pointers.set(p.id, { type: p.type, x: p.x, y: p.y, downX: p.x, downY: p.y, moved: false });
    const touches = [...this.pointers.values()].filter((t) => t.type === 'touch');
    if (touches.length >= 2) {
      this.cancelGesture();
      this.mode = 'pinch';
      this.pinch = this.pinchOf();
      return;
    }
    if (p.button === 1 || this.space) {
      this.mode = 'pan';
      return;
    }
    if (p.button !== 0) return;
    if (p.type === 'touch') {
      // A finger: decide on the first move whether this is a pan or a tap. Over a draggable
      // element in the select tool, it is a drag.
      const grab = this.store.get().tool === 'select' ? this.grabTarget(p) : null;
      if (grab !== null && this.editable) {
        this.mode = 'tool';
        this.toolDown(p);
        return;
      }
      this.mode = 'touch-pending';
      return;
    }
    this.mode = 'tool';
    this.toolDown(p);
  }

  move(p: PointerInfo): void {
    const tracked = this.pointers.get(p.id);
    if (tracked !== undefined) {
      const dx = p.x - tracked.x;
      const dy = p.y - tracked.y;
      tracked.x = p.x;
      tracked.y = p.y;
      if (!tracked.moved && Math.hypot(p.x - tracked.downX, p.y - tracked.downY) > DRAG_PX[p.type]) tracked.moved = true;
      if (this.mode === 'pinch') {
        this.applyPinch();
        return;
      }
      if (this.mode === 'pan' || (this.mode === 'touch-pending' && tracked.moved)) {
        this.mode = 'pan';
        const view = this.store.get().view;
        if (view !== null) this.store.set({ view: panBy(view, dx, dy) });
        return;
      }
      if (this.mode === 'touch-pending') return;
    }
    this.store.set({ cursor: this.world(p) });
    this.toolMove(p, tracked !== undefined && this.mode === 'tool' && tracked.moved);
  }

  up(p: PointerInfo): void {
    const tracked = this.pointers.get(p.id);
    this.pointers.delete(p.id);
    const mode = this.mode;
    if (this.pointers.size === 0) this.mode = 'idle';
    else if (mode === 'pinch' && this.pointers.size === 1) {
      this.mode = 'pan';
      this.pinch = null;
    }
    if (mode === 'touch-pending' && tracked !== undefined && !tracked.moved) {
      // A tap: the tool's click, at the tap.
      this.toolMove(p, false);
      this.toolDown(p);
      this.toolUp(p, false);
      return;
    }
    if (mode === 'tool') this.toolUp(p, tracked?.moved ?? false);
  }

  cancel(p: { id: number }): void {
    this.pointers.delete(p.id);
    if (this.pointers.size === 0) {
      this.mode = 'idle';
      this.cancelGesture();
    }
  }

  leave(): void {
    if (this.mode === 'idle') this.store.set({ hover: null, cursor: null });
  }

  wheel(e: { x: number; y: number; dx: number; dy: number; zoom: boolean }): void {
    const view = this.store.get().view;
    if (view === null) return;
    if (e.zoom) this.store.set({ view: zoomAt(view, Math.exp(-e.dy * 0.0025), [e.x, e.y]) });
    else this.store.set({ view: panBy(view, -e.dx, -e.dy) });
  }

  private pinchOf(): { d: number; mid: Point } | null {
    const [a, b] = [...this.pointers.values()].filter((t) => t.type === 'touch');
    if (a === undefined || b === undefined) return null;
    return { d: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
  }

  private applyPinch(): void {
    const now = this.pinchOf();
    const before = this.pinch;
    let view = this.store.get().view;
    if (now === null || before === null || view === null) return;
    view = panBy(view, now.mid[0] - before.mid[0], now.mid[1] - before.mid[1]);
    if (before.d > 0) view = zoomAt(view, now.d / before.d, now.mid);
    this.pinch = now;
    this.store.set({ view });
  }

  private cancelGesture(): void {
    this.dragStart = null;
    const draft = this.store.get().draft;
    if (draft?.tool === 'select' && draft.drag !== null) {
      this.store.set({ draft: { ...draft, drag: null } });
      this.store.preview(null);
    }
  }

  // ─── Tools ───────────────────────────────────────────────────────────────────────────────

  private grabTarget(p: PointerInfo): { kind: 'junction' | 'wall' | 'opening'; id: string } | null {
    const level = this.level;
    if (level === undefined) return null;
    const hit = hitTest(level, this.world(p), this.tol(p.type));
    if (hit === null) return null;
    if (hit.kind === 'junction') return hit;
    // A finger drags a wall or an opening only once it is selected; otherwise it pans.
    if ((hit.kind === 'wall' || hit.kind === 'opening') && (p.type !== 'touch' || this.store.get().selection === hit.id)) return { kind: hit.kind, id: hit.id };
    return null;
  }

  private snapFor(p: PointerInfo, from: Point | undefined, extra: readonly Point[] = []): Snap {
    const level = this.level;
    const units = this.store.units;
    const withExtra: LevelView | undefined =
      level === undefined
        ? undefined
        : { ...level, junctions: [...level.junctions, ...extra.map((position, i) => ({ id: `~${String(i)}`, position, edges: 0 }))] };
    return snapPoint(withExtra, this.world(p), {
      from,
      tol: this.tol(p.type),
      grid: gridStep(units),
      lock45: p.shift,
      free: p.alt,
    });
  }

  private toolDown(p: PointerInfo): void {
    const s = this.store.get();
    if (!this.editable && s.tool !== 'select') return;
    switch (s.tool) {
      case 'select':
        this.selectDown(p);
        return;
      case 'wall':
      case 'separator':
        this.chainDown(p, s.tool);
        return;
      case 'door':
      case 'window':
        this.openingDown();
        return;
      case 'room':
        this.roomDown(p);
        return;
    }
  }

  private toolMove(p: PointerInfo, dragging: boolean): void {
    const s = this.store.get();
    const level = this.level;
    if (level === undefined) return;
    switch (s.tool) {
      case 'select': {
        if (dragging && this.dragStart !== null) {
          this.selectDrag(p);
          return;
        }
        if (this.mode === 'idle' || this.mode === 'tool') {
          const hit = hitTest(level, this.world(p), this.tol(p.type));
          if ((hit?.id ?? null) !== s.hover) this.store.set({ hover: hit?.id ?? null });
        }
        return;
      }
      case 'wall':
      case 'separator': {
        const draft = s.draft?.tool === s.tool ? s.draft : { tool: s.tool, chain: [], cursor: null, typed: '' };
        const last = draft.chain[draft.chain.length - 1];
        const cursor = this.snapFor(p, last?.point, draft.chain.map((v) => v.point));
        this.store.set({ draft: { ...draft, cursor } });
        if (dragging && draft.chain.length > 0) return;
        return;
      }
      case 'door':
      case 'window':
        this.openingHover(p, s.tool);
        return;
      case 'room': {
        const point = this.world(p);
        const face = faceAt(level, point);
        this.store.set({ draft: { tool: 'room', hover: { point, free: face !== undefined && face.room === null } } });
        return;
      }
    }
  }

  private toolUp(p: PointerInfo, moved: boolean): void {
    const s = this.store.get();
    if (s.tool === 'select') {
      this.selectUp(p, moved);
      return;
    }
    // Drawing by dragging: press at one end, lift at the other.
    if ((s.tool === 'wall' || s.tool === 'separator') && moved) this.chainDown(p, s.tool);
  }

  // ── select ──

  private selectDown(p: PointerInfo): void {
    const level = this.level;
    if (level === undefined) return;
    const world = this.world(p);
    const grab = this.editable ? this.grabTarget(p) : null;
    if (grab !== null) {
      this.dragStart = { world, target: grab.id, kind: grab.kind };
      return;
    }
    this.dragStart = null;
    const hit = hitTest(level, world, this.tol(p.type));
    this.store.select(hit?.id ?? null);
  }

  private selectDrag(p: PointerInfo): void {
    const start = this.dragStart;
    const level = this.level;
    const s = this.store.get();
    if (start === null || level === undefined) return;
    const typed = s.draft?.tool === 'select' ? s.draft.typed : '';
    const grid = gridStep(this.store.units);
    if (start.kind === 'junction') {
      const walls = new Set([...level.walls, ...level.separators].filter((w) => w.start === start.target || w.end === start.target).map((w) => w.id));
      const snap = snapPoint(level, this.world(p), { tol: this.tol(p.type), grid, exclude: new Set([start.target]), excludeWalls: walls, lock45: p.shift, free: p.alt });
      this.store.set({ draft: { tool: 'select', drag: { kind: 'junction', id: start.target, to: snap.point, snap }, typed } });
      this.store.preview(moveJunction(start.target, snap.point));
      return;
    }
    if (start.kind === 'wall') {
      const wall = level.walls.find((w) => w.id === start.target);
      if (wall === undefined) return;
      const n = leftNormal(wall.a, wall.b);
      const world = this.world(p);
      const raw = (world[0] - start.world[0]) * n[0] + (world[1] - start.world[1]) * n[1];
      const by = Math.round(raw / grid) * grid;
      this.store.set({ draft: { tool: 'select', drag: { kind: 'wall', id: wall.id, by }, typed } });
      this.store.preview(by === 0 ? null : moveWall(wall.id, by));
      return;
    }
    const opening = level.openings.find((o) => o.id === start.target);
    const wall = opening === undefined ? undefined : level.walls.find((w) => w.id === opening.wall);
    if (opening === undefined || wall === undefined) return;
    const snap = snapOpening(wall.a, wall.b, dist(wall.a, wall.b), opening.width, this.world(p), { tol: this.tol(p.type), grid });
    this.store.set({ draft: { tool: 'select', drag: { kind: 'opening', id: opening.id, offset: snap.offset, centered: snap.centered }, typed } });
    this.store.preview(moveOpening(opening.id, snap.centered ? 'centered' : snap.offset));
  }

  private selectUp(p: PointerInfo, moved: boolean): void {
    const start = this.dragStart;
    this.dragStart = null;
    const draft = this.store.get().draft;
    const drag = draft?.tool === 'select' ? draft.drag : null;
    this.store.preview(null);
    this.store.set({ draft: null });
    if (start === null) return;
    if (!moved || drag === null) {
      // A click on a handle selects what it belongs to.
      this.store.select(start.target);
      return;
    }
    const model = this.store.get().model;
    const name = model === null ? drag.id : labelOf(model, drag.id);
    if (drag.kind === 'junction') {
      const junction = this.level?.junctions.find((j) => j.id === drag.id);
      if (junction !== undefined && junction.position[0] === drag.to[0] && junction.position[1] === drag.to[1]) return;
      void this.store.apply(`Move ${name}`, moveJunction(drag.id, drag.to), { select: () => drag.id });
    } else if (drag.kind === 'wall') {
      if (drag.by !== 0) void this.store.apply(`Move ${name}`, moveWall(drag.id, drag.by), { select: () => drag.id });
    } else {
      void this.store.apply(`Move ${name}`, moveOpening(drag.id, drag.centered ? 'centered' : drag.offset), { select: () => drag.id });
    }
  }

  // ── walls and separators ──

  private chainDown(p: PointerInfo, tool: 'wall' | 'separator'): void {
    const s = this.store.get();
    const draft = s.draft?.tool === tool ? s.draft : { tool, chain: [] as ChainVertex[], cursor: null, typed: '' };
    const last = draft.chain[draft.chain.length - 1];
    const snap = this.snapFor(p, last?.point, draft.chain.map((v) => v.point));
    const vertex: ChainVertex = { point: snap.point, junction: snap.kind === 'junction' && snap.ref?.startsWith('~') !== true ? snap.ref : undefined };
    if (last !== undefined && last.point[0] === vertex.point[0] && last.point[1] === vertex.point[1]) {
      // The same point again: a double click finishes.
      if (p.detail >= 2) this.finishChain();
      return;
    }
    const chain = [...draft.chain, vertex];
    this.store.set({ draft: { ...draft, chain, cursor: snap, typed: '' } });
    if (isClosed(chain) || (!s.draw.chain && chain.length >= 2)) this.finishChain();
  }

  /** Commit the chain drawn so far as one batch of drawWall (or drawSeparator) composites. */
  finishChain(): void {
    const s = this.store.get();
    const draft = s.draft;
    if ((draft?.tool !== 'wall' && draft?.tool !== 'separator') || s.model === null || s.level === null) return;
    this.store.set({ draft: { ...draft, chain: [], typed: '' } });
    if (draft.chain.length < 2) return;
    const document = s.model.document;
    const type = draft.tool === 'wall' ? this.store.chosenType(typeChoices(document, 'wallType'), s.draw.wallType) : undefined;
    const segments = draft.chain.length - 1;
    const noun = draft.tool === 'wall' ? (segments === 1 ? 'wall' : 'walls') : segments === 1 ? 'separator' : 'separators';
    void this.store.apply(`Draw ${String(segments)} ${noun}`, drawChain(document, s.level, draft.chain, { kind: draft.tool, type, justification: s.draw.justification }));
  }

  // ── openings ──

  private openingHover(p: PointerInfo, tool: 'door' | 'window'): void {
    const level = this.level;
    const s = this.store.get();
    if (level === undefined || s.model === null) return;
    const typed = s.draft?.tool === tool ? s.draft.typed : '';
    const hit = hitTest(level, this.world(p), this.tol(p.type), { junctions: false });
    const wallId = hit?.kind === 'wall' ? hit.id : hit?.kind === 'opening' ? level.openings.find((o) => o.id === hit.id)?.wall : undefined;
    const wall = level.walls.find((w) => w.id === wallId);
    if (wall === undefined) {
      this.store.set({ draft: { tool, hover: null, typed } });
      return;
    }
    const fill = this.store.chosenType(typeChoices(s.model.document, tool === 'door' ? 'doorType' : 'windowType'), tool === 'door' ? s.draw.doorType : s.draw.windowType);
    const width = Number(fill?.element['width'] ?? 0);
    const snap = snapOpening(wall.a, wall.b, dist(wall.a, wall.b), width, this.world(p), { tol: this.tol(p.type), grid: gridStep(this.store.units) });
    this.store.set({ draft: { tool, hover: { wall: wall.id, offset: snap.offset, centered: snap.centered, width, side: snap.side, nearer: snap.nearer, fits: snap.fits }, typed } });
  }

  private openingDown(at?: string): void {
    const s = this.store.get();
    const draft = s.draft;
    if ((draft?.tool !== 'door' && draft?.tool !== 'window') || draft.hover === null || s.model === null) return;
    const hover = draft.hover;
    if (!hover.fits) {
      this.store.set({ notice: { tone: 'info', text: 'That wall is shorter than the opening. Pick a narrower type, or a longer wall.' } });
      return;
    }
    const kind = draft.tool === 'door' ? 'doorType' : 'windowType';
    const fill = this.store.chosenType(typeChoices(s.model.document, kind), draft.tool === 'door' ? s.draw.doorType : s.draw.windowType);
    void this.store.apply(
      `Add ${draft.tool}`,
      addOpening(s.model.document, {
        wall: hover.wall,
        at: at ?? (hover.centered ? 'centered' : hover.offset),
        fill,
        hinge: hover.nearer,
        swing: hover.side,
      }),
      { select: (created) => created.find((id) => s.model !== null && /^O\d+$/.test(id)) ?? null },
    );
    this.store.set({ draft: { ...draft, typed: '' } });
  }

  // ── rooms ──

  private roomDown(p: PointerInfo): void {
    const s = this.store.get();
    if (s.model === null || s.level === null) return;
    const point = this.world(p);
    const at: Point = [Math.round(point[0]), Math.round(point[1])];
    const name = nextRoomName(s.model.document);
    // Once named, the room is selected with its name field focused, ready to type over.
    void this.store
      .apply(`Name a room`, addRoom({ level: s.level, at, name }), {
        select: (created) => created.find((id) => /^R\d+$/.test(id)) ?? created[0] ?? null,
        focus: 'room-name',
      })
      .then((ok) => {
        if (ok) this.store.setTool('select');
      });
  }

  // ─── Keyboard ────────────────────────────────────────────────────────────────────────────

  /** Typed lengths while drawing or dragging. Returns true when the key was taken. */
  typeKey(key: string): boolean {
    const s = this.store.get();
    // Drawing from the keyboard: the wall tool takes a typed start point before any click.
    const draft = s.draft === null && (s.tool === 'wall' || s.tool === 'separator') && this.editable ? { tool: s.tool, chain: [] as ChainVertex[], cursor: null, typed: '' } : s.draft;
    if (draft === null || draft.tool === 'room') return false;
    if (draft.tool === 'select' && draft.drag === null) return false;
    if ((draft.tool === 'door' || draft.tool === 'window') && draft.hover === null) return false;
    const typed = draft.typed;
    if (key === 'Backspace') {
      if (typed === '') return false;
      this.store.set({ draft: { ...draft, typed: typed.slice(0, -1) } });
      return true;
    }
    const starts = /^[0-9.-]$/.test(key);
    const drawing = draft.tool === 'wall' || draft.tool === 'separator';
    const continues = /^[0-9.'"/ \-a-zA-Z]$/.test(key) || (drawing && /^[,<@]$/.test(key));
    if ((typed === '' && starts) || (typed !== '' && continues)) {
      this.store.set({ draft: { ...draft, typed: typed + key } });
      return true;
    }
    return false;
  }

  /** Enter: place the typed length, or finish a chain. */
  enter(): boolean {
    const s = this.store.get();
    const draft = s.draft;
    const units = this.store.units;
    if (s.tool === 'room' && this.editable) {
      const face = this.unnamedSpaces()[0];
      if (face === undefined) {
        this.store.set({ notice: { tone: 'info', text: 'Every closed space on this level already has a room.' } });
        return true;
      }
      this.nameRoomIn(face);
      return true;
    }
    if (draft === null || draft.tool === 'room') return false;
    if (draft.tool === 'wall' || draft.tool === 'separator') {
      if (draft.typed.trim() === '') {
        this.finishChain();
        return true;
      }
      const last = draft.chain[draft.chain.length - 1];
      const parsed = parseSegment(draft.typed, units);
      if (!parsed.ok) {
        this.store.set({ notice: { tone: 'danger', text: parsed.reason } });
        return true;
      }
      if (last === undefined && parsed.kind !== 'point') {
        this.store.set({ notice: { tone: 'info', text: 'Type where the first wall starts, as x, y — for example 0, 0.' } });
        return true;
      }
      const angle = parsed.kind === 'length' ? (parsed.angle ?? draft.cursor?.angle ?? 0) : (draft.cursor?.angle ?? 0);
      const point: Point = parsed.kind === 'point' ? parsed.point : pointAtLength((last as ChainVertex).point, angle, parsed.length);
      // A typed point on an existing junction joins it, as a click there would.
      const junction = this.level?.junctions.find((j) => j.position[0] === point[0] && j.position[1] === point[1])?.id;
      const chain = [...draft.chain, { point, junction }];
      this.store.set({ draft: { ...draft, chain, typed: '', cursor: { point, kind: 'angle', guides: [], angle } } });
      if (isClosed(chain) || (!s.draw.chain && chain.length >= 2)) this.finishChain();
      return true;
    }
    if (draft.tool === 'door' || draft.tool === 'window') {
      if (draft.hover === null) return false;
      // Nothing typed: place it where it shows — the centre of a wall chosen from the keyboard.
      if (draft.typed.trim() === '') {
        this.openingDown();
        return true;
      }
      const parsed = parseLen(draft.typed, units);
      if (!parsed.ok) {
        this.store.set({ notice: { tone: 'danger', text: parsed.reason } });
        return true;
      }
      // Sent as the grammar's own position — the applier resolves it exactly (Ops 3.5).
      this.openingDown(`${lengthText(draft.typed, units)} from ${draft.hover.nearer}`);
      return true;
    }
    // Dragging a wall: the typed distance, in the direction of the drag.
    if (!('drag' in draft)) return false;
    const drag = draft.drag;
    if (drag?.kind === 'wall' && draft.typed.trim() !== '') {
      const parsed = parseLen(draft.typed, units);
      if (!parsed.ok) {
        this.store.set({ notice: { tone: 'danger', text: parsed.reason } });
        return true;
      }
      const sign = drag.by < 0 ? -1 : 1;
      this.dragStart = null;
      this.store.preview(null);
      this.store.set({ draft: null });
      const model = this.store.get().model;
      void this.store.apply(`Move ${model === null ? drag.id : labelOf(model, drag.id)}`, moveWall(drag.id, sign * parsed.value), { select: () => drag.id });
      return true;
    }
    return false;
  }

  /** Esc: drop typed text, then finish a chain, then drop the selection, then go back to select. */
  escape(): void {
    const s = this.store.get();
    const draft = s.draft;
    if (draft !== null && 'typed' in draft && draft.typed !== '') {
      this.store.set({ draft: { ...draft, typed: '' } });
      return;
    }
    if ((draft?.tool === 'wall' || draft?.tool === 'separator') && draft.chain.length > 0) {
      if (draft.chain.length >= 2) this.finishChain();
      else this.store.set({ draft: { ...draft, chain: [] } });
      return;
    }
    if (draft?.tool === 'select' && draft.drag !== null) {
      this.cancelGesture();
      return;
    }
    if (s.rejection !== null) {
      this.store.dismissRejection();
      return;
    }
    if (s.tool !== 'select') {
      this.store.setTool('select');
      return;
    }
    this.store.select(null);
  }

  /** Delete or Backspace with nothing typed: remove the selection. */
  remove(): void {
    const s = this.store.get();
    if (s.selection === null || s.model === null || !this.editable) return;
    requestRemove(this.store, s.selection);
  }

  /** Switch tool, finishing a chain in progress first. */
  setTool(tool: ToolId): void {
    const draft = this.store.get().draft;
    if ((draft?.tool === 'wall' || draft?.tool === 'separator') && draft.chain.length >= 2) this.finishChain();
    const selection = this.store.get().selection;
    this.store.setTool(tool);
    // A door or a window with a wall selected starts on that wall, centred: Enter places it there,
    // a typed length places it that far from the start (FLR-T-3.7, the keyboard's way in).
    if ((tool === 'door' || tool === 'window') && selection !== null) this.aimOpeningAt(selection, tool);
  }

  private aimOpeningAt(wallId: string, tool: 'door' | 'window'): void {
    const s = this.store.get();
    const wall = this.level?.walls.find((w) => w.id === wallId);
    if (wall === undefined || s.model === null) return;
    const fill = this.store.chosenType(typeChoices(s.model.document, tool === 'door' ? 'doorType' : 'windowType'), tool === 'door' ? s.draw.doorType : s.draw.windowType);
    const width = Number(fill?.element['width'] ?? 0);
    const L = dist(wall.a, wall.b);
    const offset = Math.round((L - width) / 2);
    this.store.set({ draft: { tool, hover: { wall: wall.id, offset, centered: true, width, side: 'right', nearer: 'start', fits: width <= L }, typed: '' } });
  }

  /**
   * The arrows while drawing walls: point the next segment east, north, west or south, so a
   * length typed next goes that way. Returns false when there is no chain to aim.
   */
  aim(key: string): boolean {
    const draft = this.store.get().draft;
    if ((draft?.tool !== 'wall' && draft?.tool !== 'separator') || draft.chain.length === 0) return false;
    const angles: Record<string, number> = { ArrowRight: 0, ArrowUp: 90, ArrowLeft: 180, ArrowDown: 270 };
    const angle = angles[key];
    if (angle === undefined) return false;
    const last = draft.chain[draft.chain.length - 1] as ChainVertex;
    this.store.set({ draft: { ...draft, cursor: { point: last.point, kind: 'angle', guides: [], angle } } });
    return true;
  }

  /** Start drawing walls at a typed point (the palette's "Draw walls from a point…"). */
  startChainAt(point: Point): void {
    if (!this.editable) return;
    this.setTool('wall');
    const junction = this.level?.junctions.find((j) => j.position[0] === point[0] && j.position[1] === point[1])?.id;
    this.store.set({ draft: { tool: 'wall', chain: [{ point, junction }], cursor: { point, kind: 'angle', guides: [], angle: 0 }, typed: '' } });
  }

  /** Name a room in an unnamed space (the keyboard's room tool). */
  nameRoomIn(face: FaceView): void {
    const s = this.store.get();
    if (s.model === null || s.level === null || !this.editable) return;
    const at = interiorPoint(face);
    if (at === null) {
      this.store.set({ notice: { tone: 'info', text: 'That space is too thin to hold a room.' } });
      return;
    }
    const name = nextRoomName(s.model.document);
    void this.store
      .apply('Name a room', addRoom({ level: s.level, at, name }), { select: (created) => created.find((id) => /^R\d+$/.test(id)) ?? created[0] ?? null, focus: 'room-name' })
      .then((ok) => {
        if (ok && this.store.get().tool === 'room') this.store.setTool('select');
      });
  }

  /** The level's unnamed spaces, largest first. */
  unnamedSpaces(): FaceView[] {
    return (this.level?.faces ?? []).filter((f) => f.room === null).sort((a, b) => (a.area2 > b.area2 ? -1 : a.area2 < b.area2 ? 1 : 0));
  }
}

/** For the inspector and tests: which rooms a wall divides, by name. */
export function wallRooms(store: EditorStore, wall: string): { left: string | null; right: string | null } {
  const level = store.levelView;
  return level === undefined ? { left: null, right: null } : roomsBeside(level, wall);
}

export { kindOf, project };
