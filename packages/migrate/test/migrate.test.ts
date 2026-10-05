import { describe, expect, it } from 'vitest';
import { canonicalize, check } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { MigrationRefusedError, RECORD, migrate, migrationBatch, needsMigration, pointer, step } from '../src/index.js';

const MM = 1280;

/** One 4 m x 3 m room on one level, declaring `floorspec`. */
function house(floorspec: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const j = (x: number, y: number) => ({ level: 'L1', position: [x * MM, y * MM] });
  const w = (start: string, end: string) => ({ level: 'L1', start, end, type: 'WT' });
  return {
    floorspec,
    project: { name: 'M' },
    buildings: { B1: {} },
    levels: { L1: { building: 'B1', elevation: 0, height: 2700 * MM } },
    types: { WT: { kind: 'wallType', layers: [{ thickness: 100 * MM, function: 'core' }] } },
    junctions: { J1: j(0, 0), J2: j(0, 3000), J3: j(4000, 3000), J4: j(4000, 0) },
    walls: { W1: w('J1', 'J2'), W2: w('J2', 'J3'), W3: w('J3', 'J4'), W4: w('J4', 'J1') },
    rooms: { R1: { level: 'L1', anchor: [2000 * MM, 1500 * MM] } },
    ...extra,
  };
}

const outlet = (option?: unknown) => ({
  fallback: { level: 'L1', box: { min: [0, -40 * MM, 0], max: [20 * MM, 40 * MM, 100 * MM] } },
  host: { mode: 'wallFace', wall: 'W2', side: 'right', offset: 1200 * MM, height: 300 * MM },
  device: 'receptacle',
  ...(option !== undefined && { option }),
});

const opaque = house('0.1', {
  extensionsUsed: { FS_furniture: '0.1' },
  extensions: { FS_furniture: { style: 'shaker', collections: { pieces: { SOFA: { fallback: 'not a fallback' } } } } },
});

describe('migrate', () => {
  it('moves 0.1 opaque collections into the record, and reads the same (20.4, 20.6)', () => {
    const r = migrate(opaque, '0.3');
    expect(r.status).toBe('migrated');
    if (r.status !== 'migrated') return;
    expect(r.document.extensions).toEqual({ FS_furniture: { style: 'shaker' } });
    expect(r.records).toEqual([
      { from: '0.1', to: '0.2', moved: [{ pointer: '/extensions/FS_furniture/collections', value: { pieces: { SOFA: { fallback: 'not a fallback' } } } }] },
    ]);
    expect((r.document.extras as Record<string, unknown>)[RECORD]).toEqual(r.records);
    expect(check(r.text).derived).toEqual(check(opaque).derived);
    expect(opaque.floorspec).toBe('0.1'); // the input is not changed
  });

  it('moves a 0.2 extension element’s own option (20.5)', () => {
    const doc = house('0.2', { extensionsUsed: { FS_electrical: '0.1.0' }, extensions: { FS_electrical: { collections: { devices: { X4: outlet('deluxe') } } } } });
    expect(check(doc).valid).toBe(true);
    const s = step(doc);
    expect(s.document.floorspec).toBe('0.3');
    expect(s.record?.moved).toEqual([{ pointer: '/extensions/FS_electrical/collections/devices/X4/option', value: 'deluxe' }]);
    expect(check(s.document).valid).toBe(true);
  });

  it('is the document itself for its own draft, nothing omitted (20.1.1, 20.1.2)', () => {
    const doc = house('0.2');
    (doc.walls as Record<string, Record<string, unknown>>).W1!.justification = 'center';
    const r = migrate(JSON.stringify(doc), '0.2');
    expect(r.status === 'migrated' && r.text.includes('"justification": "center"')).toBe(true);
    expect(r.status === 'migrated' && r.records).toEqual([]);
  });

  it('refuses what chapter 20 refuses', () => {
    const codes = (input: string | object, to: unknown = '0.3') => migrate(input, to).diagnostics.map((d) => d.code);
    expect(codes('{')).toEqual(['FS-JSON-001']);
    expect(codes(house('0.9'))).toEqual(['FS-DOC-001']);
    expect(codes(house('0.1', { program: {} }))).toEqual(['FS-SCH-001']);
    expect(codes(house('0.3'), '0.2')).toEqual(['FS-MIG-001']);
    expect(codes(house('0.1'), 0.3)).toEqual(['FS-MIG-001']);
    expect(codes({ ...opaque, extras: { [RECORD]: 'x' } })).toEqual(['FS-MIG-002']);
    expect(codes(house('0.1', { extras: { [RECORD]: 'x' } }))).toEqual([]);
    expect(codes(house('0.2', { extensionsUsed: { EXT_a: '1.0' }, extensionsRequired: ['EXT_a'] }))).toEqual([]);
  });

  it('escapes pointers as RFC 6901 says', () => {
    expect(pointer('a/b', 'c~d')).toBe('/a~1b/c~0d');
  });
});

describe('migrationBatch', () => {
  it('is empty for a document that declares the target', () => {
    expect(migrationBatch(house('0.4'))).toEqual([]);
    expect(needsMigration(house('0.4'))).toBe(false);
    expect(needsMigration(house('0.3'))).toBe(true);
    expect(needsMigration(house('0.1'))).toBe(true);
  });

  it('is a version bump when nothing moves', () => {
    expect(migrationBatch(house('0.2'))).toEqual([{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.4' }]);
    expect(migrationBatch(house('0.3'))).toEqual([{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.4' }]);
  });

  it('commits exactly the migration, and its inverse restores the document', () => {
    const batch = migrationBatch(opaque);
    expect(batch).toEqual([
      { op: 'unsetProperty', id: '$document', path: '/extensions/FS_furniture/collections' },
      { op: 'setProperty', id: '$document', path: '/extras/floorspec:migration', value: expect.any(Array) as unknown },
      { op: 'setProperty', id: '$document', path: '/floorspec', value: '0.4' },
    ]);
    const r = apply(opaque, { batch });
    expect(r.status).toBe('committed');
    if (r.status !== 'committed') return;
    const m = migrate(opaque);
    expect(r.document).toBe(canonicalize(m.status === 'migrated' && m.document));
    const back = apply(r.document, { batch: r.inverse });
    expect(back.status === 'committed' && back.document).toBe(canonicalize(opaque));
  });

  it('where a version bump alone is rejected: a 0.2 element whose own option names no option', () => {
    const doc = house('0.2', { extensionsUsed: { FS_electrical: '0.1.0' }, extensions: { FS_electrical: { collections: { devices: { X4: outlet('deluxe') } } } } });
    const bump = apply(doc, { batch: [{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' }] });
    expect(bump.status).toBe('rejected');
    expect(apply(doc, { batch: migrationBatch(doc) }).status).toBe('committed');
  });

  it('throws when the migration is refused', () => {
    expect(() => migrationBatch({ ...opaque, extras: { [RECORD]: 'x' } })).toThrow(MigrationRefusedError);
  });
});
