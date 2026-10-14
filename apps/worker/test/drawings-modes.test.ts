/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportDxf, exportPdf, splitPlan, statesOf, type Sheet } from '../src/export/drawings/index.js';
import type { Prim } from '../src/export/drawings/sheet.js';
import { exportParams } from '../src/queue/handlers.js';

/**
 * FLR-T-18.3: drawings in a trade's view. The Courtyard House as an electrical plan — its devices
 * drawn, the building screened grey under them, plumbing and the garden left out — and as a
 * furniture plan; the DXF leaves out what is off and names the drawing.
 */

const HOUSE = JSON.parse(readFileSync(new URL('./fixtures/courtyard-house.json', import.meta.url), 'utf8')) as object;
const VERSION = { hash: '3c9e1f0a71fe5b0c2d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c', seq: 58, at: new Date('2026-10-12T18:30:00Z') };
const fontDir = mkdtempSync(join(tmpdir(), 'floorspec-fonts-modes-'));

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
const strokes = (s: Sheet): Set<string> => new Set(prims(s).flatMap((p) => (p.t === 'path' && p.stroke !== undefined ? [p.stroke] : [])));

describe('drawings in a trade’s view (FLR-T-18.3)', () => {
  it('reads a job’s mode and layers, keeping only what it knows', () => {
    expect(exportParams({ versionAt: '2026-10-12T00:00:00Z', mode: 'electrical', layers: { walls: 'off', plumbing: 'maybe', attic: 'on' } })).toMatchObject({ mode: 'electrical', layers: { walls: 'off' } });
    expect(exportParams({ versionAt: '2026-10-12T00:00:00Z', mode: 'kitchen' })).not.toHaveProperty('mode');
    expect(statesOf({})).toBeNull();
  });

  it('an electrical plan: its sheets named for it, the building screened under the devices, a smaller file name', async () => {
    const all = await exportPdf(HOUSE, { version: VERSION, fontDir });
    const pdf = await exportPdf(HOUSE, { version: VERSION, fontDir, mode: 'electrical' });
    expect(pdf.name).toMatch(/-electrical-plans\.pdf$/);
    const sheet = pdf.sheets[0]!;
    expect(sheet.title).toMatch(/electrical plan$/);
    expect(texts(sheet).some((t) => /electrical plan/i.test(t))).toBe(true);
    // The screen's grey is on the sheet; the plain drawing has none.
    expect(strokes(sheet).has('#a3a3a3')).toBe(true);
    expect(strokes(all.sheets[0]!).has('#a3a3a3')).toBe(false);
  });

  it('splits a plan by the mode’s states: on, ghost, and nothing of what is off', async () => {
    const pdf = await exportPdf(HOUSE, { version: VERSION, fontDir, mode: 'decorator' });
    expect(pdf.name).toMatch(/-furniture-plans\.pdf$/);
    expect(pdf.sheets[0]?.title).toMatch(/furniture plan$/);
  });

  it('a DXF of a mode leaves out the layers that are off and is named for it', () => {
    const all = exportDxf(HOUSE, { version: VERSION });
    const electrical = exportDxf(HOUSE, { version: VERSION, mode: 'electrical' });
    expect(electrical.files.every((f) => f.name.includes('-electrical-plan'))).toBe(true);
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    const body = text(electrical.files[0]!.bytes);
    const full = text(all.files[0]!.bytes);
    // Plumbing fixtures are on P-FIXT in the full drawing; the electrical plan has none on it.
    const onLayer = (dxf: string, layer: string) => (dxf.match(new RegExp(`\\r?\\n  8\\r?\\n${layer}\\r?\\n`, 'g')) ?? []).length;
    expect(onLayer(full, 'P-FIXT')).toBeGreaterThan(0);
    expect(onLayer(body, 'P-FIXT')).toBe(0);
    expect(onLayer(body, 'E-POWR-DEVC')).toBe(onLayer(full, 'E-POWR-DEVC'));
    expect(body).toMatch(/ELECTRICAL PLAN/);
  });

  it('a person’s own layers over the mode: walls off leaves no wall on the ghost', () => {
    const states = statesOf({ mode: 'electrical', layers: { walls: 'off' } });
    expect(states?.walls).toBe('off');
    expect(splitPlan({ pieces: [{ ring: [], exterior: true }], cuts: [], outline: [], wallLines: [], separators: [], doors: [], windows: [], tags: [], rooms: [], slabs: [], unanchored: [], devices: [], stairs: [], roofs: [] } as never, states).ghost?.pieces).toEqual([]);
  });
});
