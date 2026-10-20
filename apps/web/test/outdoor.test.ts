import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { check, OFFICIAL_READER, type FloorspecDocument } from '@floorspec/engine';
import { drawFence, fenceElement, fenceStyle, FENCE_STYLES, gateAt, setGates } from '../src/editor/outdoor/ops';
import { placeOutdoor } from '../src/placing/place';
import { entriesFor } from '../src/placing/catalog';
import { outdoorKindOf, ruleFor, shelterPostsAt } from '../src/furniture/resize';

/**
 * FS_outdoor in the editor (FLR-T-15.2): a fence drawn in a style of the starter library with its box
 * round its line, a gate that snaps to where a path crosses, a plunge pool placed in one op, and a
 * pergola's posts re-spaced as it is stretched — each through the real applier, as the server runs it.
 */

const TEXT = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const DOC = JSON.parse(TEXT) as FloorspecDocument;
const IN = 32_512;
const FT = 12 * IN;
type Batch = ReturnType<typeof drawFence>;
const commit = (doc: string, batch: Batch) => apply(doc, { batch }, OFFICIAL_READER);

describe('FS_outdoor in the editor', () => {
  it('has the three fence styles of the starter library, each with its height', () => {
    expect(FENCE_STYLES.map((s) => s.id)).toEqual(['fence-privacy-6', 'fence-picket-4', 'wall-garden-3']);
    expect(fenceStyle('fence-picket-4').height).toBe(4 * FT);
  });

  it('draws a fence in one op, its box its line grown by half its width', () => {
    const el = fenceElement(fenceStyle('fence-privacy-6'), [[0, -10 * FT], [20 * FT, -10 * FT], [20 * FT, -30 * FT]], 'L1');
    expect((el['fallback'] as { box: unknown }).box).toEqual({ min: [-2 * IN, -30 * FT - 2 * IN, 0], max: [20 * FT + 2 * IN, -10 * FT + 2 * IN, 6 * FT] });
    const r = commit(TEXT, drawFence(DOC, 'L1', [[-40 * FT, -10 * FT], [-40 * FT, -40 * FT]], fenceStyle('fence-privacy-6')));
    expect(r.status, JSON.stringify(r.status === 'committed' ? null : r.diagnostics)).toBe('committed');
  });

  it("puts a gate where a path crosses the fence, else in the middle of its longest run, clear of the gates it has", () => {
    const fence = fenceElement(fenceStyle('fence-privacy-6'), [[0, 0], [0, -30 * FT], [20 * FT, -30 * FT]], 'L1');
    expect(gateAt(DOC, fence)).toEqual({ offset: 13 * FT, width: 4 * FT });
    const withPath = structuredClone(DOC) as FloorspecDocument & { extensions: Record<string, unknown> };
    withPath.extensions = { ...(withPath.extensions ?? {}), FS_landscape: { collections: { hardscape: { X900: { form: 'path', points: [[-5 * FT, -10 * FT], [5 * FT, -10 * FT]], width: 3 * FT, fallback: { level: 'L1', box: { min: [0, 0, 0], max: [1, 1, 1] } } } } } } };
    expect(gateAt(withPath, fence)).toEqual({ offset: 8 * FT, width: 4 * FT });
    const one = { ...fence, gates: [{ offset: 13 * FT, width: 4 * FT }] };
    const next = gateAt(DOC, one);
    expect(next !== null && (next.offset + next.width <= 13 * FT || next.offset >= 17 * FT)).toBe(true);
    expect(setGates('X1', one, [])).toEqual([{ op: 'unsetProperty', id: 'X1', path: '/gates' }]);
  });

  it('places a plunge pool from the Outdoor shelf in one op, and the pool derives its water', () => {
    const e = entriesFor(DOC).find((x) => x.key === 'outdoor:plunge-pool-8x14')!;
    if (e.source.kind !== 'outdoor') throw new Error('not an outdoor entry');
    const batch = placeOutdoor(DOC, e.source.collection, e.source.element, { mode: 'free', level: 'L1', at: [-30 * FT, -30 * FT] });
    expect(batch.filter((o) => o.op === 'placeElement').length).toBe(1);
    const r = commit(TEXT, batch);
    expect(r.status).toBe('committed');
    if (r.status !== 'committed') return;
    const x = check(JSON.parse(r.document) as FloorspecDocument, OFFICIAL_READER).derived!.extensions!.FS_outdoor!;
    expect(Object.values(x.pools)[0]).toMatchObject({ form: 'plunge', basin: [6 * FT, 12 * FT], depth: 60 * IN });
  });

  it("re-spaces a pergola's posts as it is stretched, never widening them, and sizes it on a 6\" grid", () => {
    const pergola = { top: 'slats', postSize: 6 * IN, postSpacing: 8 * FT };
    expect(outdoorKindOf(pergola)).toBe('shelters');
    expect(ruleFor({ extension: 'FS_outdoor', element: pergola }).step).toBe(6 * IN);
    const at = (depth: number) => shelterPostsAt(pergola, { depth, width: 10 * FT, height: 9 * FT });
    expect(at(12 * FT)).toEqual({ bays: [2, 2], spacing: [69 * IN, 57 * IN], posts: 8 });
    expect(at(20 * FT).posts).toBe(10);
    expect(at(20 * FT).spacing[0]).toBe(78 * IN);
  });
});
