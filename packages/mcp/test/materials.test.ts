import { describe, expect, it } from 'vitest';
import { LIBRARY_FILES } from '@floorspec/mesh/materials';
import { embedMaterialOps, libraryFilesAdded, materialFileBytes, materialsText, missingLibraryMaterials } from '../src/materials.js';
import type { Op } from '../src/client.js';

/** FLR-T-13.6: an agent names a library material where a material goes, and the tools embed it with its maps. */
describe('the material library through MCP', () => {
  const doc = { floorspec: '0.3', project: { name: 'T' }, materials: { 'paint-sage': { color: '#a7b59c' } } };

  it('finds the library materials a batch names that the document lacks, in finishes and set paths alike', () => {
    const batch: Op[] = [
      { op: 'setProperty', id: 'R1', path: '/floorFinish', value: 'white-oak-plank' },
      { op: 'setProperty', id: 'R2', path: '/wallFinish', value: 'paint-sage' },
      { op: 'addElement', collection: 'roofs', id: 'RF1', element: { material: 'standing-seam' } },
    ];
    expect(missingLibraryMaterials(doc, batch)).toEqual(['standing-seam', 'white-oak-plank']);
  });

  it('embeds each with its maps once, and names the library files to upload', () => {
    const ops = embedMaterialOps(doc, ['paint-eggshell', 'paint-satin', 'white-oak-plank']);
    const assets = ops.filter((o) => o['collection'] === 'assets').map((o) => o['id']);
    expect(assets).toEqual(['paint-stipple.normal', 'white-oak-plank.albedo', 'white-oak-plank.normal', 'white-oak-plank.orm']);
    expect(ops.filter((o) => o['collection'] === 'materials').map((o) => o['id'])).toEqual(['paint-eggshell', 'paint-satin', 'white-oak-plank']);
    expect(libraryFilesAdded(ops)).toEqual(['paint-stipple.normal.jpg', 'white-oak-plank.albedo.jpg', 'white-oak-plank.normal.jpg', 'white-oak-plank.orm.jpg']);
    expect(materialFileBytes('paint-stipple.normal.jpg').length).toBe(LIBRARY_FILES['paint-stipple.normal.jpg']?.byteLength);
    expect(materialsText()).toContain('white-oak-plank');
  });
});
