/**
 * The electrical layout assistant (FLR-T-5.8, FLR-REQ-090): for each room of a plan — or of a
 * level, or the rooms asked for — receptacles along its wall runs, GFCI at the device where the
 * room's function calls for it, a switch beside its entry on the latch side, a ceiling light, and
 * circuits that group them on a panel, AFCI at the breaker for habitable rooms. Everything comes
 * back as one Floorspec Ops 0.2 batch for a person to review as a changeset (FLR-ADR-016); nothing
 * is written here.
 *
 * Non-normative and advisory: the heuristics are Floorspec's own defaults (defaults.ts), stated as
 * such, and the proposal never claims a design meets a code (FLR-ADR-011). Deterministic: integer
 * arithmetic, IDs and rooms in order, no clock and no randomness.
 */
import type { FloorspecDocument } from '@floorspec/engine';
import { formatLength, type Operation } from '@floorspec/ops';
import { migrationBatch } from '@floorspec/migrate';
import { withDefaults, type ElectricalDefaults } from './defaults.js';
import { readPlan, usedIds, type RoomPlan, type WallRun } from './plan.js';

type Json = Record<string, unknown>;

export interface ElectricalOptions {
  /** Only the rooms on this level. */
  level?: string;
  /** Only these rooms (IDs). */
  rooms?: readonly string[];
  /** Overrides of Floorspec's defaults (defaults.ts). */
  defaults?: Partial<ElectricalDefaults>;
  /** IDs once used in the plan's history, never minted again (Ops 1.5). */
  retired?: readonly string[];
  /**
   * Which parts to propose; all of them by default. `panel`: when the plan has none and circuits are
   * proposed, place one (FLR-T-12.18) rather than leave the loads unfed.
   */
  include?: { [K in 'receptacles' | 'switches' | 'lights' | 'circuits' | 'panel']?: boolean | undefined };
}

/** A stretch of wall run longer than the spacing allows, before the proposal. */
export interface Gap {
  room: string;
  wall: string;
  side: 'left' | 'right';
  /** Offsets along the wall's location line. */
  from: number;
  to: number;
  length: number;
  /** Between two receptacles, or from a run's end to its nearest receptacle, or a run with none. */
  kind: 'between' | 'end' | 'none';
}

export interface ProposedCircuit {
  id: string;
  name: string;
  panel: string;
  breaker: number;
  loads: string[];
  protection: ('afci' | 'gfci')[];
  /** The load the grouping counted, from the defaults' per-device estimates. */
  estimatedLoad: number;
}

export interface ElectricalProposal {
  /** The batch, ready for a changeset; empty when there is nothing to propose. */
  batch: Operation[];
  /** A name for the changeset. */
  name: string;
  /** What it proposes and why, in sentences a person reads before accepting. */
  explanation: string[];
  added: { receptacles: string[]; switches: string[]; lights: string[]; panels: string[] };
  circuits: ProposedCircuit[];
  /** Receptacles already in the plan that it gives GFCI at the device. */
  upgraded: string[];
  /** The plan's spacing gaps before the proposal. */
  gaps: Gap[];
  /** The rooms considered, by ID. */
  rooms: string[];
  /** Why something was not proposed: no panel, a room with no entry. */
  notes: string[];
  defaults: ElectricalDefaults;
}

const PLATE = { min: [0, -51_200, -76_800], max: [32_000, 51_200, 76_800] };
const LIGHT_BOX = { min: [-128_000, -128_000, -192_000], max: [128_000, 128_000, 0] };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The spacing that applies in a room. */
const spacingOf = (room: RoomPlan, d: ElectricalDefaults) => d.spacingByFunction[room.function] ?? d.receptacleSpacing;

