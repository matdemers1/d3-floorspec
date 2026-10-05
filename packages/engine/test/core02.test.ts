/** Core 0.2's additions on small hand-built documents: angles, version ranges, known extensions, the API. */
import { describe, expect, it } from 'vitest';
import { check, compareVersions, derive, direction, facingVector, footprintsOverlap, loadKnownExtensions, validate, versionSatisfies } from '../src/index.js';
import { box, codes, doc } from './doc.js';

const v02 = (spec: Parameters<typeof doc>[0], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...doc(spec), floorspec: '0.2', ...extra });

const entry = (name: string, version: string, more: Record<string, unknown> = {}) => ({
  name,
  version,
  status: 'draft',
  schema: `https://example.com/${name}/${version}.json`,
  ...more,
});

describe('angles (13.1)', () => {
  it('F(θ) at the values the spec gives', () => {
    expect(facingVector(0)).toEqual([1_000_000_000n, 0n]);
    expect(facingVector(90_000_000)).toEqual([0n, 1_000_000_000n]);
    expect(facingVector(45_000_000)).toEqual([707106781n, 707106781n]);
    expect(facingVector(180_000_000)).toEqual([-1_000_000_000n, 0n]);
    expect(facingVector(-90_000_000)).toEqual([0n, -1_000_000_000n]);
  });

  it('the direction of F(θ) is θ for every θ in (−180°, 180°]', () => {
    let s = 12345;
    const next = (): number => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s;
    };
    const thetas = [1, -1, 179_999_999, -179_999_999, 180_000_000, 30_000_000, 60_000_000, 135_000_000];
    for (let i = 0; i < 300; i++) thetas.push((next() % 360_000_000) - 179_999_999);
    for (const t of thetas) {
      const [x, y] = facingVector(t);
      expect(direction(x, y)).toBe(t);
    }
  });

  it('direction is in (−180°, 180°]: just below the negative x-axis is 180,000,000, not −180,000,000', () => {
    expect(direction(-1, 0)).toBe(180_000_000);
    expect(direction(-9007199254740991n, -1n)).toBe(180_000_000);
    expect(direction(3, 4)).toBe(53_130_102);
    expect(direction(-3, -4)).toBe(-126_869_898);
  });
});

describe('versions and ranges (12.3)', () => {
  it('compares by Semantic Versioning precedence, 1.2 reading as 1.2.0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareVersions('10.0.0', '9.99.99')).toBe(1);
  });

  it('evaluates every comparator form', () => {
    expect(versionSatisfies('0.3.5', '^0.3.0')).toBe(true);
    expect(versionSatisfies('0.4.0', '^0.3.0')).toBe(false);
    expect(versionSatisfies('0.0.4', '^0.0.3')).toBe(false);
    expect(versionSatisfies('1.9.0', '^1.2.0')).toBe(true);
    expect(versionSatisfies('1.3.0', '~1.2.0')).toBe(false);
    expect(versionSatisfies('2.0.0-rc.1', '^1.0.0')).toBe(true); // no special treatment of prereleases
    expect(versionSatisfies('1.5.0', '>=1.0.0 <1.4.0 || >=2.0.0')).toBe(false);
    expect(versionSatisfies('2.1.0', '>=1.0.0 <1.4.0 || >=2.0.0')).toBe(true);
    expect(versionSatisfies('1.2', '=1.2.0')).toBe(true);
  });
});

describe('known extensions (12.2)', () => {
  it('accepts a valid registry as a value, text or bytes', () => {
    const reg = [entry('FS_a', '1.0.0'), entry('FS_a', '1.1.0')];
    expect(loadKnownExtensions(reg)).toHaveLength(2);
    expect(loadKnownExtensions(JSON.stringify(reg))).toHaveLength(2);
    expect(loadKnownExtensions(new TextEncoder().encode(JSON.stringify(reg)))).toHaveLength(2);
  });

  it('refuses a malformed entry, a duplicate, a cycle, and text that is not JSON', () => {
    expect(loadKnownExtensions([{ name: 'FS_a' }])).toBeUndefined();
    expect(loadKnownExtensions([entry('FS_a', '1.0.0'), entry('FS_a', '1.0.0')])).toBeUndefined();
    expect(loadKnownExtensions([entry('FS_a', '1.0.0', { requires: { FS_b: '^1.0.0' } }), entry('FS_b', '1.0.0', { requires: { FS_a: '^1.0.0' } })])).toBeUndefined();
    expect(loadKnownExtensions('[')).toBeUndefined();
    expect(loadKnownExtensions([entry('FS_a', '1.0.0', { status: 'ratified' })])).toBeUndefined();
  });

  it('FS-CFG-001 alone for every document when the registry is bad', () => {
    expect(codes(validate('not json', { knownExtensions: '{}' }))).toEqual(['FS-CFG-001']);
  });

  it('checks dependencies of a used, known extension', () => {
    const d = v02(box(1e6, 1e6), { extensionsUsed: { FS_a: '1.0', FS_b: { version: '0.9.0' } } });
    const known = [entry('FS_a', '1.0.0', { requires: { FS_b: '^1.0.0', FS_c: '>=0.1.0' } })];
    expect(codes(validate(d, { knownExtensions: known }))).toEqual(['FS-INV-601', 'FS-INV-602']);
    expect(validate(d).valid).toBe(true); // with no known extensions nothing is checked
  });
});

