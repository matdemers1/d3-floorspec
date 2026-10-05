import { readFileSync } from 'node:fs';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { firstRunSetup, password, projectIn } from './support.js';

/**
 * FLR-T-6.8 and FLR-T-6.9 end to end, against a server with rule packs installed
 * (e2e/fixtures/rule-packs: the standard's synthetic example pack and `e2e-overlays`, whose rules
 * cite only the made-up codes TEST-CODE 2024 and TEST-ELEC 2026). The house is the Rules
 * conformance suite's Phase 6 demo (examples/002): a boiler in the panel's working space, a
 * bedroom with no window, and long runs of wall between receptacles.
 *
 *   1. Under the default profile, "Model Codes (latest)", no installed rule is in force: the
 *      dashboard, the report and the editor say nothing was checked — never that anything passed.
 *   2. A profile adopting the synthetic editions is built in the profile builder and chosen for the
 *      project: the findings appear, by severity, by room and by code, each with its edition.
 *   3. The plan draws them: the working space hatched, the boiler in it, the receptacle runs.
 *   4. Changing the profile changes the set — from the report, and live in the open editor.
 *   5. The notice and the coverage link are on every one of those surfaces, and in the CSV export.
 * Each state is checked with axe in both themes.
 */

const HOUSE = new URL('./fixtures/p6-demo-house.json', import.meta.url).pathname;
const NOTICE = 'Floorspec findings are advisory. They are not a plan review, and the authority having jurisdiction decides.';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** axe in both themes: zero violations is the bar, as in a11y.spec.ts. */
async function axe(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html'), `${state}: the ${theme} theme rendered`).toHaveAttribute('data-theme', theme);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect?.getComputedTiming().iterations ?? 1) === Infinity), undefined, { timeout: 5_000 }).catch(() => undefined);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const said = results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    expect.soft(said, `${state} (${theme})`).toEqual([]);
  }
}

/** The notice, exactly, and the link to the coverage matrix, inside `scope`. */
async function noticeIn(scope: Locator): Promise<void> {
  const notice = scope.getByTestId('findings-notice').first();
  await expect(notice).toContainText(NOTICE);
  await expect(notice.getByRole('link', { name: 'What the installed rule packs check, and what they do not' })).toHaveAttribute('href', '/rule-packs');
}

