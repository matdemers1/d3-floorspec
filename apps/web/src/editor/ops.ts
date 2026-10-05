import type { FixOp, FloorspecDocument } from '@floorspec/engine';
import type { Operation } from '@floorspec/ops';
import type { Point } from './model';
import { signedArea } from './geometry';
import { UNITS_PATH, type UnitSystem } from './units';

/**
 * Op builders (FLR-ADR-008): every gesture in the editor ends as a batch of Floorspec Ops, built
 * here, sent to the server, and judged there. These functions only build JSON — they never touch a
 * document — so they are pure and tested on their own.
 *
 * A builder that has to name an element it creates (a type the same batch then refers to) takes an
 * `attempt` number: the store calls it again with the next attempt when the server refuses an ID
 * as used or retired (FS-OPS-005), since retired IDs are the store's to know, not the editor's.
 */

export type Batch = Operation[];
export type BatchBuilder = (attempt: number) => Batch;

type Json = Record<string, unknown>;

// ─── Starter library ─────────────────────────────────────────────────────────────────────────

/**
 * The types a new project can draw with before it has any (Core 8.1: "published as a
 * non-normative starter library"). A type is added to the document in the same batch as the first
 * element that uses it, so the model never holds a type nothing refers to (FS-LINT-006).
 * Dimensions are those of the conformance suite's three-room house.
 */
export interface StarterType {
  id: string;
  kind: 'wallType' | 'doorType' | 'windowType';
  element: Json;
}

export const STARTER_TYPES: readonly StarterType[] = [
  {
    id: 'EXT26',
    kind: 'wallType',
    element: {
      kind: 'wallType',
      name: '2x6 exterior wall',
      layers: [
        { thickness: 24384, function: 'finish' },
        { thickness: 14224, function: 'substrate' },
        { thickness: 178816, function: 'core' },
        { thickness: 16256, function: 'finish' },
      ],
    },
  },
  {
    id: 'INT24',
    kind: 'wallType',
    element: {
      kind: 'wallType',
      name: '2x4 partition',
      layers: [
        { thickness: 16256, function: 'finish' },
        { thickness: 113792, function: 'core' },
        { thickness: 16256, function: 'finish' },
      ],
    },
  },
  { id: 'D36', kind: 'doorType', element: { kind: 'doorType', name: '36 in entry door', width: 1170432, height: 2600960 } },
  { id: 'D32', kind: 'doorType', element: { kind: 'doorType', name: '32 in interior door', width: 1040384, height: 2600960 } },
  { id: 'W3636', kind: 'windowType', element: { kind: 'windowType', name: '36 x 36 in window', width: 1170432, height: 1170432, sill: 1365504 } },
  { id: 'W4848', kind: 'windowType', element: { kind: 'windowType', name: '48 x 48 in window', width: 1560576, height: 1560576, sill: 1170432 } },
];

/** A type choice in a picker: one the document has, or a starter it would gain. */
export interface TypeChoice {
  id: string;
  kind: 'wallType' | 'doorType' | 'windowType';
  name: string;
  starter: boolean;
  element: Json;
}

