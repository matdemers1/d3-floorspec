/**
 * Alert email through the D3 Auth mail relay (FLR-T-12.2, FLR-REQ-148).
 *
 * **Reused, not rebuilt** — the same relay, protocol and variable names as Foreman and Shipyard: D3
 * Auth runs a Cloudflare Worker that holds the ecosystem's one sending credential; this posts
 * `{to, subject, text}` to it with a bearer token. A second mail integration would be a second
 * credential to rotate and a second thing to be wrong at 3am.
 *
 * It lives in the worker package because both processes send: the api (a failed backup, drill or
 * boot) and the worker (the health watchdog — an api that is down cannot report itself down). The
 * api re-exports it from `apps/server/src/alerts/`.
 *
 * Three promises:
 * - **Never throws.** An alert that cannot be sent must not take down what was sending it.
 * - **Never repeats itself.** One email per kind an hour, remembered in the `alerts` table so a
 *   crash-looping api does not mail on every restart; in memory when the database is the thing
 *   that is down.
 * - **Never carries a secret.** Every subject and body is redacted — credentials in URLs, and each
 *   configured secret by value — before it leaves the process.
 */

export type AlertKind = 'backup-failed' | 'drill-failed' | 'deploy-failed' | 'health-failed' | 'health-recovered' | 'test';

export interface Alert {
  readonly kind: AlertKind;
  readonly subject: string;
  readonly body: string;
}

export interface MailResult {
  readonly sent: boolean;
  /** Why it was not sent, when it was not. Silence about a failed alert is its own incident. */
  readonly reason?: string;
}

export interface RelayConfig {
  readonly url: string;
  readonly token: string;
  readonly to: string;
}

/** Where sends are remembered, for the hourly suppression and the operator's history. */
export interface AlertLedger {
  /** When this kind was last actually sent, or null. Throws when the store cannot be read. */
  lastSent(kind: AlertKind): Promise<Date | null>;
  record(alert: Alert, result: MailResult): Promise<void>;
}

export interface SendOptions {
  /**
   * Skip the hourly suppression, for a caller that already sends once per episode (the watchdog:
   * a second outage within the hour must still be told, and so must the recovery).
   */
  readonly repeat?: boolean;
  /**
   * Send only when the ledger answers. For the api's boot alert: an api that cannot reach its
   * database restarts in a loop, and without a ledger every restart would be an email. The
   * watchdog reports a database that is down.
   */
  readonly requireLedger?: boolean;
}

export interface Mailer {
  readonly configured: boolean;
  send(alert: Alert, options?: SendOptions): Promise<MailResult>;
}

export interface MailerOptions {
  readonly relay: RelayConfig | null;
  /** The instance, named in every email's last line. */
  readonly appUrl?: string;
  readonly ledger?: AlertLedger | null;
  /** Values that must never appear in an email: the relay token is always added. */
  readonly secrets?: readonly (string | undefined)[];
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export const REPEAT_AFTER_MS = 60 * 60 * 1000;
/** A relay that does not answer must not hold up the job that is alerting. */
export const RELAY_TIMEOUT_MS = 10_000;
const BODY_MAX = 4000;
const MIN_SECRET_LENGTH = 12;

/** `scheme://user:password@host` → `scheme://user:[redacted]@host`, anywhere in the text. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

/** Strip credentials from text: passwords in URLs, and each listed secret wherever it appears. */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text.replace(URL_CREDENTIALS, '$1[redacted]@');
  for (const secret of secrets) {
    // By value only when long enough to be a secret rather than a word: a development password of
    // `floorspec` would otherwise blank the app's name out of every email. Shape-redaction above
    // still takes it out of a URL.
    if (secret === undefined || secret.length < MIN_SECRET_LENGTH) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** The password inside a connection URL, so it can be redacted by value as well as by shape. */
export function urlPassword(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const password = decodeURIComponent(new URL(url).password);
    return password === '' ? undefined : password;
  } catch {
    return undefined;
  }
}

/**
 * The relay, from the environment — `MAIL_RELAY_URL`, `MAIL_RELAY_TOKEN`, `ALERT_TO`, the names
 * Foreman and Shipyard use. All three or none: `missing` names what a half-configured relay lacks.
 */
export function relayFromEnv(env: NodeJS.ProcessEnv): { relay: RelayConfig | null; missing: string[] } {
  const read = (name: string) => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const url = read('MAIL_RELAY_URL');
  const token = read('MAIL_RELAY_TOKEN');
  const to = read('ALERT_TO');
  const missing = [
    ...(url === undefined ? ['MAIL_RELAY_URL'] : []),
    ...(token === undefined ? ['MAIL_RELAY_TOKEN'] : []),
    ...(to === undefined ? ['ALERT_TO'] : []),
  ];
  if (url === undefined || token === undefined || to === undefined) return { relay: null, missing: missing.length === 3 ? [] : missing };
  return { relay: { url, token, to }, missing: [] };
}

/** One line for the boot log: what happens to an alert on this instance. Names, never values. */
export function describeRelay(found: { relay: RelayConfig | null; missing: string[] }): { level: 'info' | 'warn'; message: string } {
  if (found.relay !== null) return { level: 'info', message: 'alerts: emailed to the operator through the D3 Auth mail relay' };
  if (found.missing.length > 0) {
    return { level: 'warn', message: `alerts: logged only — the mail relay is half-configured (${found.missing.join(', ')} not set)` };
  }
  return { level: 'info', message: 'alerts: logged only — MAIL_RELAY_URL, MAIL_RELAY_TOKEN and ALERT_TO are not set' };
}

function describeFetchError(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `the relay did not answer within ${String(RELAY_TIMEOUT_MS / 1000)} seconds`;
  }
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
  return `could not reach the relay${code}`;
}

