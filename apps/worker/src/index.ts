import { beat } from './heartbeat.js';

/**
 * The job-queue drain. Render-back, PDF/DXF/glTF/USDZ exports and the IFC hand-off arrive in later
 * phases; in Phase 0 the process exists so the stack, its image and its healthcheck are real.
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

process.stdout.write('d3-floorspec worker started; no job kinds are registered yet\n');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    process.exit(0);
  });
}
