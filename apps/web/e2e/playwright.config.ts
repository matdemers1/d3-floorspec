import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * The editor's end-to-end tests (FLR-T-3.7). One API process, serving the built editor the way the
 * image does (WEB_DIST), against a database whose name ends in `_test` that is dropped and created
 * fresh for every run — the server migrates it on boot. Run with:
 *
 *   pnpm --filter @d3-floorspec/web e2e
 *
 * The database server defaults to the local test Postgres; E2E_DATABASE_URL points elsewhere (CI).
 */

const PORT = Number(process.env['E2E_PORT'] ?? 3491);
const DATABASE_URL = process.env['E2E_DATABASE_URL'] ?? 'postgresql://floorspec:floorspec@127.0.0.1:55433/floorspec_e2e_test';
const web = fileURLToPath(new URL('../', import.meta.url));
const server = fileURLToPath(new URL('../../server/', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  outputDir: '../test-results',
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    // Reset the database, then boot the API on it: it migrates, and serves the built editor.
    command: `node ${web}e2e/reset-db.mjs && node --import tsx src/index.ts`,
    cwd: server,
    url: `http://localhost:${String(PORT)}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      DATABASE_URL,
      PORT: String(PORT),
      PUBLIC_URL: `http://localhost:${String(PORT)}`,
      WEB_DIST: `${web}dist`,
      // Fresh secrets per run: nothing outlives the run that needs them.
      KEK: randomBytes(32).toString('base64'),
      PEPPER: randomBytes(32).toString('base64'),
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
    },
  },
});
