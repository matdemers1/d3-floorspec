import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import pg from 'pg';
import {
  COUNTED_TABLES,
  listDumps,
  manifestName,
  PG_TOOLS,
  run,
  sha256File,
  type Manifest,
  type PgTools,
  type RowCounts,
} from './files.js';

/**
 * The restore drill (FLR-T-12.1, FLR-REQ-171): **performed, not described.** The newest nightly
 * dump is checked against its manifest, restored into a clean scratch database, compared row for
 * row with what the manifest says was dumped, and then the app itself is booted against it and
 * asked to open a project — through its own HTTP routes, signed in, the way the editor does. The
 * scratch database is dropped in a `finally`, so a failed drill leaves nothing behind to fill the
 * disk it was protecting.
 */

export interface OpenedProject {
  readonly id: string;
  readonly name: string;
  /** The head of `main`, as the app reported it. */
  readonly head: string;
  /** The content hash recomputed from the model the app served — must equal `head`. */
  readonly modelHash: string;
  readonly modelBytes: number;
  /** The engine's verdict on the served model; recorded, not required (a model may hold errors). */
  readonly valid: boolean;
  readonly errors: number;
}

export interface OpenedApp {
  /** What `/health` answered on the restored database. */
  readonly health: { readonly status: number; readonly schemaRevision: string | null };
  readonly projects: number;
  /** Null only when the dump holds no project to open. */
  readonly opened: OpenedProject | null;
}

/** Boot the app against a database and open a project from it. Throws on anything that fails. */
export type AppOpener = (databaseUrl: string) => Promise<OpenedApp>;

export interface DrillOptions {
  readonly databaseUrl: string;
  readonly backupDir: string;
  readonly open: AppOpener;
  /** Drill this file rather than the newest nightly dump. Without a manifest beside it, the sha256 and row-count checks are skipped and the record says so. */
  readonly dump?: string;
  readonly tools?: PgTools;
  readonly now?: () => Date;
}

export interface DrillResult {
  readonly dump: string;
  readonly dumpCreatedAt: string | null;
  readonly sha256: string;
  readonly manifest: 'verified' | 'absent';
  readonly scratchDatabase: string;
  readonly schemaRevision: string | null;
  readonly restoredRows: RowCounts;
  readonly app: OpenedApp;
  readonly durationMs: number;
  /** Anything a person should read that did not fail the drill. */
  readonly notes: readonly string[];
}

function databaseUrlFor(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function readManifest(path: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

export async function runRestoreDrill(options: DrillOptions): Promise<DrillResult> {
  const tools = options.tools ?? PG_TOOLS;
  const now = options.now ?? (() => new Date());
  const started = now().getTime();
  const notes: string[] = [];

  // Which dump: the newest nightly one, or the one asked for.
  let path: string;
  if (options.dump !== undefined) {
    path = options.dump;
  } else {
    const newest = (await listDumps(options.backupDir))[0];
    if (newest === undefined) throw new Error(`there is no nightly dump in ${options.backupDir} to restore`);
    path = join(options.backupDir, newest);
  }
  const dump = basename(path);
  try {
    await stat(path);
  } catch {
    throw new Error(`the dump ${path} does not exist`);
  }

  const manifest = await readManifest(join(dirname(path), manifestName(dump)));
  const sha256 = await sha256File(path);
  if (manifest === null) {
    if (options.dump === undefined) throw new Error(`${dump} has no manifest beside it, so it cannot be verified`);
    notes.push('no manifest beside this dump: its checksum and row counts were not compared');
  } else if (manifest.sha256 !== sha256) {
    throw new Error(`${dump} does not match its manifest: sha256 ${sha256.slice(0, 12)}… where the backup recorded ${manifest.sha256.slice(0, 12)}…; the file has changed since it was written`);
  }

  // A scratch database named for this run, so a drill can never touch the real one.
  const scratch = `floorspec_drill_${now().toISOString().replace(/\D/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
  const scratchUrl = databaseUrlFor(options.databaseUrl, scratch);
  const admin = new pg.Client({ connectionString: options.databaseUrl });
  await admin.connect();
  try {
    // A drill whose process was killed mid-run left its scratch database behind: drop any that are
    // hours old. A younger one may be another drill still running.
    const leftovers = await admin.query<{ name: string }>(`select datname as name from pg_database where datname like 'floorspec\\_drill\\_%'`);
    for (const { name } of leftovers.rows) {
      const at = /^floorspec_drill_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(name);
      if (at === null) continue;
      const when = Date.UTC(Number(at[1]), Number(at[2]) - 1, Number(at[3]), Number(at[4]), Number(at[5]), Number(at[6]));
      if (now().getTime() - when > 6 * 60 * 60 * 1000) await admin.query(`drop database if exists "${name}" with (force)`).catch(() => undefined);
    }
    await admin.query(`create database "${scratch}"`);
  } catch (error) {
    await admin.end().catch(() => undefined);
    throw new Error(`could not create the scratch database (the database role needs CREATEDB): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  try {
    const restored = await run(tools.pgRestore, ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', scratchUrl, path]);
    if (restored.code !== 0) throw new Error(`pg_restore could not restore ${dump}: ${restored.stderr || `exit ${String(restored.code)}`}`);

    // The restored database has to answer for what the backup said it held.
    const target = new pg.Client({ connectionString: scratchUrl });
    await target.connect();
    let restoredRows: RowCounts;
    let schemaRevision: string | null;
    try {
      const counts = await target.query<Record<string, string>>(
        `select ${COUNTED_TABLES.map((t) => `(select count(*) from "${t}") as "${t}"`).join(', ')}`,
      );
      restoredRows = Object.fromEntries(COUNTED_TABLES.map((t) => [t, Number(counts.rows[0]?.[t] ?? 0)])) as RowCounts;
      schemaRevision =
        (
          await target.query<{ name: string }>(
            'select migration_name as name from _prisma_migrations where finished_at is not null order by finished_at desc, migration_name desc limit 1',
          )
        ).rows[0]?.name ?? null;
    } catch (error) {
      throw new Error(`the restored database would not answer a query: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      await target.end().catch(() => undefined);
    }

    if (manifest !== null) {
      const differ = COUNTED_TABLES.filter((t) => restoredRows[t] !== manifest.rowCounts[t]);
      if (differ.length > 0) {
        throw new Error(`the restore does not hold what was dumped: ${differ.map((t) => `${t} ${String(restoredRows[t])} restored, ${String(manifest.rowCounts[t])} dumped`).join('; ')}`);
      }
      if (schemaRevision !== manifest.schemaRevision) {
        throw new Error(`the restored schema is ${schemaRevision ?? 'none'}, but the backup recorded ${manifest.schemaRevision ?? 'none'}`);
      }
    }

    // The part that makes it a drill: the app boots on the restore and opens a project.
    let app: OpenedApp;
    try {
      app = await options.open(scratchUrl);
    } catch (error) {
      throw new Error(`the app did not open a project from the restore: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (app.opened === null) notes.push('the dump holds no project, so none was opened');

    return {
      dump,
      dumpCreatedAt: manifest?.createdAt ?? null,
      sha256,
      manifest: manifest === null ? 'absent' : 'verified',
      scratchDatabase: scratch,
      schemaRevision,
      restoredRows,
      app,
      durationMs: now().getTime() - started,
      notes,
    };
  } finally {
    // Always, even on failure. FORCE ends any connection the booted app left open.
    await admin.query(`drop database if exists "${scratch}" with (force)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}
