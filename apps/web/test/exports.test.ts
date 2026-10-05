import { describe, expect, it } from 'vitest';
import { describeJob, designLabel, designSetsOf, takesDesign, type ExportJob } from '../src/exports/api';

/** The Export dialog's design choice and the job list's naming of it (FLR-T-9.7). */

const document = {
  floorspec: '0.3',
  optionSets: { KIT: { name: 'Kitchen', primary: 'KA' }, ST: { primary: 'SN' } },
  options: { KB: { set: 'KIT', name: 'B' }, KA: { set: 'KIT', name: 'A' }, SN: { set: 'ST' }, SS: { set: 'ST', name: 'South' } },
};

const job = (over: Partial<ExportJob>): ExportJob => ({
  id: 'j', kind: 'pdf', status: 'done', version: 'v', versionSeq: 3, levels: null, page: 'tabloid', design: null, error: null,
  result: { name: 'kitchen-v3-plans.pdf', size: 1, sheets: [{ number: 'A-101', title: 'Level 1' }] }, createdAt: '', finishedAt: null, download: null,
  ...over,
});

describe('designs in exports', () => {
  it('reads a document’s option sets and options, in ID order, with names where they have them', () => {
    expect(designSetsOf(document)).toEqual([
      { id: 'KIT', name: 'Kitchen', primary: 'KA', options: [{ id: 'KA', name: 'A' }, { id: 'KB', name: 'B' }] },
      { id: 'ST', name: 'ST', primary: 'SN', options: [{ id: 'SN', name: 'SN' }, { id: 'SS', name: 'South' }] },
    ]);
    expect(designSetsOf({ floorspec: '0.3' })).toEqual([]);
    expect(designSetsOf(null)).toEqual([]);
  });

  it('names a design one choice per set, as the options chip does', () => {
    const sets = designSetsOf(document);
    expect(designLabel({ KIT: 'KB' }, sets)).toBe('Kitchen B');
    expect(designLabel({ ST: 'SS', KIT: 'KA' }, sets)).toBe('Kitchen A, ST South');
    // A set the names are not known for still says what was chosen.
    expect(designLabel({ KIT: 'KB' })).toBe('KIT KB');
  });

  it('says which design a job was made in, and nothing for one made without a choice', () => {
    const sets = designSetsOf(document);
    expect(describeJob(job({ design: { KIT: 'KB' } }), sets)).toBe('kitchen-v3-plans.pdf · 1 sheet · design Kitchen B');
    expect(describeJob(job({}), sets)).toBe('kitchen-v3-plans.pdf · 1 sheet');
    expect(describeJob(job({ status: 'running', design: { KIT: 'KB' } }), sets)).toBe('Drawing the PDF… · design Kitchen B');
  });

  it('is asked for every kind but IFC, which is of the primary design', () => {
    expect((['pdf', 'dxf', 'gltf', 'usdz', 'ifc'] as const).filter(takesDesign)).toEqual(['pdf', 'dxf', 'gltf', 'usdz']);
  });
});