describe('program, hosting and clearances through the API', () => {
  const house = (): Record<string, unknown> =>
    v02(
      {
        junctions: { J1: [0, 0], J2: [0, 4000000], J3: [6000000, 4000000], J4: [6000000, 0], J5: [3000000, 0], J6: [3000000, 4000000] },
        walls: {
          W1: { start: 'J1', end: 'J2' },
          W2: { start: 'J2', end: 'J6' },
          W3: { start: 'J6', end: 'J3' },
          W4: { start: 'J3', end: 'J4' },
          W5: { start: 'J4', end: 'J5' },
          W6: { start: 'J5', end: 'J1' },
          W7: { start: 'J5', end: 'J6' },
        },
        rooms: { RA: { anchor: [1500000, 2000000], brief: 'BED' }, RB: { anchor: [4500000, 2000000], brief: 'KIT' } },
        openings: { O1: { wall: 'W7', offset: 1000000, fill: 'D' } },
      },
      {
        types: {
          D: {
            kind: 'doorType',
            width: 914400,
            height: 2032000,
            clearances: { swing: { purpose: 'swing', shape: 'box', min: [0, -457200, 0], max: [914400, 457200, 2032000] } },
          },
        },
        program: {
          items: { BED: { function: 'sleeping', count: 2, minArea: 100 }, KIT: { function: 'kitchen' } },
          adjacency: [{ a: 'BED', b: 'KIT', kind: 'forbidden' }],
        },
        extensionsUsed: { FS_furniture: '0.1' },
        extensions: {
          FS_furniture: {
            collections: {
              pieces: {
                BEDF: {
                  fallback: { level: 'L1', box: { min: [0, 0, 0], max: [2000000, 1500000, 600000] } },
                  host: { mode: 'surface', room: 'RA', surface: 'floor', position: [500000, 500000], rotation: 90000000 },
                },
              },
            },
          },
        },
      },
    );

  it('reports an unmet program as warnings, never errors (11.5.2)', () => {
    const r = validate(house());
    expect(r.valid).toBe(true);
    // The door joins the two rooms, but none leads outside: the building has no entry (14.4).
    expect(codes(r)).toEqual(['FS-LINT-008 BED', 'FS-LINT-011 BED,KIT', 'FS-LINT-014 B1']);
  });

  it('derives the program, fallbacks, placements, clearances and overlaps', () => {
    const d = derive(house());
    expect(d.program).toEqual({
      items: { BED: { rooms: ['RA'], countMet: false, minAreaMet: true }, KIT: { rooms: ['RB'], countMet: true } },
      adjacency: [{ a: 'BED', b: 'KIT', kind: 'forbidden', adjacent: true, connected: true }],
    });
    expect(d.placements).toEqual({ BEDF: { point: [500000, 500000, 0], facing: 90000000 } });
    expect(d.fallbacks!.BEDF).toMatchObject({ extension: 'FS_furniture', collection: 'pieces', level: 'L1', bottom: 0, top: 600000 });
    // rotated 90°: local +x runs along +y
    expect(d.fallbacks!.BEDF!.footprint).toEqual([
      [-1000000, 500000],
      [500000, 500000],
      [500000, 2500000],
      [-1000000, 2500000],
    ]);
    expect(Object.keys(d.clearances!)).toEqual(['O1']);
    expect(d.clearances!.O1!.swing).toMatchObject({ purpose: 'swing', level: 'L1', bottom: 0, top: 2032000 });
    expect(d.clearanceOverlaps).toEqual([]);
  });

  it('a 0.1 reader derives none of it, and a 0.1 document under a 0.2 reader derives it empty', () => {
    const d01 = check(doc(box(1e6, 1e6)));
    expect(d01.derived!.program).toEqual({ items: {}, adjacency: [] });
    expect(d01.derived!.clearanceOverlaps).toEqual([]);
    expect(d01.derived!.circulation).toEqual({});
    const r = check(doc(box(1e6, 1e6)), { core: '0.1' });
    expect(r.derived!.program).toBeUndefined();
    expect(r.derived!.circulation).toBeUndefined();
    expect(r.hash).toBe(d01.hash);
  });

  it('touching footprints do not overlap; overlapping by one unit do', () => {
    const a = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ] as [number, number][];
    expect(footprintsOverlap(a, a.map(([x, y]) => [x + 10, y] as [number, number]))).toBe(false);
    expect(footprintsOverlap(a, a.map(([x, y]) => [x + 9, y] as [number, number]))).toBe(true);
  });
});
