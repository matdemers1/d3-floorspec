import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 *   - `options`   — FLR-T-8.4, 8.1: an option set drawn, compared side by side and switched; a backsplash region.
 *   - `three`     — FLR-T-7.5: the P7 exit demo — the 3D view, split view with synced selection, and a
 *                   walkthrough up an L stair under a hip roof. WebGL through SwiftShader (see GL_ARGS).
 *   - `share`     — FLR-T-9.6: a share link made, opened with no account (plan, 3D, findings), a comment
 *                   pinned to a wall by an invited account, seen live and resolved by the owner, revoked.
 *   - `assets`    — FLR-T-8.2: a tile photo dropped in, calibrated to 12", applied to a backsplash
 *                   region and drawn in 3D; the asset store on a directory of its own (ASSET_DIR).
 *   - `sun`       — FLR-T-8.6: the sun and shadow study — the site placed through the panel, a date and
 *                   a time, the light three.js draws checked against the solar module, night, play.
 *   - `package`   — FLR-T-9.1: a textured kitchen exported as a .floorspec package and imported as a
 *                   new project, its texture drawn in 3D; axe on the import dialog.
 *   - `furniture` — FLR-T-8.3: the P8 fridge — placed from the library with its door's clearance,
 *                   an island in its way as a note, its glTF model in 3D, undo.
 *   - `templates` — FLR-T-4.5: a project from each of the standard's starter templates, held exactly,
 *                   opened in the plan, in 3D and in the schedules.
 *   - `moonshots` — FLR-T-12.6: the ranch's advisory energy estimate, its climate changed through Ops,
 *                   and a path-traced still of its 3D view rendered on the job queue.
 *   - `materials` — FLR-T-13.6: a library material added with its maps uploaded, a kitchen floor finished
 *                   in it and turned 90°, and the 3D view drawing it at its real size; FLR-T-13.17: every
 *                   lamp on over textured materials, every shader program linked within 16 texture units.
 *   - `arcs`      — FLR-T-11.1: an arc wall drawn by keyboard (Core 0.4, chapter 21), the curved room it
 *                   closes with its area, the arc wall's inspector, and the curved wall in 3D.
 *   - `resize`    — FLR-T-18.4: the Courtyard House's island made 10 ft long (resizeElement, Ops 0.4), its
 *                   cooktop kept at its middle, a handle dragged to the 3" module, a turn in 15° steps, 3D.
 *   - `drawers`   — FLR-T-18.2: full screen and the edge drawers — the hot zones' peek, open and leave,
 *                   pins, the shortcuts and F6, a touch swipe, reduced motion, the 3D and split views,
 *                   axe in both themes.
 *   - `modes`     — FLR-T-18.3: the trade modes on the Courtyard House — the switcher, ghosts not picked,
 *                   ⌥1–⌥7, the palette, the mode menu, a mode of one's own, full screen, render and PDF, axe.
 *   - `presentation` — FLR-T-13.7: the 3D view's Presentation quality chosen from the chips, every pass
 *                   drawn, the same exposure as Draft, every program linked within 16 texture units.
 *   - `panzoom`   — FLR-T-18.6: pan and zoom on the Courtyard House — ⇧1/⇧2/⇧0 animated (and at once
 *                   under reduced motion), the editable zoom, the wheel setting, the hand, double click,
 *                   the minimap, saved views, and the tree, the palette and a proposal moving the view.
 *
 * Run with:
 *
 *   pnpm --filter @d3-floorspec/web e2e
 *
 * The database server defaults to the local test Postgres; E2E_DATABASE_URL points elsewhere (CI).
 * It names the keyboard suite's database; the others are derived from it (`…_main_test`,
 * `…_a11y_test`, `…_program_test`, `…_systems_test`, `…_findings_test`, `…_roofs_test`, `…_exports_test`, `…_options_test`, `…_three_test`, `…_share_test`, `…_assets_test`, `…_sun_test`, `…_package_test`, `…_furniture_test`, `…_templates_test`, `…_moonshots_test`, `…_arcs_test`, `…_lighting_test`, `…_materials_test`, `…_resize_test`, `…_drawers_test`, `…_presentation_test`, `…_panzoom_test`, `…_modes_test`). E2E_PORT is the keyboard suite's port; the others take the ports after it (modes, +26).
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
  { name: 'roofs-stairs', spec: 'roofs-stairs.spec.ts', port: PORT + 6, database: databaseFor('roofs'), setupToken: true, gl: true },
  { name: 'exports', spec: 'exports.spec.ts', port: PORT + 7, database: databaseFor('exports'), setupToken: true },
  { name: 'options', spec: 'options.spec.ts', port: PORT + 8, database: databaseFor('options'), setupToken: true },
  { name: 'three', spec: 'three.spec.ts', port: PORT + 9, database: databaseFor('three'), setupToken: true, gl: true },
  // FLR-T-9.6: share links, the shared viewer (plan, 3D, findings — so packs installed and WebGL) and comments.
  { name: 'share', spec: 'share.spec.ts', port: PORT + 10, database: databaseFor('share'), setupToken: true, gl: true, env: { RULE_PACKS_DIR: `${web}e2e/fixtures/rule-packs` } },
  // Content-addressed, so a directory shared across runs only ever holds the same bytes under the same names.
  { name: 'assets', spec: 'assets.spec.ts', port: PORT + 11, database: databaseFor('assets'), setupToken: true, gl: true, env: { ASSET_DIR: join(tmpdir(), 'floorspec-e2e-assets') } },
  // FLR-T-8.6: the sun and shadow study — a site placed, a date and time, the light and its shadows checked.
  { name: 'sun', spec: 'sun.spec.ts', port: PORT + 12, database: databaseFor('sun'), setupToken: true, gl: true },
  // FLR-T-9.1: export a package, import it as a new project, the texture in 3D.
  { name: 'package', spec: 'package.spec.ts', port: PORT + 13, database: databaseFor('package'), setupToken: true, gl: true, env: { ASSET_DIR: join(tmpdir(), 'floorspec-e2e-package-assets') } },
  // FLR-T-8.3: a library refrigerator placed, its door's clearance, an island in its way, its model in 3D.
  { name: 'furniture', spec: 'furniture.spec.ts', port: PORT + 14, database: databaseFor('furniture'), setupToken: true, gl: true, env: { ASSET_DIR: join(tmpdir(), 'floorspec-e2e-furniture-assets') } },
  // FLR-T-4.5: the starter templates, each made a project and opened in the plan, 3D and the schedules.
  { name: 'templates', spec: 'templates.spec.ts', port: PORT + 15, database: databaseFor('templates'), setupToken: true, gl: true },
  // FLR-T-12.6: the advisory energy estimate of a template, its climate changed, and a path-traced still.
  { name: 'moonshots', spec: 'moonshots.spec.ts', port: PORT + 16, database: databaseFor('moonshots'), setupToken: true, gl: true },
  // FLR-T-11.1: an arc wall drawn by keyboard, the curved room it closes and its area, and the wall in 3D.
  { name: 'arcs', spec: 'arcs.spec.ts', port: PORT + 17, database: databaseFor('arcs'), setupToken: true, gl: true },
  // FLR-T-13.12: lighting design in 3D — a switch clicked, scenes chosen, a dimmer, scenes saved as Ops.
  { name: 'lighting', spec: 'lighting.spec.ts', port: PORT + 18, database: databaseFor('lighting'), setupToken: true, gl: true },
  // FLR-T-13.6: a library material added with its maps, a floor finished in it, turned, drawn in 3D at its real size.
  { name: 'materials', spec: 'materials.spec.ts', port: PORT + 19, database: databaseFor('materials'), setupToken: true, gl: true, env: { ASSET_DIR: join(tmpdir(), 'floorspec-e2e-materials-assets') } },
  // FLR-T-18.4: the Courtyard House island resized — typed, by a handle, turned — and drawn in 3D.
  { name: 'resize', spec: 'resize.spec.ts', port: PORT + 20, database: databaseFor('resize'), setupToken: true, gl: true },
  // FLR-T-18.2: full screen and the edge drawers — hot zones, pins, keys, touch, reduced motion, 3D and split, axe.
  { name: 'drawers', spec: 'drawers.spec.ts', port: PORT + 21, database: databaseFor('drawers'), setupToken: true, gl: true },
  // FLR-T-13.7: Presentation quality — its passes, its exposure against Draft's, its texture units with every lamp on.
  { name: 'presentation', spec: 'presentation.spec.ts', port: PORT + 22, database: databaseFor('presentation'), setupToken: true, gl: true },
  // FLR-T-18.6: pan and zoom — keys, animation, the editable zoom, the wheel, the hand, the minimap, saved views, go-to.
  { name: 'panzoom', spec: 'panzoom.spec.ts', port: PORT + 23, database: databaseFor('panzoom'), setupToken: true },
  // FLR-T-18.3: the trade modes — switcher, ghosts, keys, palette, menu, own modes, full screen, render, PDF, axe.
  { name: 'modes', spec: 'modes.spec.ts', port: PORT + 26, database: databaseFor('modes'), setupToken: true },
];

/**
 * CI splits the suites across runners (`E2E_SUITES=a11y` on one, `three,sun,…` on another): a runner
 * boots the servers of, and runs, only its own. Unset, every suite runs.
 */
const only = (process.env['E2E_SUITES'] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
const unknown = only.filter((name) => !SUITES.some((suite) => suite.name === name));
if (unknown.length > 0) throw new Error(`E2E_SUITES names no suite: ${unknown.join(', ')}`);
const RUN = only.length === 0 ? SUITES : SUITES.filter((suite) => only.includes(suite.name));

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
  projects: RUN.map((suite) => ({
    name: suite.name,
    testMatch: suite.spec,
    use: { baseURL: origin(suite.port), ...(suite.gl === true ? { launchOptions: { args: GL_ARGS } } : {}) },
  })),
  webServer: RUN.map((suite) => ({
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
      // E2E_WEB_DIST: a copy of the build outside any dot directory — express will not send a file
      // under one, so a checkout in a worktree under .claude/ serves its editor from a copy.
      WEB_DIST: process.env['E2E_WEB_DIST'] ?? `${web}dist`,
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
