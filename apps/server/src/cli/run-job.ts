import { ALERTS, createAlerts, logAlertSetup } from '../alerts/index.js';
import { ConfigError, loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { appOpener } from '../maintenance/open.js';
import { MAINTENANCE_KINDS, runMaintenance, type MaintenanceKind } from '../maintenance/runs.js';
import { loadRulePacks } from '../rules/packs.js';

/**
 * Run a maintenance job now, through the same code the schedule runs, and wait for it
 * (FLR-T-12.1). This is how the restore drill is *performed* on demand, and how a backup is taken
 * before something risky. The run is recorded in `maintenance_runs` like a scheduled one, and a
 * failure alerts like one.
 *
 * ```console
 * $ docker compose exec api node dist/cli/run-job.js backup
 * $ docker compose exec api node dist/cli/run-job.js restore-drill
 * $ docker compose exec api node dist/cli/run-job.js restore-drill --dump /backups/<file>.dump
 * $ docker compose exec api node dist/cli/run-job.js alert-test
 * ```
 *
 * `alert-test` sends one test email through the relay and prints the relay's answer.
 * Exit 0 on success, 1 on failure, 2 on a usage error.
 */

const [kind, ...rest] = process.argv.slice(2);
const usage = `usage: run-job <${[...MAINTENANCE_KINDS, 'alert-test'].join('|')}> [--dump <path>]\n`;

if (kind === undefined || (![...MAINTENANCE_KINDS, 'alert-test'].includes(kind))) {
  process.stderr.write(usage);
  process.exit(2);
}
let dump: string | undefined;
if (rest.length > 0) {
  if (kind !== 'restore-drill' || rest[0] !== '--dump' || rest[1] === undefined || rest.length !== 2) {
    process.stderr.write(usage);
    process.exit(2);
  }
  dump = rest[1];
}

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`run-job refused:\n  ${error.problems.join('\n  ')}\n`);
      process.exit(1);
    }
    throw error;
  }
})();

const db = createDb(config.DATABASE_URL);
logAlertSetup(config);
const mailer = createAlerts(config, db);

let code = 1;
try {
  if (kind === 'alert-test') {
    const result = await mailer.send(ALERTS.test(), { repeat: true });
    process.stdout.write(`alert-test: ${result.sent ? 'sent' : `not sent — ${result.reason ?? 'no reason given'}`}\n`);
    code = result.sent ? 0 : 1;
  } else {
    const rulePacks = loadRulePacks(config.RULE_PACKS_DIR, config.RULE_PROFILE);
    const outcome = await runMaintenance(kind as MaintenanceKind, { config, db, mailer, open: appOpener({ config, rulePacks }) }, {
      key: `manual:${kind}:${new Date().toISOString()}`,
      trigger: 'manual',
      ...(dump === undefined ? {} : { dump }),
    });
    if (outcome === null) {
      process.stderr.write(`${kind}: another run holds this key; try again\n`);
    } else {
      process.stdout.write(`${JSON.stringify(outcome.status === 'succeeded' ? outcome.result : { error: outcome.error, alert: outcome.alert }, null, 2)}\n`);
      process.stdout.write(`${kind}: ${outcome.status} (run ${outcome.id})\n`);
      code = outcome.status === 'succeeded' ? 0 : 1;
    }
  }
} catch (error) {
  process.stderr.write(`${kind} failed: ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  await db.$disconnect();
}
process.exit(code);
