/** Independent checks on a candidate: applied with @floorspec/ops, measured with @floorspec/engine. */
import { expect } from 'vitest';
import { check, type CheckResult } from '@floorspec/engine';
import { apply, type Operation } from '@floorspec/ops';
import { BU_PER_FOOT, type Candidate, type Program } from '../src/index.js';
import { parseDocument } from '../src/document.js';

type Doc = Record<string, unknown>;
type Coll = Record<string, Record<string, unknown>>;

/** Apply a batch to the document as given, as the server's Ops 0.2 applier does; fail the test if it does not commit. */
export function commit(doc: object, batch: readonly Operation[]): Doc {
  const r = apply(parseDocument(doc), { batch: [...batch] });
  if (r.status !== 'committed') expect.fail(`the batch does not commit: ${JSON.stringify(r.diagnostics.slice(0, 5))}`);
  return JSON.parse(r.document) as Doc;
}

/**
 * The committed document, which already holds the program and — the batch set them — each placed
 * room's brief. Checked here rather than assumed: the program is the one solved for, and every
 * room the candidate says fulfils an item names it.
 */
export function withBrief(committed: Doc, program: Program, c: Candidate): Doc {
  const held = committed['program'] as Program;
  expect(Object.keys(held.items ?? {}).sort()).toEqual(Object.keys(program.items ?? {}).sort());
  expect((held.adjacency ?? []).map((a) => `${a.a}|${a.b}|${a.kind}`)).toEqual((program.adjacency ?? []).map((a) => `${a.a}|${a.b}|${a.kind}`));
  const rooms = committed['rooms'] as Coll;
  for (const r of c.rooms) expect(rooms[r.id]!['brief'], r.id).toBe(r.item);
  return committed;
}

/**
 * Which rooms are connected (Core 0.2, 11.4: a separator, or a wall with a door or an empty
 * opening between them), as the engine derives it: a program of one item per room with every pair
 * an adjacency.
 */
export function connections(committed: Doc, roomIds: readonly string[]): { adjacent: Set<string>; connected: Set<string>; result: CheckResult } {
  const view = structuredClone(committed);
  view['floorspec'] = '0.2';
  const rooms = view['rooms'] as Coll;
  for (const room of Object.values(rooms)) delete room['brief'];
  const items: Record<string, unknown> = {};
  const adjacency: unknown[] = [];
  for (const id of roomIds) {
    items[`t-${id}`] = { function: rooms[id]!['function'] ?? 'unspecified' };
    rooms[id]!['brief'] = `t-${id}`;
  }
  for (const a of roomIds) for (const b of roomIds) if (a < b) adjacency.push({ a: `t-${a}`, b: `t-${b}`, kind: 'preferred' });
  view['program'] = { items, adjacency };
  const result = check(view);
  expect(result.valid).toBe(true);
  const adjacent = new Set<string>();
  const connected = new Set<string>();
  for (const a of result.derived!.program!.adjacency) {
    const key = `${a.a.slice(2)}|${a.b.slice(2)}`;
    if (a.adjacent) adjacent.add(key);
    if (a.connected) connected.add(key);
  }
  return { adjacent, connected, result };
}

const linked = (set: Set<string>, a: string, b: string): boolean => set.has(`${a}|${b}`) || set.has(`${b}|${a}`);

/** Rooms reachable from `from`, passing only through rooms `through` allows (the target itself always counts). */
export function reachable(ids: readonly string[], connected: Set<string>, from: string, through: (id: string) => boolean): Set<string> {
  const seen = new Set([from]);
  const todo = [from];
  while (todo.length > 0) {
    const k = todo.pop()!;
    if (k !== from && !through(k)) continue;
    for (const n of ids) if (!seen.has(n) && linked(connected, k, n)) {
      seen.add(n);
      todo.push(n);
    }
  }
  return seen;
}

/** A small, reviewable summary of a candidate. */
export function summary(c: Candidate): { strategy: string; footprint: string; rooms: string[]; total: number } {
  const ft = (bu: number): number => bu / BU_PER_FOOT;
  return {
    strategy: c.strategy,
    footprint: `${String(ft(c.footprint.width))}' x ${String(ft(c.footprint.depth))}'`,
    rooms: c.rooms.map((r) => `${r.name} ${String(ft(r.rect[2] - r.rect[0]))}x${String(ft(r.rect[3] - r.rect[1]))}`).sort(),
    total: c.score.total,
  };
}
