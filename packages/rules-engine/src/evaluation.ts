/**
 * Evaluating rules on one valid document (Rules chapters 3 and 9): measure results (4.7), tests
 * (3.8), subjects (3.4), candidates (3.5), exceptions (3.7) and findings with their measured
 * conditions, elements, location and message (9.2–9.5).
 */
import { halfString, toSafeNumber } from '@floorspec/engine';
import { displayThreshold, displayValue } from './display.js';
import { measureFor } from './measures/library.js';
import { typeOf, type Value } from './measures/measure.js';
import { cmpStr, own, sortIds, type IPoint, type Model } from './model.js';
import type { Finding, MeasureResult, MeasuredCondition, Pack, Rule, Shape, Target, Test, Applicability, Selection, Ring } from './types.js';

const NUMERIC = new Set(['length', 'count', 'integer']);

/** 3.8: compare a measured value with a condition's value, exactly. */
export function compare(type: MeasureResult['type'], value: Value, op: string, t: unknown): boolean {
  if (value === null) return op === '!=';
  if (type === 'terms') return (value as string[]).includes(t as string);
  if (NUMERIC.has(type) || type === 'area') {
    // An area is held doubled; so is the threshold it is compared with.
    const scale = type === 'area' ? 2n : 1n;
    const v = value as bigint;
    if (op === 'in') return (t as number[]).some((x) => BigInt(x) === v);
    const w = scale * BigInt(t as number);
    switch (op) {
      case '<':
        return v < w;
      case '<=':
        return v <= w;
      case '>':
        return v > w;
      case '>=':
        return v >= w;
      case '=':
        return v === w;
      default:
        return v !== w;
    }
  }
  if (op === 'in') return (t as unknown[]).includes(value);
  return op === '=' ? value === t : value !== t;
}

/** 4.7: a value as a report writes it. */
function jsonValue(type: MeasureResult['type'], v: Value): MeasureResult['value'] {
  if (v === null) return null;
  if (type === 'area') return halfString(v as bigint);
  if (typeof v === 'bigint') return toSafeNumber(v);
  return v;
}

/** Targets in order (4.1): by ID, then by envelope name. */
export const cmpTarget = (a: Target, b: Target): number =>
  cmpStr(a.id, b.id) || cmpStr(a.kind === 'envelope' ? a.envelope : '', b.kind === 'envelope' ? b.envelope : '');

const ringOf = (r: readonly (readonly [number, number])[]): Ring => r.map((p) => [p[0], p[1]]);

/** Rotate a ring to start at its least vertex (least x, then least y). */
function leastFirst(ring: readonly IPoint[]): IPoint[] {
  let best = 0;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[best]!;
    if (p[0] < q[0] || (p[0] === q[0] && p[1] < q[1])) best = i;
  }
  return [...ring.slice(best), ...ring.slice(0, best)];
}

export class Evaluator {
  readonly model: Model;
  private readonly cache = new Map<string, { result: MeasureResult; value: Value }>();

  constructor(model: Model) {
    this.model = model;
  }

  /** 4.7: the measure result of a measure on a target with arguments, and its exact value. Memoised. */
  result(name: string, target: Target, args: Record<string, unknown>): { result: MeasureResult; value: Value } {
    const key = JSON.stringify([name, target.kind, target.id, target.kind === 'envelope' ? target.envelope : null, args]);
    let hit = this.cache.get(key);
    if (!hit) {
      const m = measureFor(name, target.kind)!;
      const { value, involved } = m.compute(this.model, target, args);
      const type = typeOf(m, args);
      const result: MeasureResult = { type, value: jsonValue(type, value), display: displayValue(type, value, this.model.units, args.unit as string | undefined) };
      if (m.involved) result.involved = sortIds(new Set(involved ?? []));
      hit = { result, value };
      this.cache.set(key, hit);
    }
    return hit;
  }

