import type { HouseMesh, Vec3 } from '@floorspec/mesh';
import type { EditorStore } from '../../store';
import { labelOf, type EditorModel, type LevelView, type OpeningView, type Point, type WallView } from '../../model';
import type { Batch } from '../../ops';
import { moveOpening } from '../../ops';
import { moveDevice } from '../../systems/ops';
import type { DeviceView } from '../../systems/view';
import { dragDevice, dragOpening } from '../../drag';
import { alignMove } from '../../snap';
import { boundsOfIds } from '../../arrange/shapes';
import { withRiders } from '../../arrange/riders';
import { namer, snapGridOf, snapSettingsOf } from '../../precision/state';
import { dragRotate, turnBatch } from '../../../furniture/resize';
import { haloFrame, headline, indexOf, movingFrom, nearest, purposeLabel } from '../../halos/halos';
import { prettyLen } from '../../units';
import type { ThreeStore } from '../mode';
import type { SectionRig } from '../section/rig';
import type { MotionRig } from './rig';
import { slideMotion, type Motion } from './motion';
import { alongWall, faceDrag, faceOf, lineOf, moveWords, onLevel, onUpright, toPlan, toMetres, type Ray } from './project';
import { snapOnTriangle, type TapePoint } from './tape';

/**
 * Edit in 3D (FLR-T-14.8): the pointer on the 3D view turned into the editor's own edits. With the
 * Edit tool on, a press on an item or an opening selects it and a drag moves it on its host — an item
 * on the floor (or ceiling) it stands on, at the height it was grabbed; one on a wall over that wall's
 * face, along and up; an opening along its wall — by the same snaps, smart guides and op the plan's
 * drag uses (drag.ts). Each move is previewed as the plan previews it (the store's rigid preview,
 * which the view draws by moving the item's parts, rig.ts); the drop is one op through the store,
 * which carries what rides on the item (the cooktop with the island) in the same batch. The rotate
 * handle turns an item as the plan's does. With the Tape on, clicks measure (tape.ts).
 *
 * Outside React: a drag re-renders only the overlay, through `subscribe`.
 */

/** What the pointer is over: the element a part draws, the point hit and its triangle (metres, the mesh's frame). */
export interface PickHit {
  id: string | null;
  point: Vec3;
  tri: [Vec3, Vec3, Vec3] | null;
}

export interface EditContext {
  store: EditorStore;
  three: ThreeStore;
  rig: SectionRig;
  motion: MotionRig;
  /** The first part under a point of the canvas (CSS pixels within it); `seen`: only what is drawn (not an opening's pick target). */
  pick: (x: number, y: number, seen?: boolean) => PickHit | null;
  /** The model the house is meshed from, and its mesh. */
  meshed: () => { model: EditorModel; mesh: HouseMesh } | null;
  /** The canvas's box on the page. */
  bounds: () => DOMRect | null;
  /** The parts of an element as meshed: their box, metres in the mesh's frame. */
  boxOf: (id: string) => { min: Vec3; max: Vec3 } | null;
}

export type DragKind = 'floor' | 'face' | 'opening' | 'rotate';

/** What the overlay draws of a drag: metres in the mesh's frame. */
export interface EditView {
  drag: {
    kind: DragKind;
    id: string;
    name: string;
    /** "on the floor of Great room", "on W12", "along W12". */
    where: string;
    /** A smart guide's words ("Aligned with Three-seat sofa GR-SOFA"), when one holds. */
    guide: string | null;
  } | null;
  /** Where the item stood before the drag: its outline at its bottom. */
  ghost: Vec3[] | null;
  /** The smart guides' lines. */
  guides: [Vec3, Vec3][];
  /** The clearance tags: the gap to the nearest wall, and the worst clearance it now has. */
  tags: { from: Vec3; to: Vec3; text: string; tone: 'info' | 'warning' | 'danger' }[];
  /** Where the tape's next point would go. */
  hover: TapePoint | null;
}

const EMPTY: EditView = { drag: null, ghost: null, guides: [], tags: [], hover: null };

