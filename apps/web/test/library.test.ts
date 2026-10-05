import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { check, OFFICIAL_READER, type FloorspecDocument } from '@floorspec/engine';
import { LIBRARY_ITEMS, libraryChoices } from '../src/editor/library';
import { typeChoices, useType } from '../src/editor/ops';
import { TEMPLATES } from '../src/projects/templates';

/** FLR-T-10.4 in the editor: a US starter library type embedded with its materials, by its own batch. */

const house = JSON.parse(TEMPLATES.find((t) => t.id === 'three-room-house')?.document ?? '{}') as FloorspecDocument;

describe('the US starter library', () => {
  it('holds wall, door and window types and materials', () => {
    const kinds = new Set(LIBRARY_ITEMS.map((i) => i.kind));
    expect([...kinds].sort()).toEqual(['doorType', 'material', 'wallType', 'windowType']);
  });

  it('embeds a wall type and its materials when a wall uses it, and offers it no more', () => {
    const choice = typeChoices(house, 'wallType').find((c) => c.id === 'wall-2x4-interior');
    expect(choice?.library).toBeDefined();
    const used = useType(house, choice, 0);
    expect(used.id).toBe('wall-2x4-interior');
    // A wall whose joins still apply at the new thickness (a butt join may not, FS-INV-111).
    const r = Object.keys(house.walls ?? {})
      .map((wall) => apply({ ...house, floorspec: '0.3' }, { batch: [...used.ops, { op: 'setProperty', id: wall, path: '/type', value: used.id }] }, OFFICIAL_READER))
      .find((x) => x.status === 'committed') ?? { status: 'rejected' };
    expect(r.status, JSON.stringify(r)).toBe('committed');
    const doc = JSON.parse((r as { document: string }).document) as FloorspecDocument;
    expect(check(doc).valid).toBe(true);
    expect(doc.types?.['wall-2x4-interior']?.source).toMatchObject({ item: 'wall-2x4-interior', version: '0.1.0' });
    expect(Object.keys(doc.materials ?? {})).toEqual(expect.arrayContaining(['gypsum-board', 'wood-stud-framing']));
    expect(libraryChoices(doc, 'wallType').some((i) => i.id === 'wall-2x4-interior')).toBe(false);
    // A second type sharing a material copies only what is missing.
    const exterior = typeChoices(doc, 'wallType').find((c) => c.library?.element['layers'] !== undefined && JSON.stringify(c.library.embed).includes('gypsum-board'));
    if (exterior !== undefined) expect(useType(doc, exterior, 0).ops.some((op) => (op as { id?: string }).id === 'gypsum-board')).toBe(false);
  });
});
