import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alertBootFailure, createAlerts } from '../../src/alerts/index.js';
import type { Config } from '../../src/config.js';
import { sha256File } from '../../src/maintenance/files.js';
import { appOpener } from '../../src/maintenance/open.js';
import { maintenanceTick, runMaintenance, type MaintenanceDeps } from '../../src/maintenance/runs.js';
import { Browser, createProjectAs, inviteMember, reset, setupOperator, start, testConfig, testDb, TEST_ENV, type Running } from './helpers.js';

/**
 * FLR-T-12.1 and FLR-T-12.2, against a real Postgres 16 and the real pg_dump and pg_restore: the
 * nightly backup writes a dump and a manifest that agree; the drill restores it into a clean
 * database, boots the app on it and opens the project; and each failure — pg_dump failing, a
 * corrupt dump, a boot whose migration fails — sends exactly one email, with the relay mocked and
 * no secret in it. (The watchdog's forced health failures are in apps/worker/test/alerts.test.ts.)
 *
 * Skipped on a host without the PostgreSQL client tools; CI's runner has them.
 */

const hasPgTools = spawnSync('pg_dump', ['--version']).status === 0 && spawnSync('pg_restore', ['--version']).status === 0;
const RELAY_ENV = { MAIL_RELAY_URL: 'https://relay.example.test/send', MAIL_RELAY_TOKEN: 'relay-token-for-tests', ALERT_TO: 'operator@example.test' };
const ROOM = [{ op: 'addElement', collection: 'buildings', element: {} }];

interface Posted {
  readonly subject: string;
  readonly text: string;
  readonly to: string;
}

function fakeRelay() {
  const posted: Posted[] = [];
  const fetchFn = ((_url: string, init: RequestInit) => {
    posted.push(JSON.parse(init.body as string) as Posted);
    return Promise.resolve(new Response('ok', { status: 200 }));
  }) as unknown as typeof fetch;
  return { posted, fetch: fetchFn };
}

async function databases(prefix: string): Promise<string[]> {
  const admin = new Client({ connectionString: TEST_ENV.DATABASE_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string }>('select datname from pg_database where datname like $1', [`${prefix}%`]);
    return rows.map((r) => r.datname);
  } finally {
    await admin.end();
  }
}

/** A stand-in pg_dump: `--version` works, a dump fails with a message that carries a credential. */
async function failingPgDump(dir: string): Promise<string> {
  const path = join(dir, 'pg_dump_failing');
  await writeFile(
    path,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.0"; exit 0; fi\n' +
      'echo "pg_dump: error: connection to postgresql://floorspec:leaked-pw-9876@postgres:5432/floorspec failed: disk full" >&2\nexit 1\n',
  );
  await chmod(path, 0o755);
  return path;
}

/** A stand-in pg_dump that writes ten bytes: a dump too small to be one. */
async function tinyPgDump(dir: string): Promise<string> {
  const path = join(dir, 'pg_dump_tiny');
  await writeFile(
    path,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.0"; exit 0; fi\n' +
      'while [ $# -gt 0 ]; do if [ "$1" = "--file" ]; then shift; printf "0123456789" > "$1"; fi; shift; done\nexit 0\n',
  );
  await chmod(path, 0o755);
  return path;
}

