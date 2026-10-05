import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALERTS,
  createMailer,
  createWatchdog,
  describeRelay,
  httpProbe,
  redact,
  relayFromEnv,
  REPEAT_AFTER_MS,
  type Alert,
  type AlertKind,
  type AlertLedger,
  type MailResult,
  type Probe,
} from '../src/alerts/index.js';

/** FLR-T-12.2: the alert mailer and the health watchdog, with the relay mocked. */

const RELAY = { url: 'https://relay.example.test/send', token: 'relay-token-abcdef', to: 'operator@example.test' };
const quiet = () => undefined;

interface Posted {
  url: string;
  headers: Record<string, string>;
  body: { to: string; subject: string; text: string };
}

function fakeRelay(status = 200) {
  const posted: Posted[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    posted.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) as Posted['body'] });
    return Promise.resolve(new Response('ok', { status }));
  }) as unknown as typeof fetch;
  return { posted, fetch: fetchFn };
}

function memoryLedger(clock: () => number = Date.now): AlertLedger & { rows: { alert: Alert; result: MailResult }[] } {
  const rows: { alert: Alert; result: MailResult; at: number }[] = [];
  return {
    rows,
    lastSent(kind: AlertKind) {
      const sent = rows.filter((r) => r.alert.kind === kind && r.result.sent);
      return Promise.resolve(sent.length === 0 ? null : new Date(Math.max(...sent.map((r) => r.at))));
    },
    record(alert, result) {
      rows.push({ alert, result, at: clock() });
      return Promise.resolve();
    },
  };
}

describe('relayFromEnv', () => {
  it('is null and quiet when nothing is set', () => {
    const found = relayFromEnv({});
    expect(found).toEqual({ relay: null, missing: [] });
    expect(describeRelay(found).message).toMatch(/logged only/);
  });
  it('names what a half-configured relay lacks, and never a value', () => {
    const found = relayFromEnv({ MAIL_RELAY_URL: RELAY.url, MAIL_RELAY_TOKEN: RELAY.token });
    expect(found).toEqual({ relay: null, missing: ['ALERT_TO'] });
    const line = describeRelay(found);
    expect(line.level).toBe('warn');
    expect(line.message).toContain('ALERT_TO');
    expect(line.message).not.toContain(RELAY.token);
  });
  it('is the relay when all three are set', () => {
    expect(relayFromEnv({ MAIL_RELAY_URL: RELAY.url, MAIL_RELAY_TOKEN: RELAY.token, ALERT_TO: RELAY.to }).relay).toEqual(RELAY);
  });
});

describe('redact', () => {
  it('strips passwords from URLs and listed secrets by value', () => {
    const text = 'pg_dump: connection to postgresql://floorspec:hunter2-long@postgres:5432/floorspec failed; key=KEYVALUE1234567';
    const out = redact(text, ['KEYVALUE1234567']);
    expect(out).not.toContain('hunter2-long');
    expect(out).not.toContain('KEYVALUE1234567');
    expect(out).toContain('postgresql://floorspec:[redacted]@postgres:5432/floorspec');
  });
});

describe('createMailer', () => {
  it('logs only, and says why, when no relay is configured', async () => {
    const ledger = memoryLedger();
    const mailer = createMailer({ relay: null, ledger, log: quiet });
    expect(mailer.configured).toBe(false);
    const result = await mailer.send(ALERTS.backupFailed('pg_dump exited 1'));
    expect(result).toEqual({ sent: false, reason: 'no mail relay is configured' });
    expect(ledger.rows).toHaveLength(1);
  });

  it('posts {to, subject, text} with the bearer token, and no secret in what it sends', async () => {
    const relay = fakeRelay();
    const mailer = createMailer({
      relay: RELAY,
      appUrl: 'https://floorspec.example.test',
      ledger: memoryLedger(),
      secrets: ['db-password-xyz', 'KEK-VALUE-1234'],
      fetch: relay.fetch,
      log: quiet,
    });
    const result = await mailer.send(
      ALERTS.backupFailed(`pg_dump: postgresql://floorspec:db-password-xyz@postgres/floorspec refused; KEK-VALUE-1234; ${RELAY.token}`),
    );
    expect(result).toEqual({ sent: true });
    expect(relay.posted).toHaveLength(1);
    const [post] = relay.posted;
    expect(post?.url).toBe(RELAY.url);
    expect(post?.headers['authorization']).toBe(`Bearer ${RELAY.token}`);
    expect(post?.body.to).toBe(RELAY.to);
    expect(post?.body.subject).toBe('[Floorspec] The nightly backup failed');
    expect(post?.body.text).toContain('run-job.js backup');
    expect(post?.body.text).toContain('https://floorspec.example.test');
    const all = JSON.stringify(post?.body);
    for (const secret of ['db-password-xyz', 'KEK-VALUE-1234', RELAY.token]) expect(all).not.toContain(secret);
  });

  it('sends one email per kind an hour, remembered by the ledger across instances', async () => {
    const relay = fakeRelay();
    let clock = new Date('2026-10-05T08:00:00Z');
    const ledger = memoryLedger(() => clock.getTime());
    const make = () => createMailer({ relay: RELAY, ledger, fetch: relay.fetch, now: () => clock, log: quiet });
    const first = make();
    expect((await first.send(ALERTS.backupFailed('a'))).sent).toBe(true);
    expect(await first.send(ALERTS.backupFailed('b'))).toEqual({ sent: false, reason: 'already alerted about this within the hour' });
    // A restarted process reads the same ledger.
    expect((await make().send(ALERTS.backupFailed('c'))).sent).toBe(false);
    // Another kind is not suppressed by this one.
    expect((await first.send(ALERTS.drillFailed('d'))).sent).toBe(true);
    // `repeat` is for callers that already send once per episode.
    expect((await first.send(ALERTS.backupFailed('e'), { repeat: true })).sent).toBe(true);
    clock = new Date(clock.getTime() + REPEAT_AFTER_MS + 1);
    expect((await make().send(ALERTS.backupFailed('f'))).sent).toBe(true);
    expect(relay.posted.map((p) => p.body.subject)).toEqual([
      '[Floorspec] The nightly backup failed',
      '[Floorspec] The restore drill failed',
      '[Floorspec] The nightly backup failed',
      '[Floorspec] The nightly backup failed',
    ]);
  });

  it('falls back to remembering in memory when the ledger cannot be read', async () => {
    const relay = fakeRelay();
    const broken: AlertLedger = { lastSent: () => Promise.reject(new Error('down')), record: () => Promise.reject(new Error('down')) };
    const mailer = createMailer({ relay: RELAY, ledger: broken, fetch: relay.fetch, log: quiet });
    expect((await mailer.send(ALERTS.drillFailed('x'))).sent).toBe(true);
    expect((await mailer.send(ALERTS.drillFailed('y'))).sent).toBe(false);
    expect(relay.posted).toHaveLength(1);
  });

  it('does not send a requireLedger alert when the ledger is unreachable', async () => {
    const relay = fakeRelay();
    const broken: AlertLedger = { lastSent: () => Promise.reject(new Error('down')), record: () => Promise.resolve() };
    const mailer = createMailer({ relay: RELAY, ledger: broken, fetch: relay.fetch, log: quiet });
    const result = await mailer.send(ALERTS.deployFailed('the migration', 'boom'), { requireLedger: true });
    expect(result.sent).toBe(false);
    expect(relay.posted).toHaveLength(0);
  });

  it('never throws when the relay refuses or cannot be reached', async () => {
    const refusing = fakeRelay(502);
    const a = createMailer({ relay: RELAY, fetch: refusing.fetch, log: quiet });
    expect(await a.send(ALERTS.test())).toEqual({ sent: false, reason: 'the relay answered 502' });

    const unreachable = (() => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))) as unknown as typeof fetch;
    const b = createMailer({ relay: RELAY, fetch: unreachable, log: quiet });
    expect(await b.send(ALERTS.test())).toEqual({ sent: false, reason: 'could not reach the relay (ECONNREFUSED)' });
  });
});

