import type { Alert } from './mailer.js';

/**
 * Every alert this instance can send, worded so the subject line alone says what happened and the
 * body says what to do first. Alerts are for what nobody would otherwise notice; a failing export
 * is shown to the person who asked for it and is not one of them.
 */

const RUNBOOK = 'Runbook: docs/runbooks/restore.md in the d3-floorspec repository.';

export const ALERTS = {
  backupFailed: (detail: string): Alert => ({
    kind: 'backup-failed',
    subject: 'The nightly backup failed',
    body:
      `The nightly pg_dump and asset backup did not complete, so the newest restorable backup is ` +
      `older than it should be.\n\n${detail}\n\nTake one by hand once the cause is fixed:\n` +
      `  docker compose exec api node dist/cli/run-job.js backup\n\n${RUNBOOK}`,
  }),
  drillFailed: (detail: string): Alert => ({
    kind: 'drill-failed',
    subject: 'The restore drill failed',
    body:
      `The weekly restore drill could not restore the newest backup into a clean database and open a ` +
      `project from it. Until a drill passes, assume the backups would not restore.\n\n${detail}\n\n` +
      `Run it again by hand:\n  docker compose exec api node dist/cli/run-job.js restore-drill\n\n${RUNBOOK}`,
  }),
  deployFailed: (stage: string, detail: string): Alert => ({
    kind: 'deploy-failed',
    subject: `The api failed to start (${stage})`,
    body:
      `A new api container stopped during ${stage}, before it began serving. On a Shipyard deploy this ` +
      `is a failed deploy: Shipyard rolls the image back, and a migration that failed part-way is the ` +
      `thing to check first. The pre-migration dump is in the backups volume.\n\n${detail}\n\n${RUNBOOK}`,
  }),
  healthFailed: (failures: number, detail: string): Alert => ({
    kind: 'health-failed',
    subject: 'Floorspec is failing its health check',
    body:
      `The worker's watchdog has seen ${String(failures)} failed health checks in a row.\n\n${detail}\n\n` +
      `You will get one more email when it recovers.`,
  }),
  healthRecovered: (downFor: string): Alert => ({
    kind: 'health-recovered',
    subject: 'Floorspec is healthy again',
    body: `The health check passes again, after failing for ${downFor}.`,
  }),
  test: (): Alert => ({
    kind: 'test',
    subject: 'Test alert',
    body: 'This is a test of the alert email. If you can read it, failed backups, drills, deploys and health checks will reach you too.',
  }),
} as const;
