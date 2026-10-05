import { createHmac } from 'node:crypto';
import { expect, request, type APIRequestContext, type Page } from '@playwright/test';

/** Helpers the end-to-end suites share. */

/** Base units: 1/1280 mm (FLR-ADR-004). */
export const IN = 32_512;
export const FT = 12 * IN;

export interface Doc {
  levels?: Record<string, { name?: string }>;
  junctions?: Record<string, { level?: string; position: [number, number] }>;
  walls?: Record<string, { start: string; end: string; name?: string; level?: string }>;
  openings?: Record<string, { wall: string; fill?: string; offset?: number; clearOpening?: { width: number; height: number; area?: number } }>;
  rooms?: Record<string, { name?: string; anchor?: [number, number] }>;
  types?: Record<string, { kind: string; name?: string; operation?: string; clearOpening?: { width: number; height: number; area?: number } }>;
}

export const count = (c: Record<string, unknown> | undefined) => Object.keys(c ?? {}).length;

/** The head model, as the server holds it — the download the dashboard offers. */
export async function modelOf(page: Page, project: string): Promise<Doc> {
  const res = await page.request.get(`/api/projects/${project}/model.json`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as Doc;
}

export interface HistoryOp {
  seq: number;
  kind: string;
  before: string | null;
  after: string;
  undoOf?: number | null;
  changeset?: { id: string; name: string } | null;
  author: { kind: string; name?: string | null; token?: string | null };
}

export async function historyOf(page: Page, project: string): Promise<HistoryOp[]> {
  const res = await page.request.get(`/api/projects/${project}/history`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { ops: HistoryOp[] }).ops;
}

/** The project id in a `/projects/:id…` URL. */
export function projectIn(url: string): string {
  const id = /\/projects\/([0-9a-f-]{36})/.exec(url)?.[1];
  if (id === undefined) throw new Error(`no project in ${url}`);
  return id;
}

/** The setup token the gated suites' servers were started with (playwright.config.ts). */
export function setupToken(): string {
  const token = process.env['E2E_SETUP_TOKEN'];
  if (token === undefined) throw new Error('E2E_SETUP_TOKEN is not set: run through e2e/playwright.config.ts');
  return token;
}

/** A password for this run only. */
export const password = (who: string) => `${who}-${String(Date.now())}-e2e-only`;

/** First-run setup, through the screen, with the setup token. */
export async function firstRunSetup(page: Page, o: { name: string; email: string; password: string }): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up D3 Floorspec' })).toBeVisible();
  await page.getByLabel('Setup token').fill(setupToken());
  await page.getByLabel('Your name').fill(o.name);
  await page.getByLabel('Email').fill(o.email);
  await page.getByLabel('Password', { exact: true }).fill(o.password);
  await page.getByLabel('Password again').fill(o.password);
  await page.getByRole('button', { name: 'Create the operator account' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
}

/**
 * A request context that is a program, not a person: no cookie, only the bearer token — what an
 * MCP client or a script holding an agent token sends.
 */
export async function asAgent(baseURL: string, token: string): Promise<APIRequestContext> {
  return request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

/** Wait until the editor is not in the middle of an edit. */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator('.fs-topbar__title p')).toContainText('saved');
}

/** RFC 6238 TOTP, SHA-1, 6 digits, 30 s — the code an authenticator app shows for `secret`. */
export function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac('sha1', bytes).update(counter).digest();
  const offset = (mac[mac.length - 1] as number) & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}