  /** 3.8: whether a test holds on a target, and every condition measured, depth first (9.3). */
  test(t: Test, target: Target): { holds: boolean; measured: MeasuredCondition[] } {
    if ('measure' in t) {
      const args = (t.args ?? {}) as Record<string, unknown>;
      const { result, value } = this.result(t.measure, target, args);
      const holds = compare(result.type, value, t.op, t.value);
      const mc: MeasuredCondition = {
        target,
        measure: t.measure,
        ...result,
        op: t.op,
        threshold: t.value,
        thresholdDisplay: displayThreshold(result.type, t.op, t.value, this.model.units, args.unit as string | undefined),
        holds,
      };
      if (t.args !== undefined) mc.args = t.args;
      return { holds, measured: [mc] };
    }
    if ('all' in t || 'any' in t) {
      const list = 'all' in t ? t.all : t.any;
      const outs = list.map((x) => this.test(x, target));
      const holds = 'all' in t ? outs.every((o) => o.holds) : outs.some((o) => o.holds);
      return { holds, measured: outs.flatMap((o) => o.measured) };
    }
    const inner = this.test(t.not, target);
    return { holds: !inner.holds, measured: inner.measured };
  }

  holds(t: Test, target: Target): boolean {
    return this.test(t, target).holds;
  }

  /** 3.4: a rule's subjects, in order. */
  subjects(a: Applicability): Target[] {
    const m = this.model;
    let ids: string[];
    if (a.to === 'room') ids = sortIds(Object.keys(m.doc.rooms ?? {}));
    else if (a.to === 'opening') ids = sortIds(Object.keys(m.doc.openings ?? {}));
    else if (a.to === 'level') ids = sortIds(Object.keys(m.doc.levels ?? {}));
    else
      ids = sortIds(
        [...m.ext.values()].filter((x) => (a.extension === undefined || x.extension === a.extension) && (a.collection === undefined || x.collection === a.collection)).map((x) => x.id),
      );
    const targets = ids.map((id): Target => ({ kind: a.to, id }));
    return a.where === undefined ? targets : targets.filter((t) => this.holds(a.where!, t));
  }

  /** 3.5: a subject's candidates, in order. */
  candidates(subject: Target, sel: Selection): Target[] {
    const m = this.model;
    const args = (sel.args ?? {}) as Record<string, unknown>;
    let out: Target[];
    if (sel.from === 'openings') {
      const lv = m.level(m.room(subject.id).level);
      const face = lv.roomFace.get(subject.id);
      out = [];
      for (const oid of sortIds(Object.keys(m.doc.openings ?? {}))) {
        const faces = lv.halfEdges(m.opening(oid).wall).map((h) => lv.faceOf(h));
        if (!faces.includes(face)) continue;
        if ((args.to ?? 'any') === 'outside' && !faces.includes(undefined)) continue;
        out.push({ kind: 'opening', id: oid });
      }
    } else if (sel.from === 'envelopes') {
      out = m
        .envelopesOf(subject.id)
        .filter((n) => args.purpose === undefined || m.clearance(subject.id, n).purpose === args.purpose)
        .map((n): Target => ({ kind: 'envelope', id: subject.id, envelope: n }));
    } else if (sel.from === 'rooms') {
      out = sortIds(Object.keys(m.doc.rooms ?? {}))
        .filter((r) => m.room(r).level === subject.id && (args.function === undefined || m.roomFunction(r) === args.function))
        .map((r): Target => ({ kind: 'room', id: r }));
    } else {
      out = sortIds(m.ext.keys())
        .filter((e) => {
          const x = m.ext.get(e)!;
          const inside = subject.kind === 'room' ? m.roomOf(e) === subject.id : x.element.fallback.level === subject.id;
          return inside && (args.extension === undefined || x.extension === args.extension) && (args.collection === undefined || x.collection === args.collection);
        })
        .map((e): Target => ({ kind: 'element', id: e }));
    }
    return sel.where === undefined ? out : out.filter((c) => this.holds(sel.where!, c));
  }

