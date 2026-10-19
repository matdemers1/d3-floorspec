/**
 * Two-level layouts (FLR-T-12.16). Every clause of the task's doneWhen is checked independently of
 * the solver, on the document each candidate's batch commits, with the engine: both levels share an
 * outline (Core 6.1's unbounded face, `exteriorOutline`); a stair rises between them with headroom
 * at least its minHeadroom and no FS-LINT-019 (17.6); 3' of floor at its foot and head (the engine's
 * landings measure); and every upper room reachable from the stair's head room through the upper
 * level's doors and openings (11.4).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check, exteriorOutline, landings } from '@floorspec/engine';
import { planAccess } from '../src/access.js';
import { variants } from '../src/builders.js';
import { idsOf, parseDocument } from '../src/document.js';
import { segments } from '../src/layout.js';
import { readBrief, type Program } from '../src/program.js';
import { canonDims, LANDING_CLEAR, placements, profileOf, REACH, STAIR, toActual, toCanon, type Frame } from '../src/stair.js';
import { frameFor, UpperPlanner } from '../src/upper.js';
import { BU_PER_INCH, GRID, solve, type Candidate } from '../src/index.js';
import { commit, connections, reachable } from './helpers.js';
import { SAMPLES, TWO_STOREY } from './programs.js';

const here = dirname(fileURLToPath(import.meta.url));
type Doc = Record<string, unknown>;

/** A built house's brief on its own: its project, buildings, levels and program, nothing drawn. */
function briefOf(path: string): Doc {
  const fx = JSON.parse(readFileSync(join(here, path), 'utf8')) as Doc;
  return { floorspec: fx['floorspec'], project: fx['project'], buildings: fx['buildings'], levels: fx['levels'], program: fx['program'] };
}

const BRIEFS: [string, () => Doc][] = [
  ['the two-storey sample (a Core 0.2 brief, 9\' levels)', SAMPLES['two-storey-ground']],
  ["the Courtyard House's brief (Core 0.4, a garage below, 10' and 9' 6\" levels)", () => briefOf('../../../apps/worker/test/fixtures/courtyard-house.json')],
  ["the standard's two-storey starter's brief (Core 0.3, a 1' floor upstairs)", () => briefOf('../../engine/standard/templates/two-storey.floorspec.json')],
];

const solved = new Map<string, Candidate[]>();
const candidatesOf = (name: string, doc: () => Doc): Candidate[] => {
  if (!solved.has(name)) solved.set(name, solve(doc(), { count: 3 }));
  return solved.get(name)!;
};

const sortedRing = (ring: readonly (readonly [number, number])[]): string[] => ring.map((p) => `${String(p[0])},${String(p[1])}`).sort();

describe.each(BRIEFS)('propose_layouts on %s', (name, doc) => {
  const candidates = (): Candidate[] => candidatesOf(name, doc);

  it('returns at least three candidates, each laying out both levels with a stair between them', () => {
    const cs = candidates();
    expect(cs.length).toBeGreaterThanOrEqual(3);
    for (const c of cs) {
      expect(c.levels).toEqual(['L1', 'L2']);
      expect(c.stair).toBeDefined();
      expect(new Set(c.rooms.map((r) => r.level))).toEqual(new Set(['L1', 'L2']));
      // Every item of the brief is placed, on the level it prefers.
      expect(c.unplaced).toEqual([]);
      const program = doc()['program'] as Program;
      for (const r of c.rooms) if (r.item !== undefined) expect(r.level, r.name).toBe(program.items![r.item]!.level);
    }
  });

  it('meets every clause of the doneWhen on the committed document, as the engine derives it', () => {
    for (const c of candidates()) {
      const committed = commit(doc(), c.batch);
      const result = check(committed);
      expect(result.valid).toBe(true);
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

      // Both levels share an outline.
      const [lower] = exteriorOutline(committed, 'L1');
      const [upper] = exteriorOutline(committed, 'L2');
      expect(lower!.length).toBeGreaterThanOrEqual(4);
      expect(sortedRing(upper!)).toEqual(sortedRing(lower!));

      // A stair rises between them with headroom at least its minHeadroom: no FS-LINT-019.
      const stairs = Object.entries((committed['stairs'] ?? {}) as Record<string, Record<string, unknown>>);
      expect(stairs).toHaveLength(1);
      const [id, stair] = stairs[0]!;
      expect([stair['level'], stair['to']]).toEqual(['L1', 'L2']);
      const d = result.derived!.stairs![id]!;
      expect(d.headroom, c.id).toBeDefined();
      expect(d.headroom!).toBeGreaterThanOrEqual(stair['minHeadroom'] as number);
      expect(result.diagnostics.map((x) => x.code)).not.toContain('FS-LINT-019');
      const rooms = committed['rooms'] as Record<string, Record<string, unknown>>;
      expect(rooms[d.footRoom!]!['level']).toBe('L1');
      expect(rooms[d.headRoom!]!['level']).toBe('L2');

      // At least 3' of floor at its foot and its head.
      const [land] = landings(committed);
      expect(land!.stair).toBe(id);
      expect(land!.foot ?? Infinity).toBeGreaterThanOrEqual(36 * BU_PER_INCH);
      expect(land!.head ?? Infinity).toBeGreaterThanOrEqual(36 * BU_PER_INCH);

      // Every upper room is reachable from the stair's head, through the upper level's doors and openings.
      const upstairs = c.rooms.filter((r) => r.level === 'L2').map((r) => r.id);
      expect(upstairs).toContain(d.headRoom);
      const { connected } = connections(committed, upstairs);
      expect([...reachable(upstairs, connected, d.headRoom!, () => true)].sort()).toEqual([...upstairs].sort());
      // And the engine agrees the whole house is reachable from the front door (Core 14.3), the stair included.
      for (const [rid, v] of Object.entries(result.derived!.circulation!)) expect(v.reachable, rid).toBe(true);

      // What the candidate reports of its stair is what the engine derives.
      expect(c.stair).toMatchObject({ id, footRoom: d.footRoom, headRoom: d.headRoom, risers: d.risers, headroom: d.headroom, minHeadroom: STAIR.minHeadroom });
      expect(c.stair!.clearAtFoot).toBe(land!.foot);
      expect(c.stair!.clearAtHead).toBe(land!.head);
    }
  });

  it('is deterministic: the same brief gives the same candidates, byte for byte', () => {
    expect(JSON.stringify(solve(doc(), { count: 3 }))).toBe(JSON.stringify(candidates()));
  });
});