/** The document's types of a kind, then the starters it does not have yet (matched by name). */
export function typeChoices(document: FloorspecDocument, kind: TypeChoice['kind']): TypeChoice[] {
  const own = Object.entries((document.types ?? {}) as Record<string, Json | undefined>)
    .filter((e): e is [string, Json] => e[1]?.['kind'] === kind)
    .map(([id, t]) => ({ id, kind, name: typeof t['name'] === 'string' ? t['name'] : id, starter: false, element: t }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set(own.map((t) => t.name));
  const starters = STARTER_TYPES.filter((s) => s.kind === kind && !names.has(String(s.element['name']))).map((s) => ({
    id: s.id,
    kind,
    name: String(s.element['name']),
    starter: true,
    element: s.element,
  }));
  return [...own, ...starters];
}

/** An ID for an element this batch adds and names itself: the starter's own, then -2, -3… */
export function namedId(document: FloorspecDocument, base: string, attempt: number): string {
  const used = new Set<string>();
  for (const c of Object.values(document as unknown as Json)) if (c !== null && typeof c === 'object') for (const k of Object.keys(c)) used.add(k);
  let n = attempt;
  for (;;) {
    const id = n === 0 ? base : `${base}-${String(n + 1)}`;
    if (!used.has(id)) return id;
    n += 1;
  }
}

/**
 * Resolve a type choice to the ID a batch should use, and the op that adds it when it is a
 * starter the document does not have yet.
 */
export function useType(document: FloorspecDocument, choice: TypeChoice | undefined, attempt: number): { id: string | undefined; ops: Batch } {
  if (choice === undefined) return { id: undefined, ops: [] };
  if (!choice.starter) return { id: choice.id, ops: [] };
  const id = namedId(document, choice.id, attempt);
  return { id, ops: [{ op: 'addElement', collection: 'types', id, element: { ...choice.element } }] };
}

// ─── Levels ──────────────────────────────────────────────────────────────────────────────────

/** 9'-1⅛" floor to floor, the conformance house's: a common stud wall plus a floor. */
export const DEFAULT_LEVEL_HEIGHT = 3_511_296;

/**
 * Add a level. With no building yet, the batch adds one first under a name it picks, so the level
 * can refer to it in the same transaction.
 */
export function addLevel(document: FloorspecDocument, o: { name: string; elevation: number; height: number; building?: string | undefined }): BatchBuilder {
  return (attempt) => {
    const buildings = Object.keys(document.buildings ?? {});
    const existing = o.building ?? buildings[0];
    if (existing !== undefined) {
      return [{ op: 'addElement', collection: 'levels', element: { building: existing, elevation: o.elevation, height: o.height, name: o.name } }];
    }
    const building = namedId(document, 'B1', attempt);
    return [
      { op: 'addElement', collection: 'buildings', id: building, element: { name: 'House' } },
      { op: 'addElement', collection: 'levels', element: { building, elevation: o.elevation, height: o.height, name: o.name } },
    ];
  };
}

// ─── Drawing ─────────────────────────────────────────────────────────────────────────────────

export interface ChainVertex {
  point: Point;
  /** The existing junction the vertex snapped to, sent by ID so the log reads naturally. */
  junction?: string | undefined;
}

/** Whether a chain ends where it starts. */
export function isClosed(chain: readonly ChainVertex[]): boolean {
  if (chain.length < 4) return false;
  const a = chain[0] as ChainVertex;
  const b = chain[chain.length - 1] as ChainVertex;
  return a.point[0] === b.point[0] && a.point[1] === b.point[1];
}

/**
 * The drawWall (or drawSeparator) composites for a chain of clicks, in one batch (Ops 4.1). A
 * closed loop drawn counter-clockwise is reversed first: Core 5.4 puts a wall's exterior on its
 * left, so an enclosure drawn clockwise has its exterior layers outside.
 */
export function drawChain(
  document: FloorspecDocument,
  level: string,
  chain: readonly ChainVertex[],
  o: { kind: 'wall' | 'separator'; type?: TypeChoice | undefined; justification?: string | undefined },
): BatchBuilder {
  return (attempt) => {
    let vertices = chain.filter((v, i) => i === 0 || v.point[0] !== chain[i - 1]?.point[0] || v.point[1] !== chain[i - 1]?.point[1]);
    if (o.kind === 'wall' && isClosed(vertices) && signedArea(vertices.slice(0, -1).map((v) => v.point)) > 0) vertices = [...vertices].reverse();
    const type = o.kind === 'wall' ? useType(document, o.type, attempt) : { id: undefined, ops: [] };
    const ref = (v: ChainVertex): string | [number, number] => v.junction ?? [v.point[0], v.point[1]];
    const ops: Batch = [...type.ops];
    for (let i = 1; i < vertices.length; i++) {
      const from = ref(vertices[i - 1] as ChainVertex);
      const to = ref(vertices[i] as ChainVertex);
      if (o.kind === 'separator') {
        ops.push({ op: 'drawSeparator', level, from, to });
      } else {
        ops.push({
          op: 'drawWall',
          level,
          from,
          to,
          ...(type.id === undefined ? {} : { type: type.id }),
          ...(o.justification === undefined || o.justification === 'center' ? {} : { justification: o.justification as 'exteriorFace' }),
        });
      }
    }
    return ops;
  };
}

// ─── Slabs ───────────────────────────────────────────────────────────────────────────────────

/**
 * A slab (Core 6.7): its outline as drawn, on the level, with a thickness, its top above the level
 * (omitted at 0, its default) and — in a Floorspec 0.3 plan only — its purpose.
 */
export function addSlab(document: FloorspecDocument, level: string, outline: readonly Point[], o: { thickness: number; offset: number; purpose: string | null }): Batch {
  const v03 = document.floorspec !== '0.1' && document.floorspec !== '0.2';
  return [
    {
      op: 'addElement',
      collection: 'slabs',
      element: {
        level,
        boundary: outline.map((p) => [p[0], p[1]]),
        thickness: o.thickness,
        ...(o.offset === 0 ? {} : { offset: o.offset }),
        ...(v03 && o.purpose !== null ? { purpose: o.purpose } : {}),
      },
    },
  ];
}

// ─── Openings and rooms ──────────────────────────────────────────────────────────────────────

export function addOpening(
  document: FloorspecDocument,
  o: { wall: string; at: number | string; fill?: TypeChoice | undefined; width?: number; height?: number; hinge?: 'start' | 'end'; swing?: 'left' | 'right' },
): BatchBuilder {
  return (attempt) => {
    const fill = useType(document, o.fill, attempt);
    const door = o.fill?.kind === 'doorType';
    return [
      ...fill.ops,
      {
        op: 'addOpening',
        wall: o.wall,
        at: o.at,
        ...(fill.id === undefined ? {} : { fill: fill.id }),
        ...(o.width === undefined ? {} : { width: o.width }),
        ...(o.height === undefined ? {} : { height: o.height }),
        ...(door && o.hinge === 'end' ? { hinge: 'end' as const } : {}),
        ...(door && o.swing === 'left' ? { swing: 'left' as const } : {}),
      },
    ];
  };
}

export function addRoom(o: { level: string; at: Point; name?: string; function?: string }): Batch {
  return [
    {
      op: 'addRoom',
      level: o.level,
      at: [o.at[0], o.at[1]],
      ...(o.name === undefined || o.name === '' ? {} : { name: o.name }),
      ...(o.function === undefined || o.function === 'unspecified' ? {} : { function: o.function }),
    },
  ];
}

/** The next "Room N" name not yet used on the document. */
export function nextRoomName(document: FloorspecDocument): string {
  const names = new Set(Object.values((document.rooms ?? {}) as Record<string, Json | undefined>).map((r) => r?.['name']));
  for (let n = 1; ; n++) if (!names.has(`Room ${String(n)}`)) return `Room ${String(n)}`;
}

// ─── Edits ───────────────────────────────────────────────────────────────────────────────────

export const moveJunction = (id: string, to: Point): Batch => [{ op: 'moveJunction', id, to: [to[0], to[1]] }];

/** Move a wall sideways; positive is towards its left (exterior) side (Ops 4.2). */
export const moveWall = (wall: string, by: number | string): Batch => [{ op: 'moveWall', wall, by }];

export const moveOpening = (opening: string, at: number | string): Batch => [{ op: 'moveOpening', opening, at }];

export function setProperty(id: string, path: string, value: unknown): Batch {
  return [{ op: 'setProperty', id, path, value }];
}

export function unsetProperty(id: string, path: string): Batch {
  return [{ op: 'unsetProperty', id, path }];
}

/** Set a member when it has a value, unset it when the value is its default or empty. */
export function setOrUnset(id: string, path: string, value: unknown, present: boolean): Batch {
  if (value === undefined || value === null || value === '') return present ? unsetProperty(id, path) : [];
  return setProperty(id, path, value);
}

export function setRoomFinish(room: string, surface: 'wall' | 'floor' | 'ceiling', material: string | null, present: boolean): Batch {
  if (material === null) return present ? unsetProperty(room, `/${surface}Finish`) : [];
  return [{ op: 'setRoomFinish', room, surface, material }];
}

/** The per-project display units, held in the document's extras (Core 1.7). */
export const setUnits = (system: UnitSystem): Batch => setProperty('$document', UNITS_PATH, system);

export type RemoveKind = 'wall' | 'separator' | 'junction' | 'opening' | 'room' | 'level' | 'building' | 'type' | 'material' | 'other';

/**
 * Remove an element. A wall goes with removeWall, which takes its openings and — when it divides
 * two rooms — must be told which room survives (Ops 4.7). A junction or a level takes what stands
 * on it (cascade, Ops 2.2); anything else is a plain removeElement.
 */
export function removeOps(id: string, kind: RemoveKind, keep?: string): Batch {
  switch (kind) {
    case 'wall':
      return [{ op: 'removeWall', wall: id, ...(keep === undefined ? {} : { keep }) }];
    case 'junction':
    case 'level':
    case 'building':
    case 'separator':
      return [{ op: 'removeElement', id, ...(kind === 'separator' ? {} : { cascade: true }) }];
    default:
      return [{ op: 'removeElement', id }];
  }
}

// ─── Diagnostics' fixes ──────────────────────────────────────────────────────────────────────

/**
 * A Core diagnostic's fix (Core 10.5: `remove` / `set` / `unset`, a provisional subset of Ops) as
 * Ops primitives.
 */
export function fixToOps(fix: readonly FixOp[]): Batch {
  return fix.map((f): Operation => {
    switch (f.op) {
      case 'remove':
        return { op: 'removeElement', id: f.id };
      case 'set':
        return { op: 'setProperty', id: f.id, path: f.member, value: f.value };
      case 'unset':
        return { op: 'unsetProperty', id: f.id, path: f.member };
    }
  });
}

/** Describe a fix in a few words for its button: "Remove J7", "Set offset of O3". */
export function describeFix(fix: readonly FixOp[], name: (id: string) => string): string {
  if (fix.length === 0) return 'Apply fix';
  const first = fix[0] as FixOp;
  const what = first.op === 'remove' ? `Remove ${name(first.id)}` : first.op === 'set' ? `Set ${first.member.replace(/^\//, '')} of ${name(first.id)}` : `Reset ${first.member.replace(/^\//, '')} of ${name(first.id)}`;
  return fix.length === 1 ? what : `${what} and ${String(fix.length - 1)} more`;
}
