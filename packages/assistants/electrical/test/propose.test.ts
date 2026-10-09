import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, OFFICIAL_READER, type FloorspecDocument } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { analyseGaps, DEFAULTS, fillRun, PlanError, proposeElectrical, readPlan, runGaps, type ElectricalProposal } from '../src/index.js';

/**
 * The electrical assistant (FLR-T-5.8, FLR-REQ-090) on the conformance suites' houses: the batch it
 * proposes commits under the reference applier as the server runs it, every room it lays out then
 * meets the spacing it was given, GFCI rooms get GFCI devices, every load lands on a circuit within
 * its limits, and the same plan always gives the same batch.
 */

const IN = 32_512;
const FT = 12 * IN;
const standard = new URL('../../../engine/standard/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, standard), 'utf8');
const HOUSE = read('conformance/core/0.2/examples/001-three-room-house/input.json');
const DEMO = read('conformance/ext/FS_electrical/0.1.0/examples/001-p5-demo-house/input.json');

function commit(doc: string, p: ElectricalProposal): string {
  const r = apply(doc, { batch: p.batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}

type Json = Record<string, unknown>;
const electrical = (doc: string) => (JSON.parse(doc) as { extensions?: { FS_electrical?: { collections?: Record<string, Record<string, Json>>; circuits?: Record<string, Json> } } }).extensions?.FS_electrical;
const derivedRooms = (doc: string) => check(doc, OFFICIAL_READER).derived?.extensions?.FS_electrical?.rooms ?? {};

describe('proposing for a house with no electrical yet', () => {
  const p = proposeElectrical(HOUSE);
  const after = commit(HOUSE, p);

  it('declares FS_electrical first, and the batch commits', () => {
    expect(p.batch[0]).toEqual({ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' });
    expect(check(after, OFFICIAL_READER).valid).toBe(true);
    expect(p.rooms).toEqual(['BED', 'KIT', 'LIV']);
  });

  it('leaves no room with a spacing gap', () => {
    expect(p.gaps.length).toBeGreaterThan(0);
    expect(analyseGaps(after)).toEqual([]);
  });

  it('puts GFCI at the device in the kitchen, and only there', () => {
    const receptacles = electrical(after)?.collections?.['receptacles'] ?? {};
    const rooms = derivedRooms(after);
    for (const id of p.added.receptacles) {
      const inKitchen = rooms['KIT']?.includes(id) ?? false;
      expect(receptacles[id]?.['features'] ?? [], id).toEqual(inKitchen ? ['gfci'] : []);
    }
    expect(p.added.receptacles.filter((id) => rooms['KIT']?.includes(id)).length).toBeGreaterThan(0);
  });

  it('puts a light in each room and a switch beside its entry that controls it', () => {
    expect(p.added.lights).toHaveLength(3);
    const switches = electrical(after)?.collections?.['switches'] ?? {};
    const rooms = derivedRooms(after);
    for (const r of ['BED', 'KIT', 'LIV']) {
      const light = p.added.lights.find((l) => rooms[r]?.includes(l));
      expect(light, r).toBeDefined();
      const sw = Object.entries(switches).find(([, s]) => (s['controls'] as string[]).includes(light as string));
      expect(sw, `${r}'s light is switched`).toBeDefined();
    }
    // The bedroom door BD hangs from its end jamb, so its latch — and the switch — is at its start.
    const bed = Object.values(switches).find((s) => (s['controls'] as string[]).some((c) => rooms['BED']?.includes(c)));
    expect(bed?.['host']).toMatchObject({ mode: 'wallFace', wall: 'WI1', offset: 3121152 - 6 * IN, height: 48 * IN });
  });

  it('places a panel when the plan has none, says where to move it, and feeds every load from it (FLR-T-12.18)', () => {
    expect(p.added.panels).toHaveLength(1);
    const [panel] = p.added.panels;
    expect(p.notes.some((n) => n.startsWith(`There was no panel, so it places a 200 A, 40-space panel (${String(panel)})`) && n.endsWith('move it to where the service enters.'))).toBe(true);
    expect(p.circuits.length).toBeGreaterThan(0);
    expect(p.circuits.every((c) => c.panel === panel)).toBe(true);
    const fed = new Set(p.circuits.flatMap((c) => c.loads));
    for (const id of [...p.added.receptacles, ...p.added.lights]) expect(fed.has(id)).toBe(true);
  });

  it('names a proposal by its room count when listing them would pass 120 characters', () => {
    const long = JSON.parse(HOUSE) as { rooms: Record<string, { name?: string }> };
    for (const [id, room] of Object.entries(long.rooms)) room.name = `${id} — a room with a name long enough to fill a changeset title`;
    expect(proposeElectrical(long).name).toBe(`Electrical layout: ${String(Object.keys(long.rooms).length)} rooms`);
    expect(p.name.length).toBeLessThanOrEqual(120);
    expect(p.name).toMatch(/^Electrical layout: /);
  });

  it('keeps the panel clear of doors and windows: a wall runs on under a window, a panel does not (FLR-T-12.19)', () => {
    type Doc = { openings?: Record<string, Record<string, unknown>>; types?: Record<string, { width?: number }> };
    const panelHost = (prop: ReturnType<typeof proposeElectrical>) => {
      const op = prop.batch.find((o) => (o as { collection?: string }).collection === 'panels') as unknown as { host: { wall: string; at: number } };
      return op.host;
    };
    const doc = JSON.parse(HOUSE) as Doc;
    const first = panelHost(proposeElectrical(doc));
    // A 4' window centred where the panel went: the panel must move off it, 6" clear.
    const w = 4 * 390_144;
    doc.openings = { ...(doc.openings ?? {}), OW: { wall: first.wall, offset: first.at - w / 2, fill: 'W4848', width: w } };
    const moved = panelHost(proposeElectrical(doc));
    const half = 260_096;
    const types = doc.types ?? {};
    for (const o of Object.values(doc.openings)) {
      if (o['wall'] !== moved.wall) continue;
      const from = o['offset'] as number;
      const to = from + ((o['width'] as number | undefined) ?? types[o['fill'] as string]?.width ?? 0);
      expect(moved.at + half <= from - 195_072 || moved.at - half >= to + 195_072, `panel at ${String(moved.at)} on ${moved.wall} clear of ${String(from)}–${String(to)}`).toBe(true);
    }
  });

  it('leaves the loads unfed, and says so, when told not to place a panel', () => {
    const bare = proposeElectrical(HOUSE, { include: { panel: false } });
    expect(bare.circuits).toEqual([]);
    expect(bare.added.panels).toEqual([]);
    expect(bare.notes).toContain('There is no panel, so no circuits are proposed: place one and ask again.');
  });

  it('says what it used and that it is not a code check, and never more', () => {
    const text = p.explanation.join('\n');
    expect(text).toContain("From Floorspec's layout defaults, each configurable: receptacles at most 12' apart along a wall run");
    expect(text).toContain('These are layout defaults, not a code check');
    expect(text).not.toMatch(/complian|NEC|\bIRC\b|requires|code requirement|meets the code/i);
  });

  it('has nothing more to add the second time', () => {
    const again = proposeElectrical(after);
    expect(again.added).toEqual({ receptacles: [], switches: [], lights: [], panels: [] });
    expect(again.batch).toEqual([]);
    expect(again.explanation[0]).toMatch(/^Nothing to add/);
  });
});

describe('proposing for the P5 demo house, which has a panel and circuits', () => {
  const p = proposeElectrical(DEMO);
  const after = commit(DEMO, p);

  it('groups every unfed load into circuits on the panel, within the limits', () => {
    const e = electrical(after);
    const fed = new Set(Object.values(e?.circuits ?? {}).flatMap((c) => c['loads'] as string[]));
    for (const id of [...p.added.receptacles, ...p.added.lights]) expect(fed.has(id), id).toBe(true);
    for (const c of p.circuits) {
      expect(c.panel).toBe('X1');
      expect(c.loads.length).toBeLessThanOrEqual(DEFAULTS.maxDevicesPerCircuit);
      expect(c.estimatedLoad).toBeLessThanOrEqual(c.breaker * DEFAULTS.volts * DEFAULTS.loadFraction);
    }
    // New circuits take spaces the panel's own do not, and IDs nothing uses.
    const d = check(after, OFFICIAL_READER).derived?.extensions?.FS_electrical;
    expect(d?.panels['X1']?.circuits).toEqual(expect.arrayContaining(p.circuits.map((c) => c.id)));
  });

  it('gives AFCI to habitable rooms’ circuits, and GFCI to the bath’s receptacles', () => {
    const rooms = derivedRooms(after);
    for (const c of p.circuits) {
      const kitchen = c.loads.some((l) => rooms['R1']?.includes(l));
      if (kitchen) expect(c.protection).toEqual(['afci']);
    }
    const receptacles = electrical(after)?.collections?.['receptacles'] ?? {};
    for (const id of rooms['R2'] ?? []) if (receptacles[id] !== undefined) expect(receptacles[id]['features']).toContain('gfci');
  });

  it('leaves every room’s runs within the spacing', () => {
    expect(analyseGaps(after)).toEqual([]);
  });
});

describe('the heuristics', () => {
  it('are configurable: a wider spacing proposes fewer receptacles', () => {
    const tight = proposeElectrical(HOUSE).added.receptacles.length;
    const loose = proposeElectrical(HOUSE, { defaults: { receptacleSpacing: 20 * FT, spacingByFunction: {} } }).added.receptacles.length;
    expect(loose).toBeLessThan(tight);
    expect(() => proposeElectrical(HOUSE, { defaults: { receptacleSpacing: 0 } })).toThrow(RangeError);
  });

  it('covers a run greedily, on the grid, kept clear of its ends', () => {
    const run = { room: 'R', wall: 'W', side: 'right' as const, from: 0, to: 30 * FT };
    const at = fillRun(run, [], 12 * FT, DEFAULTS);
    expect(at).toEqual([6 * FT, 18 * FT, 30 * FT - 6 * IN]);
    expect(runGaps(run, at, 12 * FT)).toEqual([]);
    expect(runGaps(run, [], 12 * FT)).toEqual([{ room: 'R', wall: 'W', side: 'right', from: 0, to: 30 * FT, length: 30 * FT, kind: 'none' }]);
    expect(runGaps(run, [6 * FT, 20 * FT], 12 * FT).map((g) => g.kind)).toEqual(['between', 'end']);
  });

  it('can be asked for one room, or a level, and only some parts', () => {
    const kitchen = proposeElectrical(HOUSE, { rooms: ['KIT'], include: { switches: false, lights: false } });
    expect(kitchen.rooms).toEqual(['KIT']);
    expect(kitchen.added.lights).toEqual([]);
    expect(kitchen.added.receptacles.length).toBeGreaterThan(0);
    expect(proposeElectrical(HOUSE, { level: 'MAIN' }).rooms).toEqual(['BED', 'KIT', 'LIV']);
    expect(() => proposeElectrical(HOUSE, { rooms: ['NOPE'] })).toThrow(PlanError);
  });

  it('never mints a retired ID', () => {
    const p = proposeElectrical(HOUSE, { retired: ['X1', 'X2', 'X3'] });
    expect([...p.added.receptacles, ...p.added.lights, ...p.added.switches]).not.toContain('X1');
    expect(p.added.receptacles[0]).toBe('X4');
  });

  it('refuses a plan that is not valid', () => {
    const broken = JSON.parse(HOUSE) as FloorspecDocument & { walls: Record<string, { start: string }> };
    const first = Object.keys(broken.walls)[0] as string;
    (broken.walls[first] as { start: string }).start = 'NOWHERE';
    expect(() => readPlan(broken, { grid: IN })).toThrow(PlanError);
  });
});

describe('determinism', () => {
  it('gives the same batch, byte for byte, from the same plan however it is given', () => {
    const a = JSON.stringify(proposeElectrical(HOUSE));
    const b = JSON.stringify(proposeElectrical(JSON.parse(HOUSE) as object));
    expect(a).toBe(b);
    expect(JSON.stringify(proposeElectrical(DEMO))).toBe(JSON.stringify(proposeElectrical(DEMO)));
  });
});
