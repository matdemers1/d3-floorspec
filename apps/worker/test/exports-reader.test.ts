/**
 * FLR-T-12.10: every 3D, IFC and still path reads a model as the editor does — OFFICIAL_READER, the
 * reader the api validates with and the drawings draw with (FLR-T-12.8) — and validates it once a
 * job. So a model that requires an official extension exports in every kind, and one the editor calls
 * invalid is refused in every kind, even when a core-only reader would have taken it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import * as engine from '@floorspec/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportGltf, exportUsdz, readGlb } from '../src/export/gltf/index.js';
import { exportIfc, ifcPayload } from '../src/export/ifc/index.js';
import { renderStill } from '../src/pathtrace/index.js';
import { createHandlers, type Handler, type JobRow } from '../src/queue/handlers.js';
import { render3dPng } from '../src/render3d/index.js';
import { pngSize } from '../src/render/index.js';

vi.mock('@floorspec/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@floorspec/engine')>();
  return { ...actual, evaluate: vi.fn(actual.evaluate) };
});

const { check, InvalidDocumentError, OFFICIAL_READER } = engine;
const evaluations = vi.mocked(engine.evaluate);

const fixture = (path: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, unknown>;
const VERSION = { hash: '3c9e1f0a71fe5b0c2d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c', seq: 7, at: new Date('2026-10-06T12:00:00Z') };

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

/**
 * Core 0.3's kitchen with two option sets, as written: valid to a core-only reader, but its
 * refrigerators are FS_furniture 0.1.0 pieces with no model or symbol, so the editor's reader calls
 * it invalid (FS-INV-603; with those given, the missing category is FS-FURN-SCH-001 next).
 */
const editorInvalid = (): Record<string, unknown> => fixture('../../../packages/engine/standard/conformance/core/0.3/examples/002-kitchen-options/input.json');

/** A kind's handler from the job table. */
function handlerFor(kind: string): Handler {
  const h = createHandlers()[kind];
  if (h === undefined) throw new Error(`no handler for ${kind}`);
  return h;
}

/** A job row for a handler. */
const job = (kind: string, params: Record<string, unknown> = {}): JobRow => ({ id: 'j', projectId: 'p', kind, params: { versionSeq: 7, versionAt: VERSION.at.toISOString(), ...params }, versionHash: VERSION.hash });

/** A stand-in IFC worker: answers every payload with a stub file, and keeps the last payload. */
let ifcServer: Server;
let ifcUrl = '';
let lastPayload: { derived: { extensions?: Record<string, unknown> }; document: { extensionsRequired?: string[] } } | null = null;

beforeAll(async () => {
  ifcServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastPayload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof lastPayload;
      const summary = { schema: 'IFC4', view: 'ReferenceView_V1.2', entities: {}, validation: { errors: 0 } };
      res.writeHead(200, { 'content-type': 'application/x-step', 'x-floorspec-ifc-summary': JSON.stringify(summary) });
      res.end('ISO-10303-21;\n');
    });
  });
  await new Promise<void>((resolve) => ifcServer.listen(0, '127.0.0.1', resolve));
  ifcUrl = `http://127.0.0.1:${String((ifcServer.address() as AddressInfo).port)}`;
  vi.stubEnv('IFC_WORKER_URL', ifcUrl);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => ifcServer.close(resolve));
});

beforeEach(() => {
  evaluations.mockClear();
  lastPayload = null;
});

/** One evaluation, with the editor's reader (and the design, when one was asked for). */
function readOnceAsTheEditor(): void {
  expect(evaluations).toHaveBeenCalledTimes(1);
  expect(evaluations.mock.calls[0]?.[1]).toMatchObject(OFFICIAL_READER);
}

describe('the readers these fixtures need', () => {
  it('the wired ranch is valid only to a reader that implements FS_electrical', () => {
    expect(check(requiresElectrical(), OFFICIAL_READER).valid).toBe(true);
    expect(check(requiresElectrical()).diagnostics.map((d) => d.code)).toEqual(['FS-DOC-002']);
  });

  it('the kitchen as written is valid core-only and invalid to the editor', () => {
    expect(check(editorInvalid()).valid).toBe(true);
    const codes = new Set(check(editorInvalid(), OFFICIAL_READER).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code));
    expect([...codes]).toEqual(['FS-INV-603']);
  });
});

