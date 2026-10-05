import { ALERTS, type Mailer } from '../alerts/index.js';
import { redact, urlPassword } from '@d3-floorspec/worker/alerts';
import type { Config } from '../config.js';
import { Prisma, type Db } from '../db.js';
import { logger } from '../logger.js';
import { runBackup } from './backup.js';
import { runRestoreDrill, type AppOpener } from './drill.js';
import type { PgTools } from './files.js';

/**
 * Running and scheduling the maintenance jobs (FLR-T-12.1): the nightly `backup` and the weekly
 * `restore-drill`, recorded in `maintenance_runs` and alerted on when they fail (FLR-T-12.2).
 *
 * **Why here, and not on the export queue.** The drill boots the app, and only the api image holds
 * the app, the PostgreSQL 16 client tools and the `backups` volume; the export queue's rows belong
 * to a project and a version, and are drained by the worker, which has none of those. So the api
 * schedules them on its own tick, and `maintenance_runs` is their queue and their record at once:
 * **inserting the idempotency key is the claim.** The key carries the date — `backup:2026-10-05`,
 * `restore-drill:2026-W41` — so asking every five minutes runs one backup a day, and an api
 * restarted at noon still gets that day's run where a timer reset by every deploy would skip it.
 */

export type MaintenanceKind = 'backup' | 'restore-drill';
export const MAINTENANCE_KINDS: readonly MaintenanceKind[] = ['backup', 'restore-drill'];

export interface MaintenanceDeps {
  readonly config: Pick<Config, 'DATABASE_URL' | 'BACKUP_DIR' | 'BACKUP_RETENTION_DAYS' | 'ASSET_DIR' | 'BACKUP_HOUR_UTC' | 'KEK' | 'PEPPER'>;
  readonly db: Db;
  readonly mailer: Mailer;
  /** Boots the app on the drill's restore (`appOpener`). */
  readonly open: AppOpener;
  readonly tools?: PgTools;
  readonly now?: () => Date;
}

export interface RunOutcome {
  readonly id: string;
  readonly kind: MaintenanceKind;
  readonly key: string;
  readonly status: 'succeeded' | 'failed';
  readonly result: unknown;
  readonly error: string | null;
  readonly alert: { readonly sent: boolean; readonly reason?: string } | null;
}

