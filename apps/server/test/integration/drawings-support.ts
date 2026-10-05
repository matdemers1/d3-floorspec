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