describe.skipIf(!hasPgTools)('backups, the restore drill and their alerts', () => {
  let running: Running;
  let operator: Browser;
  let projectId: string;
  let dir: string;
  let backupDir: string;
  let config: Config;
  let relay: ReturnType<typeof fakeRelay>;
  let deps: MaintenanceDeps;

  beforeAll(async () => {
    // One backups directory for the suite, so the running app's maintenance page reads it too.
    backupDir = await mkdtemp(join(tmpdir(), 'flr-backups-'));
    running = await start({ env: { ...RELAY_ENV, BACKUP_DIR: backupDir } });
  });
  afterAll(async () => {
    await running.close();
    await rm(backupDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await reset(testDb());
    operator = await setupOperator(running);
    projectId = (await createProjectAs(operator, 'Drill house')).id;
    const applied = await operator.post(`/api/projects/${projectId}/ops`, { batch: ROOM });
    expect(applied.status).toBe(201);

    dir = await mkdtemp(join(tmpdir(), 'flr-backup-'));
    await rm(backupDir, { recursive: true, force: true });
    config = testConfig({ ...RELAY_ENV, BACKUP_DIR: backupDir });
    relay = fakeRelay();
    deps = { config, db: testDb(), mailer: createAlerts(config, testDb(), { fetch: relay.fetch }), open: appOpener({ config }) };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('backs up: a dump and a manifest that agree, an asset mirror, and a recorded run', async () => {
    const assets = join(dir, 'assets');
    await mkdir(join(assets, 'ab'), { recursive: true });
    await writeFile(join(assets, 'ab', 'abcdef.png'), 'not really a png');
    await writeFile(join(assets, 'ffee.glb'), 'not really a model');
    const withAssets = { ...deps, config: { ...config, ASSET_DIR: assets } };

    const outcome = await runMaintenance('backup', withAssets, { key: 'backup:test-1', trigger: 'manual' });
    expect(outcome?.status).toBe('succeeded');
    const result = outcome?.result as { dump: string; path: string; manifest: { sha256: string; bytes: number; rowCounts: Record<string, number>; schemaRevision: string; assets: Record<string, unknown> } };

    const files = await readdir(config.BACKUP_DIR);
    expect(files).toContain(result.dump);
    expect(files).toContain(result.dump.replace(/\.dump$/, '.manifest.json'));
    expect(result.dump).toMatch(/^floorspec-\d{4}-\d{2}-\d{2}T.*\.dump$/);
    const manifest = JSON.parse(await readFile(join(config.BACKUP_DIR, result.dump.replace(/\.dump$/, '.manifest.json')), 'utf8')) as typeof result.manifest;
    expect(manifest.sha256).toBe(await sha256File(result.path));
    expect(manifest.bytes).toBeGreaterThan(1024);
    expect(manifest.rowCounts.projects).toBe(1);
    expect(manifest.rowCounts.accounts).toBe(1);
    expect(manifest.rowCounts.op_log).toBeGreaterThanOrEqual(2);
    expect(manifest.schemaRevision).toMatch(/^\d{14}_/);
    expect(manifest.assets).toMatchObject({ status: 'mirrored', files: 2, copied: 2 });
    expect(await readFile(join(config.BACKUP_DIR, 'assets', 'ab', 'abcdef.png'), 'utf8')).toBe('not really a png');

    // Content-addressed: the second night copies nothing that is already there.
    const again = await runMaintenance('backup', withAssets, { key: 'backup:test-2', trigger: 'manual' });
    expect((again?.result as { manifest: { assets: unknown } }).manifest.assets).toMatchObject({ status: 'mirrored', files: 2, copied: 0 });

    // No asset store configured yet: recorded, not failed.
    const none = await runMaintenance('backup', deps, { key: 'backup:test-3', trigger: 'manual' });
    expect((none?.result as { manifest: { assets: unknown } }).manifest.assets).toEqual({ status: 'none', reason: 'no asset store is configured (ASSET_DIR is not set)' });

    // A key runs once.
    expect(await runMaintenance('backup', deps, { key: 'backup:test-3', trigger: 'manual' })).toBeNull();
    expect(await testDb().maintenanceRun.count({ where: { kind: 'backup', status: 'succeeded' } })).toBe(3);
    expect(relay.posted).toHaveLength(0);
  });

  it('a failing pg_dump: the run is recorded failed, one email, no secret, and no repeat within the hour', async () => {
    const failing = { ...deps, tools: { pgDump: await failingPgDump(dir), pgRestore: 'pg_restore' } };
    const outcome = await runMaintenance('backup', failing, { key: 'backup:fail-1', trigger: 'schedule' });
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toMatch(/pg_dump exited 1/);
    expect(outcome?.error).not.toContain('leaked-pw-9876');
    expect(outcome?.alert).toEqual({ sent: true });

    expect(relay.posted).toHaveLength(1);
    const [email] = relay.posted;
    expect(email?.to).toBe('operator@example.test');
    expect(email?.subject).toBe('[Floorspec] The nightly backup failed');
    expect(email?.text).toContain('backup:fail-1');
    expect(email?.text).toContain('disk full');
    for (const secret of ['leaked-pw-9876', RELAY_ENV.MAIL_RELAY_TOKEN, TEST_ENV.KEK, TEST_ENV.PEPPER]) expect(JSON.stringify(email)).not.toContain(secret);
    expect(await readdir(config.BACKUP_DIR)).toEqual([]);

    const run = await testDb().maintenanceRun.findUniqueOrThrow({ where: { key: 'backup:fail-1' } });
    expect(run.status).toBe('failed');

    // The next failure within the hour is recorded but not mailed: the ledger is the database.
    const second = await runMaintenance('backup', { ...failing, mailer: createAlerts(config, testDb(), { fetch: relay.fetch }) }, { key: 'backup:fail-2', trigger: 'schedule' });
    expect(second?.alert).toEqual({ sent: false, reason: 'already alerted about this within the hour' });
    expect(relay.posted).toHaveLength(1);
    expect(await testDb().alertLog.count({ where: { kind: 'backup-failed' } })).toBe(2);
  });

  it('a database pg_dump cannot reach fails the backup the same way', async () => {
    const wrong = new URL(TEST_ENV.DATABASE_URL);
    wrong.password = 'wrong-password-5555';
    const outcome = await runMaintenance('backup', { ...deps, config: { ...config, DATABASE_URL: wrong.toString() } }, { key: 'backup:unreachable', trigger: 'schedule' });
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toMatch(/could not connect to the database/);
    expect(relay.posted).toHaveLength(1);
    expect(JSON.stringify(relay.posted)).not.toContain('wrong-password-5555');
  });

  it('refuses a dump under 1 KiB', async () => {
    const outcome = await runMaintenance('backup', { ...deps, tools: { pgDump: await tinyPgDump(dir), pgRestore: 'pg_restore' } }, { key: 'backup:tiny', trigger: 'manual' });
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toMatch(/only 10 bytes/);
    expect(await readdir(config.BACKUP_DIR)).toEqual([]);
  });

  it('drills: restores into a clean database, boots the app on it, opens the project, and records it', async () => {
    const backup = await runMaintenance('backup', deps, { key: 'backup:for-drill', trigger: 'manual' });
    expect(backup?.status).toBe('succeeded');
    const head = ((await operator.get(`/api/projects/${projectId}`)).body as { head: { version: string } }).head.version;

    const drill = await runMaintenance('restore-drill', deps, { key: 'restore-drill:test', trigger: 'manual' });
    expect(drill?.error).toBeNull();
    expect(drill?.status).toBe('succeeded');
    const result = drill?.result as {
      dump: string;
      manifest: string;
      scratchDatabase: string;
      restoredRows: Record<string, number>;
      app: { health: { status: number; schemaRevision: string }; projects: number; opened: { id: string; name: string; head: string; modelHash: string; valid: boolean } };
    };
    expect(result.dump).toBe((backup?.result as { dump: string }).dump);
    expect(result.manifest).toBe('verified');
    expect(result.restoredRows.projects).toBe(1);
    expect(result.app.health.status).toBe(200);
    expect(result.app.projects).toBe(1);
    expect(result.app.opened).toMatchObject({ id: projectId, name: 'Drill house', head, modelHash: head });
    // Dropped in the finally.
    expect(await databases(result.scratchDatabase)).toEqual([]);

    const recorded = await testDb().maintenanceRun.findUniqueOrThrow({ where: { key: 'restore-drill:test' } });
    expect(recorded.status).toBe('succeeded');
    expect(recorded.finishedAt).not.toBeNull();
    expect(relay.posted).toHaveLength(0);

    // The operator sees it; /health carries when and whether.
    const health = (await new Browser(running.url).get('/health')).body as { backup: { ok: boolean }; drill: { ok: boolean; at: string } };
    expect(health.backup.ok).toBe(true);
    expect(health.drill.ok).toBe(true);
    const page = await operator.get('/api/maintenance');
    expect(page.status).toBe(200);
    const body = page.body as { runs: Record<string, { key: string; status: string }[]>; dumps: { name: string }[]; alerts: { email: string } };
    expect(body.runs['restore-drill']?.[0]).toMatchObject({ key: 'restore-drill:test', status: 'succeeded' });
    expect(body.dumps[0]?.name).toBe(result.dump);
    expect(body.alerts.email).toBe('configured');
  });

  it('a corrupt dump fails the drill: one email, the scratch database dropped', async () => {
    await runMaintenance('backup', deps, { key: 'backup:before-corrupt', trigger: 'manual' });
    // A newer "dump" of random bytes, with a manifest that matches it: only a restore can tell.
    const name = 'floorspec-2999-01-01T00-00-00-000Z.dump';
    await writeFile(join(config.BACKUP_DIR, name), Buffer.alloc(8192, 0x5a));
    const sha256 = await sha256File(join(config.BACKUP_DIR, name));
    await writeFile(
      join(config.BACKUP_DIR, 'floorspec-2999-01-01T00-00-00-000Z.manifest.json'),
      JSON.stringify({ format: 'floorspec-backup/1', file: name, bytes: 8192, sha256, createdAt: '2999-01-01T00:00:00.000Z', schemaRevision: null, rowCounts: {}, assets: { status: 'none', reason: 'x' }, pgDump: 'x' }),
    );
    const before = await databases('floorspec_drill_');

    const drill = await runMaintenance('restore-drill', deps, { key: 'restore-drill:corrupt', trigger: 'schedule' });
    expect(drill?.status).toBe('failed');
    expect(drill?.error).toMatch(/pg_restore could not restore floorspec-2999/);
    expect(relay.posted).toHaveLength(1);
    expect(relay.posted[0]?.subject).toBe('[Floorspec] The restore drill failed');
    expect(relay.posted[0]?.text).toContain('pg_restore could not restore');
    expect(await databases('floorspec_drill_')).toEqual(before);
  });

  it('a dump changed since it was written fails the drill before restoring anything', async () => {
    const backup = await runMaintenance('backup', deps, { key: 'backup:before-tamper', trigger: 'manual' });
    const path = (backup?.result as { path: string }).path;
    const bytes = await readFile(path);
    bytes[bytes.length - 10] = (bytes[bytes.length - 10] ?? 0) ^ 0xff;
    await writeFile(path, bytes);
    const drill = await runMaintenance('restore-drill', deps, { key: 'restore-drill:tampered', trigger: 'schedule' });
    expect(drill?.status).toBe('failed');
    expect(drill?.error).toMatch(/does not match its manifest/);
    expect(relay.posted).toHaveLength(1);
  });

  it('schedules one backup a day after the hour, then the week\'s drill, and nothing twice', async () => {
    const at = (iso: string) => ({ ...deps, now: () => new Date(iso) });
    expect(await maintenanceTick(at('2026-10-05T03:00:00Z'))).toEqual([]);
    const first = await maintenanceTick(at('2026-10-05T07:05:00Z'));
    expect(first.map((r) => [r.kind, r.key, r.status])).toEqual([
      ['backup', 'backup:2026-10-05', 'succeeded'],
      ['restore-drill', 'restore-drill:2026-W41', 'succeeded'],
    ]);
    expect(await maintenanceTick(at('2026-10-05T07:10:00Z'))).toEqual([]);
    const nextDay = await maintenanceTick(at('2026-10-06T08:00:00Z'));
    expect(nextDay.map((r) => r.key)).toEqual(['backup:2026-10-06']);
  });

  it('the maintenance page is the operator\'s alone', async () => {
    expect((await new Browser(running.url).get('/api/maintenance')).status).toBe(401);
    const member = await inviteMember(running, operator, 'member@example.test');
    expect((await member.get('/api/maintenance')).status).toBe(403);
  });
});

describe('alerting a boot that fails (a failed deploy)', () => {
  let server: Server;
  let posted: Posted[];
  let relayUrl: string;
  const bootDb = 'floorspec_bootfail_test';
  const bootUrl = (() => {
    const u = new URL(TEST_ENV.DATABASE_URL || 'postgresql://localhost/x');
    u.pathname = `/${bootDb}`;
    return u.toString();
  })();

  beforeAll(async () => {
    posted = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        posted.push(JSON.parse(body) as Posted);
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    relayUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/send`;

    // A database whose migration will fail: a table the first migration creates is already there.
    // The alerts table is there too, as it is on any instance past this migration.
    const admin = new Client({ connectionString: TEST_ENV.DATABASE_URL });
    await admin.connect();
    await admin.query(`drop database if exists "${bootDb}" with (force)`);
    await admin.query(`create database "${bootDb}"`);
    await admin.end();
    const target = new Client({ connectionString: bootUrl });
    await target.connect();
    await target.query('create table accounts (id int)');
    await target.query(
      'create table alerts (id bigserial primary key, kind text not null, subject text not null, sent boolean not null, reason text, created_at timestamptz(6) not null default current_timestamp)',
    );
    await target.end();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    const admin = new Client({ connectionString: TEST_ENV.DATABASE_URL });
    await admin.connect();
    await admin.query(`drop database if exists "${bootDb}" with (force)`);
    await admin.end();
  });

  function boot(): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: join(import.meta.dirname, '../..'),
        env: {
          ...process.env,
          ...TEST_ENV,
          DATABASE_URL: bootUrl,
          PORT: '3999',
          PREMIGRATION_DUMP: 'false',
          BACKUP_SCHEDULE: 'off',
          MAIL_RELAY_URL: relayUrl,
          MAIL_RELAY_TOKEN: 'boot-relay-token',
          ALERT_TO: 'operator@example.test',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('close', (code) => { resolve({ code, stderr }); });
    });
  }

  it('emails once when the migration fails, and not again when the container restarts', async () => {
    const first = await boot();
    expect(first.code).toBe(1);
    expect(first.stderr).toMatch(/refused to start \(the migration\)/);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.subject).toBe('[Floorspec] The api failed to start (the migration)');
    expect(posted[0]?.text).toMatch(/prisma|migrat/i);
    for (const secret of ['boot-relay-token', TEST_ENV.KEK, TEST_ENV.PEPPER]) expect(JSON.stringify(posted)).not.toContain(secret);

    // Restart policy brings it straight back, and it fails again: no second email this hour.
    const second = await boot();
    expect(second.code).toBe(1);
    expect(posted).toHaveLength(1);
  }, 60_000);

  it('does not email when the alert ledger is unreachable (the watchdog reports a database that is down)', async () => {
    const relay = fakeRelay();
    const wrong = new URL(bootUrl);
    wrong.port = '1';
    const mailer = createAlerts({ ...testConfig(RELAY_ENV), DATABASE_URL: wrong.toString() }, (await import('../../src/db.js')).createDb(wrong.toString()), { fetch: relay.fetch });
    await alertBootFailure(mailer, 'the migration', new Error('connect ECONNREFUSED'));
    expect(relay.posted).toHaveLength(0);
  });
});