describe('a model that requires an official extension exports in every kind, validated once', () => {
  it('glTF', async () => {
    const file = await exportGltf(requiresElectrical(), { version: VERSION });
    readOnceAsTheEditor();
    const nodes = readGlb(file.bytes).json['nodes'] as { extras?: { floorspec?: Record<string, unknown> } }[];
    // The alarm is drawn as its fallback box (Core 12.6).
    expect(nodes.some((n) => n.extras?.floorspec?.['id'] === 'SA1')).toBe(true);
  });

  it('USDZ', async () => {
    const file = await exportUsdz(requiresElectrical(), { version: VERSION });
    readOnceAsTheEditor();
    expect(file.contentType).toBe('model/vnd.usdz+zip');
  });

  it('IFC: the payload is derived with the editor’s reader, the extension’s derived values with it', async () => {
    const payload = ifcPayload(requiresElectrical(), VERSION);
    readOnceAsTheEditor();
    expect(payload.document.extensionsRequired).toEqual(['FS_electrical']);
    expect(payload.derived.extensions).toHaveProperty('FS_electrical');
    evaluations.mockClear();
    const out = await exportIfc(requiresElectrical(), { version: VERSION, workerUrl: ifcUrl });
    readOnceAsTheEditor();
    expect(out.contentType).toBe('application/x-step');
  });

  it('a still', async () => {
    const r = await renderStill(requiresElectrical(), { pixels: { width: 32, height: 24 }, samples: 2, denoise: false });
    readOnceAsTheEditor();
    expect(pngSize(r.png)).toEqual({ width: 32, height: 24 });
  });

  it('a 3D render', async () => {
    const r = await render3dPng(requiresElectrical(), { width: 64 });
    readOnceAsTheEditor();
    expect(pngSize(r.png).width).toBe(64);
  });

  it('through the job handlers: export.gltf, export.usdz, export.ifc and render.3d', async () => {
    for (const [kind, params] of [['export.gltf', {}], ['export.usdz', {}], ['export.ifc', {}], ['render.3d', { width: 64 }]] as const) {
      evaluations.mockClear();
      const file = await handlerFor(kind)(requiresElectrical(), job(kind, params));
      readOnceAsTheEditor();
      expect(file.bytes.byteLength, kind).toBeGreaterThan(0);
    }
    expect(lastPayload?.derived.extensions).toHaveProperty('FS_electrical');
  });

  it('a reader that does not implement the extension refuses it, in every kind', async () => {
    const coreOnly = {};
    await expect(exportGltf(requiresElectrical(), { version: VERSION, reader: coreOnly })).rejects.toThrow(InvalidDocumentError);
    await expect(exportUsdz(requiresElectrical(), { version: VERSION, reader: coreOnly })).rejects.toThrow(InvalidDocumentError);
    expect(() => ifcPayload(requiresElectrical(), VERSION, coreOnly)).toThrow(InvalidDocumentError);
    await expect(renderStill(requiresElectrical(), { pixels: { width: 8, height: 8 }, samples: 1, reader: coreOnly })).rejects.toThrow(InvalidDocumentError);
    await expect(render3dPng(requiresElectrical(), { width: 64, reader: coreOnly })).rejects.toThrow(InvalidDocumentError);
  });
});

describe('a model the editor calls invalid is refused in every kind, though a core-only reader takes it', () => {
  it('glTF, USDZ, IFC, a still and a 3D render', async () => {
    await expect(exportGltf(editorInvalid(), { version: VERSION })).rejects.toThrow(InvalidDocumentError);
    await expect(exportUsdz(editorInvalid(), { version: VERSION })).rejects.toThrow(InvalidDocumentError);
    expect(() => ifcPayload(editorInvalid(), VERSION)).toThrow(InvalidDocumentError);
    await expect(exportIfc(editorInvalid(), { version: VERSION, workerUrl: ifcUrl })).rejects.toThrow(InvalidDocumentError);
    expect(lastPayload).toBeNull(); // refused before anything reached the IFC worker
    await expect(renderStill(editorInvalid(), { pixels: { width: 8, height: 8 }, samples: 1 })).rejects.toThrow(InvalidDocumentError);
    await expect(render3dPng(editorInvalid(), { width: 64 })).rejects.toThrow(InvalidDocumentError);
    // The same model, read core-only, still builds: the refusal is the reader's.
    await expect(exportGltf(editorInvalid(), { version: VERSION, reader: {} })).resolves.toMatchObject({ contentType: 'model/gltf-binary' });
  });

  it('through every job handler', async () => {
    const kinds: [string, Record<string, unknown>][] = [
      ['export.gltf', {}],
      ['export.usdz', {}],
      ['export.ifc', {}],
      ['export.still', { size: 'small', quality: 'draft' }],
      ['render.3d', { width: 64 }],
    ];
    for (const [kind, params] of kinds) await expect(handlerFor(kind)(editorInvalid(), job(kind, params)), kind).rejects.toThrow(InvalidDocumentError);
    expect(lastPayload).toBeNull();
  });
});
