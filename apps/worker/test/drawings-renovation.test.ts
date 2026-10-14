/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportDxf, exportPdf, type Sheet } from '../src/export/drawings/index.js';
import type { Prim } from '../src/export/drawings/sheet.js';
import { DEMOLISH_INK } from '../src/export/drawings/renovation.js';
import { exportParams } from '../src/queue/handlers.js';

/**
 * FLR-T-18.13: renovation plans in the drawings — the courtyard house's kitchen remodel as its
 * existing, demolition, proposed and combined plans: existing work screened under new work,
 * demolished work dashed in red, a legend; in the DXF the changes on NCS status layers.
 */

const REMODEL = JSON.parse(readFileSync(new URL('./fixtures/courtyard-remodel.json', import.meta.url), 'utf8')) as object;
const VERSION = { hash: '3c9e1f0a71fe5b0c2d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c', seq: 7, at: new Date('2026-10-14T09:00:00Z') };
const fontDir = mkdtempSync(join(tmpdir(), 'floorspec-fonts-renovation-'));

const prims = (s: Sheet): Prim[] => {
  const out: Prim[] = [];
  const walk = (ps: readonly Prim[]): void => {
    for (const p of ps) {
      out.push(p);
      if (p.t === 'clip') walk(p.children);
    }
  };
  walk(s.prims);
  return out;
};
const texts = (s: Sheet): string[] => prims(s).flatMap((p) => (p.t === 'text' ? [p.text] : []));
const red = (s: Sheet): Prim[] => prims(s).filter((p) => p.t === 'path' && p.stroke === DEMOLISH_INK);

describe('renovation plans in the drawings (FLR-T-18.13)', { timeout: 180_000 }, () => {
  it('reads a job’s renovation plan, keeping only what it knows', () => {
    expect(exportParams({ versionAt: '2026-10-14T00:00:00Z', renovation: 'demolition' })).toMatchObject({ renovation: 'demolition' });
    expect(exportParams({ versionAt: '2026-10-14T00:00:00Z', renovation: 'after' })).not.toHaveProperty('renovation');
  });

  it('draws the demolition plan: what goes dashed in red, a legend, the plan named', async () => {
    const pdf = await exportPdf(REMODEL, { version: VERSION, levels: ['L1'], renovation: 'demolition', fontDir, viewDpi: 36 });
    expect(pdf.name).toMatch(/demolition-plans\.pdf$/);
    const sheet = pdf.sheets[0]!;
    expect(texts(sheet).join(' ')).toMatch(/Main floor demolition plan/i);
    expect(texts(sheet)).toContain('To be demolished');
    expect(texts(sheet)).not.toContain('New construction');
    expect(red(sheet).length).toBeGreaterThan(5);
  });

  it('draws the proposed plan with nothing demolished, and the existing plan plainly', async () => {
    const proposed = await exportPdf(REMODEL, { version: VERSION, levels: ['L1'], renovation: 'proposed', fontDir, viewDpi: 36 });
    expect(red(proposed.sheets[0]!)).toHaveLength(0);
    expect(texts(proposed.sheets[0]!)).toContain('New construction');
    const existing = await exportPdf(REMODEL, { version: VERSION, levels: ['L1'], renovation: 'existing', fontDir, viewDpi: 36 });
    expect(texts(existing.sheets[0]!)).not.toContain('Existing to remain');
    expect(texts(existing.sheets[0]!).join(' ')).toMatch(/Pantry/i);
  });

  it('puts the changes on status layers in the DXF', () => {
    const dxf = exportDxf(REMODEL, { version: VERSION, levels: ['L1'], renovation: 'combined' });
    const level = (r: typeof dxf) => new TextDecoder().decode(r.files.find((f) => f.name.includes('main-floor'))!.bytes);
    expect(dxf.files[0]!.name).toMatch(/main-floor-combined-plan\.dxf$/);
    const text = level(dxf);
    for (const layer of ['A-WALL-DEMO', 'A-WALL-NEWW', 'A-DOOR-DEMO', 'I-FURN-DEMO']) expect(text).toMatch(new RegExp(`\r\n *8\r\n${layer}\r\n`));
    const plain = level(exportDxf(REMODEL, { version: VERSION, levels: ['L1'] }));
    expect(plain).not.toMatch(/\r\n *8\r\nA-WALL-DEMO\r\n/);
  });
});
