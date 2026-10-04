import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Browser, reset, start, testDb, type Running } from './helpers.js';

const HASH = 'a'.repeat(64);

describe('the schema', () => {
  const db = testDb();
  let running: Running;

  beforeAll(async () => {
    running = await start();
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
  });

  it('keys a version by a lowercase hex SHA-256 and nothing else', async () => {
    await expect(
      db.version.create({ data: { hash: 'NOT-A-HASH', document: {} } }),
    ).rejects.toThrow();
    await expect(db.version.create({ data: { hash: HASH, document: { floorspec: '0.1' } } })).resolves.toBeDefined();
  });

  it('refuses to change or delete a version', async () => {
    await db.version.create({ data: { hash: HASH, document: { floorspec: '0.1' } } });
    await expect(db.$executeRaw`update versions set document = '{}' where hash = ${HASH}`).rejects.toThrow(/append-only/);
    await expect(db.$executeRaw`delete from versions where hash = ${HASH}`).rejects.toThrow(/append-only/);
  });

  it('keeps op_log and audit_log append-only', async () => {
    const account = await db.account.create({ data: { email: 'a@example.test', displayName: 'A' } });
    const project = await db.project.create({ data: { ownerAccountId: account.id, name: 'P' } });
    await db.version.create({ data: { hash: HASH, document: {} } });
    const op = await db.opLog.create({
      data: { projectId: project.id, seq: 1, authorKind: 'account', authorAccountId: account.id, ops: [], afterHash: HASH },
    });
    await expect(db.$executeRaw`update op_log set seq = 2 where id = ${op.id}::uuid`).rejects.toThrow(/append-only/);
    await expect(db.$executeRaw`delete from op_log where id = ${op.id}::uuid`).rejects.toThrow(/append-only/);

    const row = await db.auditLog.create({ data: { actor: 'anonymous', action: 'x', targetType: 'y' } });
    await expect(db.$executeRaw`update audit_log set action = 'z' where id = ${row.id}::uuid`).rejects.toThrow(/append-only/);
    await expect(db.$executeRaw`delete from audit_log where id = ${row.id}::uuid`).rejects.toThrow(/append-only/);
  });

  it('numbers a project\'s ops uniquely, from 1', async () => {
    const account = await db.account.create({ data: { email: 'b@example.test', displayName: 'B' } });
    const project = await db.project.create({ data: { ownerAccountId: account.id, name: 'P' } });
    await db.version.create({ data: { hash: HASH, document: {} } });
    const base = { projectId: project.id, authorKind: 'account' as const, authorAccountId: account.id, ops: [], afterHash: HASH };
    await db.opLog.create({ data: { ...base, seq: 1 } });
    await expect(db.opLog.create({ data: { ...base, seq: 1 } })).rejects.toThrow();
    await expect(db.opLog.create({ data: { ...base, seq: 0 } })).rejects.toThrow();
    // An agent-authored op names the agent; an account-authored one names the account.
    await expect(db.opLog.create({ data: { ...base, seq: 2, authorAccountId: null } })).rejects.toThrow();
  });

  it('reports the newest migration as the schema revision on /health', async () => {
    const newest = readdirSync(join(import.meta.dirname, '../../prisma/migrations'))
      .filter((name) => /^\d{14}_/.test(name))
      .sort()
      .at(-1);
    const res = await new Browser(running.url).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', schemaRevision: newest });
  });
});
