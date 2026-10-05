/** Checks shared by the DSL's tests: what a document derives, compared room by room and opening by opening. */
import { expect } from 'vitest';
import { check } from '@floorspec/engine';
import { build, formatDiagnostic, type Built } from '../src/index.js';

type Json = Record<string, unknown>;
type Point = [number, number];

/** Build a text that must build; fail the test with its diagnostics otherwise. */
export function built(text: string, base?: object): Built {
  const r = build(text, base === undefined ? {} : { base });
  if (!r.ok) expect.fail(`the DSL does not build:\n${r.diagnostics.map(formatDiagnostic).join('\n')}\n---\n${text}`);
  return r;
}

const coll = (doc: Json, name: string): Record<string, Json> => (doc[name] as Record<string, Json> | undefined) ?? {};
const key = (p: Point): string => `${p[0]},${p[1]}`;
const side = (dx: number, dy: number): string => (dx > 0 ? 'east' : dx < 0 ? 'west' : dy > 0 ? 'north' : 'south');

export interface RoomSummary {
  level: string;
  function: string;
  area: string;
  outer: string[];
  holes: string[][];
  brief: string | null;
}

export interface OpeningSummary {
  level: string;
  kind: string;
  /** The two ends of the opening, sorted. */
  span: string;
  sill: number;
  head: number;
  /** For a door: the jamb it hangs from, and the compass side its leaf opens into. */
  hinge?: string;
  swing?: string;
  name: string | null;
}

/**
 * What a document says about its rooms and openings, independent of IDs: rooms by name (each with
 * its level's name, function, net area and exact polygon), openings sorted.
 */
export function summarize(input: string | object): { rooms: Record<string, RoomSummary>; openings: OpeningSummary[]; program: string[] } {
  const r = check(input);
  if (!r.valid || !r.derived) expect.fail(`not valid: ${JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error').slice(0, 5))}`);
  const doc = JSON.parse(r.canonical!) as Json;
  const levels = coll(doc, 'levels');
  const program = (doc['program'] as Json | undefined) ?? {};
  const items = coll(program, 'items');
  const itemName = (id: unknown): string | null => (typeof id === 'string' ? String(items[id]?.['name'] ?? items[id]?.['function']) : null);
  const rooms: Record<string, RoomSummary> = {};
  for (const [id, room] of Object.entries(coll(doc, 'rooms'))) {
    const name = typeof room['name'] === 'string' ? room['name'] : id;
    expect(rooms[name], `two rooms are named ${name}`).toBeUndefined();
    const d = r.derived.rooms[id]!;
    rooms[name] = {
      level: String(levels[room['level'] as string]!['name'] ?? room['level']),
      function: typeof room['function'] === 'string' ? room['function'] : 'unspecified',
      area: d.area,
      outer: d.outer.map(key),
      holes: d.holes.map((h) => h.map(key)),
      brief: itemName(room['brief']),
    };
  }
  const junctions = coll(doc, 'junctions');
  const walls = coll(doc, 'walls');
  const types = coll(doc, 'types');
  const openings: OpeningSummary[] = [];
  for (const [id, o] of Object.entries(coll(doc, 'openings'))) {
    const d = r.derived.openings[id]!;
    const fill = typeof o['fill'] === 'string' ? types[o['fill']] : undefined;
    const kind = typeof fill?.['kind'] === 'string' ? fill['kind'] : 'empty';
    const w = walls[o['wall'] as string]!;
    const s = junctions[w['start'] as string]!['position'] as Point;
    const e = junctions[w['end'] as string]!['position'] as Point;
    const dx = e[0] - s[0];
    const dy = e[1] - s[1];
    const summary: OpeningSummary = { level: String(levels[w['level'] as string]!['name'] ?? w['level']), kind, span: [key(d.start), key(d.end)].sort().join(' '), sill: d.sillElevation, head: d.headElevation, name: typeof o['name'] === 'string' ? o['name'] : null };
    if (kind === 'doorType') {
      summary.hinge = key(o['hinge'] === 'end' ? d.end : d.start);
      summary.swing = o['swing'] === 'left' ? side(-dy, dx) : side(dy, -dx);
    }
    openings.push(summary);
  }
  const order = (o: OpeningSummary): string => JSON.stringify([o.level, o.span, o.sill, o.head, o.kind, o.hinge ?? '', o.swing ?? '', o.name ?? '']);
  openings.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  const programLines = [
    ...Object.values(items).map((it) => JSON.stringify([it['function'], it['count'] ?? 1, it['targetArea'] ?? null, it['minArea'] ?? null, it['level'] ? levels[it['level'] as string]!['name'] : null, it['name'] ?? null])),
    ...((program['adjacency'] as Json[] | undefined) ?? []).map((a) => JSON.stringify([[itemName(a['a']), itemName(a['b'])].sort(), a['kind']])),
  ].sort();
  return { rooms, openings, program: programLines };
}

/** A tiny seeded PRNG (mulberry32): the property tests are deterministic. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
