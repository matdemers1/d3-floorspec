import { readFileSync } from 'node:fs';
import { createDrain, type Drain } from '@d3-floorspec/worker/queue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { reset, setupOperator, start, testDb, TEST_ENV, type Browser, type Running } from './helpers.js';
import { projectWithDocument } from './drawings-support.js';

/**
 * FLR-T-14.12: the inline drain — the api's own, in development and the end-to-end tests, which
 * these tests stand in for by draining in the api's process — runs a heavy job on a thread of its
 * own. While the Courtyard House is meshed and path-traced for a tour, or for a still, the api
 * answers at once: a share link made right after the export was asked for, and its health, in
 * well under a second. Before, the tour meshed the house on the api's event loop and the next
 * request waited for it (PR #91's CI: POST /shares took 9.9 s).
 */

const COURTYARD = JSON.parse(readFileSync(new URL('../../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Prisma.InputJsonObject & { rooms: Record<string, unknown> };
const db = testDb();
/** What a request may take while a job runs. */
const ANSWERS_WITHIN_MS = 1000;

interface Job {
  id: string;
  status: string;
  progress: Record<string, unknown> | null;
}
const exportOf = (body: unknown): Job => (body as { export: Job }).export;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
}

describe('the inline drain runs heavy jobs off the api thread (FLR-T-14.12)', () => {
  let running: Running;
  let drain: Drain;
  let operator: Browser;
  /** What the drain said, and when. */
  let said: { at: number; m: string }[];

  beforeAll(async () => {
    running = await start();
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
    said = [];
    // Listening and polling, as the api's drain does.
    drain = createDrain({ databaseUrl: TEST_ENV.DATABASE_URL, pollMs: 200, log: (m) => { said.push({ at: performance.now(), m }); } });
    await drain.start();
    operator = await setupOperator(running);
  });
  afterEach(async () => {
    await drain.stop();
  });

  /**
   * Ask the api for its health every 50 ms until `until` says stop, and say the longest a request
   * waited: the slowest answer, or the most a 50 ms pause between them overran — a request arriving
   * then would have waited as long.
   */
  async function slowestHealth(until: () => Promise<boolean>, forMs: number): Promise<{ slowest: number; asked: number }> {
    let slowest = 0;
    let asked = 0;
    const deadline = Date.now() + forMs;
    while (Date.now() < deadline && !(await until())) {
      const { ms, value } = await timed(() => fetch(`${running.url}/health`));
      expect(value.status).toBe(200);
      slowest = Math.max(slowest, ms);
      asked++;
      const paused = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 50));
      slowest = Math.max(slowest, performance.now() - paused - 50);
    }
    return { slowest, asked };
  }

  it('answers a share link and its health at once while a tour of the Courtyard House is meshed and traced, and stops the tour at once when it is cancelled', async () => {
    const { id } = await projectWithDocument(db, operator, COURTYARD, 'Courtyard House');
    const rooms = Object.keys(COURTYARD.rooms).slice(0, 3).map((room) => ({ room }));
    const asked = await operator.post(`/api/projects/${id}/exports`, { kind: 'tour', tour: { rooms, size: 'small', quality: 'draft' } });
    expect(asked.status, asked.text).toBe(202);
    const tour = exportOf(asked.body);

    // The drain takes the tour at once, on its NOTIFY; the link is made while it does.
    const shared = await timed(() => operator.post(`/api/projects/${id}/shares`, { tour: tour.id, expiresInDays: 30 }));
    expect(shared.value.status, shared.value.text).toBe(201);
    expect(shared.ms).toBeLessThan(ANSWERS_WITHIN_MS);

    // Through the meshing and into the tracing of the first panorama.
    const tracing = async () => {
      const job = exportOf((await operator.get(`/api/projects/${id}/exports/${tour.id}`)).body);
      return job.status !== 'queued' && job.status !== 'running' ? true : typeof job.progress?.['pass'] === 'number' && job.progress['pass'] >= 1;
    };
    const health = await slowestHealth(tracing, 60_000);
    expect(health.asked).toBeGreaterThan(3);
    expect(health.slowest).toBeLessThan(ANSWERS_WITHIN_MS);
    expect(exportOf((await operator.get(`/api/projects/${id}/exports/${tour.id}`)).body).status).toBe('running');

    // Cancelled mid-pass: the thread is ended at once, not at its next report.
    const cancelled = performance.now();
    expect((await operator.post(`/api/projects/${id}/exports/${tour.id}/cancel`, {})).status).toBe(200);
    const stopped = await new Promise<number>((resolve, reject) => {
      const look = setInterval(() => {
        const line = said.find((s) => s.m.includes(tour.id));
        if (line !== undefined) {
          clearInterval(look);
          resolve(line.at - cancelled);
        } else if (performance.now() - cancelled > 30_000) {
          clearInterval(look);
          reject(new Error('the tour did not stop'));
        }
      }, 20);
    });
    expect(said.find((s) => s.m.includes(tour.id))?.m).toMatch(/stopped: it was cancelled/);
    // Seen within the drain's second, and the thread ended there and then.
    expect(stopped).toBeLessThan(2500);
    expect(await db.jobOutput.count({ where: { jobId: tour.id } })).toBe(0);
  }, 120_000);

  it('answers its health at once while a still of the Courtyard House is path-traced, and stores the still the thread made', async () => {
    const { id } = await projectWithDocument(db, operator, COURTYARD, 'Courtyard House');
    const asked = await operator.post(`/api/projects/${id}/exports`, { kind: 'still', still: { size: 'small', quality: 'draft' } });
    expect(asked.status, asked.text).toBe(202);
    const still = exportOf(asked.body);
    const finished = () => Promise.resolve(said.some((s) => s.m.includes(still.id)));
    const health = await slowestHealth(finished, 60_000);
    expect(said.find((s) => s.m.includes(still.id))?.m).toMatch(/done/);
    expect(health.asked).toBeGreaterThan(3);
    expect(health.slowest).toBeLessThan(ANSWERS_WITHIN_MS);
    const done = exportOf((await operator.get(`/api/projects/${id}/exports/${still.id}`)).body) as Job & { result: { contentType: string; size: number } | null };
    expect(done.status).toBe('done');
    expect(done.result?.contentType).toBe('image/png');
    const output = await db.jobOutput.findUnique({ where: { jobId: still.id } });
    expect([...(output?.bytes ?? new Uint8Array()).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 120_000);
});
