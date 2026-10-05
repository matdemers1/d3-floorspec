import { cp, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import {
  COUNTED_TABLES,
  DUMP_PREFIX,
  DUMP_SUFFIX,
  listDumps,
  MANIFEST_FORMAT,
  manifestName,
  PG_TOOLS,
  run,
  sha256File,
  stamp,
  type AssetSummary,
  type Manifest,
  type PgTools,
  type RowCounts,
} from './files.js';

/**
 * The nightly backup (FLR-T-12.1, FLR-REQ-147): a pg_dump of the whole database and a mirror of
 * the asset volume, into `BACKUP_DIR`, with a manifest beside each dump, then old dumps pruned.
 *
 * - **One snapshot.** The row counts and schema revision in the manifest are read inside a
 *   repeatable-read transaction whose snapshot pg_dump is handed (`--snapshot`), so they describe
 *   exactly the dump — which is what lets the drill compare a restore against them.
 * - **Custom format**, compressed, restorable selectively with pg_restore; ownership and grants
 *   are dropped at restore (`--no-owner --no-privileges`), so a dump restores on a fresh host
 *   under whatever role is there.
 * - **Written aside, then renamed.** A drill or a person never sees a half-written dump.
 * - **Under 1 KiB is a failure.** A dump that small restored nothing; better found here, where the
 *   fix is cheap, than during a restore.
 */

export interface BackupOptions {
  readonly databaseUrl: string;
  readonly backupDir: string;
  readonly retentionDays: number;
  /** The asset volume. Unset: there is no asset store yet (FLR-T-8.2), and the manifest says so. */
  readonly assetDir?: string | undefined;
  readonly tools?: PgTools;
  readonly now?: () => Date;
}

export interface BackupResult {
  readonly dump: string;
  readonly path: string;
  readonly manifest: Manifest;
  readonly pruned: readonly string[];
}

export const MIN_DUMP_BYTES = 1024;

/** Mirror the content-addressed asset store: files are immutable, so only new ones are copied. */
async function backupAssets(assetDir: string | undefined, backupDir: string): Promise<AssetSummary> {
  if (assetDir === undefined || assetDir === '') return { status: 'none', reason: 'no asset store is configured (ASSET_DIR is not set)' };
  let info;
  try {
    info = await stat(assetDir);
  } catch {
    // Configured but absent is not "no assets": it is a volume that did not mount.
    throw new Error(`ASSET_DIR ${assetDir} does not exist; is the asset volume mounted?`);
  }
  if (!info.isDirectory()) throw new Error(`ASSET_DIR ${assetDir} is not a directory`);

  const entries = await readdir(assetDir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile());
  if (files.length === 0) return { status: 'none', reason: `the asset directory ${assetDir} is empty` };

  const target = join(backupDir, 'assets');
  const before = await countFiles(target);
  // force: false — a file already mirrored is the same bytes under the same name; it is not copied.
  await cp(assetDir, target, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
  const after = await countFiles(target);
  let bytes = 0;
  for (const file of files) bytes += (await stat(join(file.parentPath, file.name))).size;
  return { status: 'mirrored', dir: target, files: files.length, bytes, copied: after - before };
}

async function countFiles(dir: string): Promise<number> {
  try {
    return (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

/** Remove nightly dumps (and their manifests) older than the retention; never the newest. */
async function prune(dir: string, retentionDays: number, now: Date, keep: string): Promise<string[]> {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const name of await listDumps(dir)) {
    if (name === keep) continue;
    const path = join(dir, name);
    if ((await stat(path)).mtime.getTime() >= cutoff) continue;
    await unlink(path);
    await unlink(join(dir, manifestName(name))).catch(() => undefined);
    removed.push(name);
  }
  // A dump that was being written when the process died.
  for (const name of await readdir(dir)) {
    if (name.startsWith(DUMP_PREFIX) && name.endsWith('.partial')) {
      const path = join(dir, name);
      if ((await stat(path)).mtime.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
        await unlink(path);
        removed.push(name);
      }
    }
  }
  return removed;
}

export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const tools = options.tools ?? PG_TOOLS;
  const now = options.now ?? (() => new Date());
  const started = now();
  const dir = options.backupDir;
  await mkdir(dir, { recursive: true });

  const dump = `${DUMP_PREFIX}${stamp(started)}${DUMP_SUFFIX}`;
  const path = join(dir, dump);
  const partial = `${path}.partial`;

  const version = await run(tools.pgDump, ['--version']);
  const client = new pg.Client({ connectionString: options.databaseUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`could not connect to the database: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  let rowCounts: RowCounts;
  let schemaRevision: string | null;
  try {
    await client.query('begin isolation level repeatable read read only');
    const snapshot = (await client.query<{ id: string }>('select pg_export_snapshot() as id')).rows[0]?.id;
    if (snapshot === undefined) throw new Error('Postgres exported no snapshot');

    const counts = await client.query<Record<string, string>>(
      `select ${COUNTED_TABLES.map((t) => `(select count(*) from "${t}") as "${t}"`).join(', ')}`,
    );
    rowCounts = Object.fromEntries(COUNTED_TABLES.map((t) => [t, Number(counts.rows[0]?.[t] ?? 0)])) as RowCounts;
    schemaRevision =
      (
        await client.query<{ name: string }>(
          'select migration_name as name from _prisma_migrations where finished_at is not null order by migration_name desc limit 1',
        )
      ).rows[0]?.name ?? null;

    const dumped = await run(tools.pgDump, ['--format=custom', `--snapshot=${snapshot}`, '--file', partial, options.databaseUrl]);
    if (dumped.code !== 0) {
      await unlink(partial).catch(() => undefined);
      throw new Error(`pg_dump exited ${String(dumped.code)}: ${dumped.stderr || 'no output'}`);
    }
    await client.query('commit');
  } finally {
    await client.end().catch(() => undefined);
  }

  const bytes = (await stat(partial)).size;
  if (bytes < MIN_DUMP_BYTES) {
    await unlink(partial).catch(() => undefined);
    throw new Error(`the dump is only ${String(bytes)} bytes; a dump that small restores nothing`);
  }
  const sha256 = await sha256File(partial);
  await rename(partial, path);

  const assets = await backupAssets(options.assetDir, dir);

  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    file: dump,
    bytes,
    sha256,
    createdAt: started.toISOString(),
    schemaRevision,
    rowCounts,
    assets,
    pgDump: version.stdout.trim(),
  };
  await writeFile(join(dir, manifestName(dump)), `${JSON.stringify(manifest, null, 2)}\n`);

  const pruned = await prune(dir, options.retentionDays, now(), dump);
  return { dump, path, manifest, pruned };
}