describe('createWatchdog', () => {
  function flakyProbe(name: string) {
    const probe = { name, failing: false, run: () => (probe.failing ? Promise.reject(new Error(`${name} answered 503`)) : Promise.resolve()) };
    return probe;
  }

  it('emails once after three failed checks in a row, once on recovery, and again for a second episode', async () => {
    const relay = fakeRelay();
    const mailer = createMailer({ relay: RELAY, fetch: relay.fetch, log: quiet });
    const api = flakyProbe('api /health');
    const db = flakyProbe('database');
    const watchdog = createWatchdog({ probes: [api, db] as Probe[], mailer, threshold: 3, log: quiet });

    await watchdog.check();
    expect(relay.posted).toHaveLength(0);

    api.failing = true;
    await watchdog.check();
    await watchdog.check();
    expect(relay.posted).toHaveLength(0);
    const third = await watchdog.check();
    expect(third).toMatchObject({ healthy: false, consecutiveFailures: 3, alerted: true });
    expect(relay.posted).toHaveLength(1);
    expect(relay.posted[0]?.body.subject).toBe('[Floorspec] Floorspec is failing its health check');
    expect(relay.posted[0]?.body.text).toContain('api /health: api /health answered 503');
    expect(relay.posted[0]?.body.text).not.toContain('database:');

    // Still failing: no second email for the same episode.
    for (let i = 0; i < 5; i++) await watchdog.check();
    expect(relay.posted).toHaveLength(1);

    api.failing = false;
    expect((await watchdog.check()).healthy).toBe(true);
    expect(relay.posted).toHaveLength(2);
    expect(relay.posted[1]?.body.subject).toBe('[Floorspec] Floorspec is healthy again');

    // A blip under the threshold says nothing.
    db.failing = true;
    await watchdog.check();
    db.failing = false;
    await watchdog.check();
    expect(relay.posted).toHaveLength(2);

    // A second outage is a second email, within the hour or not.
    db.failing = true;
    for (let i = 0; i < 3; i++) await watchdog.check();
    expect(relay.posted).toHaveLength(3);
    expect(relay.posted[2]?.body.text).toContain('database: database answered 503');
  });
});

describe('httpProbe', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === null) resolve();
      else server.close(() => { resolve(); });
    });
    server = null;
  });

  it('passes on 200, fails on 503 and on a closed port — and drives the watchdog to one email', async () => {
    let status = 200;
    server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: status === 200 ? 'ok' : 'degraded' }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const probe = httpProbe('api /health', `http://127.0.0.1:${String(port)}/health`);
    await expect(probe.run()).resolves.toBeUndefined();

    status = 503;
    await expect(probe.run()).rejects.toThrow(/answered 503/);

    const relay = fakeRelay();
    const watchdog = createWatchdog({ probes: [probe], mailer: createMailer({ relay: RELAY, fetch: relay.fetch, log: quiet }), log: quiet });
    for (let i = 0; i < 3; i++) await watchdog.check();
    expect(relay.posted).toHaveLength(1);
    expect(relay.posted[0]?.body.text).toContain('answered 503');

    const closed = httpProbe('api /health', 'http://127.0.0.1:1/health');
    await expect(closed.run()).rejects.toThrow(/could not be reached/);
  });
});
