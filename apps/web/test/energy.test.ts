import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENERGY_PATH, estimateEnergy } from '@floorspec/analysis';
import { assemblyIn, assemblyOut, ddIn, ddOut, estimateOf, hasInputs, setInputs, tempIn, tempOut } from '../src/energy/model';
import { describeJob, QUALITIES, SIZES, stillWithinBudget, type ExportJob } from '../src/exports/api';

/** The energy screen's model and the still's options (FLR-T-12.6). */

const RANCH = JSON.parse(readFileSync(new URL('../../../packages/engine/standard/templates/ranch.floorspec.json', import.meta.url), 'utf8')) as object;

describe('the energy screen’s model', () => {
  it('estimates a template, and says why there is nothing to estimate', () => {
    const e = estimateOf(RANCH);
    expect(e.status).toBe('ok');
    expect(estimateOf(null)).toEqual({ status: 'none', message: 'This project has no model yet.' });
    expect(estimateOf({ floorspec: '0.3' }).status).toBe('none');
  });

  it('saves inputs as one setProperty on the document’s extras, and resets them with an unset', () => {
    expect(setInputs({ zone: '5A', ach: 0.3 }, false)).toEqual([{ op: 'setProperty', id: '$document', path: ENERGY_PATH, value: { zone: '5A', ach: 0.3 } }]);
    expect(setInputs({}, true)).toEqual([{ op: 'unsetProperty', id: '$document', path: ENERGY_PATH }]);
    expect(setInputs({}, false)).toEqual([]);
    expect(hasInputs({ extras: { d3floorspec: { energy: {} } } })).toBe(true);
    expect(hasInputs(RANCH)).toBe(false);
  });

  it('speaks the project’s units: °F and °F·days and R-values, or SI, and back', () => {
    expect(tempIn(0, 'imperial')).toBe(32);
    expect(tempOut(212, 'imperial')).toBeCloseTo(100, 9);
    expect(tempIn(-10.56, 'metric')).toBe(-10.6);
    expect(ddIn(2500, 'imperial')).toBe(4500);
    expect(ddOut(4500, 'imperial')).toBeCloseTo(2500, 9);
    // A wall of U 0.2555 W/m²K is R-22; R-22 back is the same U.
    expect(assemblyIn({ kind: 'wall', value: 0.045 * 5.678263 }, 'imperial')).toBe(22.2);
    expect(assemblyOut('wall', 22.222, 'imperial')).toBeCloseTo(0.2555, 3);
    expect(assemblyIn({ kind: 'slab', value: 0.54 * 1.730735 }, 'imperial')).toBe(0.54);
    expect(assemblyIn({ kind: 'wall', value: 0.3 }, 'metric')).toBe(0.3);
  });

  it('a saved value changes the estimate it is saved for', () => {
    const doc = { ...RANCH, extras: { d3floorspec: { energy: { zone: '6A' } } } };
    const cold = estimateEnergy(doc);
    const mild = estimateEnergy(RANCH);
    expect(cold.climate.zone).toBe('6A');
    expect(cold.loads.heating).toBeGreaterThan(mild.loads.heating);
  });
});

describe('stills in the exports list', () => {
  it('offers exactly the worker’s sizes, qualities and budget', () => {
    const worker = readFileSync(new URL('../../worker/src/pathtrace/presets.ts', import.meta.url), 'utf8');
    expect(worker).toContain(`export const SIZES = ${JSON.stringify(SIZES).replace(/"(\w+)":/g, '$1: ').replace(/,(?=\w)/g, ', ').replace(/{/g, '{ ').replace(/}/g, ' }').replace(/\[(\d+),(\d+)\]/g, '[$1, $2]')}`);
    expect(worker).toContain(`export const QUALITIES = { draft: ${String(QUALITIES.draft)}, standard: ${String(QUALITIES.standard)}, high: ${String(QUALITIES.high)} }`);
    expect(worker).toContain('export const MAX_WORK = 1024 * 768 * 256;');
    expect(stillWithinBudget('large', 'high')).toBe(false);
    expect(stillWithinBudget('medium', 'high')).toBe(true);
  });

  it('says how far a still has got', () => {
    const job = { id: 'j', kind: 'still', status: 'running', version: 'v', versionSeq: 4, levels: null, page: null, design: null, error: null, result: null, createdAt: '', finishedAt: null, download: null, progress: { pass: 26, passes: 64 } } satisfies ExportJob;
    expect(describeJob(job)).toBe('Rendering the still… pass 26 of 64');
    expect(describeJob({ ...job, status: 'queued', progress: null })).toBe('Still waiting to be rendered');
  });
});
