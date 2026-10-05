import { describe, expect, it } from 'vitest';
import { check } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { BU_PER_FOOT, MAX_BATCH, MAX_CHANGESET_NAME, solve, SolverError, toChangesetProposals, type Candidate, type ChangesetProposal, type Program } from '../src/index.js';
import { commit, connections, reachable, summary, withBrief } from './helpers.js';
import { parseDocument, toBase } from '../src/document.js';
import { CABIN, house, RANCH, SAMPLES, TWO_STOREY } from './programs.js';

const CASES: [string, () => Record<string, unknown>, Program, Parameters<typeof solve>[1]][] = [
  ['a 3-bed/2-bath ranch', SAMPLES.ranch, RANCH, {}],
  ['a one-bedroom cabin', SAMPLES.cabin, CABIN, {}],
  ['a two-storey program on one level', SAMPLES['two-storey-ground'], TWO_STOREY, { ignoreItemLevels: true }],
];

const memo = new Map<string, Candidate[]>();
const solved = (name: string, doc: () => Record<string, unknown>, options: Parameters<typeof solve>[1]): Candidate[] => {
  if (!memo.has(name)) memo.set(name, solve(doc(), options));
  return memo.get(name)!;
};

describe.each(CASES)('%s', (name, doc, program, options) => {
  const candidates = (): Candidate[] => solved(name, doc, options);

  it('gives at least three distinct candidates, ranked by score', () => {
    const cs = candidates();
    expect(cs.length).toBeGreaterThanOrEqual(3);
    expect(cs.map((c) => c.rank)).toEqual(cs.map((_, i) => i + 1));
    for (let i = 1; i < cs.length; i++) expect(cs[i - 1]!.score.total).toBeGreaterThanOrEqual(cs[i]!.score.total);
    const tilings = new Set(cs.map((c) => JSON.stringify(c.rooms.map((r) => [r.name, r.rect]))));
    expect(tilings.size).toBe(cs.length);
    expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length);
  });

  it('has every candidate batch commit, and the result check with no errors (Core 0.1 and 0.2 with its brief)', () => {
    for (const c of candidates()) {
      const b = commit(doc(), c.batch);
      const r01 = check(b, { core: '0.1' });
      expect(r01.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const r02 = check(withBrief(b, program, c));
      expect(r02.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      // The engine's findings are the ones the score counted.
      const lints = r02.diagnostics.filter((d) => !['FS-LINT-008', 'FS-LINT-009', 'FS-LINT-010', 'FS-LINT-011'].includes(d.code));
      expect(lints.filter((d) => d.severity === 'warning').length).toBe(c.score.detail.warnings);
    }
  });

  it('reaches every room from the front door, and no bedroom only through another (top candidate)', () => {
    const c = candidates()[0]!;
    const b = commit(doc(), c.batch);
    const ids = c.rooms.map((r) => r.id);
    const { connected } = connections(b, ids);
    expect([...reachable(ids, connected, c.entry, () => true)].sort()).toEqual([...ids].sort());
    const sleeping = new Set(c.rooms.filter((r) => r.function === 'sleeping').map((r) => r.id));
    const viaNonSleeping = reachable(ids, connected, c.entry, (id) => !sleeping.has(id));
    for (const id of sleeping) expect(viaNonSleeping.has(id)).toBe(true);
    expect(c.score.detail.reach).toBe(1);
    expect(c.score.detail.sleepingThroughSleeping).toBe(0);
  });

  it('has the required adjacencies adjacent in the top candidate, as the engine derives them', () => {
    const c = candidates()[0]!;
    const derived = check(withBrief(commit(doc(), c.batch), program, c)).derived!.program!;
    const required = derived.adjacency.filter((a) => a.kind === 'required');
    expect(required.length).toBeGreaterThan(0);
    for (const a of required) expect(a.adjacent, `${a.a} – ${a.b}`).toBe(true);
    for (const a of derived.adjacency.filter((x) => x.kind === 'forbidden')) expect(a.adjacent, `${a.a} – ${a.b}`).toBe(false);
    for (const [id, v] of Object.entries(derived.items)) expect(v.countMet, id).toBe(true);
  });

  it('uses only integer coordinates on the 6-inch grid and explains itself', () => {
    for (const c of candidates()) {
      for (const op of c.batch) {
        if (op.op === 'drawWall' || op.op === 'drawSeparator')
          for (const p of [op.from, op.to] as [number, number][]) for (const v of p) expect(Number.isInteger(v) && v % 195072 === 0).toBe(true);
        if (op.op === 'addOpening') expect(Number.isInteger(op.at)).toBe(true);
      }
      expect(c.explanation.length).toBeGreaterThan(3);
      expect(c.score.source).toBe('engine');
    }
  });
});

describe('determinism', () => {
  it('gives the same candidates, byte for byte, every time', () => {
    const a = JSON.stringify(solve(SAMPLES.ranch()));
    const b = JSON.stringify(solve(SAMPLES.ranch()));
    expect(b).toBe(a);
    expect(JSON.stringify(solve(JSON.stringify(SAMPLES.cabin())))).toBe(JSON.stringify(solve(SAMPLES.cabin())));
  });

  it('a different seed only reorders what is tried, not what is valid', () => {
    for (const c of solve(SAMPLES.cabin(), { seed: 7 })) expect(commit(SAMPLES.cabin(), c.batch)).toBeDefined();
  });
});

describe('golden summaries (reviewed by looking at the rendered plans)', () => {
  it('ranch: bedroom wing along a hall, living to the front, garage at the west end', () => {
    expect(summary(solved(CASES[0]![0], SAMPLES.ranch, {})[0]!)).toEqual({
      strategy: 'wing',
      footprint: "71.5' x 30'",
      rooms: [
        'Bedroom 1 12x12',
        'Bedroom 2 12x12',
        'Coat closet 5x5',
        'Dining 11x14',
        'Garage 17x30',
        'Hall 29x4',
        'Hall bath 5x12',
        'Kitchen 14.5x14',
        'Laundry 5x11',
        'Living room 20.5x16',
        'Primary bath 11x9',
        'Primary bedroom 18x14',
        'Walk-in closet 11x5',
      ],
      total: 99.93,
    });
  });

  it('cabin: compact, the bedroom and bath off a full-depth great room', () => {
    expect(summary(solved(CASES[1]![0], SAMPLES.cabin, {})[0]!)).toEqual({
      strategy: 'compact',
      footprint: "31.5' x 21'",
      rooms: ['Bath 10x5.5', 'Bedroom 10x15.5', 'Great room 13.5x21', 'Kitchen 8x21'],
      total: 97.83,
    });
  });

  it('two-storey, ground floor only: the bedrooms are left for the upper floor', () => {
    const cs = solve(SAMPLES['two-storey-ground']());
    expect(summary(cs[0]!)).toEqual({
      strategy: 'compact',
      footprint: "41' x 27.5'",
      rooms: ['Coat closet 5x6', 'Dining 12x15', 'Family room 28x12.5', 'Foyer 6x15', 'Kitchen 15x15', 'Laundry 8x9', 'Powder room 5x6.5', 'Study 8x18.5'],
      total: 98.34,
    });
    expect(cs[0]!.level).toBe('L1');
    expect(cs[0]!.unplaced.map((u) => [u.item, u.count])).toEqual([
      ['BED', 3],
      ['BTH', 1],
      ['PBA', 1],
      ['PBR', 1],
    ]);
  });
});

describe('options and edges', () => {
  it('lays out on a new building and level in a bare Core 0.1 document — what the server stores — with the program passed in', () => {
    const bare = { floorspec: '0.1', project: { name: 'Empty' } };
    const cs = solve(bare, { program: CABIN, count: 3 });
    expect(cs.length).toBeGreaterThanOrEqual(3);
    for (const c of cs) {
      expect(c.batch[0]).toMatchObject({ op: 'addElement', collection: 'buildings', id: 'B1' });
      expect(c.batch[1]).toMatchObject({ op: 'addLevel', id: 'L1', building: 'B1', elevation: 0 });
      const r = apply(bare, { batch: c.batch });
      expect(r.status).toBe('committed');
    }
  });

  it('stretches to a given footprint', () => {
    const width = 76 * BU_PER_FOOT;
    const depth = 32 * BU_PER_FOOT;
    const cs = solve(SAMPLES.ranch(), { footprint: { width, depth }, count: 3 });
    expect(cs.length).toBeGreaterThanOrEqual(3);
    for (const c of cs) {
      expect(c.footprint).toEqual({ width, depth });
      commit(SAMPLES.ranch(), c.batch);
    }
  });

  it('never names an ID the store has retired', () => {
    const c = solve(SAMPLES.cabin(), { retired: ['W40', 'R9', 'T3'], count: 3 })[0]!;
    const named = c.batch.flatMap((o) => ('id' in o && typeof o.id === 'string' ? [o.id] : []));
    for (const id of named) expect(['W40', 'R9', 'T3', 'W1', 'R1']).not.toContain(id);
    const r = apply(toBase(parseDocument(SAMPLES.cabin())), { batch: c.batch, context: { retired: ['W40', 'R9', 'T3'] } });
    expect(r.status).toBe('committed');
  });

  it('can set each room\'s brief in the batch, for an Ops 0.2 applier', () => {
    const [plain] = solve(SAMPLES.cabin(), { count: 3 });
    const [withBriefs] = solve(SAMPLES.cabin(), { count: 3, emitBrief: true });
    expect(plain!.batch.some((o) => o.op === 'setProperty')).toBe(false);
    const briefs = withBriefs!.batch.filter((o) => o.op === 'setProperty' && o.path === '/brief');
    expect(briefs.length).toBe(withBriefs!.rooms.filter((r) => r.item !== undefined).length);
  });

  it('refuses a document with no program, and a level that already has walls', () => {
    expect(() => solve(house('Nothing', { items: {} }))).toThrow(SolverError);
    const cs = solve(SAMPLES.cabin(), { count: 3 });
    const drawn = commit(SAMPLES.cabin(), cs[0]!.batch);
    expect(() => solve(drawn, { program: CABIN, level: 'L1' })).toThrow(/already has walls/);
  });

  it('adds a level above when every level is drawn on', () => {
    const drawn = commit(SAMPLES.cabin(), solve(SAMPLES.cabin(), { count: 3 })[0]!.batch);
    const c = solve(drawn, { program: { items: { OFF: { function: 'office', name: 'Studio', targetArea: 150 * 152_212_340_736 } } }, count: 3 });
    expect(c.length).toBeGreaterThan(0);
    expect(c[0]!.batch[0]).toMatchObject({ op: 'addLevel', above: 'L1' });
    commit(drawn, c[0]!.batch);
  });
});

describe('changeset proposals', () => {
  it('match the server\'s propose body: a name of at most 120 characters and a batch of 1–500 operations', () => {
    const cs = solve(SAMPLES.ranch());
    const proposals = toChangesetProposals(cs);
    expect(proposals.length).toBe(cs.length);
    proposals.forEach((p, i) => {
      expect(Object.keys(p).sort()).toEqual(['batch', 'name']);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.name.length).toBeLessThanOrEqual(MAX_CHANGESET_NAME);
      expect(p.name.startsWith(`Layout ${String(i + 1)} of ${String(cs.length)} (`)).toBe(true);
      expect(p.batch.length).toBeGreaterThan(0);
      expect(p.batch.length).toBeLessThanOrEqual(MAX_BATCH);
      for (const op of p.batch) expect(typeof op.op === 'string' && op.op.length <= 64).toBe(true);
      // A round trip through JSON, as the request body travels, still commits.
      commit(SAMPLES.ranch(), (JSON.parse(JSON.stringify(p)) as ChangesetProposal).batch);
    });
  });
});
