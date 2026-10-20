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
 *   - `arrange`   — FLR-T-18.8: multi-select on the Courtyard House — a crossing and a window marquee, ⇧-click,
 *                   ⌘D duplicating three chairs as one undo, an array of recessed lights; axe in both themes.
 *   - `placing`   — FLR-T-18.7: adding things on the Courtyard House — a sofa and a window dragged from the
 *                   library drawer, click-to-place turned with R, / quick add, the keyboard alone, a finger.
 *   - `rooms`     — FLR-T-18.10: rooms you can grab on the Courtyard House — the pantry's east edge dragged (resizeRoom,
 *                   Ops 4.4) and undone, ⌥→/⌥⇧→ and ↑ from the keys, its floor dragged (moveRoom), and a room made
 *                   with the magic wand, Tab cycling the spaces; axe in both themes.
 *   - `styles`    — FLR-T-18.5: plan styles on the Courtyard House — Colour by default, the style menu,
 *                   Construction's Technical and wall-type legend, details, exports only, a still, the render, axe.
 *   - `camera`    — FLR-T-13.10: the Camera panel — a saved view gone to, its lens and lens shift, a preset
 *                   lens, two-point off, exposure, a view saved, renamed and deleted as Ops — and a shot list.
 *   - `dimensions` — FLR-T-18.11: on the Courtyard House, exterior strings with no span under 6", room strings
 *                   and tags in Construction, the area summary, the show toggles and the schedule, the dimension
 *                   tool (⇧D) and its string following a moved window, a note with a leader (⇧T), picked and
 *                   deleted, and the measure tool's "Keep as a dimension"; axe in both themes.
 *   - `trace`     — FLR-T-18.12: the Courtyard House's main floor rendered as a blueprint PNG, imported as the
 *                   underlay of a blank project's Level 1, its scale set from two clicks and a typed 22',
 *                   moved by a point, the guest bedroom traced on it exactly; opacity, a turn, the lock, Ghost
 *                   and Off, a reload; Level 1 as Level 2's reference, snapped to and never picked; a PDF's
 *                   second page in its place; axe in both themes. Its own asset directory.
 *   - `feedback`  — FLR-T-18.14: live feedback on the Courtyard House — the island dragged towards the counter, its
 *                   working space's halo clear, then red with the card naming the counter, fps measured; the
 *                   history scrubber scrubbed back one version, restored as one new op, and branched; axe.
 *   - `precision` — FLR-T-18.9: on the Courtyard House, a door's temporary dimension typed (Tab: face, centre,
 *                   other face) as one moveOpening and one undo, the inspector's Position, the snap menu,
 *                   a measure chain closed on the kitchen's work triangle, ⌥ distances; axe in both themes.
 *   - `renovation` — FLR-T-18.13: renovation plans on a kitchen remodel of the Courtyard House — the Renovation
 *                   menu's Existing, Demolition, Proposed and Combined plans with their legend, two cabinets marked
 *                   "To demolish" as one batch and one undo, 3D, the plan render and the demolition PDF; axe.
 *   - `phrases`   — FLR-T-18.15: say it on the plan, on the Courtyard House — "push the island 6 inches north" from
 *                   the palette, ghosted with its cooktop and accepted as one op; a resize rejected with Esc; "add
 *                   a 36-inch door to the pantry" asking which wall, each lit as it is highlighted; axe in both themes.
 *   - `keys`      — FLR-T-18.16: the P18 editor without a pointer, on the Courtyard House — ? and its shortcut sheet,
 *                   the palette's keys, ⌥L's element list mirroring the plan (selection both ways, ghosts, ⌘A), Tab
 *                   to the island's handles (→ a 3″ module, ⇧ four, Enter to its width, the rotate handle), a room's
 *                   side, ⌥1–⌥7, the drawers in full screen; axe on each in both themes; the mode menu as each kind
 *                   of colour blindness sees it.
 *   - `section`   — FLR-T-14.6: the section box on the Courtyard House — opened from the Experiences cluster, its
 *                   cut capped and hatched (a probe of the caps' pixels), its east face dragged and nudged by the
 *                   keys, the plane, a PNG still; the exploded axonometric — levels and roof lifted under an
 *                   orthographic camera, leader labels, Space in and out (at once under reduced motion), an SVG
 *                   still; axe in both themes.
 *   - `films`     — FLR-T-14.1: on the Courtyard House with five saved views, Film… from the Camera panel, two views
 *                   added as keyframes (Ops on the document's extras), one dragged, nudged, eased linearly and held;
 *                   the film played with the 3D camera following; a draft rendered day to night as an MP4, its job
 *                   card counting frames, then playing and downloading it; axe in both themes. Needs ffmpeg.
 *   - `edit3d`    — FLR-T-14.8: edit in 3D on the Courtyard House — Edit on the Experiences cluster, the great room's
 *                   armchair dragged on its floor (moved without meshing again, a clearance tag) and dropped as one op,
 *                   undone from the toast; turned by its rotate handle with the keys and the pointer; a window slid
 *                   along its wall as one op; the tape measure between two floor points, its readout checked; axe in
 *                   both themes; what each drag move cost.
 *   - `compare`   — FLR-T-14.4: compare in 3D on the Courtyard House — an agent's "Bigger island" changeset as B beside
 *                   main, swiped from one camera (the divider dragged and moved by the keys) and side by side (cameras
 *                   linked, unlinked, linked), Flip, the B picker's groups, the Comparing panel, a matched pair rendered
 *                   on the job queue; axe in both themes.
 *   - `xray`      — FLR-T-14.5: X-ray on the Courtyard House (with a furnace and two terminals added) — the finishes
 *                   faded, every system drawn and counted, each switched off and on, ⌥X, Fade finishes by the keys,
 *                   the kitchen's north wall's studs, pipes and circuits, its layers in the inspector, "Section box
 *                   here" cutting the systems too; axe in both themes.
 *   - `daylight`  — FLR-T-14.7: daylight on the Courtyard House — Daylight on the Experiences cluster, Jun 21 and
 *                   Dec 21 at 3 pm (America/New_York): the four bands' legend, the advisory alert, the study
 *                   path-traced by the inline drain, glare flags at the den's desk and the primary bed, the overlay on
 *                   the plan with its chip, legend and June-against-December card; axe in both themes.
 *   - `tour`      — FLR-T-14.2: a virtual tour of the Courtyard House — Share ▸ Virtual tour…, three rooms as a small
 *                   draft (one from its saved view), the job card and its link; opened on a phone (iPhone 15) with no
 *                   account: dragged, a hotspot tapped into the next room, the map, the plan sheet's room list, the
 *                   arrow keys; axe in both themes; panoramas and screenshots in test-results/tour-*.
 *   - `xr`        — FLR-T-14.3: walk it in VR and place it on the lot in AR, on the Courtyard House — no "Enter VR"
 *                   without a headset; with a stand-in one (fixtures/webxr-mock.js: headless Chromium has no WebXR
 *                   device), the pill, its panel, a session from the entry, a look-and-pinch teleport, a level
 *                   switch and Exit VR; Export ▸ View in AR… at table and true scale (aligned, the scale in the
 *                   USDZ's metadata), its QR code and link opened on a phone; axe in both themes.
 *   - `seasons`   — FLR-T-15.4: seasons and weather on the Courtyard House — the Sky and sun panel's season and
 *                   weather tiles, the deciduous trees bare in winter and coloured in autumn, rain-wet and light
 *                   snow, "Follow the date", the studio as the Camera panel's backdrop, the saved views going to
 *                   their own skies and rendering the same, the model untouched; axe in both themes.
 *
 * Run with:
 *
 *   pnpm --filter @d3-floorspec/web e2e
 *
 * The database server defaults to the local test Postgres; E2E_DATABASE_URL points elsewhere (CI).
 * It names the keyboard suite's database; the others are derived from it (`…_main_test`,
 * `…_a11y_test`, `…_program_test`, `…_systems_test`, `…_findings_test`, `…_roofs_test`, `…_exports_test`, `…_options_test`, `…_three_test`, `…_share_test`, `…_assets_test`, `…_sun_test`, `…_package_test`, `…_furniture_test`, `…_templates_test`, `…_moonshots_test`, `…_arcs_test`, `…_lighting_test`, `…_materials_test`, `…_resize_test`, `…_drawers_test`, `…_presentation_test`, `…_panzoom_test`, `…_camera_test`, `…_modes_test`, `…_arrange_test`, `…_rooms_test`, `…_placing_test`, `…_precision_test`, `…_styles_test`, `…_feedback_test`, `…_trace_test`, `…_dimensions_test`, `…_renovation_test`, `…_phrases_test`, `…_keys_test`, `…_section_test`, `…_films_test`, `…_edit3d_test`, `…_compare_test`, `…_xray_test`, `…_daylight_test`, `…_tour_test`, `…_xr_test`, `…_seasons_test`). E2E_PORT is the keyboard suite's port; the others take the ports after it (modes, +26; arrange, +27; rooms, +31; placing, +33; precision, +34; styles, +37; dimensions, +41; trace, +42; renovation, +43; feedback, +46; phrases, +47; keys, +48; films, +49; section, +50; edit3d, +51; compare, +52; daylight, +53; xray, +54; tour, +55; xr, +56; seasons, +58).
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
  // FLR-T-18.8: multi-select and arrange — marquees, ⇧-click, duplicate as one undo, an array of lights, axe.
  { name: 'arrange', spec: 'arrange.spec.ts', port: PORT + 27, database: databaseFor('arrange'), setupToken: true },
  // FLR-T-18.10: rooms you can grab — an edge handle (resizeRoom), the keys, the floor dragged (moveRoom), the magic wand, axe.
  { name: 'rooms', spec: 'rooms.spec.ts', port: PORT + 31, database: databaseFor('rooms'), setupToken: true },
  // FLR-T-13.10: a camera for photographs — saved views, the lens, two-point, exposure, the frame, a shot list.
  { name: 'camera', spec: 'camera.spec.ts', port: PORT + 24, database: databaseFor('camera'), setupToken: true, gl: true },
  // FLR-T-18.3: the trade modes — switcher, ghosts, keys, palette, menu, own modes, full screen, render, PDF, axe.
  { name: 'modes', spec: 'modes.spec.ts', port: PORT + 26, database: databaseFor('modes'), setupToken: true },
  // FLR-T-18.7: adding things — a sofa and a window dragged in, click-to-place, R, quick add, keyboard, touch, axe.
  { name: 'placing', spec: 'placing.spec.ts', port: PORT + 33, database: databaseFor('placing'), setupToken: true },
  // FLR-T-18.9: precision — a temporary dimension typed, Tab's references, the snap menu, a measure chain, ⌥ distances, axe.
  { name: 'precision', spec: 'precision.spec.ts', port: PORT + 34, database: databaseFor('precision'), setupToken: true },
  // FLR-T-18.5: plan styles — Colour by default, the menu, Construction's Technical and legend, details, a still, the render, axe.
  { name: 'styles', spec: 'styles.spec.ts', port: PORT + 37, database: databaseFor('styles'), setupToken: true },
  // FLR-T-18.11: dimensions and annotation — auto strings, the dimension tool, tags and the schedule, areas, notes, axe.
  { name: 'dimensions', spec: 'dimensions.spec.ts', port: PORT + 41, database: databaseFor('dimensions'), setupToken: true },
  // FLR-T-18.12: trace and reference — a rendered plan as an underlay, its scale set, moved, a room traced on it; the level below as a reference; a PDF page.
  { name: 'trace', spec: 'trace.spec.ts', port: PORT + 42, database: databaseFor('trace'), setupToken: true, env: { ASSET_DIR: join(tmpdir(), 'floorspec-e2e-trace-assets') } },
  // FLR-T-18.14: live feedback — clearance halos while dragging the island, fps, the history scrubber back one version, restore, branch, axe.
  { name: 'feedback', spec: 'feedback.spec.ts', port: PORT + 46, database: databaseFor('feedback'), setupToken: true },
  // FLR-T-18.13: renovation plans — Existing, Demolition, Proposed, Combined in plan and 3D, statuses from the inspector, the render, a PDF, axe.
  { name: 'renovation', spec: 'renovation.spec.ts', port: PORT + 43, database: databaseFor('renovation'), setupToken: true, gl: true },
  // FLR-T-18.15: say it on the plan — a phrase from the palette and ⌘/ previewed as a ghost, accepted as one op, rejected, a wall asked about.
  { name: 'phrases', spec: 'phrases.spec.ts', port: PORT + 47, database: databaseFor('phrases'), setupToken: true },
  // FLR-T-18.16: the P18 editor by keyboard and assistive technology — ?, the element list, handles, drawers, modes, axe.
  { name: 'keys', spec: 'keys.spec.ts', port: PORT + 48, database: databaseFor('keys'), setupToken: true },
  // FLR-T-14.1: films — keyframes from saved views, eased and held, played in 3D, rendered day to night as an MP4 (ffmpeg on the host).
  { name: 'films', spec: 'films.spec.ts', port: PORT + 49, database: databaseFor('films'), setupToken: true, gl: true },
  // FLR-T-14.6: the section box and plane, capped and hatched cuts, handles by pointer and keys, the exploded axonometric, stills, axe.
  { name: 'section', spec: 'section.spec.ts', port: PORT + 50, database: databaseFor('section'), setupToken: true, gl: true },
  // FLR-T-14.8: edit in 3D — an armchair dragged and turned, a window slid, each one op with undo; the tape measure; axe.
  { name: 'edit3d', spec: 'edit3d.spec.ts', port: PORT + 51, database: databaseFor('edit3d'), setupToken: true, gl: true },
  // FLR-T-14.4: compare in 3D — main and a changeset swiped and side by side from one camera, the B picker, a matched pair, axe.
  { name: 'compare', spec: 'compare.spec.ts', port: PORT + 52, database: databaseFor('compare'), setupToken: true, gl: true },
  // FLR-T-14.5: X-ray — the finishes faded, each system drawn and toggled, the kitchen wall's studs, pipes and circuits, a section box into it, axe.
  { name: 'xray', spec: 'xray.spec.ts', port: PORT + 54, database: databaseFor('xray'), setupToken: true, gl: true },
  // FLR-T-14.7: daylight — Jun 21 and Dec 21 at 3 pm on the Courtyard House: the bands, the advisory, glare at the den's desk and the primary bed, the plan, axe.
  { name: 'daylight', spec: 'daylight.spec.ts', port: PORT + 53, database: databaseFor('daylight'), setupToken: true, gl: true },
  // FLR-T-14.2: a virtual tour — made in the editor, rendered on the inline drain, walked on a phone with no account.
  { name: 'tour', spec: 'tour.spec.ts', port: PORT + 55, database: databaseFor('tour'), setupToken: true, gl: true },
  // FLR-T-14.3: walk it in VR (a stand-in headset, fixtures/webxr-mock.js) and the USDZ for AR Quick Look at two scales, sent to a phone.
  { name: 'xr', spec: 'xr.spec.ts', port: PORT + 56, database: databaseFor('xr'), setupToken: true, gl: true },
  // FLR-T-15.4: seasons and weather on the Courtyard House — foliage through the year, rain and snow, the studio a backdrop, the model untouched.
  { name: 'seasons', spec: 'seasons.spec.ts', port: PORT + 58, database: databaseFor('seasons'), setupToken: true, gl: true },
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