export function createMailer(options: MailerOptions): Mailer {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((level, message, fields) => {
    const line = JSON.stringify({ level, msg: message, ...fields });
    if (level === 'info') process.stdout.write(`${line}\n`);
    else process.stderr.write(`${line}\n`);
  });
  const relay = options.relay;
  const secrets = [...(options.secrets ?? []), relay?.token];
  const ledger = options.ledger ?? null;
  // The fallback when the ledger cannot be read: still suppressed, within this process.
  const memory = new Map<AlertKind, number>();

  async function lastSent(kind: AlertKind): Promise<{ at: number | null; ledgerOk: boolean }> {
    const remembered = memory.get(kind) ?? null;
    if (ledger === null) return { at: remembered, ledgerOk: false };
    try {
      const at = await ledger.lastSent(kind);
      const stored = at === null ? null : at.getTime();
      return { at: stored === null ? remembered : Math.max(stored, remembered ?? 0), ledgerOk: true };
    } catch {
      return { at: remembered, ledgerOk: false };
    }
  }

  async function remember(alert: Alert, result: MailResult): Promise<void> {
    if (ledger === null) return;
    try {
      await ledger.record(alert, result);
    } catch (error) {
      log('warn', 'could not record an alert', { kind: alert.kind, err: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    configured: relay !== null,
    async send(raw, sendOptions = {}) {
      const alert: Alert = {
        kind: raw.kind,
        subject: redact(raw.subject, secrets).replace(/[\r\n]+/g, ' ').slice(0, 200),
        body: redact(raw.body, secrets).slice(0, BODY_MAX),
      };
      // The alert is always logged, configured or not: the log is where it is when mail is not.
      log(alert.kind === 'health-recovered' || alert.kind === 'test' ? 'info' : 'error', `alert: ${alert.subject}`, { kind: alert.kind });

      if (relay === null) {
        const result = { sent: false, reason: 'no mail relay is configured' };
        await remember(alert, result);
        return result;
      }

      const previous = await lastSent(alert.kind);
      if (sendOptions.requireLedger === true && !previous.ledgerOk) {
        return { sent: false, reason: 'the alert ledger is unreachable, so this alert could repeat; not sent' };
      }
      if (sendOptions.repeat !== true && previous.at !== null && now().getTime() - previous.at < REPEAT_AFTER_MS) {
        const result = { sent: false, reason: 'already alerted about this within the hour' };
        await remember(alert, result);
        return result;
      }

      let result: MailResult;
      try {
        const text = `${alert.body}\n\n— D3 Floorspec${options.appUrl === undefined ? '' : ` at ${options.appUrl}`}`;
        const res = await doFetch(relay.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' },
          // Plain text: an alert is read on a phone at an awkward moment.
          body: JSON.stringify({ to: relay.to, subject: `[Floorspec] ${alert.subject}`, text }),
          // A bearer token goes only to the address that was configured.
          redirect: 'manual',
          signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
        });
        if (res.ok) {
          result = { sent: true };
        } else {
          const detail = redact((await res.text().catch(() => '')).slice(0, 200), secrets);
          log('error', 'alert email refused by the relay', { kind: alert.kind, status: res.status, detail });
          result = { sent: false, reason: `the relay answered ${String(res.status)}` };
        }
      } catch (error) {
        result = { sent: false, reason: describeFetchError(error) };
        log('error', 'alert email failed', { kind: alert.kind, reason: result.reason });
      }
      if (result.sent) memory.set(alert.kind, now().getTime());
      await remember(alert, result);
      return result;
    },
  };
}
