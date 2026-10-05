import {
  ALERTS,
  createMailer,
  describeRelay,
  relayFromEnv,
  urlPassword,
  type AlertLedger,
  type Mailer,
} from '@d3-floorspec/worker/alerts';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { logger } from '../logger.js';

/**
 * Alerts from the api (FLR-T-12.2, FLR-REQ-148): a failed backup, a failed restore drill, and a
 * boot that fails before serving — which, on a Shipyard deploy, is the deploy failing. The health
 * watchdog that reports an api or database that is down runs in the worker.
 *
 * The mailer itself is shared with the worker (`@d3-floorspec/worker/alerts`): the worker cannot
 * import the api, and both must speak the relay the same way.
 */
export { ALERTS, type Alert, type AlertKind, type Mailer, type MailResult } from '@d3-floorspec/worker/alerts';

/** The `alerts` table through Prisma, for the hourly suppression and the operator's history. */
export function prismaAlertLedger(db: Db): AlertLedger {
  return {
    async lastSent(kind) {
      const { _max } = await db.alertLog.aggregate({ where: { kind, sent: true }, _max: { createdAt: true } });
      return _max.createdAt;
    },
    async record(alert, result) {
      await db.alertLog.create({
        data: { kind: alert.kind, subject: alert.subject, sent: result.sent, reason: result.reason ?? null },
      });
    },
  };
}

type RelayEnv = Pick<Config, 'MAIL_RELAY_URL' | 'MAIL_RELAY_TOKEN' | 'ALERT_TO' | 'PUBLIC_URL' | 'DATABASE_URL' | 'KEK' | 'PEPPER' | 'D3AUTH_CLIENT_SECRET'>;

/** The relay this config names, or null; and what a half-configured one lacks. */
export function relayOf(config: RelayEnv): ReturnType<typeof relayFromEnv> {
  return relayFromEnv({
    ...(config.MAIL_RELAY_URL === undefined ? {} : { MAIL_RELAY_URL: config.MAIL_RELAY_URL }),
    ...(config.MAIL_RELAY_TOKEN === undefined ? {} : { MAIL_RELAY_TOKEN: config.MAIL_RELAY_TOKEN }),
    ...(config.ALERT_TO === undefined ? {} : { ALERT_TO: config.ALERT_TO }),
  });
}

/** The api's mailer. `db` null: no ledger (suppression in memory only). */
export function createAlerts(config: RelayEnv, db: Db | null, deps: { fetch?: typeof fetch } = {}): Mailer {
  return createMailer({
    relay: relayOf(config).relay,
    appUrl: config.PUBLIC_URL,
    ledger: db === null ? null : prismaAlertLedger(db),
    // Redacted by value as well as by shape: the database password, the keys, the relay token.
    secrets: [urlPassword(config.DATABASE_URL), config.KEK, config.PEPPER, config.D3AUTH_CLIENT_SECRET],
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    log: (level, message, fields) => {
      logger[level](fields ?? {}, message);
    },
  });
}

/** Say at boot what happens to an alert here — emailed, or logged only — naming no values. */
export function logAlertSetup(config: RelayEnv): void {
  const line = describeRelay(relayOf(config));
  logger[line.level](line.message);
}

/**
 * A boot that failed before serving: alert, then let the caller exit. Sent only when the alert
 * ledger answers, so an api restarting in a loop mails once an hour rather than once a restart;
 * when the database is what is down, the worker's watchdog is the one that reports it.
 */
export async function alertBootFailure(mailer: Mailer, stage: string, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  const result = await mailer.send(ALERTS.deployFailed(stage, detail.slice(0, 2000)), { requireLedger: true });
  if (!result.sent) logger.warn({ reason: result.reason }, 'boot-failure alert not emailed');
}