describe('two levels: the batch', () => {
  it('upgrades a brief older than Core 0.4 first, in the same batch — minHeadroom is a 0.4 member', () => {
    const [c] = candidatesOf(BRIEFS[0]![0], BRIEFS[0]![1]);
    expect(c!.batch[0]).toEqual({ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.4' });
    const [d] = candidatesOf(BRIEFS[1]![0], BRIEFS[1]![1]);
    expect(d!.batch.filter((o) => o.op === 'setProperty' && o.path === '/floorspec')).toEqual([]);
  });

  it('adds each type once for both levels, and the stair last', () => {
    for (const [name, doc] of BRIEFS) {
      for (const c of candidatesOf(name, doc)) {
        const types = c.batch.filter((o) => o.op === 'addElement' && o.collection === 'types').map((o) => (o as unknown as { element: { name: string } }).element.name);
        expect(new Set(types).size, name).toBe(types.length);
        expect(c.batch.at(-1)).toMatchObject({ op: 'addElement', collection: 'stairs' });
      }
    }
  });

  it('gives each two-level candidate distinct IDs when asked, so all can be proposed at once', () => {
    const cs = solve(SAMPLES['two-storey-ground'](), { count: 3, distinctIds: true });
    const named = cs.map((c) => new Set(c.batch.flatMap((o) => ('id' in o && typeof o.id === 'string' && o.op !== 'setProperty' ? [o.id] : []))));
    for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++) expect([...named[i]!].filter((x) => named[j]!.has(x))).toEqual([]);
  });

  it('lays out one level when one is asked for, as before', () => {
    const [c] = solve(SAMPLES['two-storey-ground'](), { level: 'L1', count: 3 });
    expect(c!.levels).toEqual(['L1']);
    expect(c!.stair).toBeUndefined();
    expect(c!.batch.some((o) => o.op === 'addElement' && o.collection === 'stairs')).toBe(false);
    expect(c!.unplaced.map((u) => u.item).sort()).toEqual(['BED', 'BTH', 'PBA', 'PBR']);
  });
});

// ── the parts ─────────────────────────────────────────────────────────────────

describe('frames', () => {
  it('maps the footprint onto itself both ways, for a stair rising each way', () => {
    for (const dir of ['N', 'S', 'E', 'W'] as const) {
      const f: Frame = { dir, W: 40, D: 30 };
      const [WC, DC] = canonDims(f);
      expect(WC * DC).toBe(1200);
      for (const [x, y] of [
        [0, 0],
        [3, 7],
        [40, 30],
      ] as const) {
        const [cx, cy] = toCanon(f, x, y);
        expect(toActual(f, cx, cy)).toEqual([x, y]);
      }
      // Rising north in the frame is rising `dir` in the plan.
      const [ax, ay] = toActual(f, 5, 5);
      const [bx, by] = toActual(f, 5, 6);
      expect({ N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] }[dir]).toEqual([bx - ax, by - ay]);
    }
  });
});