/** How far the pointer goes before a press is a drag. */
const DRAG_PX = 4;
/** The snaps' and guides' reach on screen. */
const TOL_PX = 8;
/** How long the pointer rests on an opening before the house is previewed with it there. */
const OPENING_REST_MS = 250;

type Drag =
  | { kind: 'floor'; id: string; level: string; z: number; from: Point }
  | { kind: 'face'; id: string; level: string; wall: string; side: 'left' | 'right'; along: number; z: number; offset: number; height: number }
  | { kind: 'opening'; id: string; level: string; wall: string; centre: Point; from: Point }
  | { kind: 'rotate'; id: string; level: string; z: number };

interface Press {
  drag: Drag;
  x: number;
  y: number;
  live: boolean;
  batch: Batch | null;
  /** What the drop says it did. */
  words: string;
}

export interface PointerLike {
  clientX: number;
  clientY: number;
  button?: number;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An item or an opening on a level of `model`. */
export function findEditable(model: EditorModel, id: string): { level: LevelView; device?: DeviceView; opening?: OpeningView; wall?: WallView } | null {
  for (const level of model.levels) {
    const device = level.devices.find((d) => d.id === id);
    if (device !== undefined) return { level, device };
    const opening = level.openings.find((o) => o.id === id);
    if (opening !== undefined) {
      const wall = level.walls.find((w) => w.id === opening.wall);
      return wall === undefined ? null : { level, opening, wall };
    }
  }
  return null;
}

/** Where an item is hosted, in words: "on the floor of Great room", "on W12", "on Main floor". */
export function hostWords(model: EditorModel, level: LevelView, d: DeviceView): string {
  const h = d.host;
  if (h?.['mode'] === 'surface' && typeof h['room'] === 'string') return `on the ${h['surface'] === 'ceiling' ? 'ceiling' : 'floor'} of ${labelOf(model, h['room'])}`;
  if (h?.['mode'] === 'wallFace' && typeof h['wall'] === 'string') return `on ${labelOf(model, h['wall'])}`;
  return `on ${level.name}`;
}

/** A smart guide's label as the tag says it. */
export function guideWords(label: string | undefined): string | null {
  if (label === undefined) return null;
  if (label.startsWith('centre = ')) return `Centred on ${label.slice(9)}`;
  if (label.startsWith('Face of ')) return `In line with the face of ${label.slice(8)}`;
  if (label.startsWith('In line with ')) return label;
  return `Aligned with ${label}`;
}

export class EditController {
  private view: EditView = EMPTY;
  private readonly listeners = new Set<() => void>();
  private press: Press | null = null;
  private rest: ReturnType<typeof setTimeout> | null = null;
  private hoverFrame = 0;
  /** Under automation: what each move cost, to keep a drag inside a frame's budget. */
  readonly stats = { moves: 0, totalMs: 0, maxMs: 0 };
  /** Told what a drop did: the toast and the live region. */
  onDropped: ((text: string) => void) | null = null;

  constructor(private readonly ctx: EditContext) {}

  get = (): EditView => this.view;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private publish(patch: Partial<EditView>): void {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l();
    this.ctx.rig.invalidate();
  }

  /** Whether a drag is under way (the canvas then does not orbit). */
  get pressing(): boolean {
    return this.press !== null;
  }

  get dragging(): string | null {
    return this.press?.live === true ? this.press.drag.id : null;
  }

  private get editable(): boolean {
    const s = this.ctx.store.get();
    return s.readOnly === null && s.model !== null && s.compare === null;
  }

  private local(e: PointerLike): [number, number] {
    const r = this.ctx.bounds();
    return r === null ? [0, 0] : [e.clientX - r.left, e.clientY - r.top];
  }

  private ray(e: PointerLike): Ray | null {
    const [x, y] = this.local(e);
    return this.ctx.rig.ray(x, y);
  }

  private origin(): { origin: Vec3; k: number } | null {
    const m = this.ctx.meshed();
    return m === null ? null : { origin: m.mesh.origin, k: m.mesh.unitsPerMetre };
  }

