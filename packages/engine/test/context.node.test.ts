/**
 * FS_context 0.1.0 (FLR-T-15.3): context is never the design — everything Core and the other extensions
 * derive is the same with it and without it — and the generator writes the same street, neighbours and
 * trees for one lot and one seed, valid under FS_context, beyond the lot, its street along the lot's
 * street edge with its sidewalk's back on the lot line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, contextDrawing, exactRectangle, generateContext, generatedIds, OFFICIAL_EXTENSION_NAMES, OFFICIAL_EXTENSIONS, pitchOf, roofOf, sideOfEdge, type FloorspecDocument } from '../src/index.js';

const ext = join(import.meta.dirname, '..', 'standard', 'conformance', 'ext');
const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const onItsStreet = (): FloorspecDocument => structuredClone(read(join(ext, 'FS_context', '0.1.0', 'examples', '001-p15-garden-on-its-street', 'input.json'))) as FloorspecDocument;
const onItsSlope = (): FloorspecDocument => structuredClone(read(join(ext, 'FS_site', '0.1.0', 'examples', '001-p15-garden-on-a-slope', 'input.json'))) as FloorspecDocument;
const FT = 390_144;
const every = { extensions: OFFICIAL_EXTENSION_NAMES, knownExtensions: OFFICIAL_EXTENSIONS };
type Json = Record<string, unknown>;

const withoutContext = (d: FloorspecDocument): FloorspecDocument => {
  const x = structuredClone(d) as FloorspecDocument & { extensionsUsed: Json; extensions: Json };
  delete x.extensionsUsed['FS_context'];
  delete x.extensions['FS_context'];
  return x;
};
const withContext = (d: FloorspecDocument, data: Json): FloorspecDocument => {
  const x = structuredClone(d) as FloorspecDocument & { extensionsUsed: Json; extensions: Json };
  x.extensionsUsed['FS_context'] = '0.1.0';
  x.extensions['FS_context'] = data;
  return x;
};

describe('FS_context: never the design (1.5)', () => {
  it('everything derived outside extensions.FS_context is the same with the context and without it, with every official extension implemented', () => {
    const a = check(onItsStreet(), every);
    const b = check(withoutContext(onItsStreet()), every);
    expect(a.valid, JSON.stringify(a.diagnostics)).toBe(true);
    expect(b.valid).toBe(true);
    const { extensions: ea, ...ra } = a.derived!;
    const { extensions: eb, ...rb } = b.derived!;
    expect(ra).toEqual(rb);
    // FS_site's lot, surface and cut and fill, FS_landscape's plants: unchanged
    expect({ ...ea, FS_context: undefined }).toEqual({ ...eb, FS_context: undefined });
    expect(ea!.FS_context!.neighbours['NB1']).toEqual({ roof: 'gable', area: String(30 * 35 * FT * FT), eaves: 6 * FT, ridge: 12 * FT });
  });

  it('a neighbour drawn over the Kitchen counts in no room, slab or quantity — only the lint says it is there', () => {
    const d = onItsStreet() as FloorspecDocument & { extensions: { FS_context: { neighbours: Record<string, Json> } } };
    d.extensions.FS_context.neighbours['NB3']!.boundary = [[FT, FT], [11 * FT, FT], [11 * FT, 11 * FT], [FT, 11 * FT]];
    const a = check(d, every);
    expect(a.valid).toBe(true);
    expect(a.diagnostics.map((x) => [x.code, x.elements])).toContainEqual(['FS-CTXT-LINT-001', ['NB3']]);
    const b = check(withoutContext(d), every).derived!;
    expect({ ...a.derived!, extensions: undefined }).toEqual({ ...b, extensions: undefined });
  });
});

describe('FS_context: generating context from the street side (6.3)', () => {
  it('is deterministic: one lot and one seed always give the same context, another seed another', () => {
    const a = generateContext(onItsSlope(), { seed: 7 });
    const b = generateContext(onItsSlope(), { seed: 7 });
    const c = generateContext(onItsSlope(), { seed: 8 });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(c));
  });

  it('runs the street along FS_site\'s street edge, its sidewalk\'s back on the lot line, neighbours on both sides at the setbacks, and trees beyond', () => {
    const g = generateContext(onItsSlope(), { seed: 1, trees: 'some' });
    expect(g.streetEdges).toEqual([0]); // the garden's south edge, y = -40'
    const st = Object.values(g.streets)[0]!;
    // centreline 5' sidewalk + 4' strip + 6" curb + 15' half carriageway beyond the front line
    expect(st.points.every((p) => p[1] === -40 * FT - (5 + 4 + 0.5 + 15) * FT)).toBe(true);
    expect(Object.keys(g.neighbours)).toEqual(['NB1', 'NB2']);
    for (const n of Object.values(g.neighbours)) {
      expect(['gable', 'hip']).toContain(n.roof);
      const xs = n.boundary.map((p) => p[0]);
      // west of the lot's west line (-30') or east of its east line (40'), at the 5' side setback
      expect(Math.max(...xs) <= -35 * FT || Math.min(...xs) >= 45 * FT).toBe(true);
    }
    expect(Object.keys(g.trees).length).toBeGreaterThanOrEqual(8);
  });

  it('writes context that is valid under FS_context and stands beyond the lot: no diagnostic at all', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const g = generateContext(onItsSlope(), { seed, trees: 'many' });
      const r = check(withContext(onItsSlope(), { streets: g.streets, neighbours: g.neighbours, trees: g.trees }), { extensions: ['FS_context'], knownExtensions: OFFICIAL_EXTENSIONS });
      expect(r.valid, JSON.stringify(r.diagnostics)).toBe(true);
      expect(r.diagnostics.filter((x) => x.code.startsWith('FS-CTXT'))).toEqual([]);
    }
  });

  it('takes a compass side when FS_site has no street edge, and fresh IDs past the taken ones', () => {
    const d = onItsSlope() as FloorspecDocument & { extensions: { FS_site: Json } };
    delete d.extensions.FS_site['setbacks'];
    const g = generateContext(d, { side: 'west', trees: 'none' }, new Set(['ST1', 'NB1']));
    expect(Object.keys(g.streets)).toEqual(['ST2']);
    expect(g.streetEdges).toEqual([3]);
    expect(sideOfEdge([[0, 0], [10, 0], [10, 10], [0, 10]], 3)).toBe('west');
    expect(Object.keys(g.neighbours)).toEqual(['NB2', 'NB3']);
    expect(Object.keys(g.trees)).toEqual([]);
  });

  it('marks what it writes, so regenerating replaces only the generated records', () => {
    const g = generateContext(onItsSlope(), { seed: 3, trees: 'few' });
    const d = withContext(onItsSlope(), {
      streets: g.streets,
      neighbours: { ...g.neighbours, NB9: { boundary: [[-80 * FT, 50 * FT], [-60 * FT, 50 * FT], [-60 * FT, 70 * FT], [-80 * FT, 70 * FT]], height: 10 * FT } },
      trees: g.trees,
    });
    const ids = generatedIds(d).map((x) => x.id);
    expect(ids).not.toContain('NB9');
    expect(ids.length).toBe(Object.keys(g.streets).length + Object.keys(g.neighbours).length + Object.keys(g.trees).length);
  });

  it('says why there is nothing to generate without a lot', () => {
    const d = onItsSlope();
    delete d.site;
    expect(generateContext(d).reason).toMatch(/lot/);
  });
});

describe('FS_context: drawing', () => {
  it('draws the street as bands: the carriageway, curbs, strips and sidewalks, 49\' overall', () => {
    const s = contextDrawing(onItsStreet()).streets[0]!;
    expect(s.overall).toBe(49 * FT);
    expect(s.curbs).toHaveLength(2);
    expect(s.strips).toHaveLength(2);
    expect(s.sidewalks).toHaveLength(2);
    const ys = s.backLines.map((l) => l[0]![1]);
    // the near sidewalk's back is the lot's front line, y = -40'
    expect(Math.max(...ys)).toBeCloseTo(-40 * FT, 3);
  });

  it('puts a gable\'s ridge along the longer sides and a square hip\'s at a point; says the pitch', () => {
    const d = contextDrawing(onItsStreet());
    const nb1 = d.neighbours.find((n) => n.id === 'NB1')!;
    expect(nb1.ridgeLine).toHaveLength(2);
    const [p, q] = nb1.ridgeLine!;
    expect(p![0]).toBeCloseTo(q![0], 6); // 30' x 35': the ridge runs north-south
    expect(nb1.gables).toHaveLength(2);
    const nb2 = d.neighbours.find((n) => n.id === 'NB2')!;
    expect(nb2.ridgeLine).toHaveLength(1);
    expect(nb2.roofPlanes).toHaveLength(4);
    expect(pitchOf(nb1.footprint, 6 * FT)).toBe('5:12'); // 6' over 15'
    expect(roofOf([[0, 0], [10, 0], [10, 5], [0, 5]], 'gable', 0, 5).ridgeLine).toEqual([[0, 2.5], [10, 2.5]]);
  });

  it('builds exact rectangles, turned or not', () => {
    for (const r of [exactRectangle([[0, 0], [100, 0], [100, 50], [0, 50]]), exactRectangle([[0, 0], [30.2, 40.1], [-9.8, 70.3], [-40, 30]])]) {
      for (let i = 0; i < 4; i++) {
        const a = r[(i + 3) % 4]!;
        const b = r[i]!;
        const c = r[(i + 1) % 4]!;
        expect((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) === 0).toBe(true);
      }
    }
  });
});
