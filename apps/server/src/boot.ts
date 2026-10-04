import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Config } from './config.js';
import { createDb } from './db.js';
import { logger } from './logger.js';

/**
 * Boot: the api applies its own migrations, after a dump (ported from Foreman, FRM-REQ-007).
 *
 * The moment before a migration is the moment a dump matters most, so when `PREMIGRATION_DUMP` is
 * on (it is in the image, which carries a pg_dump pinned to Postgres 16) the dump path is logged
 * before the migration starts and a dump that fails stops the boot. When nothing is pending there
 * is nothing to protect against, and no dump is taken.
 */

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../prisma/migrations');

/** Migration directory names not yet recorded as applied, oldest first. */
export async function pendingMigrations(databaseUrl: string): Promise<string[]> {
  const onDisk = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const db = createDb(databaseUrl);
  try {
    const applied = await db.$queryRaw<{ migration_name: string }[]>`
      select migration_name from _prisma_migrations where finished_at is not null
    `;
    const done = new Set(applied.map((r) => r.migration_name));
    return onDisk.filter((name) => !done.has(name));
  } catch {
    // No `_prisma_migrations` table yet: an empty database, so everything is pending.
    return onDisk;
  } finally {
    await db.$disconnect();
  }
}

/**
 * The Prisma CLI's own entry script, resolved as a module rather than trusted to be on `PATH`.
 * In the image `node_modules/.bin` is not on the service user's `PATH`, and a boot that cannot find
 * its migration tool must not be a runtime surprise.
 */
function prismaCli(): string {
  const require_ = createRequire(import.meta.url);
  const manifestPath = require_.resolve('prisma/package.json');
  const manifest = require_('prisma/package.json') as { bin: Record<string, string> | string };
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin['prisma'];
  if (entry === undefined) throw new Error('the prisma package declares no CLI entry point');
  return join(dirname(manifestPath), entry);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      logger.debug({ command, out: chunk.toString().trim() });
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${String(code)}: ${stderr.trim()}`));
    });
  });
}

/** Write a pre-migration dump and return its path. */
export async function dumpDatabase(config: Config, reason: string): Promise<string> {
  await mkdir(config.BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(config.BACKUP_DIR, `${stamp}-${reason}.dump`);
  // Custom format, so a restore can be selective. `pg_dump` reads the URL directly.
  await run('pg_dump', ['--format=custom', '--file', path, config.DATABASE_URL], process.env);
  return path;
}

/**
 * Apply pending migrations, dumping first. Returns the names applied, which is what the caller
 * reports as the schema revision.
 */
export async function migrate(config: Config): Promise<string[]> {
  const pending = await pendingMigrations(config.DATABASE_URL);
  if (pending.length === 0) {
    logger.info('schema is current; no migration and no dump');
    return [];
  }

  logger.info({ pending }, 'migrations pending');
  if (config.PREMIGRATION_DUMP) {
    const dumpPath = await dumpDatabase(config, 'pre-migration');
    // Logged before the migration runs, because that order is the whole point.
    logger.info({ dumpPath }, 'pre-migration dump written');
  }

  await run(process.execPath, [prismaCli(), 'migrate', 'deploy'], {
    ...process.env,
    DATABASE_URL: config.DATABASE_URL,
  });
  logger.info({ applied: pending }, 'migrations applied');
  return pending;
}

/** The schema revision this instance is running — the newest applied migration. */
export async function schemaRevision(databaseUrl: string): Promise<string | null> {
  const db = createDb(databaseUrl);
  try {
    const rows = await db.$queryRaw<{ migration_name: string }[]>`
      select migration_name from _prisma_migrations
      where finished_at is not null order by finished_at desc limit 1
    `;
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  } finally {
    await db.$disconnect();
  }
}
