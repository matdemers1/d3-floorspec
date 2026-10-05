import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canonicalize } from '@floorspec/engine';
import { firstRunSetup, modelOf, password, projectIn, settled } from './support.js';

/**
 * FLR-T-4.5: the standard's starter templates — the ranch, the two-storey house and the cabin —
 * offered on the projects screen with a plan of each, and a project made from each: the server holds
 * the template exactly (as Floorspec Ops, FLR-ADR-008), and the editor's plan, its 3D view and the
 * schedules open it without an error. WebGL through SwiftShader (playwright.config.ts).
 */

/** The 3D view's test hook (src/editor/three/ThreeView.tsx), present under automation only; three.spec.ts declares it in full. */
type Hooked = { __floorspec3d?: { ready: boolean; parts: number } };

const TEMPLATES = [
  { id: 'ranch', name: 'Ranch', levels: ['Main floor'], rooms: 16 },
  { id: 'two-storey', name: 'Two-storey house', levels: ['Main floor', 'Upper floor'], rooms: 19 },
  { id: 'cabin', name: 'Cabin', levels: ['Main floor', 'Loft'], rooms: 6 },
] as const;

const fileOf = (id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../packages/engine/standard/templates/${id}.floorspec.json`, import.meta.url), 'utf8')) as Record<string, unknown>;

/** Errors the page itself reports: an uncaught exception or a console error. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

test('a project from each starter template: held exactly, drawn in plan and 3D, scheduled', async ({ page }) => {
  test.setTimeout(240_000);
  await firstRunSetup(page, { name: 'Templates', email: 'templates@example.test', password: password('templates') });
  // Watched once signed in: before that, the app's session check is answered 401 by design.
  const errors = watchErrors(page);
  await page.getByRole('button', { name: 'New project' }).first().click();
  const blank = page.getByRole('dialog', { name: 'New project' });
  await blank.getByLabel('Name').fill('First house');
  await blank.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);

  for (const t of TEMPLATES) {
    await page.goto('/projects');
    const section = page.getByRole('region', { name: 'Start from a template' });
    await expect(section).toBeVisible();
    // Each house's card shows its plan, drawn from what the engine derived.
    await expect(section.getByRole('img', { name: 'Floor plan' })).toHaveCount(4);
    if (t.id === 'ranch') await section.screenshot({ path: 'test-results/templates-cards.png' });
    await section.getByText(t.name, { exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `New project from ${t.name}` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
    const project = projectIn(page.url());
    await expect(page.getByRole('heading', { name: t.name, level: 1 })).toBeVisible();

    // The server holds the template, byte for byte in canonical form, under the project's name.
    const template = fileOf(t.id);
    const held = await modelOf(page, project);
    expect(canonicalize(held)).toBe(canonicalize({ ...template, project: { ...(template['project'] as object), name: t.name } }));

    // The plan editor opens on the lowest level, with every level to pick.
    await page.goto(`/projects/${project}/editor`);
    await settled(page);
    const levels = page.getByRole('combobox', { name: 'Level' });
    await expect(levels).toContainText(t.levels[0]);
    await expect(page.getByRole('application', { name: /^Plan of / })).toBeVisible();
    if (t.levels.length > 1) {
      await levels.click();
      for (const name of t.levels) await expect(page.getByRole('option', { name: new RegExp(name) })).toBeVisible();
      await page.keyboard.press('Escape');
    }

    // The 3D view meshes the whole house.
    await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '3D' }).click();
    await expect(page).toHaveURL(/[?&]view=3d\b/);
    await page.waitForFunction(() => (window as unknown as Hooked).__floorspec3d?.ready === true, undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => (window as unknown as Hooked).__floorspec3d?.parts ?? 0)).toBeGreaterThan(t.rooms);
    // The whole house, roof on, as a person sees it first.
    await page.getByRole('button', { name: /^Cutaway · / }).click();
    await expect(page.getByRole('button', { name: 'Whole house' })).toHaveAttribute('aria-pressed', 'false');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/templates-${t.id}-3d.png` });

    // The schedules: the plumbing fixtures the template places.
    await page.goto(`/projects/${project}/schedules`);
    await expect(page.getByRole('heading', { name: 'Schedules', level: 1 })).toBeVisible();
    await page.getByRole('tab', { name: /^Fixtures/ }).click();
    await expect(page.getByRole('tabpanel')).toContainText('Kitchen sink');
  }
  expect(errors).toEqual([]);
});
