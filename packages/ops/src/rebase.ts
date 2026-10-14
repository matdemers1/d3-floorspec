import { omitDefaults } from '@floorspec/engine';
import { inverseOf } from './inverse.js';
import type { OpsVersion } from './model/working.js';
import type { ResolvedPrimitive } from './types.js';
import type { JsonObject } from './lib/json.js';

/**
 * A return to an earlier version, rebased (FLR-T-18.18) — not part of Floorspec Ops: a tool for an
 * implementation's history, built from Ops 1.6's inverse.
 *
 * A branch from version T (the editor's history scrubber) starts with one batch that takes main as it
 * was then, B, back to T: the inverses of everything after T. Replayed onto a main that has moved
 * since, that batch is stale — it re-adds an element main has already brought back, or removes one
 * main has already removed — and the changeset could never be accepted. What the person asked for is
 * still well defined: what B → T changed, on main as it is now. So the batch is made again, against
 * main: every member T has as B had it is main's (main's later edits kept), every member T changed is
 * T's (a member main changed too is T's: going back to T was the choice), and the result is reached
 * from main by the inverse of Ops 1.6 — removes, adds under the elements' own IDs, property edits.
 */

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return false;
}

/** The three-way merge of a JSON value: `base` → `target` applied to `main`, member by member (undefined: absent). */
export function mergeThreeWay(base: unknown, target: unknown, main: unknown): unknown {
  if (same(base, target)) return main;
  if (same(base, main)) return target;
  if (isObject(base) && isObject(target) && isObject(main)) {
    const out: JsonObject = {};
    for (const k of new Set([...Object.keys(main), ...Object.keys(target), ...Object.keys(base)])) {
      const v = mergeThreeWay(base[k], target[k], main[k]);
      if (v !== undefined) out[k] = v as JsonObject[string];
    }
    return out;
  }
  // Changed on both sides, and not object by object: the version gone back to.
  return target;
}

/** The primitives that turn document `from` into document `to` (Ops 1.6's inverse of `to` → `from`). */
export function patchBetween(from: JsonObject, to: JsonObject, options: { ops?: OpsVersion } = {}): ResolvedPrimitive[] {
  return inverseOf(omitDefaults(to) as JsonObject, omitDefaults(from) as JsonObject, options.ops ?? '0.4');
}

/**
 * The batch that does to `main` what going from `base` back to `target` did: `main` turned into the
 * three-way merge of the three (see above). Empty when main already is that.
 */
export function restoreOnto(base: JsonObject, target: JsonObject, main: JsonObject, options: { ops?: OpsVersion } = {}): ResolvedPrimitive[] {
  const merged = mergeThreeWay(omitDefaults(base), omitDefaults(target), omitDefaults(main)) as JsonObject;
  return patchBetween(main, merged, options);
}