  /** 9.4: the shape a plan draws for a target, a wall, or nothing. */
  shape(kind: string, id: string, envelope?: string): Shape | undefined {
    const d = this.model.derived;
    switch (kind) {
      case 'room': {
        const r = own(d.rooms, id)!;
        return { kind: 'polygon', outer: ringOf(r.outer), holes: r.holes.map(ringOf) };
      }
      case 'opening': {
        const o = own(d.openings, id)!;
        return { kind: 'segment', points: [[o.start[0], o.start[1]], [o.end[0], o.end[1]]] };
      }
      case 'element':
        return { kind: 'polygon', outer: ringOf(own(d.fallbacks, id)!.footprint), holes: [] };
      case 'envelope':
        return { kind: 'polygon', outer: ringOf(this.model.clearance(id, envelope!).footprint), holes: [] };
      case 'wall': {
        const ring = leastFirst(this.model.level(this.model.wallLevel(id)).g.outline(id));
        return { kind: 'polygon', outer: ring.map((p) => [toSafeNumber(p[0]), toSafeNumber(p[1])]), holes: [] };
      }
      default:
        return undefined;
    }
  }

  /** 9.2–9.5: the finding for a subject that is not exempt and does not pass. */
  finding(pack: Pack, ruleId: string, rule: Rule, subject: Target, candidates: Target[], measured: MeasuredCondition[]): Finding {
    const m = this.model;
    const c = rule.citation;
    const ids = new Set<string>([subject.id, ...candidates.map((x) => x.id)]);
    const involved = sortIds(new Set(measured.flatMap((mc) => mc.involved ?? [])));
    for (const i of involved) ids.add(i);
    const shapes: Shape[] = [];
    const drawn = new Set<string>();
    const draw = (kind: string, id: string, envelope?: string): void => {
      const key = JSON.stringify([kind, id, envelope ?? null]);
      if (drawn.has(key)) return;
      const s = this.shape(kind, id, envelope);
      if (s === undefined) return;
      drawn.add(key);
      shapes.push(s);
    };
    for (const t of [subject, ...candidates]) draw(t.kind, t.id, t.kind === 'envelope' ? t.envelope : undefined);
    for (const i of involved) {
      // What `involved` can name that has a shape: walls (7.6, 7.7) and extension elements. An
      // opening named as an envelope's owner (7.8) is not drawn, as the reference oracle does not.
      const kind = own(m.doc.walls, i) !== undefined ? 'wall' : m.ext.has(i) ? 'element' : undefined;
      if (kind !== undefined) draw(kind, i);
    }
    let message = `${subject.id} may not meet ${c.code} ${c.edition} ${c.section} (${rule.title}).`;
    if (rule.severity === 'check') message += ' Check it with a professional or the authority having jurisdiction.';
    else if (rule.severity === 'note') message += ' This is for information.';
    const f: Finding = {
      pack: pack.name,
      version: pack.version,
      rule: ruleId,
      title: rule.title,
      citation: c,
      severity: rule.severity,
      subject,
      measures: measured,
      elements: sortIds(ids),
      location: { level: m.targetLevel(subject), shapes },
      message,
    };
    if (rule.select !== undefined) f.candidates = candidates;
    return f;
  }

  /** 3.4–3.7: a rule's subjects, how many are exempt, and the findings of the others that do not pass. */
  evaluateRule(pack: Pack, ruleId: string, rule: Rule): { subjects: number; exempt: number; findings: Finding[] } {
    const subjects = this.subjects(rule.applies);
    let exempt = 0;
    const findings: Finding[] = [];
    const sel = rule.select;
    for (const s of subjects) {
      if ((rule.exceptions ?? []).some((e) => this.holds(e.when, s))) {
        exempt++;
        continue;
      }
      let passed: boolean;
      let measured: MeasuredCondition[];
      let cands: Target[] = [];
      if (sel !== undefined) {
        cands = this.candidates(s, sel);
        const outs = cands.map((c) => this.test(rule.requirement, c));
        passed = sel.need === 'any' ? outs.some((o) => o.holds) : outs.every((o) => o.holds);
        measured = outs.flatMap((o) => o.measured);
      } else {
        const o = this.test(rule.requirement, s);
        passed = o.holds;
        measured = o.measured;
      }
      if (!passed) findings.push(this.finding(pack, ruleId, rule, s, cands, measured));
    }
    return { subjects: subjects.length, exempt, findings };
  }
}