/** A run still `running` after this long was abandoned by a process that ended. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** UTC, so a machine moving between time zones does not get two backups or none. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** ISO 8601 week, so "once a week" does not drift with the day a process happened to restart. */
export function weekKey(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${String(date.getUTCFullYear())}-W${String(week).padStart(2, '0')}`;
}

function failureText(error: unknown, deps: MaintenanceDeps): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message, [urlPassword(deps.config.DATABASE_URL), deps.config.KEK, deps.config.PEPPER]).slice(0, 2000);
}

/**
 * Claim `key` and run `kind` under it. Null when the key is already taken — the run happened, or
 * is happening, somewhere else. A failure is recorded and alerted, and returned, never thrown.
 */
export async function runMaintenance(
  kind: MaintenanceKind,
  deps: MaintenanceDeps,
  options: { key: string; trigger: 'schedule' | 'manual'; dump?: string },
): Promise<RunOutcome | null> {
  let id: string;
  try {
    ({ id } = await deps.db.maintenanceRun.create({ data: { kind, key: options.key, trigger: options.trigger }, select: { id: true } }));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
    throw error;
  }
  logger.info({ kind, key: options.key }, 'maintenance run started');

  try {
    const result =
      kind === 'backup'
        ? await runBackup({
            databaseUrl: deps.config.DATABASE_URL,
            backupDir: deps.config.BACKUP_DIR,
            retentionDays: deps.config.BACKUP_RETENTION_DAYS,
            assetDir: deps.config.ASSET_DIR,
            ...(deps.tools === undefined ? {} : { tools: deps.tools }),
            ...(deps.now === undefined ? {} : { now: deps.now }),
          })
        : await runRestoreDrill({
            databaseUrl: deps.config.DATABASE_URL,
            backupDir: deps.config.BACKUP_DIR,
            open: deps.open,
            ...(options.dump === undefined ? {} : { dump: options.dump }),
            ...(deps.tools === undefined ? {} : { tools: deps.tools }),
            ...(deps.now === undefined ? {} : { now: deps.now }),
          });
    const json = JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
    await deps.db.maintenanceRun.update({ where: { id }, data: { status: 'succeeded', result: json, finishedAt: new Date() } });
    logger.info({ kind, key: options.key }, 'maintenance run succeeded');
    return { id, kind, key: options.key, status: 'succeeded', result: json, error: null, alert: null };
  } catch (error) {
    const text = failureText(error, deps);
    await deps.db.maintenanceRun
      .update({ where: { id }, data: { status: 'failed', error: text, finishedAt: new Date() } })
      .catch((failure: unknown) => {
        logger.error({ err: failure instanceof Error ? failure.message : String(failure) }, 'could not record a failed maintenance run');
      });
    logger.error({ kind, key: options.key, err: text }, 'maintenance run failed');
    const detail = `Run ${options.key} (${options.trigger}) failed:\n${text}`;
    const alert = await deps.mailer.send(kind === 'backup' ? ALERTS.backupFailed(detail) : ALERTS.drillFailed(detail));
    return { id, kind, key: options.key, status: 'failed', result: null, error: text, alert };
  }
}

/** Fail, and alert on, runs a process abandoned part-way: their key is spent, so nothing else would. */
export async function reapStale(deps: MaintenanceDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const stale = await deps.db.maintenanceRun.findMany({
    where: { status: 'running', startedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
  });
  for (const run of stale) {
    const error = 'stopped part-way: the process running it ended before it finished';
    await deps.db.maintenanceRun.update({ where: { id: run.id }, data: { status: 'failed', error, finishedAt: now } });
    const detail = `Run ${run.key}, started ${run.startedAt.toISOString()}, ${error}.`;
    await deps.mailer.send(run.kind === 'backup' ? ALERTS.backupFailed(detail) : ALERTS.drillFailed(detail));
  }
  return stale.length;
}

/**
 * One scheduling pass: after `BACKUP_HOUR_UTC`, today's backup if it has not run; after a backup
 * that succeeded, this week's drill if it has not run. A failed backup is not retried under the
 * same key — it alerted, and the operator runs one by hand — so a broken pg_dump is one email a
 * day, not one every five minutes.
 */
export async function maintenanceTick(deps: MaintenanceDeps): Promise<RunOutcome[]> {
  const now = deps.now?.() ?? new Date();
  const ran: RunOutcome[] = [];
  await reapStale(deps);
  if (now.getUTCHours() < deps.config.BACKUP_HOUR_UTC) return ran;

  const backupKey = `backup:${dayKey(now)}`;
  const existing = await deps.db.maintenanceRun.findUnique({ where: { key: backupKey }, select: { status: true } });
  let backupStatus = existing?.status ?? null;
  if (existing === null) {
    const outcome = await runMaintenance('backup', deps, { key: backupKey, trigger: 'schedule' });
    if (outcome !== null) {
      ran.push(outcome);
      backupStatus = outcome.status;
    }
  }
  if (backupStatus !== 'succeeded') return ran;

  const drillKey = `restore-drill:${weekKey(now)}`;
  if ((await deps.db.maintenanceRun.findUnique({ where: { key: drillKey }, select: { id: true } })) === null) {
    const outcome = await runMaintenance('restore-drill', deps, { key: drillKey, trigger: 'schedule' });
    if (outcome !== null) ran.push(outcome);
  }
  return ran;
}

export interface Scheduler {
  stop(): Promise<void>;
}

/** Tick every five minutes, the first a minute after boot (a deploy's soak is not the moment). */
export function startMaintenance(deps: MaintenanceDeps, options: { everyMs?: number; firstAfterMs?: number } = {}): Scheduler {
  let inFlight: Promise<unknown> | null = null;
  const tick = () => {
    if (inFlight !== null) return;
    inFlight = maintenanceTick(deps)
      .catch((error: unknown) => {
        logger.error({ err: failureText(error, deps) }, 'maintenance tick failed');
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const first = setTimeout(tick, options.firstAfterMs ?? 60_000);
  const timer = setInterval(tick, options.everyMs ?? 5 * 60_000);
  first.unref();
  timer.unref();
  return {
    async stop() {
      clearTimeout(first);
      clearInterval(timer);
      await inFlight;
    },
  };
}

/** The newest finished run of each kind, for `/health`: when, and whether it worked. */
export async function latestRuns(db: Db): Promise<Record<MaintenanceKind, { at: string; ok: boolean } | null>> {
  const out: Record<MaintenanceKind, { at: string; ok: boolean } | null> = { backup: null, 'restore-drill': null };
  for (const kind of MAINTENANCE_KINDS) {
    const run = await db.maintenanceRun.findFirst({
      where: { kind, status: { not: 'running' } },
      orderBy: { startedAt: 'desc' },
      select: { status: true, finishedAt: true, startedAt: true },
    });
    out[kind] = run === null ? null : { at: (run.finishedAt ?? run.startedAt).toISOString(), ok: run.status === 'succeeded' };
  }
  return out;
}
