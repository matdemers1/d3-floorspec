import { migrate } from './boot.js';
import { ConfigError, loadConfig } from './config.js';
import { createApp, eventHubOf } from './app.js';
import { opsApplier } from './ops/applier.js';
import { createOidcClient } from './auth/oidc.js';
import { createDb } from './db.js';
import { logger } from './logger.js';
import { workerRenderer } from './render.js';
import { loadRulePacks, RulePackError } from './rules/packs.js';
import { alertBootFailure, createAlerts, logAlertSetup } from './alerts/index.js';
import { startMaintenance } from './maintenance/runs.js';
import { appOpener } from './maintenance/open.js';

/** Entry point. A misconfigured instance exits here, naming what is wrong. */
const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write('d3-floorspec api refused to start:\n');
      for (const problem of error.problems) process.stderr.write(`  - ${problem}\n`);
      process.exit(1);
    }
    throw error;
  }
})();

// Created before anything can fail, so a boot that fails can say so: the client connects lazily.
const db = createDb(config.DATABASE_URL);
logAlertSetup(config);
const alerts = createAlerts(config, db);

/**
 * A boot that fails after the configuration was read — a rule pack that is not one, a migration
 * that fails — emails the operator before exiting (FLR-T-12.2): on a Shipyard deploy, this is the
 * deploy failing.
 */
async function refuseBoot(stage: string, error: unknown): Promise<never> {
  process.stderr.write(`d3-floorspec api refused to start (${stage}):\n  - ${error instanceof Error ? error.message : String(error)}\n`);
  await alertBootFailure(alerts, stage, error);
  await db.$disconnect().catch(() => undefined);
  process.exit(1);
}

// The installed rule packs, read and validated once: a pack that is not one refuses the boot.
const rulePacks = await (async () => {
  try {
    return loadRulePacks(config.RULE_PACKS_DIR, config.RULE_PROFILE);
  } catch (error) {
    if (error instanceof RulePackError) return await refuseBoot('loading the rule packs', error);
    throw error;
  }
})();

try {
  await migrate(config);
} catch (error) {
  await refuseBoot('the migration', error);
}
// Discovery is attempted once and allowed to fail: an unreachable D3 Auth means one sign-in button
// instead of two, never an api that will not start.
const oidc = await createOidcClient(config);
// Plans are drawn in-process by the worker's renderer until the worker has a job queue (FLR-T-2.8).
const app = createApp({ config, db, oidc, renderer: workerRenderer(), applier: opsApplier, rulePacks });

// Listen for events from boot, so a client reconnecting after a quiet spell can still resume. A
// database that is not answering yet is retried on the first subscriber.
const events = eventHubOf(app);
events.start().catch((error: unknown) => {
  logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'event listener did not start; will retry on the first subscriber');
});

// The job queue (FLR-T-9.3): drained by the worker container in production; by this process when
// no worker runs (development, the end-to-end suites).
const drainInline = (config.JOB_DRAIN ?? (config.NODE_ENV === 'production' ? 'worker' : 'inline')) === 'inline';
const drain = drainInline ? (await import('@d3-floorspec/worker/queue')).createDrain({ databaseUrl: config.DATABASE_URL, ...(config.ASSET_DIR === undefined ? {} : { assetDir: config.ASSET_DIR }), log: (m) => { logger.info(m); } }) : null;
if (drain !== null) {
  drain.start().catch((error: unknown) => {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'the inline job drain did not start');
  });
}

// The nightly backup and weekly restore drill (FLR-T-12.1): scheduled here because only this image
// holds the app the drill boots, the PostgreSQL client tools and the backups volume.
const scheduleOn = (config.BACKUP_SCHEDULE ?? (config.NODE_ENV === 'production' ? 'on' : 'off')) === 'on';
const maintenance = scheduleOn ? startMaintenance({ config, db, mailer: alerts, open: appOpener({ config, rulePacks }) }) : null;
logger.info(
  scheduleOn
    ? { backupHourUtc: config.BACKUP_HOUR_UTC, retentionDays: config.BACKUP_RETENTION_DAYS, backupDir: config.BACKUP_DIR }
    : {},
  scheduleOn ? 'nightly backup and weekly restore drill scheduled' : 'backups are not scheduled here (BACKUP_SCHEDULE=off)',
);

logger.info(
  { assetDir: config.ASSET_DIR ?? null, maxBytes: config.ASSET_MAX_BYTES },
  config.ASSET_DIR !== undefined
    ? 'asset store on the filesystem'
    : config.NODE_ENV === 'production'
      ? 'no asset store: ASSET_DIR is not set, so texture uploads are refused'
      : 'ASSET_DIR is not set: texture uploads are kept in memory and lost on restart',
);

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, publicUrl: config.PUBLIC_URL, oidcConfigured: config.oidcConfigured, oidcReachable: oidc !== null, rulePacks: rulePacks.sources, ruleProfile: rulePacks.profile?.name ?? 'default' },
    'd3-floorspec api listening',
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    // Open event streams would hold the server open forever: end them first.
    void events.close();
    void drain?.stop();
    void maintenance?.stop();
    server.close(() => {
      void db.$disconnect().then(() => process.exit(0));
    });
  });
}
