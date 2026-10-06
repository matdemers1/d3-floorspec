/**
 * FLR-T-12.8: the worker's drawings and plan PNGs draw with the reader the api validates with, and
 * validate a model once. A model that requires an official extension — valid under OFFICIAL_READER,
 * refused by a core-only reader — is drawn.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as engine from '@floorspec/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportDxf, exportPdf, levelPlan } from '../src/export/drawings/index.js';
import { pngSize, renderPlanPng } from '../src/render/index.js';

vi.mock('@floorspec/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@floorspec/engine')>();
  return { ...actual, evaluate: vi.fn(actual.evaluate) };
});

const { check, InvalidDocumentError, OFFICIAL_READER } = engine;
const evaluations = vi.mocked(engine.evaluate);

const fixture = (path: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, unknown>;
const VERSION = { hash: '3c9e1f0a71fe5b0c2d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c', seq: 7, at: new Date('2026-10-06T12:00:00Z') };
const fontDir = mkdtempSync(join(tmpdir(), 'floorspec-fonts-reader-'));

/** The ranch with a smoke alarm in the living room, which it requires FS_electrical to read. */
function requiresElectrical(): Record<string, unknown> {
  const d = fixture('../../../packages/mcp/test/fixtures/two-bedroom-ranch.json');
  d['floorspec'] = '0.4';
  d['extensionsUsed'] = { FS_electrical: '0.1.0' };
  d['extensionsRequired'] = ['FS_electrical'];
  d['extensions'] = {
    FS_electrical: {
      collections: {
        alarms: {
          SA1: {
            fallback: { level: 'MAIN', box: { min: [-96000, -96000, -64000], max: [96000, 96000, 0] } },
            host: { mode: 'surface', room: 'LIV', surface: 'ceiling', position: [4681728, 3121152] },
            detects: ['smoke'],
          },
        },
      },
    },
  };
  return d;
}

beforeEach(() => {
  evaluations.mockClear();
});

describe('a model that requires an official extension', () => {
  it('is valid under OFFICIAL_READER and refused by a core-only reader', () => {
    expect(check(requiresElectrical(), OFFICIAL_READER).valid).toBe(true);
    expect(check(requiresElectrical()).diagnostics.map((d) => d.code)).toEqual(['FS-DOC-002']);
  });

  it('is drawn as a DXF, validated once', () => {
    const dxf = exportDxf(requiresElectrical(), { version: VERSION });
    expect(dxf.files).toHaveLength(1);
    expect(new TextDecoder().decode(dxf.files[0]?.bytes)).toContain('A-WALL');
    expect(evaluations).toHaveBeenCalledTimes(1);
    expect(evaluations.mock.calls[0]?.[1]).toEqual(OFFICIAL_READER);
  });

  it('is drawn as a PDF — plans and 3D views from the one evaluation', async () => {
    const pdf = await exportPdf(requiresElectrical(), { version: VERSION, fontDir, viewDpi: 72 });
    expect(pdf.sheets[0]?.number).toBe('A-101');
    expect(evaluations).toHaveBeenCalledTimes(1);
  });

  it('draws one level with levelPlan, validated once; a core-only reader refuses it', () => {
    expect(levelPlan(requiresElectrical(), 'MAIN').levelId).toBe('MAIN');
    expect(evaluations).toHaveBeenCalledTimes(1);
    expect(() => levelPlan(requiresElectrical(), 'MAIN', new Map(), undefined, {})).toThrow(InvalidDocumentError);
  });

  it('draws as a plan PNG, validated once', () => {
    const png = renderPlanPng(requiresElectrical(), { width: 320, fontDir });
    expect(pngSize(png).width).toBe(320);
    expect(evaluations).toHaveBeenCalledTimes(1);
  });

  it('refuses a drawing with a reader that does not implement the extension', () => {
    expect(() => exportDxf(requiresElectrical(), { version: VERSION, reader: {} })).toThrow(InvalidDocumentError);
  });
});