/** A run's gaps: where its receptacles leave more than the spacing allows. */
export function runGaps(run: WallRun, existing: readonly number[], spacing: number): Gap[] {
  const half = spacing / 2;
  const at = existing.filter((p) => p >= run.from && p <= run.to).sort((a, b) => a - b);
  const base = { room: run.room, wall: run.wall, side: run.side };
  if (at.length === 0) return [{ ...base, from: run.from, to: run.to, length: run.to - run.from, kind: 'none' }];
  const out: Gap[] = [];
  const first = at[0]!;
  const last = at[at.length - 1]!;
  if (first - run.from > half) out.push({ ...base, from: run.from, to: first, length: first - run.from, kind: 'end' });
  for (let i = 1; i < at.length; i++) if (at[i]! - at[i - 1]! > spacing) out.push({ ...base, from: at[i - 1]!, to: at[i]!, length: at[i]! - at[i - 1]!, kind: 'between' });
  if (run.to - last > half) out.push({ ...base, from: last, to: run.to, length: run.to - last, kind: 'end' });
  return out;
}

/**
 * Where new receptacles go on a run so that every point of it is within half the spacing of one:
 * greedily, each as far along as it may be, on the grid, kept the end clearance from corners and doors.
 */
export function fillRun(run: WallRun, existing: readonly number[], spacing: number, d: ElectricalDefaults): number[] {
  const half = Math.floor(spacing / 2);
  const lo = run.from + d.endClearance;
  const hi = run.to - d.endClearance;
  if (hi < lo) return [];
  const have = existing.filter((p) => p >= run.from && p <= run.to).sort((a, b) => a - b);
  const placed: number[] = [];
  let cur = run.from;
  let guard = 0;
  while (cur <= run.to && guard++ < 10_000) {
    const covering = [...have, ...placed].filter((p) => p - half <= cur && p + half >= cur);
    if (covering.length > 0) {
      cur = Math.max(...covering) + half + 1;
      continue;
    }
    let q = Math.min(cur + half, hi);
    q = Math.max(lo, Math.floor(q / d.grid) * d.grid);
    if (q > hi) q = hi;
    if (q + half < cur) break;
    placed.push(q);
    cur = q + half + 1;
  }
  return placed;
}

/** The plan's spacing gaps for the rooms asked about: what the editor's card and markers show. */
export function analyseGaps(document: string | Uint8Array | FloorspecDocument | object, options: Pick<ElectricalOptions, 'level' | 'rooms' | 'defaults'> = {}): Gap[] {
  const d = withDefaults(options.defaults);
  const plan = readPlan(document, { level: options.level, rooms: options.rooms, grid: d.grid });
  return plan.rooms.flatMap((room) =>
    d.noReceptacleFunctions.includes(room.function)
      ? []
      : room.runs.filter((r) => r.to - r.from >= d.minRun).flatMap((run) => runGaps(run, plan.receptaclesOn(run.wall, run.side).map((x) => x.offset), spacingOf(room, d))),
  );
}

/** A length for a sentence, in the plan's display units (Core 1.7 extras, as the editor keeps them). */
function lengthText(document: FloorspecDocument, v: number): string {
  const units = ((document.extras as Json | undefined)?.['d3floorspec'] as Json | undefined)?.['units'];
  return units === 'metric' ? formatLength(v, { system: 'metric' }) : formatLength(v, { denominator: 2 });
}

