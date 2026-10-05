import type pg from 'pg';
import type { AlertKind, AlertLedger } from './mailer.js';

/**
 * The `alerts` table as the mailer's ledger: when each kind was last sent (for the hourly
 * suppression, across processes and restarts) and the history the operator reads at
 * `GET /api/maintenance`. Any `pg` pool or client will do — the api and the worker each bring theirs.
 */
export function pgAlertLedger(db: Pick<pg.Pool, 'query'>): AlertLedger {
  return {
    async lastSent(kind: AlertKind) {
      const { rows } = await db.query<{ at: Date | null }>('select max(created_at) as at from alerts where kind = $1 and sent', [kind]);
      return rows[0]?.at ?? null;
    },
    async record(alert, result) {
      await db.query('insert into alerts (kind, subject, sent, reason) values ($1, $2, $3, $4)', [
        alert.kind,
        alert.subject,
        result.sent,
        result.reason ?? null,
      ]);
    },
  };
}