  /** Base units per CSS pixel on the level plane at `p` (metres): how far the snaps reach. */
  private tolAt(p: Vec3): number {
    const o = this.origin();
    if (o === null) return 0;
    const s = this.ctx.rig.project(p);
    const r = this.ctx.rig.ray(s.x + 10, s.y);
    const q = r === null ? null : onLevel(r, p[2]);
    const perPx = q === null ? 0.01 : Math.hypot(q[0] - p[0], q[1] - p[1]) / 10;
    return Math.max(1, perPx * TOL_PX * o.k);
  }

  /** The element under a point of the canvas (CSS pixels within it): for the test hook. */
  pickId(x: number, y: number): string | null {
    return this.ctx.pick(x, y)?.id ?? null;
  }

  // ─── The Edit tool ───────────────────────────────────────────────────────────────────────

  /**
   * A press on the view with the Edit tool on: on an item or an opening, it is selected and may be
   * dragged — true, and the canvas does not orbit. Anywhere else, false.
   */
  down(e: PointerLike): boolean {
    const three = this.ctx.three.get();
    if (three.edit !== 'move' || three.walking || three.explode.active || (e.button ?? 0) !== 0 || !this.editable) return false;
    const [x, y] = this.local(e);
    const hit = this.ctx.pick(x, y);
    if (hit === null || hit.id === null) return false;
    return this.grab(hit.id, hit.point, e);
  }

  /** Begin a press on element `id`, grabbed at `point` (metres): false when it is not something Edit moves. */
  grab(id: string, point: Vec3, e: PointerLike): boolean {
    const s = this.ctx.store.get();
    const model = s.model;
    const o = this.origin();
    if (model === null || o === null) return false;
    if (!isEditable(model, id)) return false;
    const found = findEditable(model, id);
    if (found === null) return false;
    const ray = this.ray(e);
    if (ray === null) return false;
    let drag: Drag | null = null;
    if (found.device !== undefined) {
      const d = found.device;
      if (d.host?.['mode'] === 'wallFace') {
        const wall = found.level.walls.find((w) => w.id === d.host?.['wall']);
        const side = d.host['side'] === 'left' ? 'left' : 'right';
        const offset = d.host['offset'];
        const height = d.host['height'];
        if (wall === undefined || typeof offset !== 'number') return false;
        const face = faceOf(wall, side, o.origin, o.k);
        const at = onUpright(ray, face.p, face.n);
        if (at === null) return false;
        drag = { kind: 'face', id, level: found.level.id, wall: wall.id, side, along: alongWall(wall, toPlan(at, o.origin, o.k)), z: at[2], offset, height: typeof height === 'number' ? height : 0 };
      } else {
        const at = onLevel(ray, point[2]);
        if (at === null) return false;
        drag = { kind: 'floor', id, level: found.level.id, z: point[2], from: toPlan(at, o.origin, o.k) };
      }
    } else if (found.opening !== undefined && found.wall !== undefined) {
      const line = lineOf(found.wall, o.origin, o.k);
      const at = onUpright(ray, line.p, line.n);
      if (at === null) return false;
      const op = found.opening;
      drag = { kind: 'opening', id, level: found.level.id, wall: found.wall.id, centre: [(op.start[0] + op.end[0]) / 2, (op.start[1] + op.end[1]) / 2], from: toPlan(at, o.origin, o.k) };
    }
    if (drag === null) return false;
    if (s.selection !== id) this.ctx.store.select(id);
    this.press = { drag, x: e.clientX, y: e.clientY, live: false, batch: null, words: '' };
    return true;
  }

  /** The rotate handle pressed: the item turns about its middle as the pointer goes round it. */
  grabRotate(id: string, z: number, e: PointerLike): boolean {
    const model = this.ctx.store.get().model;
    if (model === null || !this.editable) return false;
    const found = findEditable(model, id);
    if (found?.device === undefined) return false;
    this.press = { drag: { kind: 'rotate', id, level: found.level.id, z }, x: e.clientX, y: e.clientY, live: true, batch: null, words: '' };
    this.begin(found.device, found.level, model, 'rotate');
    return true;
  }

