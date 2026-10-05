import {
  dist,
  distToSegment,
  ftIn,
  interval,
  len,
  measure,
  midpoint,
  onSegment,
  SIXTEENTH,
  INCH,
  sqft,
  type Box,
  type Measured,
  type MeasuredOpening,
  type MeasuredWall,
  type Pt,
} from './measure.js';
import type { Doc } from './seeds.js';
import type { AnswerExpectation, Assertion, AssertionResult, OpeningKind, RoomRef, Score, WallSel } from './types.js';

/**
 * The scorer: every assertion of a task, checked against the resulting model with the seed beside
 * it. Pure — no network, no clock — so it is unit-tested on hand-made models.
 */

export interface ScoreInput {
  readonly seed: Doc;
  readonly result: Doc;
  /** The agent's final reply; only `answer` and `asked` read it. */
  readonly reply: string | null;
}

interface Ctx {
  readonly seed: Measured;
  readonly result: Measured;
  readonly reply: string | null;
}

const DEFAULT_TOL = SIXTEENTH;

const ok = (kind: string, detail: string): AssertionResult => ({ kind, pass: true, detail });
const fail = (kind: string, detail: string): AssertionResult => ({ kind, pass: false, detail });

export function score(input: ScoreInput, assertions: readonly Assertion[]): Score {
  const ctx: Ctx = { seed: measure(input.seed), result: measure(input.result), reply: input.reply };
  const results = assertions.map((a) => check(ctx, a));
  return { pass: results.every((r) => r.pass), results };
}

/** Score against already-measured models (the harness measures the seed once per task). */
export function scoreMeasured(seed: Measured, result: Measured, reply: string | null, assertions: readonly Assertion[]): Score {
  const ctx: Ctx = { seed, result, reply };
  const results = assertions.map((a) => check(ctx, a));
  return { pass: results.every((r) => r.pass), results };
}

