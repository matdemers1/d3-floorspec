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
const FLAT = read('conformance/ext/FS_furniture/0.1.0/examples/001-p8-demo-flat/input.json');

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

  it('gives the panel it places FS_electrical 2.7\'s default working space, so no FS-ELEC-LINT-006', () => {
    const codes = check(after, OFFICIAL_READER).diagnostics.map((x) => x.code);
    expect(codes).not.toContain('FS-ELEC-LINT-006');
    const [panel] = p.added.panels;
    const placed = electrical(after)?.collections?.['panels']?.[panel as string];
    expect(placed?.['clearances']).toMatchObject({ working: { purpose: 'workingSpace', shape: 'box', min: [0, -512_000, -60 * IN], max: [1_280_000, 512_000, 2_560_000 - 60 * IN] } });
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

/** A proposed wall-face device: its collection, wall, offset and centre height. */
type Placed = { id: string; collection: string; wall: string; at: number; height: number };
const placedOf = (p: ElectricalProposal): Placed[] =>
  p.batch.flatMap((o) => {
    const x = o as unknown as { op: string; id: string; collection?: string; host?: { mode: string; wall: string; at: number; height: number } };
    return x.op === 'placeElement' && x.host?.mode === 'wallFace' && x.collection !== 'panels' ? [{ id: x.id, collection: x.collection ?? '', wall: x.host.wall, at: x.host.at, height: x.host.height }] : [];
  });

type Doc = { openings?: Record<string, Record<string, unknown>>; types?: Record<string, { kind?: string; width?: number; sill?: number }> };
const PLATE_TOP = 76_800;

/** Every proposed receptacle and switch clear of every opening that comes down near it: a door always, a window when its sill is below the device's top plus 6". */
function expectClear(docText: string, p: ElectricalProposal): number {
  const doc = JSON.parse(docText) as Doc;
  let checked = 0;
  for (const x of placedOf(p))
    for (const [oid, o] of Object.entries(doc.openings ?? {})) {
      if (o['wall'] !== x.wall) continue;
      const t = doc.types?.[o['fill'] as string];
      const from = o['offset'] as number;
      const to = from + ((o['width'] as number | undefined) ?? t?.width ?? 0);
      const sill = t?.kind === 'windowType' ? ((o['sill'] as number | undefined) ?? t.sill ?? 0) : 0;
      if (sill >= x.height + PLATE_TOP + 6 * IN) continue;
      checked++;
      expect(x.at <= from - 6 * IN || x.at >= to + 6 * IN, `${x.collection} ${x.id} at ${String(x.at)} on ${x.wall} is clear of ${oid} (${String(from)}–${String(to)}, sill ${String(sill)})`).toBe(true);
    }
  return checked;
}

describe('receptacle and switch heights, clear of openings (FLR-T-12.26)', () => {
  it('puts general receptacles at 16" to centre, counter receptacles at 42" and switches at 48"', () => {
    const p = proposeElectrical(HOUSE);
    const after = commit(HOUSE, p);
    const rooms = derivedRooms(after);
    for (const x of placedOf(p)) {
      if (x.collection === 'switches') expect(x.height, x.id).toBe(48 * IN);
      // The kitchen has no casework drawn, so its function says its walls are counters.
      else expect(x.height, x.id).toBe(rooms['KIT']?.includes(x.id) ? 42 * IN : 16 * IN);
    }
    expect(DEFAULTS.receptacleHeight).toBe(16 * IN);
    expect(DEFAULTS.counterHeight).toBe(42 * IN);
  });

  it('keeps every device out of the span of a door, and of a window that comes down near it, in every house', () => {
    // The three-room house's kitchen window has a 42" sill: above a counter, it keeps its receptacles out.
    expect(expectClear(HOUSE, proposeElectrical(HOUSE))).toBeGreaterThan(0);
    expectClear(DEMO, proposeElectrical(DEMO));
  });

  it('slides a receptacle out from under a low window rather than dropping it, and the spacing still holds', () => {
    const before = proposeElectrical(HOUSE);
    const doc = JSON.parse(HOUSE) as Doc;
    // A receptacle on a wall with no opening yet.
    const target = placedOf(before).find((x) => x.collection === 'receptacles' && x.height === 16 * IN && !Object.values(doc.openings ?? {}).some((o) => o['wall'] === x.wall));
    expect(target).toBeDefined();
    // A 3' window with an 18" sill centred where that receptacle went: its sill is below 16" + plate + 6".
    const w = 3 * FT;
    doc.openings = { ...(doc.openings ?? {}), OLOW: { wall: target!.wall, offset: target!.at - w / 2, fill: 'W3636', width: w, sill: 18 * IN } };
    const text = JSON.stringify(doc);
    const p = proposeElectrical(text);
    expectClear(text, p);
    const after = commit(text, p);
    expect(analyseGaps(after)).toEqual([]);
    const near = placedOf(p).filter((x) => x.collection === 'receptacles' && x.wall === target!.wall && Math.abs(x.at - target!.at) <= 6 * FT);
    expect(near.length, 'slid along the wall, not dropped').toBeGreaterThan(0);
    // The same window with a 36" sill is high enough: the receptacle stays where it was, under it.
    doc.openings['OLOW'] = { ...doc.openings['OLOW'], sill: 36 * IN };
    expect(placedOf(proposeElectrical(doc)).some((x) => x.wall === target!.wall && x.at === target!.at)).toBe(true);
  });

  it('covers a run around a window, sliding to the nearest clear stretch, even under one wider than the spacing', () => {
    const run = { room: 'R', wall: 'W', side: 'right' as const, from: 0, to: 30 * FT };
    // A window from 5' to 8': allowed before 4' 6" and after 8' 6".
    const around = fillRun(run, [], 12 * FT, DEFAULTS, [[6 * IN, 4 * FT + 6 * IN], [8 * FT + 6 * IN, 30 * FT - 6 * IN]]);
    expect(around.every((a) => a <= 4 * FT + 6 * IN || a >= 8 * FT + 6 * IN)).toBe(true);
    expect(runGaps(run, around, 12 * FT)).toEqual([]);
    // A 16' window from 4' to 20': one before it, then on past it rather than none at all.
    const wide = fillRun(run, [], 12 * FT, DEFAULTS, [[6 * IN, 3 * FT + 6 * IN], [20 * FT + 6 * IN, 30 * FT - 6 * IN]]);
    expect(wide.every((a) => a <= 3 * FT + 6 * IN || a >= 20 * FT + 6 * IN)).toBe(true);
    expect(wide.filter((a) => a <= 3 * FT + 6 * IN)).toHaveLength(1);
    expect(wide.filter((a) => a >= 20 * FT + 6 * IN).length).toBeGreaterThan(0);
    expect(runGaps(run, wide, 12 * FT).every((g) => g.from >= 3 * FT && g.to <= 21 * FT)).toBe(true);
    // And with no allowance given, the run as before.
    expect(fillRun(run, [], 12 * FT, DEFAULTS)).toEqual([6 * FT, 18 * FT, 30 * FT - 6 * IN]);
  });

  it('puts counter receptacles at 42" along base cabinets, and the rest of the kitchen at 16"', () => {
    const p = proposeElectrical(FLAT);
    const plan = readPlan(FLAT, { grid: IN, counterCategories: DEFAULTS.counterCategories });
    const kitchen = plan.rooms.find((r) => r.id === 'R1');
    expect(kitchen?.hasCounters).toBe(true);
    // The two base cabinets against W2; not the wall or tall cabinets.
    expect(kitchen?.counters.map((c) => [c.casework, c.wall, c.from, c.to])).toEqual([
      ['X2', 'W2', 1_216_000, 1_984_000],
      ['X4', 'W2', 2_956_800, 3_724_800],
    ]);
    const after = commit(FLAT, p);
    const rooms = derivedRooms(after);
    const inKitchen = placedOf(p).filter((x) => x.collection === 'receptacles' && rooms['R1']?.includes(x.id));
    const onCounter = (x: Placed) => x.wall === 'W2' && kitchen!.counters.some((c) => x.at >= c.from && x.at <= c.to);
    expect(inKitchen.filter(onCounter).length).toBeGreaterThan(0);
    for (const x of inKitchen) expect(x.height, `${x.id} at ${String(x.at)} on ${x.wall}`).toBe(onCounter(x) ? 42 * IN : 16 * IN);
    // The laundry and bedroom have no counters: 16".
    for (const x of placedOf(p).filter((y) => y.collection === 'receptacles' && !rooms['R1']?.includes(y.id))) expect(x.height).toBe(16 * IN);
  });

  it('moves a switch off a low window beside the door, to the door\'s other side', () => {
    const doc = JSON.parse(HOUSE) as Doc;
    // The bedroom door BD hangs from its end jamb, so its switch goes at its start: put a low window there.
    const bd = doc.openings!['BD']!;
    const start = bd['offset'] as number;
    doc.openings!['OSW'] = { wall: 'WI1', offset: start - 3 * FT - 3 * IN, fill: 'W3636', width: 3 * FT, sill: 30 * IN };
    const text = JSON.stringify(doc);
    const p = proposeElectrical(text, { rooms: ['BED'] });
    expectClear(text, p);
    const sw = placedOf(p).find((x) => x.collection === 'switches');
    expect(sw).toMatchObject({ wall: 'WI1', height: 48 * IN });
    expect(sw!.at).toBeGreaterThan(start);
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

describe('a room with an arc wall (Core 21)', () => {
  // The living room's west wall bowed out 2': the level graph walks it as segments `WW~<k>`, which
  // are not walls of the document — reading them as walls threw, and the API answered 500.
  const doc = JSON.parse(HOUSE) as Json & { walls: Record<string, Json> };
  doc['floorspec'] = '0.4';
  doc.walls['WW'] = { ...doc.walls['WW'], arc: { sagitta: 2 * FT } };
  const ARC = JSON.stringify(doc);

  it('is valid to start with', () => {
    expect(check(ARC, OFFICIAL_READER).valid).toBe(true);
  });

  it('proposes for every room, the straight walls laid out, the curve said', () => {
    const p = proposeElectrical(ARC);
    expect(p.rooms).toEqual(['BED', 'KIT', 'LIV']);
    const after = commit(ARC, p);
    expect(check(after, OFFICIAL_READER).valid).toBe(true);
    expect(p.explanation.some((l) => l.includes('curved wall WW gets no receptacles'))).toBe(true);
    const hosts = Object.values(electrical(after)?.collections?.['receptacles'] ?? {}).map((r) => (r['host'] as { wall?: string }).wall);
    expect(hosts).not.toContain('WW');
    expect(hosts.length).toBeGreaterThan(0);
  });
});

describe('counters and crowding (FLR-T-12.28)', () => {
  const hosts = (p: ElectricalProposal) =>
    p.batch
      .filter((o) => (o as { collection?: string }).collection === 'receptacles')
      .map((o) => (o as unknown as { host: { wall: string; side: string; at: number; height: number } }).host);

  it('puts no two new receptacles on one wall face within a foot of each other', () => {
    for (const doc of [HOUSE, DEMO, FLAT]) {
      const byFace = new Map<string, number[]>();
      for (const h of hosts(proposeElectrical(doc))) byFace.set(`${h.wall}/${h.side}`, [...(byFace.get(`${h.wall}/${h.side}`) ?? []), h.at]);
      for (const [face, ats] of byFace) {
        const s = ats.sort((a, b) => a - b);
        for (let i = 1; i < s.length; i++) expect(s[i]! - s[i - 1]!, face).toBeGreaterThanOrEqual(FT);
      }
    }
  });

  it('covers cabinets side by side as one counter, and a cabinet whose end only touches a wall is no counter along it', () => {
    const doc = JSON.parse(FLAT) as Json & { extensions: { FS_furniture: { collections: { casework: Record<string, Json> } } } };
    const plan = readPlan(doc, { grid: DEFAULTS.grid, counterCategories: DEFAULTS.counterCategories });
    for (const room of plan.rooms)
      for (const c of room.counters) {
        // Every counter span is along the face its casework backs onto: never the face its end meets.
        const el = doc.extensions.FS_furniture.collections.casework[c.casework];
        expect(el, c.casework).toBeDefined();
      }
    const counterHeights = hosts(proposeElectrical(FLAT)).filter((h) => h.height === DEFAULTS.counterHeight);
    const perFace = new Map<string, number>();
    for (const h of counterHeights) perFace.set(`${h.wall}/${h.side}`, (perFace.get(`${h.wall}/${h.side}`) ?? 0) + 1);
    const cabinetsPerFace = new Map<string, number>();
    for (const room of plan.rooms) for (const c of room.counters) cabinetsPerFace.set(`${c.wall}/${c.side}`, (cabinetsPerFace.get(`${c.wall}/${c.side}`) ?? 0) + 1);
    for (const [face, n] of perFace) expect(n, face).toBeLessThanOrEqual(Math.max(1, cabinetsPerFace.get(face) ?? 1));
  });
});
