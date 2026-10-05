import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { Routes } from '../http/routes.js';
import { relayOf } from '../alerts/index.js';
import { listDumps } from '../maintenance/files.js';
import { MAINTENANCE_KINDS } from '../maintenance/runs.js';

/**
 * What the operator reads about backups, drills and alerts (FLR-T-12.1, FLR-T-12.2): the recent
 * runs with their recorded results, the dumps on disk, and the alerts raised — sent or not, and
 * why. The operator's alone: it names the instance's files.
 */
export function maintenanceRoutes(db: Db, config: Config): Routes {
  const routes = new Routes(db);

  routes.read('/', async (_req, res) => {
    const runs: Record<string, unknown> = Object.fromEntries(
      await Promise.all(
        MAINTENANCE_KINDS.map(async (kind): Promise<[string, unknown]> => [
          kind,
          await db.maintenanceRun.findMany({
            where: { kind },
            orderBy: { startedAt: 'desc' },
            take: 10,
            select: { id: true, key: true, trigger: true, status: true, startedAt: true, finishedAt: true, error: true, result: true },
          }),
        ]),
      ),
    );
    const dumps = await Promise.all(
      (await listDumps(config.BACKUP_DIR)).slice(0, 30).map(async (name) => {
        const info = await stat(join(config.BACKUP_DIR, name)).catch(() => null);
        return { name, bytes: info?.size ?? null, at: info?.mtime ?? null };
      }),
    );
    const alerts = await db.alertLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { kind: true, subject: true, sent: true, reason: true, createdAt: true },
    });
    const relay = relayOf(config);
    res.json({
      runs,
      dumps,
      alerts: {
        email: relay.relay !== null ? 'configured' : relay.missing.length > 0 ? 'half-configured' : 'not configured',
        missing: relay.missing,
        recent: alerts,
      },
    });
  }, { access: 'operator' });

  return routes;
}
