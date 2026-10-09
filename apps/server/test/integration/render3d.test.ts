import { readFileSync } from 'node:fs';
import { createDrain, type Drain } from '@d3-floorspec/worker/queue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { MAX_PENDING_RENDERS } from '../../src/routes/checks.js';
import { reset, setupOperator, start, testDb, TEST_ENV, type Browser, type Running } from './helpers.js';

const cookieOf = (b: Browser): string => [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
import { KITCHEN_AS_WRITTEN, projectWithDocument, REQUIRES_ELECTRICAL } from './drawings-support.js';

/**
 * FLR-T-8.5 end to end: `GET /render?view=3d` queues a `render.3d` job on the Postgres job queue,
 * the worker's drain (the code the worker container runs) draws it, and the request answers with
 * the PNG — from a named camera, or standing in a room — or says plainly why it could not.
 */

const L_STAIR = JSON.parse(readFileSync(new URL('../../../web/e2e/fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8')) as Prisma.InputJsonObject;

function pngSize(png: Uint8Array): { width: number; height: number } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(v.getUint32(0)).toBe(0x89504e47);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

describe('3D render-back', () => {
  const db = testDb();
  let running: Running;
  let drain: Drain;

  beforeAll(async () => {
    running = await start({ with: { render3d: { timeoutMs: 20_000, pollMs: 50 } } });
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
    drain = createDrain({ databaseUrl: TEST_ENV.DATABASE_URL, pollMs: 200, log: () => undefined });
    await drain.start();
  });
  afterEach(async () => {
    await drain.stop();
  });

  it('draws a named camera, and a room, in the worker', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator, L_STAIR, 'Stair house');
    const ne = await fetch(`${running.url}/api/projects/${id}/render?view=3d&camera=ne&width=512`, { headers: { cookie: cookieOf(operator) } });
    expect(ne.status, await ne.clone().text()).toBe(200);
    expect(ne.headers.get('content-type')).toBe('image/png');
    expect(pngSize(new Uint8Array(await ne.arrayBuffer()))).toEqual({ width: 512, height: 384 });
    const room = await fetch(`${running.url}/api/projects/${id}/render?view=3d&room=Kitchen`, { headers: { cookie: cookieOf(operator) } });
    expect(room.status).toBe(200);
    expect(pngSize(new Uint8Array(await room.arrayBuffer()))).toEqual({ width: 1024, height: 768 });
    // Each was a job on the queue, drawn and recorded; neither is an export.
    const jobs = await db.job.findMany({ where: { projectId: id }, orderBy: { createdAt: 'asc' } });
    expect(jobs.map((j) => [j.kind, j.status, j.versionHash])).toEqual([
      ['render.3d', 'done', hash],
      ['render.3d', 'done', hash],
    ]);
    expect(jobs[1]?.result).toMatchObject({ camera: expect.stringMatching(/^Kitchen \(KIT\) from its doorway/) as string, width: 1024, height: 768 });
    expect((await operator.get(`/api/projects/${id}/exports`)).body).toEqual({ exports: [] });
  });

  it('reads the model as the editor does: draws one that requires an official extension, refuses one the editor calls invalid (FLR-T-12.10)', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator, REQUIRES_ELECTRICAL, 'Wired ranch');
    const wired = await fetch(`${running.url}/api/projects/${id}/render?view=3d&camera=sw&width=256`, { headers: { cookie: cookieOf(operator) } });
    expect(wired.status, await wired.clone().text()).toBe(200);
    expect(pngSize(new Uint8Array(await wired.arrayBuffer()))).toEqual({ width: 256, height: 192 });
    expect((await db.job.findMany({ where: { projectId: id } })).map((j) => [j.kind, j.status, j.versionHash])).toEqual([['render.3d', 'done', hash]]);
    const { id: kitchen } = await projectWithDocument(db, operator, KITCHEN_AS_WRITTEN, 'Kitchen as written');
    const refused = await operator.get(`/api/projects/${kitchen}/render?view=3d`);
    expect(refused.status).toBe(422);
    expect(refused.text).toContain('not-renderable');
    expect(await db.job.count({ where: { projectId: kitchen } })).toBe(0);
  });

  it('draws the light fixtures on and off, path-traced at night (FLR-T-12.22)', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator, REQUIRES_ELECTRICAL, 'Wired ranch');
    for (const lights of ['on', 'off'] as const) {
      const lit = await fetch(`${running.url}/api/projects/${id}/render?view=3d&camera=sw&width=96&lights=${lights}`, { headers: { cookie: cookieOf(operator) } });
      expect(lit.status, await lit.clone().text()).toBe(200);
      expect(pngSize(new Uint8Array(await lit.arrayBuffer()))).toEqual({ width: 96, height: 72 });
    }
    const jobs = await db.job.findMany({ where: { projectId: id }, orderBy: { createdAt: 'asc' } });
    expect(jobs.map((j) => (j.params as { lights?: string }).lights)).toEqual(['on', 'off']);
    expect(jobs[0]?.result).toMatchObject({ lit: { lights: 'on', time: 'night' } });
    expect(jobs[1]?.result).toMatchObject({ lit: { lights: 'off', time: 'night', lamps: 0 } });
    // Too wide for a path-traced render, a time without lights, and lights that are neither.
    expect((await operator.get(`/api/projects/${id}/render?view=3d&lights=on&width=1600`)).status).toBe(400);
    expect((await operator.get(`/api/projects/${id}/render?view=3d&time=dusk`)).status).toBe(400);
    expect((await operator.get(`/api/projects/${id}/render?view=3d&lights=dim`)).status).toBe(400);
  });

  it('says why it could not draw: no such room, both a camera and a room, too wide', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator, L_STAIR, 'Stair house');
    const attic = await operator.get(`/api/projects/${id}/render?view=3d&room=Attic`);
    expect(attic.status).toBe(422);
    expect(attic.text).toContain('no room Attic; its rooms are');
    expect((await operator.get(`/api/projects/${id}/render?view=3d&room=KIT&camera=sw`)).status).toBe(400);
    expect((await operator.get(`/api/projects/${id}/render?view=3d&width=3000`)).status).toBe(400);
    expect((await operator.get(`/api/projects/${id}/render?view=3d&camera=up`)).status).toBe(400);
  });

  it('answers in time when no worker is drawing, and holds a project to a few renders waiting', async () => {
    await drain.stop();
    const quick = await start({ with: { render3d: { timeoutMs: 300, pollMs: 50 } } });
    try {
      const operator = await setupOperator(quick);
      const { id } = await projectWithDocument(db, operator, L_STAIR, 'Stair house');
      const waited = await operator.get(`/api/projects/${id}/render?view=3d`);
      expect(waited.status).toBe(503);
      expect(waited.text).toContain('the 3D render did not finish in time');
      for (let i = 1; i < MAX_PENDING_RENDERS; i++) expect((await operator.get(`/api/projects/${id}/render?view=3d`)).status).toBe(503);
      expect((await operator.get(`/api/projects/${id}/render?view=3d`)).status).toBe(429);
    } finally {
      await quick.close();
      drain = createDrain({ databaseUrl: TEST_ENV.DATABASE_URL, log: () => undefined });
    }
  });
});
