import { readFileSync } from 'node:fs';
import { createDrain, type Drain } from '@d3-floorspec/worker/queue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { reset, setupOperator, start, testDb, TEST_ENV, type Running } from './helpers.js';
import { projectWithDocument } from './drawings-support.js';

/**
 * FLR-T-14.7 end to end: `GET /daylight?at=` queues an `analysis.daylight` job, the worker's drain
 * path-traces the study, and the request answers with it — the same question again answered from
 * the study already made — or says plainly why it could not.
 */

const COURTYARD = JSON.parse(readFileSync(new URL('../../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Prisma.InputJsonObject;

interface Study {
  head: string;
  hash: string;
  at: string;
  sky: string;
  advisory: string;
  levels: { level: string; lux: number[] }[];
  rooms: { id: string; median: number; shares: Record<string, number> }[];
  glare: { id: string; hours: { from: number; to: number }[] }[];
}

describe('daylight studies', () => {
  const db = testDb();
  let running: Running;
  let drain: Drain;

  beforeAll(async () => {
    running = await start({ with: { render3d: { timeoutMs: 60_000, pollMs: 50 } } });
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

  it('studies a June afternoon in the worker, and answers the same question again from the study made', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator, COURTYARD, 'Courtyard House');
    const res = await operator.get(`/api/projects/${id}/daylight?at=2026-06-21T15:00-04:00`);
    expect(res.status, res.text).toBe(200);
    const study = res.body as Study;
    expect(study).toMatchObject({ head: 'main', hash, at: '2026-06-21T15:00', sky: 'clear', advisory: 'Advisory, not a compliance check.' });
    expect(study.levels.map((l) => l.level)).toEqual(['L1', 'L2']);
    expect(study.rooms.find((r) => r.id === 'R6')?.median).toBeGreaterThan(100);
    expect(study.glare.map((g) => g.id)).toEqual(expect.arrayContaining(['DEN-DESK', 'PB-BED']));
    expect(res.text).not.toMatch(/\bcompliant\b/i);
    const again = await operator.get(`/api/projects/${id}/daylight?at=2026-06-21T15:00-04:00`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(study);
    // One job: the second answer was the first study.
    const jobs = await db.job.findMany({ where: { projectId: id } });
    expect(jobs.map((j) => [j.kind, j.status, j.versionHash])).toEqual([['analysis.daylight', 'done', hash]]);
    expect((await operator.get(`/api/projects/${id}/exports`)).body).toEqual({ exports: [] });
    // An overcast sky is another study.
    const grey = await operator.get(`/api/projects/${id}/daylight?at=2026-06-21T15:00-04:00&sky=overcast`);
    expect(grey.status).toBe(200);
    expect((grey.body as Study).sky).toBe('overcast');
    expect((grey.body as Study).glare).toEqual([]);
    expect(await db.job.count({ where: { projectId: id } })).toBe(2);
  }, 240_000);

  it('needs a date and time it can read, and a sky it studies', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator, COURTYARD, 'Courtyard House');
    for (const q of ['', '?at=June', '?at=2026-06-21T15:00&sky=night', '?at=2026-02-30T15:00']) {
      const res = await operator.get(`/api/projects/${id}/daylight${q}`);
      expect([400, 422], `${q}: ${res.text}`).toContain(res.status);
    }
    expect(await db.job.count({ where: { projectId: id, status: 'done' } })).toBe(0);
  }, 120_000);
});