describe('the stair and the upper level', () => {
  const doc = parseDocument(SAMPLES['two-storey-ground']());
  const upgrade = [{ op: 'setProperty' as const, id: '$document', path: '/floorspec', value: '0.4' }];
  const profile = profileOf(doc, 'L1', 'L2', idsOf(doc), upgrade)!;
  const lower = readBrief(TWO_STOREY, { level: 'L1', ignoreItemLevels: false, fulfilled: new Map() });
  const upperReqs = readBrief(TWO_STOREY, { level: 'L2', ignoreItemLevels: false, fulfilled: new Map() }).reqs.filter((r) => TWO_STOREY.items![r.item]!.level === 'L2');
  const layout = variants({ reqs: lower.reqs, adjacency: lower.adjacency })
    .find((v) => v.key === 'compact-great-room-1-flexpub-open')!
    .build()!;
  const segs = segments(layout);
  const access = planAccess(layout, segs)!;

  it('asks the engine how the stair rises: 14 risers between 9\' levels, the floor above open from the third step', () => {
    expect(profile).toEqual({ risers: 14, first: 2, run: 13 * STAIR.tread, riserHeight: Math.round((9 * 12 * BU_PER_INCH) / 14) });
  });

  it('stands the stair in a room people pass through, inside it, with 3\' of its floor before the foot', () => {
    const ps = placements(layout, segs, access, profile);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      const host = layout.spaces.find((s) => s.key === p.host)!;
      expect(['living', 'dining', 'circulation']).toContain(host.fn);
      const f: Frame = { dir: p.dir, W: layout.width, D: layout.depth };
      const r = toCanon(f, host.rect.x0, host.rect.y0);
      const s = toCanon(f, host.rect.x1, host.rect.y1);
      const [x0, x1] = [Math.min(r[0], s[0]) * GRID, Math.max(r[0], s[0]) * GRID];
      const [y0, y1] = [Math.min(r[1], s[1]) * GRID, Math.max(r[1], s[1]) * GRID];
      // The stair's sides clear of the room's walls, its head inside the room, and 3' before its foot.
      expect(p.xc - STAIR.width / 2).toBeGreaterThanOrEqual(x0 + REACH.separator);
      expect(p.xc + STAIR.width / 2).toBeLessThanOrEqual(x1);
      expect(p.H * GRID).toBeLessThanOrEqual(y1);
      expect(p.foot).toBe(p.H * GRID - profile.run);
      expect(p.foot - LANDING_CLEAR).toBeGreaterThanOrEqual(y0);
    }
  });

  it('cuts the well from before the first step that needs the opening to the head, beside a hall the stair arrives in, and reaches every upper room from it', () => {
    const planner = new UpperPlanner(upperReqs);
    let built = 0;
    for (const p of placements(layout, segs, access, profile)) {
      const f2 = frameFor(p, layout.width, layout.depth, profile);
      if (f2 === undefined) continue;
      const [up] = planner.build(p, f2, layout.family, 1);
      if (up === undefined) continue;
      built++;
      // The well, in the frame: from at or before the first step that needs the opening, clear of the wall there, to the head's line.
      expect(f2.well.y1).toBe(p.H);
      expect(f2.well.y0 * GRID).toBeLessThanOrEqual(p.foot + profile.first * STAIR.tread - REACH.interior);
      // …and never over the first step: the lowest steps keep the floor above them, so the headroom is measured.
      expect(f2.well.y0 * GRID).toBeGreaterThan(p.foot);
      expect(f2.well.x0 * GRID).toBeLessThanOrEqual(p.xc - STAIR.width / 2 - REACH.interior);
      expect(f2.well.x1 * GRID).toBeGreaterThanOrEqual(p.xc + STAIR.width / 2 + REACH.interior);
      // The upper level tiles the lower one's outline; the well is no room; the hall is across the head.
      expect(up.layout.width).toBe(layout.width);
      expect(up.layout.depth).toBe(layout.depth);
      const area = up.layout.spaces.reduce((t, s) => t + (s.rect.x1 - s.rect.x0) * (s.rect.y1 - s.rect.y0), 0);
      expect(area).toBe(layout.width * layout.depth);
      const well = up.layout.spaces.find((s) => s.key === up.well)!;
      expect(well.kind).toBe('well');
      const hall = up.layout.spaces.find((s) => s.key === up.arrival)!;
      expect(hall.kind).toBe('hall');
      const usegs = segments(up.layout);
      expect(usegs.some((s) => (s.left === well.key && s.right === hall.key) || (s.left === hall.key && s.right === well.key))).toBe(true);
      // Every upper room planned reachable from the hall, the well open to it on that side only.
      const uaccess = planAccess(up.layout, usegs, { arrival: up.arrival })!;
      expect(uaccess.entry).toEqual({ space: up.arrival });
      const open = usegs.filter((s) => uaccess.separators.has(s) && (s.left === well.key || s.right === well.key));
      expect(open.length).toBeGreaterThan(0);
      for (const s of open) expect([s.left, s.right]).toContain(hall.key);
      // Every upper room is in the brief, the solver's halls and closets, or a bonus room.
      for (const r of upperReqs) expect(up.layout.spaces.some((s) => s.req?.key === r.key)).toBe(true);
    }
    expect(built).toBeGreaterThan(0);
  });

  it('is put where the stair arrives in the plan: the head on the well\'s edge with the hall', () => {
    const [p] = placements(layout, segs, access, profile);
    const f: Frame = { dir: p!.dir, W: layout.width, D: layout.depth };
    const head = toActual(f, p!.xc, p!.H * GRID, GRID);
    const foot = toActual(f, p!.xc, p!.foot, GRID);
    expect(Math.hypot(head[0] - foot[0], head[1] - foot[1])).toBe(profile.run);
  });
});
