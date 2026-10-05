/**
 * Ranking. A candidate's score is a weighted sum of three parts, each from 0 to 1:
 *
 *   total = 100 × (0.5 · briefFit + 0.3 · circulation + 0.2 · findings), to a hundredth
 *
 * **Brief fit** = 0.35 · items + 0.30 · adjacency + 0.15 · shape + 0.10 · daylight + 0.10 · efficiency
 * - items: for each program item, the share of its count placed times the mean area score of its
 *   rooms — 1 for a net area from 92% to 120% of the target, falling 3 points per 1% below and 1.5
 *   per 1% above, halved below the item's minArea;
 * - adjacency: the brief's adjacencies met (required and preferred: adjacent; forbidden: not), each
 *   weighted by its `weight` and doubled for required and forbidden;
 * - shape: per room, 1 up to a 1.6 : 1 aspect (2.5 : 1 for baths, closets, laundries, garages),
 *   falling to 0 at 1.4 more; 30% off a room narrower than its function's least dimension;
 * - daylight: the share of habitable rooms (bedrooms, living, dining, kitchen, office) with an
 *   outside wall long enough for a window — a bedroom without one has no egress;
 * - efficiency: the brief's target areas over the plan's net area, 1 from 85% up, 0 at 55%.
 * Items the solver could not place on this level (another level preferred, exterior spaces) are
 * reported as unplaced and left out of the brief fit, with the adjacencies that name them.
 *
 * **Circulation** = reach × (1 − penalties), penalties summed and capped at 1: for each room, the
 * cheapest route from the front door through the connections — passing through a kitchen 0.04, a
 * private room 0.15, a bath 0.2, a utility room 0.1 (none for a garage reached through its
 * laundry, a closet through its bedroom, an en-suite room through its bedroom), and 0.5 for every
 * bedroom reached only through another; 0.02 per door beyond the fourth; and twice the share of
 * hall area above 8% of the plan; 0.1 when the front door is not on the front (south) face.
 *
 * **Findings** = 1 − 0.15 per engine warning − 0.03 per information (program lints excluded:
 * brief fit already counts them). A candidate with any error is never scored: it is dropped.
 */
import { inNetwork } from './access.js';
import type { Layout, Space } from './layout.js';
import { pairKey } from './layout.js';
import type { Measures } from './measure.js';
import { minDim, type Brief } from './program.js';
import { SQ_BU_PER_SQ_FT } from './units.js';

export interface ScoreDetail {
  /** Items placed at their counts and areas, 0–1. */
  readonly items: number;
  /** The brief's adjacencies met, weighted, 0–1. */
  readonly adjacency: number;
  /** Room proportions, 0–1. */
  readonly shape: number;
  /** Habitable rooms with an outside wall for a window, as a share. */
  readonly daylight: number;
  /** Target area over net area, scored 0–1. */
  readonly efficiency: number;
  /** Whether the front door is on the front (south) face. */
  readonly frontEntry: boolean;
  /** Rooms reachable from the front door, as a share. */
  readonly reach: number;
  /** Bedrooms reached only through another bedroom. */
  readonly sleepingThroughSleeping: number;
  /** Summed route penalties (see the module comment). */
  readonly routePenalty: number;
  /** Hall area as a share of the plan's net area. */
  readonly hallShare: number;
  readonly warnings: number;
  readonly infos: number;
}

export interface ScoreBreakdown {
  /** 0–100, rounded to a hundredth. */
  readonly total: number;
  /** 0–1, rounded to a thousandth. */
  readonly briefFit: number;
  readonly circulation: number;
  readonly findings: number;
  readonly detail: ScoreDetail;
  /** Whether the numbers are the engine's (`engine`) or the quick estimate from rectangles. */
  readonly source: Measures['source'];
}