function check(ctx: Ctx, a: Assertion): AssertionResult {
  try {
    return CHECKS[a.kind](ctx, a as never);
  } catch (error) {
    return fail(a.kind, `could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Checks = { [K in Assertion['kind']]: (ctx: Ctx, a: Extract<Assertion, { kind: K }>) => AssertionResult };

const CHECKS: Checks = {
  valid: ({ result }) =>
    result.valid
      ? ok('valid', 'the resulting model is valid')
      : fail('valid', `the resulting model is not valid: ${result.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('; ')}`),

  unchanged: ({ seed, result }) =>
    result.hash !== null && result.hash === seed.hash ? ok('unchanged', 'the model is exactly the seed') : fail('unchanged', 'the model was changed'),

  changed: ({ seed, result }) => (result.hash !== seed.hash ? ok('changed', 'the model was changed') : fail('changed', 'nothing was changed')),

  roomEdges: ({ seed, result }, a) => {
    const tol = len(a.tol ?? DEFAULT_TOL);
    const keepTol = len(a.keepTol ?? a.tol ?? DEFAULT_TOL);
    const before = seed.rooms.get(a.room)?.box;
    const after = result.rooms.get(a.room)?.box;
    if (before === undefined) throw new Error(`the seed has no placed room ${a.room}`);
    if (after === undefined) return fail('roomEdges', `${a.room} is missing or not placed in the result`);
    const wrong: string[] = [];
    for (const side of ['minX', 'maxX', 'minY', 'maxY'] as const) {
      const want = before[side] + (a.delta[side] === undefined ? 0 : len(a.delta[side]));
      const got = after[side];
      if (Math.abs(got - want) > (a.delta[side] === undefined ? keepTol : tol)) wrong.push(`${side} moved ${ftIn(got - before[side])}, wanted ${ftIn(want - before[side])}`);
    }
    return wrong.length === 0 ? ok('roomEdges', `${a.room}: ${describeDelta(before, after)}`) : fail('roomEdges', `${a.room}: ${wrong.join('; ')}`);
  },

  roomsUnchanged: ({ seed, result }, a) => {
    const tol = len(a.tol ?? DEFAULT_TOL);
    const changed: string[] = [];
    for (const id of a.rooms) {
      const before = seed.rooms.get(id);
      const after = result.rooms.get(id);
      if (before?.box === undefined || before.area === undefined) throw new Error(`the seed has no placed room ${id}`);
      if (after?.box === undefined || after.area === undefined) {
        changed.push(`${id} is gone or not placed`);
        continue;
      }
      const b = before.box;
      const c = after.box;
      const moved = (['minX', 'maxX', 'minY', 'maxY'] as const).filter((s) => Math.abs(b[s] - c[s]) > tol);
      const perimeter = 2 * (b.maxX - b.minX + (b.maxY - b.minY));
      if (moved.length > 0 || Math.abs(after.area - before.area) > tol * perimeter) {
        changed.push(`${id} (${describeDelta(b, c)}; area ${sqft(before.area).toFixed(1)} → ${sqft(after.area).toFixed(1)} ft²)`);
      }
    }
    return changed.length === 0 ? ok('roomsUnchanged', `${a.rooms.join(', ')} unchanged`) : fail('roomsUnchanged', `changed: ${changed.join('; ')}`);
  },

  roomCount: ({ seed, result }, a) => {
    const count = (m: Measured) => [...m.rooms.values()].filter((r) => a.level === undefined || r.level === a.level).length;
    const before = count(seed);
    const after = count(result);
    const want = a.equals ?? before + (a.delta ?? 0);
    return after === want ? ok('roomCount', `${String(after)} room(s)`) : fail('roomCount', `${String(after)} room(s), wanted ${String(want)}`);
  },

  roomExists: ({ seed, result }, a) => {
    const name = a.name === undefined ? null : new RegExp(a.name, 'i');
    const fn = a.function === undefined ? null : new RegExp(a.function, 'i');
    const near: string[] = [];
    for (const r of result.rooms.values()) {
      if (a.new === true && seed.rooms.has(r.id)) continue;
      if (a.level !== undefined && r.level !== a.level) continue;
      if (name !== null && !name.test(r.name)) continue;
      if (fn !== null && !fn.test(r.function)) continue;
      if (r.box === undefined || r.area === undefined) {
        near.push(`${r.id} is not placed`);
        continue;
      }
      const why = boxProblems(r.box, a.bbox, a.size);
      if (a.areaSqft !== undefined && (sqft(r.area) < a.areaSqft[0] || sqft(r.area) > a.areaSqft[1])) why.push(`area ${sqft(r.area).toFixed(1)} ft²`);
      if (why.length === 0) return ok('roomExists', `${r.id} "${r.name}" ${ftIn(r.box.maxX - r.box.minX)} E-W × ${ftIn(r.box.maxY - r.box.minY)} N-S`);
      near.push(`${r.id} "${r.name}": ${why.join(', ')}`);
    }
    return fail('roomExists', near.length === 0 ? 'no room matches' : `no room matches in full — ${near.join('; ')}`);
  },

  openingAdded: ({ seed, result }, a) => {
    const tol = len(a.tol ?? DEFAULT_TOL);
    const walls = selectWalls(result, a.on);
    const fresh = [...result.openings.values()].filter((o) => !seed.openings.has(o.id));
    const ofKind = fresh.filter((o) => kindMatches(o, a.type));
    const here = ofKind.filter((o) => walls.has(o.wall));
    const want = a.count ?? 1;
    if (walls.size === 0) return fail('openingAdded', `no wall matches ${JSON.stringify(a.on)} in the result`);
    if (here.length !== want) {
      const elsewhere = ofKind.filter((o) => !walls.has(o.wall)).map((o) => `${o.id} in ${o.wall}`);
      const other = fresh.filter((o) => !kindMatches(o, a.type)).map((o) => `${o.id} (${o.kind}) in ${o.wall}`);
      return fail(
        'openingAdded',
        `${String(here.length)} new ${a.type}(s) in ${[...walls].join('/')}, wanted ${String(want)}` +
          (elsewhere.length > 0 ? `; new ${a.type}(s) elsewhere: ${elsewhere.join(', ')}` : '') +
          (other.length > 0 ? `; other new openings: ${other.join(', ')}` : ''),
      );
    }
    const problems: string[] = [];
    for (const o of here) {
      if (a.width !== undefined && Math.abs(o.width - len(a.width)) > tol) problems.push(`${o.id} is ${ftIn(o.width)} wide, wanted ${ftIn(len(a.width))}`);
      if (a.widthRange !== undefined) {
        const [lo, hi] = interval(a.widthRange);
        if (o.width < lo - tol || o.width > hi + tol) problems.push(`${o.id} is ${ftIn(o.width)} wide, wanted ${ftIn(lo)}–${ftIn(hi)}`);
      }
      if (a.centred === true) {
        const wall = result.walls.get(o.wall);
        if (wall === undefined) problems.push(`${o.id}'s wall ${o.wall} is not in the result`);
        else {
          const off = centreOffset(o, wall);
          if (off > tol) problems.push(`${o.id} is ${ftIn(off)} off centre`);
        }
      }
    }
    return problems.length === 0
      ? ok('openingAdded', here.map((o) => `${o.id} ${o.kind} ${ftIn(o.width)} in ${o.wall}`).join(', '))
      : fail('openingAdded', problems.join('; '));
  },

  openingMoved: ({ seed, result }, a) => {
    const tol = len(a.tol ?? DEFAULT_TOL);
    const before = seed.openings.get(a.opening);
    if (before === undefined) throw new Error(`the seed has no opening ${a.opening}`);
    const v = vector(a.by);
    const want: Pt = [before.mid[0] + v[0], before.mid[1] + v[1]];
    const same = result.openings.get(a.opening);
    const candidates = same !== undefined ? [same] : [...result.openings.values()].filter((o) => !seed.openings.has(o.id) && o.fill === before.fill && o.level === before.level);
    for (const o of candidates) {
      if (dist(o.mid, want) <= tol && Math.abs(o.width - before.width) <= tol) return ok('openingMoved', `${o.id} centre moved by ${vectorText([o.mid[0] - before.mid[0], o.mid[1] - before.mid[1]])}`);
    }
    if (candidates.length === 0) return fail('openingMoved', `${a.opening} is gone and nothing replaced it`);
    return fail(
      'openingMoved',
      candidates.map((o) => `${o.id} centre moved by ${vectorText([o.mid[0] - before.mid[0], o.mid[1] - before.mid[1]])}, width ${ftIn(o.width)}`).join('; ') +
        `; wanted ${vectorText(v)}, width ${ftIn(before.width)}`,
    );
  },

  openingAt: ({ seed, result }, a) => {
    const tol = len(a.tol ?? DEFAULT_TOL);
    const before = seed.openings.get(a.near);
    if (before === undefined) throw new Error(`the seed has no opening ${a.near}`);
    const there = [...result.openings.values()].filter((o) => o.level === before.level && kindMatches(o, a.type) && dist(o.mid, before.mid) <= tol);
    if (there.length !== 1) {
      return fail('openingAt', `${String(there.length)} ${a.type}(s) centred where ${a.near} was${there.length > 0 ? `: ${there.map((o) => `${o.id} ${ftIn(o.width)}`).join(', ')}` : ''}`);
    }
    const o = there[0] as MeasuredOpening;
    const problems: string[] = [];
    if (a.width !== undefined && Math.abs(o.width - len(a.width)) > tol) problems.push(`${o.id} is ${ftIn(o.width)} wide, wanted ${ftIn(len(a.width))}`);
    if (a.widthAtLeast !== undefined && o.width < len(a.widthAtLeast) - tol) problems.push(`${o.id} is ${ftIn(o.width)} wide, wanted at least ${ftIn(len(a.widthAtLeast))}`);
    if (a.widthAbove !== undefined && o.width <= len(a.widthAbove) + tol) problems.push(`${o.id} is ${ftIn(o.width)} wide, wanted more than ${ftIn(len(a.widthAbove))}`);
    const overlapping = [...result.openings.values()].filter((p) => p.id !== o.id && p.level === o.level && (distToSegment(p.mid, o.start, o.end) <= tol || distToSegment(o.mid, p.start, p.end) <= tol));
    if (overlapping.length > 0) problems.push(`overlapping it: ${overlapping.map((p) => p.id).join(', ')}`);
    return problems.length === 0 ? ok('openingAt', `${o.id} ${o.kind} ${ftIn(o.width)} centred where ${a.near} was`) : fail('openingAt', problems.join('; '));
  },

  openingRemoved: ({ seed, result }, a) => {
    const tol = len(a.tol ?? INCH);
    const before = seed.openings.get(a.opening);
    if (before === undefined) throw new Error(`the seed has no opening ${a.opening}`);
    if (result.openings.has(a.opening)) return fail('openingRemoved', `${a.opening} is still there`);
    const replaced = [...result.openings.values()].filter((o) => o.level === before.level && o.kind === before.kind && dist(o.mid, before.mid) <= tol);
    return replaced.length === 0 ? ok('openingRemoved', `${a.opening} removed`) : fail('openingRemoved', `replaced by ${replaced.map((o) => o.id).join(', ')}`);
  },

  openingsUnchanged: ({ seed, result }, a) => {
    const tol = len(a.tol ?? DEFAULT_TOL);
    const except = new Set(a.except ?? []);
    const ids = a.only ?? [...seed.openings.keys()].filter((id) => !except.has(id));
    const changed: string[] = [];
    for (const id of ids) {
      const before = seed.openings.get(id);
      if (before === undefined) throw new Error(`the seed has no opening ${id}`);
      const after = result.openings.get(id);
      if (after === undefined) changed.push(`${id} is gone`);
      else if (dist(after.mid, before.mid) > tol || Math.abs(after.width - before.width) > tol)
        changed.push(`${id} moved ${vectorText([after.mid[0] - before.mid[0], after.mid[1] - before.mid[1]])}, width ${ftIn(before.width)} → ${ftIn(after.width)}`);
    }
    return changed.length === 0 ? ok('openingsUnchanged', `${String(ids.length)} opening(s) unchanged`) : fail('openingsUnchanged', changed.join('; '));
  },

  levelCount: ({ seed, result }, a) => {
    const want = a.equals ?? seed.levels.size + (a.delta ?? 0);
    return result.levels.size === want ? ok('levelCount', `${String(want)} level(s)`) : fail('levelCount', `${String(result.levels.size)} level(s), wanted ${String(want)}`);
  },

  levelExists: ({ seed, result }, a) => {
    const name = a.name === undefined ? null : new RegExp(a.name, 'i');
    const near: string[] = [];
    for (const [id, l] of result.levels) {
      if (a.new === true && seed.levels.has(id)) continue;
      if (name !== null && !name.test(l.name ?? '')) {
        near.push(`${id} name "${l.name ?? ''}"`);
        continue;
      }
      const why: string[] = [];
      if (a.elevation !== undefined) {
        const [lo, hi] = interval(a.elevation);
        if (l.elevation < lo || l.elevation > hi) why.push(`elevation ${ftIn(l.elevation)}`);
      }
      if (a.height !== undefined) {
        const [lo, hi] = interval(a.height);
        if (l.height < lo || l.height > hi) why.push(`height ${ftIn(l.height)}`);
      }
      if (why.length === 0) return ok('levelExists', `${id}: elevation ${ftIn(l.elevation)}, height ${ftIn(l.height)}`);
      near.push(`${id}: ${why.join(', ')}`);
    }
    return fail('levelExists', near.length === 0 ? 'no level matches' : near.join('; '));
  },

  footprintCopied: ({ seed, result }, a) => {
    const tol = len(a.tol ?? DEFAULT_TOL);
    const outline = [...seed.walls.values()].filter((w) => w.level === a.from && w.exterior);
    if (outline.length === 0) throw new Error(`level ${a.from} has no exterior walls in the seed`);
    const fresh = [...result.levels.keys()].filter((id) => !seed.levels.has(id));
    if (fresh.length === 0) return fail('footprintCopied', 'no new level');
    const reports: string[] = [];
    for (const level of fresh) {
      const walls = [...result.walls.values()].filter((w) => w.level === level);
      const missing = outline.filter((s) => !covered(s.start, s.end, walls, tol));
      if (missing.length === 0) return ok('footprintCopied', `${level} has walls along all ${String(outline.length)} exterior wall lines of ${a.from}`);
      reports.push(`${level} (${String(walls.length)} walls) misses ${missing.map((w) => w.id).join(', ')}`);
    }
    return fail('footprintCopied', reports.join('; '));
  },

  wallLine: ({ seed, result }, a) => {
    const tol = len(a.tol ?? DEFAULT_TOL);
    const [lo, hi] = interval(a.at);
    const [s0, s1] = interval(a.span);
    const old = [...seed.walls.values()].filter((w) => w.level === a.level);
    const fresh = [...result.walls.values()].filter((w) => w.level === a.level && !old.some((o) => onSegment(w.start, w.end, o.start, o.end, tol)));
    const ns = a.orientation === 'ns';
    const along = fresh.filter((w) => {
      const c0 = ns ? w.start[0] : w.start[1];
      const c1 = ns ? w.end[0] : w.end[1];
      return Math.abs(c0 - c1) <= tol && c0 >= lo - tol && c0 <= hi + tol;
    });
    if (along.length === 0) {
      return fail('wallLine', `no new ${ns ? 'north–south' : 'east–west'} wall at ${ftIn(lo)}–${ftIn(hi)}; new walls: ${fresh.map((w) => `${w.id} ${pt(w.start)}→${pt(w.end)}`).join(', ') || 'none'}`);
    }
    const spans = along.map((w) => {
      const p = ns ? [w.start[1], w.end[1]] : [w.start[0], w.end[0]];
      return [Math.min(p[0] as number, p[1] as number), Math.max(p[0] as number, p[1] as number)] as const;
    });
    const gap = uncovered(spans, s0, s1, tol);
    return gap === null
      ? ok('wallLine', along.map((w) => `${w.id} ${pt(w.start)}→${pt(w.end)}`).join(', '))
      : fail('wallLine', `the new wall line leaves ${ftIn(gap[0])}–${ftIn(gap[1])} uncovered (${along.map((w) => `${w.id} ${pt(w.start)}→${pt(w.end)}`).join(', ')})`);
  },

  diagnosticAbsent: ({ result }, a) => {
    const hits = result.diagnostics.filter((d) => d.code === a.code);
    return hits.length === 0 ? ok('diagnosticAbsent', `no ${a.code}`) : fail('diagnosticAbsent', `${a.code} is still reported: ${hits.map((d) => d.message).join('; ')}`);
  },

  answer: ({ seed, reply }, a) => {
    const line = answerLine(reply);
    if (line === null) return fail('answer', 'the reply has no ANSWER: line');
    const verdict = judgeAnswer(line, a.expect, seed);
    return verdict === null ? ok('answer', `ANSWER: ${line}`) : fail('answer', `ANSWER: ${line} — ${verdict}`);
  },

  asked: ({ seed, result, reply }) => {
    if (result.hash !== seed.hash) return fail('asked', 'the model was changed instead of asking');
    if (reply === null || !asksSomething(reply)) return fail('asked', 'the reply asks no question');
    return ok('asked', 'nothing changed, and the reply asks');
  },

  anyOf: (ctx, a) => {
    const outcomes = a.groups.map((g) => g.map((x) => check(ctx, x)));
    const index = outcomes.findIndex((g) => g.every((r) => r.pass));
    if (index >= 0) return ok('anyOf', `outcome ${String(index + 1)} of ${String(a.groups.length)}: ${(outcomes[index] ?? []).map((r) => r.detail).join('; ')}`);
    return fail(
      'anyOf',
      outcomes.map((g, i) => `outcome ${String(i + 1)}: ${g.filter((r) => !r.pass).map((r) => `${r.kind} — ${r.detail}`).join('; ')}`).join(' | '),
    );
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

export function resolveRooms(m: Measured, ref: RoomRef): string[] {
  if (typeof ref === 'string') return m.rooms.has(ref) ? [ref] : [];
  const re = new RegExp(ref.name, 'i');
  return [...m.rooms.values()].filter((r) => re.test(r.name) && (ref.level === undefined || r.level === ref.level)).map((r) => r.id);
}

export function selectWalls(m: Measured, sel: WallSel): Set<string> {
  if ('walls' in sel) return new Set(sel.walls.filter((w) => m.walls.has(w)));
  if ('between' in sel) {
    const a = new Set(resolveRooms(m, sel.between[0]));
    const b = new Set(resolveRooms(m, sel.between[1]));
    return new Set([...m.walls.values()].filter((w) => [...w.rooms].some((r) => a.has(r)) && [...w.rooms].some((r) => b.has(r))).map((w) => w.id));
  }
  const rooms = new Set(resolveRooms(m, sel.of));
  return new Set(
    [...m.walls.values()]
      .filter((w) => [...rooms].some((r) => w.sideOf.has(r) && (sel.side === undefined || w.sideOf.get(r) === sel.side)) && (sel.exterior !== true || w.exterior))
      .map((w) => w.id),
  );
}

function kindMatches(o: MeasuredOpening, kind: OpeningKind): boolean {
  return kind === 'door-or-opening' ? o.kind === 'door' || o.kind === 'opening' : o.kind === kind;
}

/** How far an opening's centre is from the nearest reading of its wall's centre, along the wall. */
export function centreOffset(o: MeasuredOpening, wall: MeasuredWall): number {
  const L = dist(wall.start, wall.end);
  const ux = (wall.end[0] - wall.start[0]) / L;
  const uy = (wall.end[1] - wall.start[1]) / L;
  const t = (p: Pt) => (p[0] - wall.start[0]) * ux + (p[1] - wall.start[1]) * uy;
  const centres = [midpoint(wall.start, wall.end), ...wall.faceMids];
  return Math.min(...centres.map((c) => Math.abs(t(o.mid) - t(c))));
}

function vector(by: Partial<Record<'north' | 'east' | 'south' | 'west', string | number>>): Pt {
  let x = 0;
  let y = 0;
  if (by.east !== undefined) x += len(by.east);
  if (by.west !== undefined) x -= len(by.west);
  if (by.north !== undefined) y += len(by.north);
  if (by.south !== undefined) y -= len(by.south);
  return [x, y];
}

function vectorText(v: Pt): string {
  const parts: string[] = [];
  if (Math.abs(v[0]) > 0.5) parts.push(`${ftIn(Math.abs(v[0]))} ${v[0] > 0 ? 'east' : 'west'}`);
  if (Math.abs(v[1]) > 0.5) parts.push(`${ftIn(Math.abs(v[1]))} ${v[1] > 0 ? 'north' : 'south'}`);
  return parts.length === 0 ? 'nothing' : parts.join(' and ');
}

const pt = (p: Pt): string => `(${ftIn(p[0])}, ${ftIn(p[1])})`;

function describeDelta(b: Box, c: Box): string {
  const parts = (['minX', 'maxX', 'minY', 'maxY'] as const)
    .filter((s) => Math.abs(b[s] - c[s]) > 0.5)
    .map((s) => `${s} ${c[s] - b[s] > 0 ? '+' : ''}${ftIn(c[s] - b[s])}`);
  return parts.length === 0 ? 'outline unchanged' : parts.join(', ');
}

function boxProblems(b: Box, bbox?: Partial<Record<'minX' | 'maxX' | 'minY' | 'maxY', readonly [string | number, string | number]>>, size?: Partial<Record<'eastWest' | 'northSouth', readonly [string | number, string | number]>>): string[] {
  const why: string[] = [];
  for (const side of ['minX', 'maxX', 'minY', 'maxY'] as const) {
    const range = bbox?.[side];
    if (range === undefined) continue;
    const [lo, hi] = interval(range);
    if (b[side] < lo || b[side] > hi) why.push(`${side} ${ftIn(b[side])} not in ${ftIn(lo)}–${ftIn(hi)}`);
  }
  for (const [key, value] of [['eastWest', b.maxX - b.minX], ['northSouth', b.maxY - b.minY]] as const) {
    const range = size?.[key];
    if (range === undefined) continue;
    const [lo, hi] = interval(range);
    if (value < lo || value > hi) why.push(`${key} ${ftIn(value)} not in ${ftIn(lo)}–${ftIn(hi)}`);
  }
  return why;
}

/** Is segment [a, b] covered end to end by the collinear walls among `walls`? */
function covered(a: Pt, b: Pt, walls: readonly MeasuredWall[], tol: number): boolean {
  const L = dist(a, b);
  const ux = (b[0] - a[0]) / L;
  const uy = (b[1] - a[1]) / L;
  const offLine = (p: Pt) => Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux);
  const t = (p: Pt) => (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
  const spans = walls
    .filter((w) => offLine(w.start) <= tol && offLine(w.end) <= tol)
    .map((w) => [Math.min(t(w.start), t(w.end)), Math.max(t(w.start), t(w.end))] as const);
  return uncovered(spans, 0, L, tol) === null;
}

/** The first gap longer than tol in [s0, s1] that the spans leave, or null. */
function uncovered(spans: readonly (readonly [number, number])[], s0: number, s1: number, tol: number): [number, number] | null {
  const sorted = [...spans].sort((p, q) => p[0] - q[0]);
  let reach = s0;
  for (const [lo, hi] of sorted) {
    if (lo > reach + tol) return [reach, lo];
    reach = Math.max(reach, hi);
    if (reach >= s1 - tol) return null;
  }
  return reach >= s1 - tol ? null : [reach, s1];
}

/** The text after the last `ANSWER:` in a reply (markdown emphasis allowed), or null. */
export function answerLine(reply: string | null): string | null {
  if (reply === null) return null;
  const matches = [...reply.matchAll(/^[\s>*_#-]*ANSWER\s*[:：]\s*\**\s*(.*?)\s*$/gim)];
  const last = matches.at(-1);
  if (last === undefined) return null;
  return (last[1] ?? '').replace(/\*+$/g, '').replace(/^`|`$/g, '').trim();
}

/** Null when the answer is right; otherwise why not. */
export function judgeAnswer(line: string, expect: AnswerExpectation, seed: Measured): string | null {
  if ('number' in expect) {
    const m = /-?\d[\d,]*(?:\.\d+)?/.exec(line);
    if (m === null) return 'no number';
    const n = Number(m[0].replace(/,/g, ''));
    return Math.abs(n - expect.number) <= expect.tol ? null : `${String(n)}, wanted ${String(expect.number)} ± ${String(expect.tol)}`;
  }
  if ('yesno' in expect) {
    const m = /\b(yes|no)\b/i.exec(line);
    if (m === null) return 'neither yes nor no';
    return (m[1] ?? '').toLowerCase() === expect.yesno ? null : `said ${(m[1] ?? '').toLowerCase()}`;
  }
  if ('set' in expect) {
    const named = mentioned(line, expect.set.universe.map((u) => ({ key: u, aliases: [u] })));
    return sameSet(named, expect.set.expect);
  }
  // Rooms: names (longest first, so "Bedroom 2" is not read as "Bedroom") or IDs.
  const rooms = [...seed.rooms.values()].map((r) => ({ key: r.id, aliases: [r.name, r.id].filter((s) => s.length > 0) }));
  const named = mentioned(line, rooms);
  return sameSet(named, expect.rooms);
}

function mentioned(line: string, items: readonly { key: string; aliases: readonly string[] }[]): Set<string> {
  const pairs = items.flatMap((i) => i.aliases.map((alias) => ({ key: i.key, alias }))).sort((a, b) => b.alias.length - a.alias.length);
  let rest = ` ${line} `;
  const found = new Set<string>();
  for (const { key, alias } of pairs) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'giu');
    if (re.test(rest)) {
      found.add(key);
      rest = rest.replace(re, '$1 ');
    }
  }
  return found;
}

function sameSet(named: Set<string>, expect: readonly string[]): string | null {
  const want = new Set(expect);
  const missing = [...want].filter((x) => !named.has(x));
  const extra = [...named].filter((x) => !want.has(x));
  if (missing.length === 0 && extra.length === 0) return null;
  return [missing.length > 0 ? `missing ${missing.join(', ')}` : '', extra.length > 0 ? `also named ${extra.join(', ')}` : ''].filter((s) => s.length > 0).join('; ');
}

/**
 * Whether a reply asks the homeowner something. A question mark is one way; an explicit request for
 * the missing decision is another ("Tell me the width you want", "Let me know which bedroom").
 * Proxy run 2026-10-05, task 025, asked with "Tell me the width you want … and I'll put it in a
 * changeset" and was scored as not asking — a scorer bug, not an agent failure.
 */
export function asksSomething(reply: string): boolean {
  if (reply.includes('?')) return true;
  return /\b(tell me|let me know|which (one|would you|do you)|do you want|would you like|say which|choose|pick one)\b/i.test(reply);
}