async function choose(page: Page, combobox: Locator, option: string): Promise<void> {
  await combobox.click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('findings follow the jurisdiction profile, drawn on the plan, with the notice everywhere', async ({ page }) => {
  await firstRunSetup(page, { name: 'Code Checker', email: 'codes@example.test', password: password('codes') });

  // The Phase 6 demo house, imported through the projects screen like any Floorspec file.
  await page.getByRole('button', { name: 'Check a Floorspec file' }).click();
  await page.locator('input[type="file"]').setInputFiles(HOUSE);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const id = projectIn(page.url());

  // ── 1. The default profile: no installed rule is in force, and every surface says so.
  await page.goto(`/projects/${id}`);
  const card = page.locator('[data-region="findings"]');
  await expect(card).toContainText('No installed rule is in force under Model Codes (latest)');
  await noticeIn(card);
  await axe(page, 'dashboard, packs installed, none in force');

  await page.goto(`/projects/${id}/findings`);
  await expect(page.getByRole('heading', { name: 'No installed rule is in force under Model Codes (latest)' })).toBeVisible();
  await noticeIn(page.locator('main'));
  await expect(page.locator('body')).not.toContainText(/\bcomplian|\bcomplies\b|passes code/i);

  // ── 2. Build a profile adopting the synthetic editions, and use it for the project.
  await page.getByRole('link', { name: 'Build or edit profiles' }).click();
  await expect(page.getByRole('heading', { name: 'Jurisdiction profiles', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New profile' }).click();
  const form = page.getByRole('form', { name: 'New profile' });
  await form.getByLabel('Name').fill('Nowhere County');
  await form.getByLabel('Jurisdiction').fill('Nowhere County (synthetic codes)');
  await choose(page, form.getByRole('combobox', { name: 'Code of adoption 1' }), 'Another code…');
  await form.getByRole('textbox', { name: 'Code of adoption 1' }).fill('TEST-CODE');
  await form.getByRole('textbox', { name: 'Edition of adoption 1' }).fill('2024');
  await form.getByLabel('Effective date of adoption 1').fill('2025-07-01');
  await choose(page, form.getByRole('combobox', { name: 'Code of adoption 2' }), 'Another code…');
  await form.getByRole('textbox', { name: 'Code of adoption 2' }).fill('TEST-ELEC');
  await form.getByRole('textbox', { name: 'Edition of adoption 2' }).fill('2026');
  // A cited amendment that withdraws a rule no finding here depends on.
  await form.getByRole('button', { name: 'Add an amendment' }).click();
  await form.getByLabel('Authority').fill('Nowhere County');
  await form.getByLabel('Reference').fill('Ord. 2026-2 §1');
  await form.getByLabel('Pack').fill('example');
  await form.getByLabel('Rule', { exact: true }).fill('SMOKE-ALARM');
  await axe(page, 'jurisdiction profiles, building one');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('heading', { name: 'Nowhere County', level: 2 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Editions' })).toContainText('TEST-CODE 2024');
  await expect(page.getByText('Ord. 2026-2 §1')).toBeVisible();
  await page.getByRole('button', { name: 'Use for The rules house' }).click();
  await expect(page.getByRole('button', { name: 'Used for The rules house' })).toBeDisabled();
  await axe(page, 'jurisdiction profiles, one chosen for the project');

  // ── The report: four findings, each naming its edition, grouped three ways, filtered.
  await page.goto(`/projects/${id}/findings`);
  await expect(page.getByRole('heading', { name: 'Findings', level: 1 })).toBeVisible();
  const findings = page.locator('article.fs-finding');
  await expect(findings).toHaveCount(4);
  await expect(page.locator('main')).toContainText('X1 may not meet TEST-ELEC 2026 §4.2 (Clear working space in front of a panel).');
  await expect(page.locator('main')).toContainText('R1 may not meet TEST-CODE 2024 §3.1');
  await expect(page.getByRole('region', { name: 'May not meet' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Check' })).toBeVisible();
  const workspace = page.locator('article[data-rule="WORKSPACE"]');
  await expect(workspace.getByRole('table')).toContainText('clearDepthInFront');
  await expect(workspace.getByRole('table')).toContainText('≥ 2\' 6"');
  await expect(workspace.getByRole('link', { name: /Read TEST-ELEC 2026 §4\.2 at its source/ })).toHaveAttribute('target', '_blank');
  await noticeIn(page.locator('main'));
  await expect(page.locator('main')).toContainText('Withdrawn by a local amendment in this profile');
  await axe(page, 'findings report, by severity');
  await page.getByRole('radio', { name: 'Room' }).click();
  await expect(page.getByRole('region', { name: 'Bedroom' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Utility' })).toContainText('Clear working space in front of a panel');
  await page.getByRole('radio', { name: 'Code' }).click();
  await expect(page.getByRole('region', { name: 'TEST-ELEC 2026' })).toBeVisible();
  await choose(page, page.getByRole('combobox', { name: 'Severity' }), 'May not meet');
  await expect(findings).toHaveCount(1);
  await axe(page, 'findings report, by code, filtered');
  await choose(page, page.getByRole('combobox', { name: 'Severity' }), 'Every severity');

  // The CSV export opens with the notice (FLR-REQ-105).
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const csv = readFileSync(await (await download).path(), 'utf8');
  expect(csv.split('\r\n')[0]).toBe(`Notice,"${NOTICE}"`);
  expect(csv).toContain('Nowhere County');
  expect(csv).toContain('/rule-packs');

  // ── 3. On the plan: the working space hatched with the boiler in it; the receptacle runs.
  await workspace.getByRole('button', { name: 'Show on the plan' }).click();
  const panel = page.getByTestId('findings-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('article[data-rule="WORKSPACE"]')).toHaveClass(/is-focused/);
  const canvas = page.locator('.fs-canvas__svg');
  const zone = canvas.locator('g[data-finding="e2e-overlays/WORKSPACE/element:X1"]');
  await expect(zone.locator('[data-kind="zone"]')).toHaveCount(1);
  await expect(zone.locator('[data-kind="involved"]')).toHaveCount(1);
  await expect(page.locator('.fs-statusbar')).toContainText('4 findings · on the plan');
  await noticeIn(panel);
  await axe(page, 'editor, a finding in focus on the plan');
  const spacing = canvas.locator('g[data-finding="e2e-overlays/SPACING/room:R2"]');
  await expect(spacing.locator('[data-kind="spacing"]').first()).toBeAttached();
  await expect(canvas.locator('g[data-finding="e2e-overlays/ESCAPE/room:R1"] [data-kind="room"]')).toHaveCount(1);
  // The Findings layer turns them off.
  await page.getByRole('button', { name: 'Findings', exact: true }).click();
  await expect(canvas.locator('g[data-finding]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Findings', exact: true }).click();
  await expect(canvas.locator('g[data-finding]').first()).toBeAttached();

  // ── 4. Change the profile — from elsewhere — and the open editor follows (Rules 10.7).
  const back = await page.request.put(`/api/projects/${id}/profile`, { data: { profileId: null } });
  expect(back.status()).toBe(200);
  await expect(panel).toContainText('No installed rule is in force under Model Codes (latest)');
  await expect(canvas.locator('g[data-finding]')).toHaveCount(0);
  await axe(page, 'editor, findings panel, none in force');

  // And from the report's profile control.
  await page.goto(`/projects/${id}/findings`);
  await choose(page, page.getByRole('combobox', { name: 'Jurisdiction profile' }), 'Nowhere County');
  await expect(findings).toHaveCount(4);

  // ── The dashboard card, with real counts, and the coverage matrix the notice links to.
  await page.goto(`/projects/${id}`);
  await expect(card).toContainText('May not meet');
  await expect(card).toContainText('Clear working space in front of a panel');
  await expect(page.getByRole('group', { name: 'At a glance' })).toContainText('4');
  await noticeIn(card);
  await axe(page, 'dashboard, findings');

  await card.getByRole('link', { name: 'What the installed rule packs check, and what they do not' }).click();
  await expect(page.getByRole('heading', { name: 'Rule packs', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Coverage matrix' })).toContainText('ESCAPE');
  await page.getByRole('tab', { name: /e2e-overlays · Electrical/ }).click();
  await expect(page.getByRole('table', { name: 'Coverage matrix' })).toContainText('WORKSPACE');
  await expect(page.getByRole('table', { name: 'Rules' })).toContainText('Example Reviewer (synthetic)');
  await noticeIn(page.locator('main'));
  await axe(page, 'rule packs, the coverage matrix');
});
