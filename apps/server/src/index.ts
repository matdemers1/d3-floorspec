import { migrate } from './boot.js';
import { ConfigError, loadConfig } from './config.js';
import { createApp } from './app.js';
import { opsApplier } from './ops/applier.js';
import { createOidcClient } from './auth/oidc.js';
import { createDb } from './db.js';
import { logger } from './logger.js';
import { workerRenderer } from './render.js';

/** Entry point. A misconfigured instance exits here, naming what is wrong. */
const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write('d3-floorspec api refused to start:\n');
      for (const problem of error.problems) process.stderr.write(`  - ${problem}\n`);
      process.exit(1);
    }
    throw error;
  }
})();

await migrate(config);
const db = createDb(config.DATABASE_URL);
// Discovery is attempted once and allowed to fail: an unreachable D3 Auth means one sign-in button
// instead of two, never an api that will not start.
const oidc = await createOidcClient(config);
// Plans are drawn in-process by the worker's renderer until the worker has a job queue (FLR-T-2.8).
const app = createApp({ config, db, oidc, renderer: workerRenderer(), applier: opsApplier });

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, publicUrl: config.PUBLIC_URL, oidcConfigured: config.oidcConfigured, oidcReachable: oidc !== null },
    'd3-floorspec api listening',
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void db.$disconnect().then(() => process.exit(0));
    });
  });
}
