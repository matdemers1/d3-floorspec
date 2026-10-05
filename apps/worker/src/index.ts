import { beat } from './heartbeat.js';
import { createDrain, type Drain } from './queue/index.js';

/**
 * The job-queue drain. Exports (PDF and DXF drawings, FLR-T-9.3) arrive on the Postgres queue the
 * api writes; the heartbeat file keeps the image's healthcheck honest about a hung process.
 */
const TICK_MS = 30_000;

async function tick(): Promise<void> {
  await beat();
}

await tick();
const timer = setInterval(() => {
  tick().catch((error: unknown) => {
    process.stderr.write(`worker tick failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}, TICK_MS);

const databaseUrl = process.env['DATABASE_URL'];
let drain: Drain | null = null;
if (databaseUrl === undefined || databaseUrl === '') {
  process.stdout.write('d3-floorspec worker started without DATABASE_URL: no jobs are drained\n');
} else {
  drain = createDrain({ databaseUrl });
  await drain.start();
  process.stdout.write('d3-floorspec worker started: draining export.pdf and export.dxf jobs\n');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    void (drain?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
