/**
 * 3.9: whether a rule is well typed, whether it uses a deferred measure (4.8), and which extensions
 * it reads (3.10, 4.6).
 */
import { DEFERRED, measureFor } from './measures/library.js';
import { argsOk, aCollection, aExtension, aFunction, anEnum, isInt, PURPOSES, typeOf, type ArgCheck } from './measures/measure.js';
import type { MeasureType, Op, Rule, Selection, TargetKind, Test } from './types.js';

/** 3.5: the candidate sets of each subject kind, their arguments, and the kind of their candidates. */
export const CANDIDATE_SETS: Readonly<Record<string, { args: Readonly<Record<string, ArgCheck>>; kind: TargetKind }>> = {
  'room/openings': { args: { to: anEnum('outside', 'any') }, kind: 'opening' },
  'room/elements': { args: { extension: aExtension, collection: aCollection }, kind: 'element' },
  'opening/envelopes': { args: { purpose: anEnum(...PURPOSES) }, kind: 'envelope' },
  'element/envelopes': { args: { purpose: anEnum(...PURPOSES) }, kind: 'envelope' },
  'level/rooms': { args: { function: aFunction }, kind: 'room' },
  'level/elements': { args: { extension: aExtension, collection: aCollection }, kind: 'element' },
};

export const candidateSet = (subject: string, from: Selection['from']): (typeof CANDIDATE_SETS)[string] | undefined =>
  Object.hasOwn(CANDIDATE_SETS, `${subject}/${from}`) ? CANDIDATE_SETS[`${subject}/${from}`] : undefined;

const NUMERIC: readonly MeasureType[] = ['length', 'count', 'integer'];

/** 3.8: does an op apply to a measure type, with a value of the kind the table gives? */
export function valueOk(type: MeasureType, op: Op, v: unknown): boolean {
  if (NUMERIC.includes(type) || type === 'area') {
    if (op === '<' || op === '<=' || op === '>' || op === '>=' || op === '=' || op === '!=') return isInt(v);
    if (op === 'in' && type !== 'area') return Array.isArray(v) && v.length >= 1 && v.every(isInt);
    return false;
  }
  if (type === 'term') {
    if (op === '=' || op === '!=') return typeof v === 'string';
    return op === 'in' && Array.isArray(v) && v.length >= 1 && v.every((x) => typeof x === 'string');
  }
  if (type === 'boolean') return (op === '=' || op === '!=') && typeof v === 'boolean';
  return op === 'has' && typeof v === 'string';
}

export interface Typing {
  /** Well typed (3.9). */
  readonly ok: boolean;
  /** Uses a deferred measure (4.8). */
  readonly deferred: boolean;
  /** The extensions it reads (3.10). */
  readonly reads: ReadonlySet<string>;
}

export function typeRule(rule: Rule): Typing {
  const a = rule.applies;
  const subject = a.to;
  let ok = true;
  let deferred = false;
  const reads = new Set<string>();
  if ((a.extension !== undefined || a.collection !== undefined) && subject !== 'element') ok = false;
  if (a.collection !== undefined && a.extension === undefined) ok = false;
  const subjectExtension = subject === 'element' ? a.extension : undefined;

  const test = (t: Test, kind: TargetKind, ext: string | undefined): void => {
    if ('measure' in t) {
      const args = (t.args ?? {}) as Record<string, unknown>;
      if (DEFERRED.has(t.measure)) {
        deferred = true;
        return;
      }
      const m = measureFor(t.measure, kind);
      if (m === undefined || !argsOk(m, args)) {
        ok = false;
        return;
      }
      if (!valueOk(typeOf(m, args), t.op, t.value)) ok = false;
      for (const x of m.reads(args)) reads.add(x);
      if (t.measure === 'elementMember') {
        // 7.1 reads the extension the rule names for these targets; without one it is not well typed.
        if (ext === undefined) ok = false;
        else reads.add(ext);
      }
      return;
    }
    if ('all' in t) for (const x of t.all) test(x, kind, ext);
    else if ('any' in t) for (const x of t.any) test(x, kind, ext);
    else test(t.not, kind, ext);
  };

  if (a.where !== undefined) test(a.where, subject, subjectExtension);
  for (const e of rule.exceptions ?? []) test(e.when, subject, subjectExtension);
  const sel = rule.select;
  if (sel !== undefined) {
    const spec = candidateSet(subject, sel.from);
    const args = (sel.args ?? {}) as Record<string, unknown>;
    if (spec === undefined) {
      ok = false;
    } else {
      for (const [k, v] of Object.entries(args)) {
        const check = Object.hasOwn(spec.args, k) ? spec.args[k] : undefined;
        if (check === undefined || !check(v)) ok = false;
      }
      if (args.collection !== undefined && args.extension === undefined) ok = false;
      const candidateExtension = sel.from === 'elements' ? (args.extension as string | undefined) : undefined;
      if (sel.where !== undefined) test(sel.where, spec.kind, candidateExtension);
      test(rule.requirement, spec.kind, candidateExtension);
    }
  } else {
    test(rule.requirement, subject, subjectExtension);
  }
  if (rule.provenance.edition !== rule.citation.edition) ok = false;
  return { ok, deferred, reads };
}
