import { readFileSync } from 'node:fs';
import { contentHash } from '@floorspec/engine';
import type { Db } from '../../src/db.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { Browser } from './helpers.js';

/** A two-level house (the worker's drawing fixture): two plan sheets and a schedule sheet. */
export const TWO_STOREY = JSON.parse(readFileSync(new URL('../../../worker/test/fixtures/two-storey.json', import.meta.url), 'utf8')) as Prisma.InputJsonObject;

/** A project whose head is `document`, seeded as a version row — as a project stored before an import would be. */
export async function projectWithDocument(db: Db, browser: Browser, document: Prisma.InputJsonObject = TWO_STOREY, name = 'Two-storey ranch'): Promise<{ id: string; hash: string }> {
  const res = await browser.post('/api/projects', { name });
  if (res.status !== 201) throw new Error(`create project failed: ${String(res.status)} ${res.text}`);
  const { id } = res.body as { id: string };
  const hash = contentHash(document);
  await db.version.upsert({ where: { hash }, create: { hash, document }, update: {} });
  await db.head.update({ where: { projectId_name: { projectId: id, name: 'main' } }, data: { versionHash: hash } });
  return { id, hash };
}

/**
 * Core 0.3's kitchen with two option sets, as the example is written: valid to a core-only reader,
 * but its refrigerators are FS_furniture pieces with no model or symbol, which FS_furniture 0.1.0
 * requires (FS-INV-603). The api and the editor read with OFFICIAL_READER, which implements
 * FS_furniture, so they call it invalid and every export refuses it (FLR-T-12.8, FLR-T-12.10).
 */
export const KITCHEN_AS_WRITTEN = JSON.parse(
  readFileSync(new URL('../../../../packages/engine/standard/conformance/core/0.3/examples/002-kitchen-options/input.json', import.meta.url), 'utf8'),
) as Prisma.InputJsonObject;

/**
 * The kitchen as the editor reads it: without its furniture, valid under OFFICIAL_READER, with both
 * option sets — a design to choose (FLR-T-9.2, FLR-T-9.7).
 */
export const KITCHEN_OPTIONS = Object.fromEntries(Object.entries(KITCHEN_AS_WRITTEN).filter(([k]) => k !== 'extensions' && k !== 'extensionsUsed'));

/** The ranch with a smoke alarm it requires FS_electrical to read (Core 1.6.4): valid under OFFICIAL_READER only. */
export const REQUIRES_ELECTRICAL = {
  ...(JSON.parse(readFileSync(new URL('../../../../packages/mcp/test/fixtures/two-bedroom-ranch.json', import.meta.url), 'utf8')) as Prisma.InputJsonObject),
  floorspec: '0.4',
  extensionsUsed: { FS_electrical: '0.1.0' },
  extensionsRequired: ['FS_electrical'],
  extensions: {
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
  },
} as Prisma.InputJsonObject;

/**
 * The ranch with two saved views (FS_views 0.1.0, FLR-T-13.10): "Front", from the south-west across
 * the lawn, and "Living room", a 16:9 view of it from its doorway.
 */
export const WITH_VIEWS = (() => {
  const M = 1_280_000;
  const base = REQUIRES_ELECTRICAL as unknown as { extensionsUsed: Record<string, string>; extensions: Record<string, unknown> };
  return {
    ...base,
    extensionsUsed: { ...base.extensionsUsed, FS_views: '0.1.0' },
    extensions: {
      ...base.extensions,
      FS_views: {
        views: {
          SV1: { name: 'Front', eye: [-10 * M, -10 * M, 1.6 * M], target: [4_681_728, 3_121_152, 1.5 * M], focalLength: 24, twoPoint: true, at: '2026-06-21T17:00' },
          SV2: { name: 'Living room', eye: [8 * M, 6 * M, 1.5 * M], target: [4_681_728, 3_121_152, 1.2 * M], aspect: '16:9', sky: 'overcast' },
        },
      },
    },
  } as unknown as Prisma.InputJsonObject;
})();

/**
 * FLR-T-14.1: the ranch with its views and two films in its extras — a second's walk from "Front" to
 * "Living room", and one naming a view it does not have.
 */
export const WITH_FILM = (() => {
  const base = WITH_VIEWS as unknown as Record<string, unknown>;
  return {
    ...base,
    extras: {
      d3floorspec: {
        films: {
          F1: { name: 'Walk-in', keys: [{ at: 0, view: 'SV1' }, { at: 1000, view: 'SV2' }] },
          F2: { name: 'Lost', keys: [{ at: 0, view: 'SV1' }, { at: 2000, view: 'SV9' }] },
        },
      },
    },
  } as unknown as Prisma.InputJsonObject;
})();
