/**
 * FLR-T-12.8: render2d draws with the caller's reader. A document that requires an official
 * extension — valid under OFFICIAL_READER, refused by a core-only reader (FS-DOC-002) — draws, and a
 * caller that has evaluated a document already is not made to validate it a second time.
 */
import { readFileSync } from 'node:fs';
import * as engine from '@floorspec/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildScene, DEFAULT_READER, renderEvaluation, renderPlan, sceneOf } from '../src/index.js';

vi.mock('@floorspec/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@floorspec/engine')>();
  return { ...actual, evaluate: vi.fn(actual.evaluate) };
});

const { evaluate, check, InvalidDocumentError, OFFICIAL_READER } = engine;
const evaluations = vi.mocked(evaluate);

type Doc = Record<string, unknown> & { rooms: Record<string, Record<string, unknown>> };
const load = (name: string): Doc => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Doc;

/** The three-room house with a smoke alarm it requires FS_electrical to read (Core 1.6.4). */
function requiresElectrical(): Doc {
  const d = load('three-room-house');
  d.floorspec = '0.4';
  const anchor = d.rooms['LIV']!.anchor as [number, number];
  d.extensionsUsed = { FS_electrical: '0.1.0' };
  d.extensionsRequired = ['FS_electrical'];
  d.extensions = {
    FS_electrical: {
      collections: {
        alarms: {
          SA1: {
            fallback: { level: 'MAIN', box: { min: [-96000, -96000, -64000], max: [96000, 96000, 0] } },
            host: { mode: 'surface', room: 'LIV', surface: 'ceiling', position: anchor },
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

describe('a document that requires an official extension', () => {
  it('is valid under OFFICIAL_READER and refused by a core-only reader', () => {
    const d = requiresElectrical();
    const official = check(d, OFFICIAL_READER);
    expect(official.valid).toBe(true);
    expect(official.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(check(d).diagnostics.map((x) => x.code)).toEqual(['FS-DOC-002']);
  });

  it('draws by default — render2d reads as the reference implementation does', () => {
    expect(DEFAULT_READER).toBe(OFFICIAL_READER);
    const svg = renderPlan(requiresElectrical());
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('data-id="SA1"');
    expect(svg).toContain('data-kind="FS_electrical:alarms"');
  });

  it('draws with the caller’s reader, and is refused by a reader that does not implement it', () => {
    expect(renderPlan(requiresElectrical(), { reader: { extensions: ['FS_electrical'], knownExtensions: engine.OFFICIAL_EXTENSIONS } })).toBe(renderPlan(requiresElectrical()));
    expect(() => renderPlan(requiresElectrical(), { reader: {} })).toThrow(InvalidDocumentError);
    expect(() => buildScene(requiresElectrical(), undefined, undefined, {})).toThrow(InvalidDocumentError);
    expect(buildScene(requiresElectrical()).fallbacks.has('SA1')).toBe(true);
  });

  it('draws from the caller’s evaluation', () => {
    const ev = evaluate(requiresElectrical(), OFFICIAL_READER);
    expect(renderEvaluation(ev)).toBe(renderPlan(requiresElectrical()));
    expect(sceneOf(ev).fallbacks.has('SA1')).toBe(true);
  });
});

describe('drawing does not validate a second time', () => {
  it('renderEvaluation and sceneOf never call the validator', () => {
    const ev = evaluate(requiresElectrical(), OFFICIAL_READER);
    evaluations.mockClear();
    renderEvaluation(ev, { theme: 'dark', roof: true });
    sceneOf(ev, 'MAIN');
    sceneOf(ev, 'MAIN', engine.deriveFrom(ev.view!, ev.analysis!));
    expect(evaluations).not.toHaveBeenCalled();
  });

  it('renderPlan validates once, with the reader and design together', () => {
    renderPlan(requiresElectrical(), { level: 'MAIN' });
    expect(evaluations).toHaveBeenCalledTimes(1);
    expect(evaluations.mock.calls[0]![1]).toEqual(OFFICIAL_READER);
  });

  it('a ghost given as an evaluation is not validated again; one given as a document is validated once', () => {
    const before = load('three-room-house');
    const after = requiresElectrical();
    const evBefore = evaluate(before, OFFICIAL_READER);
    const evAfter = evaluate(after, OFFICIAL_READER);
    evaluations.mockClear();
    const a = renderEvaluation(evAfter, { ghost: { evaluation: evBefore } });
    expect(evaluations).not.toHaveBeenCalled();
    expect(renderPlan(after, { ghost: { before } })).toBe(a);
    expect(evaluations).toHaveBeenCalledTimes(2);
  });

  it('refuses an evaluation that is not valid, as it refuses the document', () => {
    const ev = evaluate(requiresElectrical());
    expect(ev.valid).toBe(false);
    expect(() => renderEvaluation(ev)).toThrow(InvalidDocumentError);
  });
});