const list = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1] ?? ''}`);

/** Propose an electrical layout: one batch, with what it adds and why. */
export function proposeElectrical(document: string | Uint8Array | FloorspecDocument | object, options: ElectricalOptions = {}): ElectricalProposal {
  const d = withDefaults(options.defaults);
  const include = {
    receptacles: options.include?.receptacles ?? true,
    switches: options.include?.switches ?? true,
    lights: options.include?.lights ?? true,
    circuits: options.include?.circuits ?? true,
    panel: options.include?.panel ?? true,
  };
  const plan = readPlan(document, { level: options.level, rooms: options.rooms, grid: d.grid });
  const doc = plan.document;
  const electrical = (doc.extensions as Json | undefined)?.['FS_electrical'];
  const collections = (isObject(electrical) && isObject(electrical['collections']) ? electrical['collections'] : {}) as Record<string, Record<string, Json> | undefined>;
  const existingCircuits = (isObject(electrical) && isObject(electrical['circuits']) ? electrical['circuits'] : {}) as Record<string, Json>;

  // IDs: X for elements and C for circuits, the next ones nothing uses or once used.
  const taken = new Set([...usedIds(doc), ...(options.retired ?? [])]);
  const mint = (prefix: string): string => {
    for (let n = 1; ; n++) {
      const id = `${prefix}${String(n)}`;
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
  };

  const batch: Operation[] = [];
  const placements: Operation[] = [];
  const edits: Operation[] = [];
  const added = { receptacles: [] as string[], switches: [] as string[], lights: [] as string[], panels: [] as string[] };
  const upgraded: string[] = [];
  const notes: string[] = [];
  const gaps: Gap[] = [];
  const roomOf = new Map<string, RoomPlan>();
  const receptacleRoom = new Map<string, string>();
  const lightRoom = new Map<string, string>();

  for (const room of plan.rooms) {
    const spacing = spacingOf(room, d);
    const gfci = d.gfciFunctions.includes(room.function);
    const inRoom = (collection: string) => room.devices.filter((id) => Object.hasOwn(collections[collection] ?? {}, id)).sort(cmp);

    // Receptacles along each run.
    if (include.receptacles && !d.noReceptacleFunctions.includes(room.function)) {
      for (const run of room.runs) {
        if (run.to - run.from < d.minRun) continue;
        const existing = plan.receptaclesOn(run.wall, run.side).map((x) => x.offset);
        gaps.push(...runGaps(run, existing, spacing));
        for (const at of fillRun(run, existing, spacing, d)) {
          const id = mint('X');
          added.receptacles.push(id);
          receptacleRoom.set(id, room.id);
          placements.push({
            op: 'placeElement',
            extension: 'FS_electrical',
            collection: 'receptacles',
            id,
            host: { mode: 'wallFace', wall: run.wall, side: run.side, at, height: d.heightByFunction[room.function] ?? d.receptacleHeight },
            element: { fallback: { box: structuredClone(PLATE) }, ...(gfci ? { features: ['gfci'] } : {}) },
          } as unknown as Operation);
        }
      }
      // Receptacles already here, given GFCI at the device where the room calls for it.
      if (gfci)
        for (const id of inRoom('receptacles')) {
          const features = collections['receptacles']?.[id]?.['features'];
          const list = Array.isArray(features) ? (features as string[]) : [];
          if (list.includes('gfci')) continue;
          upgraded.push(id);
          edits.push({ op: 'setProperty', id, path: '/features', value: [...list, 'gfci'] });
        }
      for (const id of inRoom('receptacles')) receptacleRoom.set(id, room.id);
    }

    // A ceiling light, where the room has none.
    const lights = inRoom('lights');
    if (include.lights && lights.length === 0 && !d.noLightFunctions.includes(room.function)) {
      if (room.centre === null) notes.push(`${room.name} is too thin to place a light in.`);
      else {
        const id = mint('X');
        added.lights.push(id);
        lights.push(id);
        placements.push({
          op: 'placeElement',
          extension: 'FS_electrical',
          collection: 'lights',
          id,
          host: { mode: 'surface', room: room.id, surface: 'ceiling', at: [room.centre[0], room.centre[1]] },
          element: { fallback: { box: structuredClone(LIGHT_BOX) }, fixture: 'ceiling' },
        } as unknown as Operation);
      }
    }
    for (const id of lights) lightRoom.set(id, room.id);

    // A switch beside the entry, on the latch side, controlling the room's lights not yet switched.
    if (include.switches && lights.length > 0) {
      const switched = new Set(Object.values(collections['switches'] ?? {}).flatMap((s) => (Array.isArray(s['controls']) ? (s['controls'] as string[]) : [])));
      const unswitched = lights.filter((l) => !switched.has(l));
      const own = inRoom('switches');
      if (unswitched.length > 0 && own.length > 0) {
        const sid = own[0]!;
        const controls = collections['switches']?.[sid]?.['controls'];
        edits.push({ op: 'setProperty', id: sid, path: '/controls', value: [...(Array.isArray(controls) ? (controls as string[]) : []), ...unswitched] });
      } else if (unswitched.length > 0) {
        const at = switchAt(room, d);
        if (at === null) notes.push(`${room.name} has no entry with wall beside it for a switch: its light is left for you to switch.`);
        else {
          const id = mint('X');
          added.switches.push(id);
          placements.push({
            op: 'placeElement',
            extension: 'FS_electrical',
            collection: 'switches',
            id,
            host: { mode: 'wallFace', wall: at.wall, side: at.side, at: at.offset, height: d.switchHeight },
            element: { fallback: { box: structuredClone(PLATE) }, controls: unswitched },
          } as unknown as Operation);
        }
      }
    }
    roomOf.set(room.id, room);
  }

  // Circuits on a panel: the loads proposed, and those already here that no circuit feeds.
  const circuits: ProposedCircuit[] = [];
  if (include.circuits) {
    const fed = new Set(Object.values(existingCircuits).flatMap((c) => (Array.isArray(c['loads']) ? (c['loads'] as string[]) : [])));
    const panels = Object.entries(collections['panels'] ?? {}).sort(([a], [b]) => cmp(a, b));
    const onLevel = panels.filter(([, p]) => options.level === undefined || (p['fallback'] as Json | undefined)?.['level'] === options.level);
    let panel: [string, Json] | undefined = onLevel[0] ?? panels[0];
    // A load is on a circuit of its own voltage (FS_electrical 3.2.4): a 240 V receptacle is left for you.
    const at = (collection: string, id: string) => {
      const v = collections[collection]?.[id]?.['volts'];
      return typeof v === 'number' ? v : 120;
    };
    const receptacles = [...receptacleRoom.entries()].filter(([id]) => !fed.has(id) && at('receptacles', id) === d.volts);
    const lighting = [...lightRoom.entries()].filter(([id]) => !fed.has(id) && at('lights', id) === d.volts);
    if (panel === undefined && include.panel && receptacles.length + lighting.length > 0) {
      const spot = panelAt(plan.rooms, doc, d);
      if (spot !== null) {
        const id = mint('X');
        const element: Json = { fallback: { box: structuredClone(PANEL_BOX) }, volts: [d.volts, 2 * d.volts], rating: d.panelRating, spaces: d.panelSpaces };
        added.panels.push(id);
        placements.push({
          op: 'placeElement',
          extension: 'FS_electrical',
          collection: 'panels',
          id,
          host: { mode: 'wallFace', wall: spot.wall, side: spot.side, at: spot.offset, height: d.panelHeight },
          element,
        } as unknown as Operation);
        notes.push(
          `There was no panel, so it places a ${String(d.panelRating)} A, ${String(d.panelSpaces)}-space panel (${id}) in ${spot.room}, on wall ${spot.wall}: move it to where the service enters.`,
        );
        panel = [id, element];
      }
    }
    if (panel === undefined) {
      if (receptacles.length + lighting.length > 0)
        notes.push(
          include.panel
            ? 'There is no panel and no wall in these rooms to put one on, so no circuits are proposed: place one and ask again.'
            : 'There is no panel, so no circuits are proposed: place one and ask again.',
        );
    } else if (!(Array.isArray(panel[1]['volts']) && (panel[1]['volts'] as number[]).includes(d.volts))) {
      notes.push(`Panel ${panel[0]} does not supply ${String(d.volts)} V, so no circuits are proposed on it.`);
    } else {
      const spaces = Number(panel[1]['spaces'] ?? 0);
      const usedSpaces = new Set<number>();
      for (const c of Object.values(existingCircuits)) {
        if (c['panel'] !== panel[0] || typeof c['space'] !== 'number') continue;
        for (let s = c['space']; s < c['space'] + (typeof c['poles'] === 'number' ? c['poles'] : 1); s++) usedSpaces.add(s);
      }
      const nextSpace = (): number | undefined => {
        for (let s = 1; s <= spaces; s++) if (!usedSpaces.has(s)) {
          usedSpaces.add(s);
          return s;
        }
        return undefined;
      };
      const afci = (rooms: readonly string[]) => rooms.some((r) => d.afciFunctions.includes(roomOf.get(r)?.function ?? ''));
      const capacity = (breaker: number) => Math.floor(breaker * d.volts * d.loadFraction);
      const make = (kind: string, loads: string[], breaker: number, rooms: string[], estimate: number) => {
        const unique = [...new Set(rooms)].map((r) => roomOf.get(r)?.name ?? r);
        circuits.push({
          id: mint('C'),
          name: `${list(unique)} ${kind}`.slice(0, 200),
          panel: panel[0],
          breaker,
          loads,
          protection: afci(rooms) ? ['afci'] : [],
          estimatedLoad: estimate,
        });
      };
      // Pack loads, in order, into circuits by the load and device-count limits.
      const pack = (kind: string, items: [string, string][], breaker: number, watts: number) => {
        let loads: string[] = [];
        let rooms: string[] = [];
        for (const [id, room] of items) {
          if (loads.length > 0 && ((loads.length + 1) * watts > capacity(breaker) || loads.length >= d.maxDevicesPerCircuit)) {
            make(kind, loads, breaker, rooms, loads.length * watts);
            loads = [];
            rooms = [];
          }
          loads.push(id);
          rooms.push(room);
        }
        if (loads.length > 0) make(kind, loads, breaker, rooms, loads.length * watts);
      };
      // Rooms whose receptacles have circuits of their own; a kitchen shares its between at least two, in turn.
      const dedicated = new Map<string, string[]>();
      const general: [string, string][] = [];
      for (const [id, room] of receptacles) {
        if (d.dedicatedFunctions.includes(roomOf.get(room)?.function ?? '')) dedicated.set(room, [...(dedicated.get(room) ?? []), id]);
        else general.push([id, room]);
      }
      for (const [room, ids] of [...dedicated.entries()].sort(([a], [b]) => cmp(a, b))) {
        const fn = roomOf.get(room)?.function ?? '';
        const per = Math.max(1, Math.min(d.maxDevicesPerCircuit, Math.floor(capacity(d.receptacleBreaker) / Math.max(1, d.receptacleWatts))));
        const n = Math.max(fn === 'kitchen' ? d.kitchenCircuits : 1, Math.ceil(ids.length / per));
        const groups: string[][] = Array.from({ length: Math.min(n, ids.length) }, () => []);
        ids.forEach((id, i) => groups[i % groups.length]!.push(id));
        groups.forEach((g, i) => { make(`receptacles${groups.length > 1 ? ` ${String(i + 1)}` : ''}`, g, d.receptacleBreaker, [room], g.length * d.receptacleWatts); });
      }
      pack('receptacles', general, d.receptacleBreaker, d.receptacleWatts);
      pack('lighting', lighting, d.lightingBreaker, d.lightWatts);
      let unspaced = 0;
      for (const c of circuits) {
        const space = nextSpace();
        if (space === undefined) unspaced++;
        edits.push({
          op: 'setProperty',
          id: '$document',
          path: `/extensions/FS_electrical/circuits/${c.id}`,
          value: {
            panel: c.panel,
            breaker: c.breaker,
            volts: d.volts,
            ...(c.protection.length > 0 ? { protection: c.protection } : {}),
            ...(space === undefined ? {} : { space }),
            loads: c.loads,
            name: c.name,
          },
        });
      }
      if (unspaced > 0) notes.push(`Panel ${panel[0]} has too few free spaces: ${String(unspaced)} circuit${unspaced === 1 ? ' has' : 's have'} no space assigned.`);
    }
  }

  // Declarations first: a 0.1 plan becomes 0.3, the current draft (a later one keeps its version),
  // and FS_electrical is declared, before anything of it.
  const changes = placements.length + edits.length;
  if (changes > 0) {
    if (doc.floorspec === '0.1') batch.push(...migrationBatch(doc, '0.3')); // Core chapter 20
    if (!Object.hasOwn((doc.extensionsUsed ?? {}), 'FS_electrical')) batch.push({ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' });
  }
  batch.push(...placements, ...edits);

  const roomNames = plan.rooms.map((r) => r.name);
  const explanation = [
    changes === 0
      ? `Nothing to add in ${list(roomNames) || 'these rooms'}: the receptacles, lights and switches there already meet Floorspec's layout defaults, and every load is on a circuit.`
      : `Proposes ${[
          added.receptacles.length > 0 && `${String(added.receptacles.length)} receptacle${added.receptacles.length === 1 ? '' : 's'}`,
          added.switches.length > 0 && `${String(added.switches.length)} switch${added.switches.length === 1 ? '' : 'es'}`,
          added.lights.length > 0 && `${String(added.lights.length)} light${added.lights.length === 1 ? '' : 's'}`,
          added.panels.length > 0 && 'a panel',
          circuits.length > 0 && `${String(circuits.length)} circuit${circuits.length === 1 ? '' : 's'}`,
          upgraded.length > 0 && `GFCI on ${String(upgraded.length)} existing receptacle${upgraded.length === 1 ? '' : 's'}`,
        ]
          .filter((x): x is string => typeof x === 'string')
          .join(', ')} for ${list(roomNames)}.`,
    `From Floorspec's layout defaults, each configurable: receptacles at most ${lengthText(doc, d.receptacleSpacing)} apart along a wall run and within ${lengthText(doc, d.receptacleSpacing / 2)} of its ends${Object.entries(d.spacingByFunction).map(([f, v]) => `, ${lengthText(doc, v)} apart in a ${f}`).join('')}; GFCI at the device in ${list([...d.gfciFunctions])} rooms; AFCI at the breaker on circuits serving ${list([...d.afciFunctions])} rooms; a switch beside each room's entry on the latch side (beside an open side when it has no door); a ceiling light per room; ${String(d.receptacleBreaker)} A receptacle and ${String(d.lightingBreaker)} A lighting circuits filled to ${String(Math.round(d.loadFraction * 100))}% of their capacity at ${String(d.receptacleWatts)} W a receptacle and ${String(d.lightWatts)} W a light.`,
    'These are layout defaults, not a code check: advisory code findings, with their citations, arrive with the Floorspec Rules packs.',
    ...plan.rooms.flatMap((room) => {
      const mine = gaps.filter((g) => g.room === room.id);
      if (mine.length === 0) return [];
      const worst = mine.reduce((a, b) => (b.length > a.length ? b : a));
      return [
        `${room.name} had ${mine.length === 1 ? 'one stretch' : `${String(mine.length)} stretches`} of wall longer than the spacing without a receptacle; the longest, ${lengthText(doc, worst.length)} ${worst.kind === 'none' ? 'with none at all' : worst.kind === 'end' ? 'from a corner or door to the nearest' : 'between two'}, on wall ${worst.wall}.`,
      ];
    }),
    ...notes,
  ];
  return {
    batch,
    // A changeset's name is at most 120 characters: past that, the rooms are counted, not listed.
    name: `Electrical layout: ${list(roomNames)}`.length <= 120 ? `Electrical layout: ${list(roomNames)}` : `Electrical layout: ${String(roomNames.length)} rooms`,
    explanation,
    added,
    circuits,
    upgraded,
    gaps,
    rooms: plan.rooms.map((r) => r.id),
    notes,
    defaults: d,
  };
}

