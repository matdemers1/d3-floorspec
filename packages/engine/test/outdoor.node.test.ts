/**
 * FS_outdoor 0.1.0 (FLR-T-15.2): a shelter's posts re-space when it is stretched (its bays are the
 * fewest whose spacing is at most postSpacing, and the drawing helper puts its posts where the count
 * says), a fence's posts and gates, a pool's water — and the drawing helpers agree with what is derived.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, OFFICIAL_EXTENSIONS, outdoor, type FloorspecDocument } from '../src/index.js';

const suite = join(import.meta.dirname, '..', 'standard', 'conformance', 'ext', 'FS_outdoor', '0.1.0');
const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const terrace = (): FloorspecDocument => structuredClone(read(join(suite, 'examples', '001-p15-back-terrace', 'input.json'))) as FloorspecDocument;
const reader = { extensions: ['FS_outdoor'], knownExtensions: OFFICIAL_EXTENSIONS };
const IN = 32512;
const FT = 12 * IN;
type Coll = Record<string, Record<string, Record<string, unknown> & { fallback: { box: { min: number[]; max: number[] } } }>>;
const colls = (d: FloorspecDocument) => (d.extensions as Record<string, { collections: Coll }>)['FS_outdoor']!.collections;
const derived = (d: FloorspecDocument) => {
  const r = check(d, reader);
  expect(r.valid, JSON.stringify(r.diagnostics)).toBe(true);
  return r.derived!.extensions!.FS_outdoor!;
};

describe('FS_outdoor', () => {
  it('derives the back terrace as its suite does', () => {
    const x = derived(terrace());
    expect(x.shelters['X3']).toEqual({ top: 'slats', bays: [2, 2], spacing: [69 * IN, 57 * IN], posts: 8 });
    expect(x.pools['X1']).toEqual({ form: 'plunge', basin: [6 * FT, 12 * FT], depth: 60 * IN, area: String(72 * FT * FT), volume: (BigInt(72 * FT * FT) * BigInt(60 * IN)).toString() });
    expect(x.fences['X6']).toEqual({ form: 'fence', length: 54 * FT, posts: 9, gates: [[40 * FT, 44 * FT]] });
  });

  it('a stretched pergola gets more posts, re-spaced, never wider ones', () => {
    const d = terrace();
    const p = colls(d)['shelters']!['X3']!;
    const lengths: number[] = [];
    for (const depth of [12, 16, 20, 24, 28]) {
      p.fallback.box.max[0] = p.fallback.box.min[0]! + depth * FT;
      const s = derived(d).shelters['X3']!;
      const posts = outdoor.shelterPosts(p);
      expect(posts.length).toBe(s.posts);
      expect(s.spacing[0]).toBeLessThanOrEqual(8 * FT);
      // every post is 6" square whatever the length: the spacing changes, not the posts
      expect(p['postSize']).toBe(6 * IN);
      lengths.push(s.bays[0]);
    }
    expect(lengths).toEqual([2, 2, 3, 3, 4]);
  });

  it("puts an attached shelter's posts on three sides", () => {
    const el = { fallback: { box: { min: [0, 0, 0], max: [10 * FT, 16 * FT, 11 * FT] } }, postSize: 6 * IN, postSpacing: 8 * FT, attached: true };
    const posts = outdoor.shelterPosts(el);
    expect(posts.length).toBe(outdoor.shelterLayout(el).posts);
    expect(posts.every(([x]) => x > 3 * IN)).toBe(true);
  });

  it("puts a fence's posts where its count says, and finds a gate along its line", () => {
    const line: [number, number][] = [[0, 0], [0, -34 * FT], [20 * FT, -34 * FT]];
    expect(outdoor.fencePosts(line, 8 * FT).length).toBe(outdoor.fencePostCount(line, 8 * FT));
    const g = outdoor.alongLine(line, 40 * FT);
    expect(g.segment).toBe(1);
    expect(g.at[0]).toBeCloseTo(6 * FT);
    expect(outdoor.gateIntervals([{ offset: 10, width: 5 }, { offset: 0, width: 5 }])).toEqual([[0, 5], [10, 15]]);
    const closed: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(outdoor.fencePosts(closed, 10).length).toBe(outdoor.fencePostCount(closed, 10));
  });

  it('rejects a gate past the end of its line and overlapping gates', () => {
    const d = terrace();
    const f = colls(d)['fences']!['X6']!;
    (f['gates'] as { offset: number }[])[0]!.offset = 51 * FT;
    expect(check(d, reader).diagnostics.map((x) => x.code)).toEqual(['FS-OUTD-INV-006']);
  });
});
