/**
 * FLR-T-12.38: a gable end is clad as the wall it stands on. On the Courtyard House the guest wing's
 * gable ends showed as tan wedges over its fibre-cement and brick walls: a gable end now takes the
 * finish of its wall's face that looks out of the roof — the south wall's siding, the arc wall's
 * brick along each edge of the polygon that approximates it — and only with no wall under it the
 * gable's own default.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, type FloorspecDocument } from '@floorspec/engine';
import { gableCladding, loadMesher, type Mesher } from '../src/index.js';

const GUEST_WING = readFileSync(new URL('./fixtures/courtyard-guest-wing.floorspec.json', import.meta.url), 'utf8');

type Doc = Record<string, Record<string, Record<string, unknown>>>;
const wing = (): Doc => JSON.parse(GUEST_WING) as Doc;

let mesher: Mesher;
beforeAll(async () => {
  mesher = await loadMesher();
});

/** Each gable end's cladding, by its key. */
function cladOf(doc: object): Record<string, unknown> {
  const parts = mesher.meshDocument(doc, { include: ['roofGable'] }).parts;
  return Object.fromEntries(parts.map((p) => [p.key, p.cladding ?? null]));
}

describe('a gable end clad as its wall (FLR-T-12.38)', () => {
  it('a straight wall: the south gable takes the fibre-cement siding of the longer wall under it, its outside (left) face', () => {
    const clad = cladOf(wing());
    // W32 (J10 → J1, 6.7 m) and W31 (J9 → J10, 3.7 m) both run along the south edge: the longer wins.
    expect(clad['roofGable:RF2:gable0']).toEqual({ wall: 'W32', side: 'left', material: 'fibre-cement-siding' });
  });

  it('an arc wall: every edge of the polygon approximating it finds the arc, and its brick veneer', () => {
    const clad = cladOf(wing());
    for (const i of [3, 4, 5, 6]) expect(clad[`roofGable:RF2:gable${String(i)}`], `gable${String(i)}`).toEqual({ wall: 'WGW', side: 'left', material: 'brick-veneer' });
  });

  it('the side that looks out of the roof, whichever way the wall runs: a wall drawn the other way is clad by its right face', () => {
    const doc = wing();
    // W32 drawn from J1 to J10: its outside, the south, is now its right side — the type's inner gypsum.
    Object.assign(doc['walls']!['W32']!, { start: 'J1', end: 'J10' });
    expect(cladOf(doc)['roofGable:RF2:gable0']).toEqual({ wall: 'W32', side: 'right', material: 'gypsum-board' });
  });

  it('a clockwise footprint finds the same walls and faces', () => {
    const doc = wing();
    const roof = doc['roofs']!['RF2']! as { footprint: number[][]; edges: Record<string, unknown> };
    const n = roof.footprint.length;
    // Reversed, edge i runs from point n − 1 − i to n − 2 − i: old edge j is new edge n − 2 − j (mod n).
    roof.footprint = [...roof.footprint].reverse();
    roof.edges = Object.fromEntries(Object.entries(roof.edges).map(([k, v]) => [String((n - 2 - Number(k) + n) % n), v]));
    const ev = evaluate(doc);
    expect(ev.valid).toBe(true);
    const derived = deriveEvaluation(ev);
    const d = (ev.view ?? ev.document) as FloorspecDocument;
    expect(gableCladding(d, derived, 'RF2', n - 2)).toEqual({ wall: 'W32', side: 'left', material: 'fibre-cement-siding' });
    expect(gableCladding(d, derived, 'RF2', (n - 2 - 4 + n) % n)).toEqual({ wall: 'WGW', side: 'left', material: 'brick-veneer' });
  });

  it('a face’s own finish wins over its layer, as on the wall', () => {
    const doc = wing();
    doc['materials']!['stucco'] = { name: 'Stucco', color: '#d8d2c4' };
    Object.assign(doc['walls']!['W32']!, { finishes: { left: { material: 'stucco' } } });
    expect(cladOf(doc)['roofGable:RF2:gable0']).toEqual({ wall: 'W32', side: 'left', material: 'stucco' });
  });

  it('with no wall under it, a gable end has no cladding: a view draws it in the gable default', () => {
    const doc = wing();
    // Moved 20 m north-east of its walls, nothing runs along any of its edges.
    const roof = doc['roofs']!['RF2']! as { footprint: number[][] };
    roof.footprint = roof.footprint.map(([x, y]) => [x! + 25_600_000, y! + 25_600_000]);
    const clad = cladOf(doc);
    expect(Object.keys(clad).length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(clad)) expect(v, k).toBeNull();
  });

  it('a wall across the gable’s edge, not along it, does not clad it', () => {
    const doc = wing();
    // Only the arc wall and the north walls left: the south edge has the arc's end and W8's end at its corners, no wall along it.
    const without = (c: Record<string, Record<string, unknown>>, ids: string[]) => Object.fromEntries(Object.entries(c).filter(([id]) => !ids.includes(id)));
    doc['walls'] = without(doc['walls']!, ['W31', 'W32']);
    doc['junctions'] = without(doc['junctions']!, ['J10']);
    const d = evaluate(doc);
    expect(d.valid).toBe(true);
    const derived = deriveEvaluation(d);
    expect(gableCladding((d.view ?? d.document) as FloorspecDocument, derived, 'RF2', 0)).toBeUndefined();
  });
});