/** Where a room's switch goes: beside its first entry, on the latch side — else the hinge side — within one of the room's runs. */
/** A panel's box: 16" wide, 4" deep, 32" tall about its host point. */
const PANEL_BOX = { min: [0, -260_096, -520_192], max: [130_048, 260_096, 520_192] };
/** Where a panel goes first: the rooms a service usually enters, best first. */
const PANEL_ROOMS = ['garage', 'utility', 'mechanical', 'laundry', 'storage', 'circulation'];

/**
 * The stretches of a run with no opening in them, each opening widened by `clear` either side: a
 * run carries on under a window, which suits a receptacle but not a panel (FLR-T-12.19).
 */
function clearOf(run: WallRun, doc: FloorspecDocument, clear: number): [number, number][] {
  const types = (doc.types ?? {}) as Record<string, { width?: number } | undefined>;
  const blocks = Object.values((doc.openings ?? {}) as Record<string, { wall?: string; offset?: number; width?: number; fill?: string } | undefined>)
    .flatMap((o) => {
      if (o?.wall !== run.wall || typeof o.offset !== 'number') return [];
      const width = o.width ?? (o.fill === undefined ? undefined : types[o.fill]?.width);
      return typeof width === 'number' ? [[o.offset - clear, o.offset + width + clear] as [number, number]] : [];
    })
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let from = run.from;
  for (const [a, b] of blocks) {
    if (b <= from) continue;
    if (a >= run.to) break;
    if (a > from) out.push([from, a]);
    from = Math.max(from, b);
  }
  if (from < run.to) out.push([from, run.to]);
  return out;
}

