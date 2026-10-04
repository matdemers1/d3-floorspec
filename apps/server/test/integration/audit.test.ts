import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/http/routes.js';
import { reset, start, testDb, type Reply, type Running } from './helpers.js';

/**
 * The audit walk (FLR-T-0.4): every mutating route, called successfully, writes an audit row with
 * an actor, a time and the operation.
 *
 * The routes come from the app's own registry, not from this file. A mutating route this table
 * does not know how to call fails the first test — so a new route is covered the day it lands, or
 * the suite says it is not.
 */

interface Ctx {
  readonly running: Running;
}

interface Exercised {
  readonly reply: Reply;
  /** The audit action the call must have written. */
  readonly action: string;
}

type Exercise = (ctx: Ctx) => Promise<Exercised>;

const EXERCISES: Record<string, Exercise> = {};

describe('the audit walk', () => {
  const db = testDb();
  let running: Running;

  beforeAll(async () => {
    running = await start();
  });
  afterAll(async () => {
    await running.close();
  });

  it('knows how to call every mutating route the app declares, and no others', () => {
    const declared = registry(running.app)
      .filter((route) => route.mutating)
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(Object.keys(EXERCISES).sort()).toEqual(declared);
  });

  for (const [route, exercise] of Object.entries(EXERCISES)) {
    it(`${route} writes an audit row with actor, time and operation`, async () => {
      await reset(db);
      const startedAt = new Date(Date.now() - 1000);
      const { reply, action } = await exercise({ running });
      expect(reply.status, reply.text).toBeLessThan(400);

      const rows = await db.auditLog.findMany({ where: { action } });
      expect(rows.length, `no "${action}" row for ${route}`).toBeGreaterThan(0);
      const row = rows.at(-1);
      expect(row?.actor).toMatch(/^(account:[0-9a-f-]{36}|anonymous)$/);
      expect(row?.at.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
      expect((row?.detail as { route?: string } | null)?.route).toBe(route);
    });
  }
});
