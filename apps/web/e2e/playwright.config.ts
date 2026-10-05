import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * The editor's end-to-end tests (FLR-T-3.7, FLR-T-3.9). Each suite gets an API process of its own,
 * serving the built editor the way the image does (WEB_DIST), against a database of its own whose
 * name ends in `_test` and which is dropped and created fresh for every run — the server migrates
 * it on boot. So every suite starts from first-run setup, and no suite's data leaks into another's.
 *
 *   - `keyboard`  — FLR-T-3.7: the editor driven without a pointer.
 *   - `main-path` — FLR-T-3.9: the P3 exit demo, setup to a compared undo, with the setup token gate.
 *   - `a11y`      — FLR-T-3.9: axe on every screen and significant state, in both themes.
 *   - `program`   — FLR-T-4.2, 4.3: the P4 exit demo, a brief to an accepted layout that meets it.
 *   - `systems`   — FLR-T-5.7, 5.8: the P5 exit demo, devices and circuits to a moved wall and schedules.
 *   - `findings`  — FLR-T-6.8, 6.9: with synthetic rule packs installed (e2e/fixtures/rule-packs), a
 *                   profile built and chosen, the findings report, the plan overlay and the notice.
 *   - `roofs-stairs` — FLR-T-7.2, 7.3: a hip roof over the walls and an L stair, checked through model.json.
 *   - `exports`   — FLR-T-9.3: a PDF sheet per level and DXF drawings, from the editor and the dashboard.
 *   - `three`     — FLR-T-7.5: the P7 exit demo — the 3D view, split view with synced selection, and a
 *                   walkthrough up an L stair under a hip roof. WebGL through SwiftShader (see GL_ARGS).
 *
 * Run with:
 *
 *   pnpm --filter @d3-floorspec/web e2e
 *
 * The database server defaults to the local test Postgres; E2E_DATABASE_URL points elsewhere (CI).
 * It names the keyboard suite's database; the others are derived from it (`…_main_test`,
 * `…_a11y_test`, `…_program_test`, `…_systems_test`, `…_findings_test`, `…_roofs_test`, `…_exports_test`, `…_three_test`). E2E_PORT is the keyboard suite's port; the others take the next eight.
 */

const PORT = Number(process.env['E2E_PORT'] ?? 3491);
const DATABASE_URL = process.env['E2E_DATABASE_URL'] ?? 'postgresql://floorspec:floorspec@127.0.0.1:55433/floorspec_e2e_test';
const web = fileURLToPath(new URL('../', import.meta.url));
const server = fileURLToPath(new URL('../../server/', import.meta.url));

// The first-run setup token the gated suites' servers require. Set in the runner's environment so
// the workers — which load this file again, and inherit that environment — see the same value.
process.env['E2E_SETUP_TOKEN'] ??= randomBytes(24).toString('base64url');
const SETUP_TOKEN = process.env['E2E_SETUP_TOKEN'];

/** The keyboard suite's database URL with the name's `_test` suffix turned into `_<suite>_test`. */
function databaseFor(suite: string | null): string {
  if (suite === null) return DATABASE_URL;
  const url = new URL(DATABASE_URL);
  url.pathname = url.pathname.replace(/_test$/, `_${suite}_test`);
  return url.toString();
}

interface Suite {
  name: string;
  spec: string;
  port: number;
  database: string;
  setupToken: boolean;
  /** More of the server's environment. */
  env?: Record<string, string>;
  /** Draws WebGL (the 3D view): Chromium is started with a software GPU. */
  gl?: boolean;
}

/**
 * Headless Chromium has no GPU; SwiftShader draws WebGL in software. Recent Chromium no longer
 * falls back to it for WebGL on its own, so the suites that open the 3D view ask for it.
 */
const GL_ARGS = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];

const SUITES: Suite[] = [
  { name: 'keyboard', spec: 'keyboard.spec.ts', port: PORT, database: databaseFor(null), setupToken: false },
  { name: 'main-path', spec: 'main-path.spec.ts', port: PORT + 1, database: databaseFor('main'), setupToken: true },
  { name: 'a11y', spec: 'a11y.spec.ts', port: PORT + 2, database: databaseFor('a11y'), setupToken: true, gl: true },
  { name: 'program', spec: 'program.spec.ts', port: PORT + 3, database: databaseFor('program'), setupToken: true },
  { name: 'systems', spec: 'systems.spec.ts', port: PORT + 4, database: databaseFor('systems'), setupToken: true },
  // The only suite with rule packs installed: the standard's synthetic example pack and an e2e pack.
  { name: 'findings', spec: 'findings.spec.ts', port: PORT + 5, database: databaseFor('findings'), setupToken: true, env: { RULE_PACKS_DIR: `${web}e2e/fixtures/rule-packs` } },
  { name: 'roofs-stairs', spec: 'roofs-stairs.spec.ts', port: PORT + 6, database: databaseFor('roofs'), setupToken: true },
  { name: 'exports', spec: 'exports.spec.ts', port: PORT + 7, database: databaseFor('exports'), setupToken: true },
  { name: 'three', spec: 'three.spec.ts', port: PORT + 8, database: databaseFor('three'), setupToken: true, gl: true },
];

const origin = (port: number) => `http://localhost:${String(port)}`;

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  outputDir: '../test-results',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: SUITES.map((suite) => ({
    name: suite.name,
    testMatch: suite.spec,
    use: { baseURL: origin(suite.port), ...(suite.gl === true ? { launchOptions: { args: GL_ARGS } } : {}) },
  })),
  webServer: SUITES.map((suite) => ({
    // Reset the database, then boot the API on it: it migrates, and serves the built editor.
    command: `node ${web}e2e/reset-db.mjs && node --import tsx src/index.ts`,
    cwd: server,
    url: `${origin(suite.port)}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore' as const,
    stderr: 'pipe' as const,
    env: {
      DATABASE_URL: suite.database,
      PORT: String(suite.port),
      PUBLIC_URL: origin(suite.port),
      WEB_DIST: `${web}dist`,
      // Fresh secrets per run: nothing outlives the run that needs them.
      KEK: randomBytes(32).toString('base64'),
      PEPPER: randomBytes(32).toString('base64'),
      ...(suite.setupToken ? { SETUP_TOKEN } : {}),
      ...suite.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
    },
  })),
});
