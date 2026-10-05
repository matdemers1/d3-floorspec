import pg from 'pg';
import { createMailer, createWatchdog, describeRelay, httpProbe, pgAlertLedger, pgProbe, relayFromEnv, urlPassword, type Probe } from './alerts/index.js';
import { beat } from './heartbeat.js';
import { createDrain, type Drain } from './queue/index.js';

/**
 * The job-queue drain. Exports (PDF and DXF drawings, FLR-T-9.3) arrive on the Postgres queue the
 * api writes; the heartbeat file keeps the image's healthcheck honest about a hung process.
 *
 * And the health watchdog (FLR-T-12.2): the api's `/health` and the database, probed every
 * `WATCHDOG_INTERVAL_MS`, with an email to the operator after `WATCHDOG_THRESHOLD` failures in a
 * row. It lives here because an api that is down cannot report itself down.
 */
const TICK_MS = 30_000;
const env = process.env;

async function tick(): Promise<void> {
  await beat();
}

await tick();
const timer = setInterval(() => {
  tick().catch((error: unknown) => {
    process.stderr.write(`worker tick failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}, TICK_MS);

const databaseUrl = env['DATABASE_URL'] === '' ? undefined : env['DATABASE_URL'];
const watchPool = databaseUrl === undefined ? null : new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
// Errors on an idle connection are the database going away, which the probe reports; they must not
// crash the process that is meant to notice.
watchPool?.on('error', () => undefined);

const relay = relayFromEnv(env);
const relayLine = describeRelay(relay);
process.stdout.write(`${relayLine.message}\n`);
const mailer = createMailer({
  relay: relay.relay,
  ...(env['PUBLIC_URL'] === undefined ? {} : { appUrl: env['PUBLIC_URL'] }),
  ledger: watchPool === null ? null : pgAlertLedger(watchPool),
  secrets: [urlPassword(databaseUrl), env['KEK'], env['PEPPER'], env['D3AUTH_CLIENT_SECRET']],
});

// The api's address on the compose network. Empty turns the api probe off (development, where no
// api runs beside the worker).
const healthUrl = env['HEALTH_URL'] ?? (env['NODE_ENV'] === 'production' ? 'http://api:3400/health' : '');
const probes: Probe[] = [
  ...(healthUrl === '' ? [] : [httpProbe('api /health', healthUrl)]),
  ...(watchPool === null ? [] : [pgProbe('database', watchPool)]),
];
const watchdog = createWatchdog({
  probes,
  mailer,
  threshold: Math.max(1, Number(env['WATCHDOG_THRESHOLD'] ?? 3) || 3),
});
const watchEvery = Math.max(5_000, Number(env['WATCHDOG_INTERVAL_MS'] ?? 60_000) || 60_000);
const watchTimer = probes.length === 0 ? null : setInterval(() => {
  watchdog.check().catch((error: unknown) => {
    process.stderr.write(`watchdog check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}, watchEvery);
process.stdout.write(
  probes.length === 0
    ? 'watchdog: nothing to probe (no HEALTH_URL and no DATABASE_URL)\n'
    : `watchdog: probing ${probes.map((p) => p.name).join(' and ')} every ${String(watchEvery / 1000)}s\n`,
);

let drain: Drain | null = null;
let drainRetry: NodeJS.Timeout | null = null;
/** A database that is not answering yet is retried, not fatal: the watchdog must keep running. */
function startDrain(url: string): void {
  const candidate = createDrain({ databaseUrl: url });
  candidate.start().then(
    () => {
      drain = candidate;
      process.stdout.write('d3-floorspec worker started: draining export.pdf and export.dxf jobs\n');
    },
    (error: unknown) => {
      process.stderr.write(`job drain did not start (${error instanceof Error ? error.message : String(error)}); retrying in 30s\n`);
      void candidate.stop().catch(() => undefined);
      drainRetry = setTimeout(() => { startDrain(url); }, 30_000);
    },
  );
}
if (databaseUrl === undefined) {
  process.stdout.write('d3-floorspec worker started without DATABASE_URL: no jobs are drained\n');
} else {
  startDrain(databaseUrl);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    if (watchTimer !== null) clearInterval(watchTimer);
    if (drainRetry !== null) clearTimeout(drainRetry);
    void (drain?.stop() ?? Promise.resolve())
      .then(() => watchPool?.end())
      .finally(() => process.exit(0));
  });
}