/**
 * Where to place a panel when the plan has none (FLR-T-12.18): the middle of the longest stretch,
 * at least panelMinRun long and clear of every door and window by 6", of the first room by
 * PANEL_ROOMS (then any room), on the lowest level, by ID. Advice like the rest: the note says to
 * move it to where the service enters.
 */
export function panelAt(rooms: readonly RoomPlan[], doc: FloorspecDocument, d: ElectricalDefaults): { room: string; wall: string; side: 'left' | 'right'; offset: number } | null {
  const elevation = (level: string): number => (doc.levels as Record<string, { elevation?: number }> | undefined)?.[level]?.elevation ?? 0;
  const rank = (fn: string): number => {
    const i = PANEL_ROOMS.indexOf(fn);
    return i < 0 ? PANEL_ROOMS.length : i;
  };
  const CLEAR = 195_072; // 6"
  const candidates = rooms
    .map((room) => {
      const stretches = room.runs.flatMap((run) => clearOf(run, doc, CLEAR).map(([from, to]) => ({ run, from, to })));
      const best = stretches.filter((x) => x.to - x.from >= d.panelMinRun).sort((a, b) => b.to - b.from - (a.to - a.from) || cmp(a.run.wall, b.run.wall))[0];
      return { room, best };
    })
    .filter((c): c is { room: RoomPlan; best: { run: WallRun; from: number; to: number } } => c.best !== undefined)
    .sort((a, b) => rank(a.room.function) - rank(b.room.function) || elevation(a.room.level) - elevation(b.room.level) || cmp(a.room.id, b.room.id));
  const pick = candidates[0];
  if (pick === undefined) return null;
  return { room: pick.room.name, wall: pick.best.run.wall, side: pick.best.run.side, offset: Math.round((pick.best.from + pick.best.to) / 2) };
}

export function switchAt(room: RoomPlan, d: ElectricalDefaults): { wall: string; side: 'left' | 'right'; offset: number } | null {
  for (const entry of room.entries) {
    // A door's latch is the jamb away from its hinge; a cased opening has none, and its end jamb is tried first.
    const latchEnd = entry.hinge !== 'end';
    const candidates = latchEnd ? [entry.to + d.switchFromOpening, entry.from - d.switchFromOpening] : [entry.from - d.switchFromOpening, entry.to + d.switchFromOpening];
    for (const at of candidates) {
      const run = room.runs.find((r) => r.wall === entry.wall && r.side === entry.side && at >= r.from && at <= r.to);
      if (run !== undefined) return { wall: entry.wall, side: entry.side, offset: at };
    }
  }
  return null;
}
