import type pg from 'pg';
import { ALERTS } from './catalogue.js';
import type { Mailer } from './mailer.js';

/**
 * The health watchdog (FLR-T-12.2): the worker probes the api's `/health` and the database on a
 * timer, and emails the operator after `threshold` failed checks in a row — then once more when it
 * recovers. It runs in the worker because an api that is down cannot report itself down.
 *
 * One email per episode, not one an hour: an outage that lasts all night is one email, and a second
 * outage after a recovery is a second one. A brief blip — a Shipyard swap restarts the api for a
 * few seconds — never reaches the threshold.
 */

export interface Probe {
  readonly name: string;
  /** Resolves when healthy; rejects with what was wrong. */
  run(): Promise<void>;
}

export interface WatchdogOptions {
  readonly probes: readonly Probe[];
  readonly mailer: Mailer;
  /** Failed checks in a row before an alert. Default 3. */
  readonly threshold?: number;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export interface WatchdogState {
  readonly healthy: boolean;
  readonly consecutiveFailures: number;
  readonly alerted: boolean;
  /** What failed on the last check, by probe. */
  readonly failures: Readonly<Record<string, string>>;
}

export interface Watchdog {
  check(): Promise<WatchdogState>;
  readonly state: WatchdogState;
}

const PROBE_TIMEOUT_MS = 5_000;

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  return `${String(Math.round(minutes / 60))} hours`;
}

/** `GET url` answers 2xx within five seconds. */
export function httpProbe(name: string, url: string, doFetch: typeof fetch = fetch): Probe {
  return {
    name,
    async run() {
      let res: Response;
      try {
        res = await doFetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
      } catch (error) {
        const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
        const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
        if (error instanceof DOMException) throw new Error(`${url} did not answer within ${String(PROBE_TIMEOUT_MS / 1000)} seconds`, { cause: error });
        throw new Error(`${url} could not be reached${code}`, { cause: error });
      }
      const body = (await res.text().catch(() => '')).slice(0, 200);
      if (!res.ok) throw new Error(`${url} answered ${String(res.status)}${body === '' ? '' : `: ${body}`}`);
    },
  };
}

/** The database answers `select 1`. */
export function pgProbe(name: string, pool: Pick<pg.Pool, 'query'>): Probe {
  return {
    name,
    async run() {
      await pool.query('select 1');
    },
  };
}

export function createWatchdog(options: WatchdogOptions): Watchdog {
  const threshold = options.threshold ?? 3;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  let consecutive = 0;
  let alerted = false;
  let firstFailureAt: number | null = null;
  let failures: Record<string, string> = {};

  const snapshot = (): WatchdogState => ({ healthy: consecutive === 0, consecutiveFailures: consecutive, alerted, failures });

  return {
    get state() {
      return snapshot();
    },
    async check() {
      const results = await Promise.all(
        options.probes.map(async (probe) => {
          try {
            await probe.run();
            return null;
          } catch (error) {
            return [probe.name, message(error)] as const;
          }
        }),
      );
      failures = Object.fromEntries(results.filter((r) => r !== null));

      if (Object.keys(failures).length === 0) {
        if (alerted) {
          const downFor = duration(now().getTime() - (firstFailureAt ?? now().getTime()));
          await options.mailer.send(ALERTS.healthRecovered(downFor), { repeat: true });
          log(`watchdog: healthy again after ${downFor}`);
        }
        consecutive = 0;
        alerted = false;
        firstFailureAt = null;
        return snapshot();
      }

      consecutive++;
      firstFailureAt ??= now().getTime();
      log(`watchdog: check failed (${String(consecutive)} in a row): ${Object.entries(failures).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
      if (consecutive >= threshold && !alerted) {
        const detail = [
          `Failing since ${new Date(firstFailureAt).toISOString()}.`,
          ...Object.entries(failures).map(([name, why]) => `- ${name}: ${why}`),
        ].join('\n');
        await options.mailer.send(ALERTS.healthFailed(consecutive, detail), { repeat: true });
        alerted = true;
      }
      return snapshot();
    },
  };
}