const round = (x: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Area score of one room: 1 within 92–120% of target. */
export function areaScore(area: number, target: number, min: number | undefined): number {
  const a = area / target;
  let s = a < 0.92 ? 1 - (0.92 - a) * 3 : a > 1.2 ? 1 - (a - 1.2) * 1.5 : 1;
  if (min !== undefined && area < min) s *= 0.5;
  return clamp01(s);
}

const LOOSE = new Set(['bath', 'storage', 'laundry', 'utility', 'mechanical', 'circulation', 'garage']);

/** The cost of passing through `n` on the way to `t`. */
function through(n: Space, t: Space): { cost: number; sleeping: boolean } {
  if (n.kind === 'hall' || n.fn === 'circulation' || n.fn === 'living' || n.fn === 'dining') return { cost: 0, sleeping: false };
  if (n.fn === 'kitchen') return { cost: 0.04, sleeping: false };
  if (n.fn === 'sleeping') {
    if (t.req?.host === n.key || t.kind === 'closet') return { cost: 0, sleeping: false };
    return t.fn === 'sleeping' ? { cost: 0.5, sleeping: true } : { cost: 0.15, sleeping: false };
  }
  if (n.fn === 'bath') return { cost: t.kind === 'closet' || t.fn === 'storage' ? 0.05 : 0.2, sleeping: false };
  if (n.fn === 'laundry' || n.fn === 'utility') return { cost: t.fn === 'garage' ? 0 : 0.1, sleeping: false };
  if (n.fn === 'garage') return { cost: 0.2, sleeping: false };
  return { cost: 0.1, sleeping: false };
}

interface Route {
  readonly cost: number;
  readonly hops: number;
  readonly sleeping: boolean;
}

/** The cheapest route from `entry` to `target` over the connected pairs (Dijkstra; ties by key). */
function route(layout: Layout, connected: ReadonlySet<string>, entry: string, target: Space): Route | undefined {
  const keys = layout.spaces.map((s) => s.key).sort();
  const byKey = new Map(layout.spaces.map((s) => [s.key, s]));
  const best = new Map<string, Route>([[entry, { cost: 0, hops: 0, sleeping: false }]]);
  const done = new Set<string>();
  for (;;) {
    let k: string | undefined;
    for (const x of keys) if (!done.has(x) && best.has(x) && (k === undefined || best.get(x)!.cost < best.get(k)!.cost)) k = x;
    if (k === undefined) return undefined;
    if (k === target.key) return best.get(k);
    done.add(k);
    const here = best.get(k)!;
    const pass = k === entry ? { cost: 0, sleeping: false } : through(byKey.get(k)!, target);
    for (const n of keys) {
      if (done.has(n) || !connected.has(pairKey(k, n))) continue;
      const next: Route = { cost: here.cost + pass.cost + 0.001, hops: here.hops + 1, sleeping: here.sleeping || pass.sleeping };
      const old = best.get(n);
      if (old === undefined || next.cost < old.cost) best.set(n, next);
    }
  }
}

export interface ScoreContext {
  /** The space the front door opens into. */
  readonly entry: string;
  /** Whether the front door is on the south face. */
  readonly frontEntry: boolean;
  /** Spaces with an outside wall long enough for a window. */
  readonly daylit: ReadonlySet<string>;
}

const HABITABLE = new Set(['sleeping', 'living', 'dining', 'kitchen', 'office']);

export function score(layout: Layout, brief: Brief, m: Measures, ctx: ScoreContext): ScoreBreakdown {
  const entry = ctx.entry;
  const byKey = new Map(layout.spaces.map((s) => [s.key, s]));
  const unplaced = new Set(brief.unplaced.map((u) => u.item));

  // Brief fit: items.
  const itemScores: number[] = [];
  for (const [id, item] of Object.entries(brief.items)) {
    if (unplaced.has(id)) continue;
    const v = m.items[id];
    const count = item.count ?? 1;
    const rooms = v?.rooms ?? [];
    const placed = Math.min(1, rooms.length / count);
    const scores = rooms.map((k) => {
      const room = m.rooms.get(k);
      const s = byKey.get(k);
      if (room === undefined || s?.req === undefined) return 1; // fulfilled elsewhere already
      return areaScore(room.area, s.req.target, item.minArea === undefined ? undefined : item.minArea / SQ_BU_PER_SQ_FT);
    });
    const mean = scores.length === 0 ? 0 : scores.reduce((p, q) => p + q, 0) / scores.length;
    itemScores.push(placed * mean);
  }
  const items = itemScores.length === 0 ? 1 : itemScores.reduce((p, q) => p + q, 0) / itemScores.length;

  // Brief fit: adjacency.
  let won = 0;
  let all = 0;
  for (const a of m.adjacency) {
    if (unplaced.has(a.a) || unplaced.has(a.b)) continue;
    const w = a.weight * (a.kind === 'preferred' ? 1 : 2);
    all += w;
    if (a.kind === 'forbidden' ? !a.adjacent : a.adjacent) won += w;
  }
  const adjacency = all === 0 ? 1 : won / all;

  // Brief fit: shape.
  const shapes: number[] = [];
  for (const s of layout.spaces) {
    if (s.kind !== 'room') continue;
    const r = m.rooms.get(s.key);
    if (r === undefined || r.w <= 0 || r.h <= 0) {
      shapes.push(0);
      continue;
    }
    const aspect = Math.max(r.w, r.h) / Math.min(r.w, r.h);
    const limit = LOOSE.has(s.fn) ? 2.5 : 1.6;
    let g = clamp01(1 - (aspect - limit) / 1.4);
    if (Math.min(r.w, r.h) < minDim(s.fn) / 2 - 1) g *= 0.7;
    shapes.push(g);
  }
  const shape = shapes.length === 0 ? 1 : shapes.reduce((p, q) => p + q, 0) / shapes.length;
  const habitable = layout.spaces.filter((s) => s.kind === 'room' && HABITABLE.has(s.fn));
  const daylight = habitable.length === 0 ? 1 : habitable.filter((s) => ctx.daylit.has(s.key)).length / habitable.length;
  let wanted = 0;
  let netAll = 0;
  for (const s of layout.spaces) {
    netAll += m.rooms.get(s.key)?.area ?? 0;
    if (s.req !== undefined) wanted += s.req.target;
  }
  const efficiency = netAll === 0 ? 0 : clamp01((wanted / netAll - 0.55) / 0.3);
  const briefFit = 0.35 * items + 0.3 * adjacency + 0.15 * shape + 0.1 * daylight + 0.1 * efficiency;

  // Circulation.
  let reached = 0;
  let sts = 0;
  let routePenalty = 0;
  for (const s of layout.spaces) {
    if (s.key === entry) {
      reached++;
      continue;
    }
    const r = route(layout, m.connected, entry, s);
    if (r === undefined) continue;
    reached++;
    if (r.sleeping && s.fn === 'sleeping') sts++;
    routePenalty += r.cost - 0.001 * r.hops + 0.02 * Math.max(0, r.hops - 4);
  }
  const reach = reached / layout.spaces.length;
  let net = 0;
  let hall = 0;
  for (const s of layout.spaces) {
    const a = m.rooms.get(s.key)?.area ?? 0;
    net += a;
    if (s.kind === 'hall') hall += a;
  }
  const hallShare = net === 0 ? 0 : hall / net;
  const penalties = routePenalty + 2 * Math.max(0, hallShare - 0.08) + (ctx.frontEntry ? 0 : 0.1);
  const circulation = reach * clamp01(1 - penalties);

  // Findings.
  const warnings = m.findings.filter((d) => d.severity === 'warning').length;
  const infos = m.findings.filter((d) => d.severity === 'info').length;
  const findings = clamp01(1 - 0.15 * warnings - 0.03 * infos);

  const total = 100 * (0.5 * briefFit + 0.3 * circulation + 0.2 * findings);
  return {
    total: round(total, 2),
    briefFit: round(briefFit, 3),
    circulation: round(circulation, 3),
    findings: round(findings, 3),
    detail: {
      items: round(items, 3),
      adjacency: round(adjacency, 3),
      shape: round(shape, 3),
      daylight: round(daylight, 3),
      efficiency: round(efficiency, 3),
      frontEntry: ctx.frontEntry,
      reach: round(reach, 3),
      sleepingThroughSleeping: sts,
      routePenalty: round(routePenalty, 3),
      hallShare: round(hallShare, 3),
      warnings,
      infos,
    },
    source: m.source,
  };
}

/** Whether a space is part of the house's circulation network (for explanations). */
export const isCirculation = inNetwork;