  private begin(d: DeviceView | undefined, level: LevelView, model: EditorModel, kind: DragKind): void {
    const press = this.press;
    const o = this.origin();
    if (press === null || o === null) return;
    const id = press.drag.id;
    const name = labelOf(model, id);
    const where = d !== undefined ? hostWords(model, level, d) : `along ${labelOf(model, (press.drag as { wall: string }).wall)}`;
    let ghost = d !== undefined && d.footprint.length >= 3 ? d.footprint.map((p) => toMetres(p, d.bottom, o.origin, o.k)) : null;
    // An opening: its outline in its wall where it stood (its parts as meshed).
    if (d === undefined && press.drag.kind === 'opening') {
      const wall = level.walls.find((w) => w.id === (press.drag as { wall: string }).wall);
      const box = this.ctx.boxOf(id);
      if (wall !== undefined && box !== null) {
        const l = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]) || 1;
        const t: [number, number] = [(wall.b[0] - wall.a[0]) / l, (wall.b[1] - wall.a[1]) / l];
        const c: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, 0];
        const hw = Math.abs((box.max[0] - box.min[0]) * t[0]) / 2 + Math.abs((box.max[1] - box.min[1]) * t[1]) / 2;
        const corner = (s1: number, z: number): Vec3 => [c[0] + t[0] * hw * s1, c[1] + t[1] * hw * s1, z];
        ghost = [corner(-1, box.min[2]), corner(1, box.min[2]), corner(1, box.max[2]), corner(-1, box.max[2])];
      }
    }
    this.publish({ drag: { kind, id, name, where, guide: null }, ghost, guides: [], tags: [], hover: null });
  }

  /** The pointer moved: true while a press is this controller's. */
  move(e: PointerLike): boolean {
    const press = this.press;
    if (press === null) {
      this.hoverTape(e);
      return false;
    }
    if (!press.live) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX) return true;
      press.live = true;
      const model = this.ctx.store.get().model;
      const found = model === null ? null : findEditable(model, press.drag.id);
      if (model === null || found === null) {
        this.cancel();
        return true;
      }
      this.begin(found.device, found.level, model, press.drag.kind);
    }
    const started = performance.now();
    this.step(press, e);
    const ms = performance.now() - started;
    this.stats.moves += 1;
    this.stats.totalMs += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    return true;
  }

  private step(press: Press, e: PointerLike): void {
    const store = this.ctx.store;
    const s = store.get();
    const model = s.model;
    const o = this.origin();
    const ray = this.ray(e);
    if (model === null || o === null || ray === null) return;
    const level = model.levels.find((l) => l.id === press.drag.level);
    if (level === undefined) return;
    const grid = snapGridOf(store);
    const settings = snapSettingsOf(store);
    const name = namer(store);
    const free = e.altKey || e.metaKey;
    const drag = press.drag;
    const metres = (p: Point, z: number): Vec3 => toMetres(p, z, o.origin, o.k);
    const len = (v: number) => prettyLen(v, store.units);

    if (drag.kind === 'rotate') {
      const d = level.devices.find((x) => x.id === drag.id);
      const at = onLevel(ray, drag.z);
      if (d === undefined || at === null) return;
      const turn = dragRotate(d, toPlan(at, o.origin, o.k), e.shiftKey);
      if (turn === null) return;
      const batch = turnBatch(d, turn.rotation);
      press.batch = batch.length === 0 ? null : batch;
      const deg = -Math.round(turn.rotation / 1_000_000);
      press.words = deg === 0 ? 'back as drawn' : `${String(Math.abs(deg))}° ${deg > 0 ? 'right' : 'left'}`;
      store.preview(press.batch);
      this.publish({ guides: [], tags: [] });
      return;
    }

    if (drag.kind === 'floor') {
      const d = level.devices.find((x) => x.id === drag.id);
      const at = onLevel(ray, drag.z);
      if (d === undefined || at === null) return;
      const now = toPlan(at, o.origin, o.k);
      const tol = this.tolAt(at);
      const r = dragDevice(level, d, [now[0] - drag.from[0], now[1] - drag.from[1]], { grid, tol, free, axis: e.shiftKey, settings, name });
      if (r.hover === null) {
        press.batch = null;
        store.preview(null);
        this.publish({ guides: [], tags: [], drag: this.view.drag === null ? null : { ...this.view.drag, guide: null } });
        return;
      }
      press.batch = moveDevice(d.id, r.hover.host);
      const before = d.placement?.point ?? r.hover.point;
      press.words = moveWords([r.hover.point[0] - before[0], r.hover.point[1] - before[1]], len);
      store.preview(press.batch);
      const z = d.bottom;
      const guides = (r.guide?.guides ?? []).map(([a, b]) => [metres(a, z), metres(b, z)] as [Vec3, Vec3]);
      const moving = this.movedFootprint(d, r.hover.point, before);
      this.publish({
        drag: this.view.drag === null ? null : { ...this.view.drag, guide: guideWords(r.guide?.label) },
        guides,
        tags: this.clearanceTags(level, d, moving, metres),
      });
      return;
    }

    if (drag.kind === 'face') {
      const d = level.devices.find((x) => x.id === drag.id);
      const wall = level.walls.find((w) => w.id === drag.wall);
      if (d === undefined || wall === undefined) return;
      const face = faceOf(wall, drag.side, o.origin, o.k);
      const at = onUpright(ray, face.p, face.n);
      if (at === null) return;
      const along = alongWall(wall, toPlan(at, o.origin, o.k)) - drag.along;
      const up = (at[2] - drag.z) * o.k;
      const length = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
      const t: Point = [(wall.b[0] - wall.a[0]) / (length || 1), (wall.b[1] - wall.a[1]) / (length || 1)];
      const tol = this.tolAt(at);
      let label: string | undefined;
      let lines: [Point, Point][] = [];
      const box = boundsOfIds(level, [d.id]);
      const snapAlong = box === null ? undefined : (offset: number): number => {
        const by = offset - drag.offset;
        const aligned = alignMove(level, box, [t[0] * by, t[1] * by], { tol, settings, excludeItems: new Set(withRiders(level, [d.id])), name });
        label = aligned.label;
        lines = aligned.guides;
        return drag.offset + aligned.d[0] * t[0] + aligned.d[1] * t[1];
      };
      const next = faceDrag({ offset: drag.offset, height: drag.height, length, along, up, grid, free, ...(snapAlong === undefined ? {} : { snapAlong }) });
      press.batch = moveDevice(d.id, { mode: 'wallFace', wall: wall.id, side: drag.side, at: next.offset, height: next.height });
      const da = next.offset - drag.offset;
      const dh = next.height - drag.height;
      press.words = [moveWords([t[0] * da, t[1] * da], len), dh === 0 ? '' : `${len(Math.abs(dh))} ${dh > 0 ? 'up' : 'down'}`].filter((w) => w !== '').join(', ');
      store.preview(press.batch);
      const z = d.bottom + dh;
      this.publish({
        drag: this.view.drag === null ? null : { ...this.view.drag, guide: guideWords(label) },
        guides: lines.map(([a, b]) => [metres(a, z), metres(b, z)] as [Vec3, Vec3]),
        tags: [],
      });
      return;
    }

    // An opening, along its wall.
    const opening = level.openings.find((x) => x.id === drag.id);
    const wall = level.walls.find((w) => w.id === drag.wall);
    if (opening === undefined || wall === undefined) return;
    const line = lineOf(wall, o.origin, o.k);
    const at = onUpright(ray, line.p, line.n);
    if (at === null) return;
    const now = toPlan(at, o.origin, o.k);
    const pointer: Point = [drag.centre[0] + now[0] - drag.from[0], drag.centre[1] + now[1] - drag.from[1]];
    const tol = this.tolAt([at[0], at[1], at[2]]);
    const slid = dragOpening(level, wall, opening, pointer, { grid: free ? 1 : grid, tol, free, settings, name });
    const length = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
    const offset = slid.centered ? Math.round((length - opening.width) / 2) : slid.offset;
    press.batch = offset === opening.offset && !slid.centered ? null : moveOpening(opening.id, slid.centered ? 'centered' : slid.offset);
    const t: Point = [(wall.b[0] - wall.a[0]) / (length || 1), (wall.b[1] - wall.a[1]) / (length || 1)];
    const by = offset - opening.offset;
    press.words = moveWords([t[0] * by, t[1] * by], len);
    // Drawn at once by sliding its parts; the house previewed with it there once the pointer rests.
    const meshed = this.ctx.meshed();
    const was = meshed === null ? undefined : findEditable(meshed.model, opening.id)?.opening;
    const live = new Map<string, Motion>();
    if (was !== undefined && wall.line.length <= 2) live.set(opening.id, slideMotion(wall, offset - was.offset, o.k));
    this.ctx.motion.setLive(live);
    if (this.rest !== null) clearTimeout(this.rest);
    const batch = press.batch;
    this.rest = setTimeout(() => {
      this.rest = null;
      if (this.press === press) store.preview(batch);
    }, OPENING_REST_MS);
    const z = level.elevation;
    this.publish({
      drag: this.view.drag === null ? null : { ...this.view.drag, guide: guideWords(slid.guide?.label) },
      guides: (slid.guide?.guides ?? []).map(([a, b]) => [metres(a, z), metres(b, z)] as [Vec3, Vec3]),
      tags: this.openingTags(wall, opening, offset, metres, len),
    });
  }

  /** The item's footprint where the drag has it: moved rigidly from where it stood (its turn kept). */
  private movedFootprint(d: DeviceView, to: Point, from: Point): Point[] {
    return d.footprint.map((p) => [p[0] + to[0] - from[0], p[1] + to[1] - from[1]] as Point);
  }

  /**
   * The clearance tags (FLR-T-18.14's halos, as tags): the gap from the item to the nearest wall, and
   * — when one of its clearances is tight or runs into something — that, to what, and what it needs.
   */
  private clearanceTags(level: LevelView, d: DeviceView, footprint: Point[], metres: (p: Point, z: number) => Vec3): EditView['tags'] {
    const store = this.ctx.store;
    const len = (v: number) => prettyLen(Math.round(v), store.units);
    const tags: EditView['tags'] = [];
    if (footprint.length < 3) return tags;
    const z = d.bottom;
    let best: { d: number; from: Point; to: Point } | null = null;
    for (const w of level.walls) {
      if (w.ring.length < 3) continue;
      const n = nearest(footprint, w.ring);
      if (best === null || n.d < best.d) best = n;
    }
    if (best !== null && best.d > 0 && Number.isFinite(best.d)) tags.push({ from: metres(best.from, z), to: metres(best.to, z), text: `${len(best.d)} to wall`, tone: 'info' });
    const s = store.get();
    const preview = s.preview?.model;
    const model = s.model;
    if (preview !== null && preview !== undefined && model !== null) {
      const index = indexOf(model, level.id);
      if (index !== null) {
        const moving = movingFrom(preview, level.id, [d.id]);
        const head = headline(haloFrame(index, moving), new Set(moving.map((m) => m.id)));
        if (head?.against !== undefined) {
          const what = head.against.kind === 'wall' ? 'a wall' : labelOf(model, head.against.id);
          const text = head.tone === 'conflict' ? `${purposeLabel(head.purpose, false)} runs into ${what}` : `${purposeLabel(head.purpose, false)} tight: ${len(head.against.clear)} to ${what}, needs ${len(head.against.needs)}`;
          tags.push({ from: metres(head.against.from, z), to: metres(head.against.to, z), text, tone: head.tone === 'conflict' ? 'danger' : 'warning' });
        }
      }
    }
    return tags;
  }

  /** An opening's tags: how far it stands from each end of its wall. */
  private openingTags(wall: WallView, opening: OpeningView, offset: number, metres: (p: Point, z: number) => Vec3, len: (v: number) => string): EditView['tags'] {
    const length = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
    const t: Point = [(wall.b[0] - wall.a[0]) / (length || 1), (wall.b[1] - wall.a[1]) / (length || 1)];
    const at = (v: number): Point => [wall.a[0] + t[0] * v, wall.a[1] + t[1] * v];
    const level = this.ctx.store.get().model?.levels.find((l) => l.walls.includes(wall));
    const z = (level?.elevation ?? 0) + 1_280_000;
    const after = length - offset - opening.width;
    return [
      { from: metres(at(0), z), to: metres(at(offset), z), text: len(Math.round(offset)), tone: 'info' },
      { from: metres(at(offset + opening.width), z), to: metres(at(length), z), text: len(Math.round(after)), tone: 'info' },
    ];
  }

  /** The press let go: a drag drops as one op; a click has selected what it was on. */
  up(): boolean {
    const press = this.press;
    if (press === null) return false;
    this.press = null;
    if (this.rest !== null) {
      clearTimeout(this.rest);
      this.rest = null;
    }
    if (!press.live) return true;
    void this.drop(press);
    return true;
  }

  private async drop(press: Press): Promise<void> {
    const store = this.ctx.store;
    const model = store.get().model;
    const batch = press.batch;
    const id = press.drag.id;
    const name = model === null ? id : labelOf(model, id);
    this.publish({ drag: null, ghost: null, guides: [], tags: [] });
    if (batch === null || batch.length === 0 || press.words === '') {
      store.preview(null);
      this.ctx.motion.setLive(new Map());
      return;
    }
    const turning = press.drag.kind === 'rotate';
    // The preview stays until the op is in, so the item never flickers back to where it was.
    const ok = await store.apply(`${turning ? 'Turn' : 'Move'} ${name}`, batch, { select: () => id });
    store.preview(null);
    this.ctx.motion.setLive(new Map());
    if (ok) this.onDropped?.(`${turning ? 'Turned' : 'Moved'} ${name} ${press.words} · one op`);
  }

  /** Esc: the drag is dropped where it began; nothing is sent. */
  cancel(): boolean {
    const press = this.press;
    this.press = null;
    if (this.rest !== null) {
      clearTimeout(this.rest);
      this.rest = null;
    }
    if (press === null) return false;
    this.ctx.store.preview(null);
    this.ctx.motion.setLive(new Map());
    this.publish({ drag: null, ghost: null, guides: [], tags: [] });
    return true;
  }

  // ─── The tape measure ────────────────────────────────────────────────────────────────────

  /** Where a click at a point of the canvas would put the tape's point: snapped to a corner, an edge or the face. */
  tapeAt(x: number, y: number): TapePoint | null {
    const hit = this.ctx.pick(x, y, true);
    if (hit === null) return null;
    if (hit.tri === null) return { at: hit.point, kind: 'face' };
    const corner = (w: Vec3) => {
      const s = this.ctx.rig.project(w);
      return { world: w, screen: [s.x, s.y] as const };
    };
    return snapOnTriangle(hit.point, [x, y], [corner(hit.tri[0]), corner(hit.tri[1]), corner(hit.tri[2])]);
  }

  private hoverTape(e: PointerLike): void {
    if (this.ctx.three.get().edit !== 'tape') {
      if (this.view.hover !== null) this.publish({ hover: null });
      return;
    }
    if (this.hoverFrame !== 0) return;
    const [x, y] = this.local(e);
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      this.publish({ hover: this.tapeAt(x, y) });
    });
  }

  /** A click with the tape: a point, chained on from the last. */
  tapeClick(e: PointerLike): boolean {
    const three = this.ctx.three;
    if (three.get().edit !== 'tape') return false;
    const [x, y] = this.local(e);
    const p = this.tapeAt(x, y);
    if (p === null) return true;
    three.set({ tape: [...three.get().tape, p] });
    return true;
  }

  /** Esc with the tape: what it measured goes; true when there was something. */
  clearTape(): boolean {
    const three = this.ctx.three;
    if (three.get().tape.length === 0) return false;
    three.set({ tape: [] });
    return true;
  }

  dispose(): void {
    this.cancel();
    if (this.hoverFrame !== 0) cancelAnimationFrame(this.hoverFrame);
    this.listeners.clear();
  }
}

/** Whether an element is one Edit moves: an item (on a host it can be dragged on) or an opening. */
export function isEditable(model: EditorModel, id: string): boolean {
  const f = findEditable(model, id);
  if (f === null) return false;
  if (f.opening !== undefined) return true;
  const h = f.device?.host;
  return isObj(h) && (h['mode'] === 'surface' || h['mode'] === 'free' || h['mode'] === 'wallFace');
}
