/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dimensionStrings, exportDxf, exportPdf, levelPlan, openingMarks, type Sheet } from '../src/export/drawings/index.js';
import { buildScene } from '@floorspec/render2d';

/**
 * FLR-T-18.11: the Courtyard House's sheet — the clutter FLR-T-18.5 found (inch-long spans along the
 * top, a stack of strings down the left) gone; the person's own strings and notes (FS_annotation)
 * on the PDF and the DXF; the area summary in the title strip.
 */

const HOUSE = JSON.parse(readFileSync(new URL('./fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const ANNOTATED = {
  ...HOUSE,
  extensionsUsed: { ...(HOUSE['extensionsUsed'] as object), FS_annotation: '0.1.0' },
  extensions: {
    ...(HOUSE['extensions'] as object),
    FS_annotation: {
      dimensions: { DM1: { level: 'L1', direction: [1, 0], through: [21_000_000, 1_600_000], anchors: [{ junction: 'J16' }, { opening: 'O36' }, { opening: 'O37' }, { junction: 'J8' }] } },
      notes: { NT1: { level: 'L1', text: 'Verify the header over the den doors', at: [19_300_000, 7_300_000], leader: [21_200_000, 5_600_000] } },
    },
  },
};
const VERSION = { hash: '3c9e1f0a71fe5b0c2d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c', seq: 58, at: new Date('2026-10-14T12:00:00Z') };
const fontDir = mkdtempSync(join(tmpdir(), 'floorspec-fonts-annotation-'));
const texts = (s: Sheet): string[] => s.prims.flatMap((p) => (p.t === 'text' ? [p.text] : []));

describe('dimensions and annotation on the drawings (FLR-T-18.11)', { timeout: 120_000 }, () => {
  it('dimensions the Courtyard House with no span under 6" and no more than three strings a side', () => {
    const plan = levelPlan(HOUSE, 'L1', openingMarks([buildScene(HOUSE, 'L1')]));
    const dims = dimensionStrings(plan);
    for (const d of dims) for (const l of d.lengths) expect(l, d.id).toBeGreaterThanOrEqual(6 * 32_512);
    for (const side of ['N', 'S', 'E', 'W']) expect(dims.filter((d) => d.side === side && d.local !== true).length).toBeLessThanOrEqual(3);
  });

  it('prints the person’s strings and notes, and the area summary', async () => {
    const pdf = await exportPdf(ANNOTATED, { version: VERSION, fontDir, viewDpi: 48, levels: ['L1'] });
    const t = texts(pdf.sheets[0]!);
    // DM1: the den's south wall from its corner to each window's centre and on to the next corner.
    expect(t).toContain(`3'-8 3/4"`);
    expect(t).toContain(`4'-3 1/4"`);
    expect(t).toContain('Verify the header over the den doors');
    expect(t).toContain('AREA');
    expect(t).toContain('Gross (to exterior faces)');
    expect(t).toContain('Finished (Z765)');
    // Leaders end in a filled arrowhead.
    expect(pdf.sheets[0]!.prims.some((p) => p.t === 'path' && p.fill === '#000000' && /^M[^M]*L[^M]*L[^M]*Z$/.test(p.d))).toBe(true);
  });

  it('writes them into the DXF too', () => {
    const dxf = exportDxf(ANNOTATED, { version: VERSION, levels: ['L1'] });
    const text = new TextDecoder().decode(dxf.bytes);
    expect(text).toContain('Verify the header over the den doors');
    expect(text).toContain(`8'-0"`);
  });

  it('draws nothing of a person’s string the model no longer lets it measure', async () => {
    const orphan = structuredClone(ANNOTATED) as typeof ANNOTATED & { extensions: { FS_annotation: { dimensions: Record<string, { anchors: unknown[] }> } } };
    orphan.extensions.FS_annotation.dimensions['DM1']!.anchors = [{ junction: 'J16' }, { junction: 'NOPE' }];
    const pdf = await exportPdf(orphan, { version: VERSION, fontDir, viewDpi: 48, levels: ['L1'] });
    expect(pdf.sheets.length).toBeGreaterThan(0);
  });
});
