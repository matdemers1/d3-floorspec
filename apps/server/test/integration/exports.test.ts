import { createDrain, type Drain } from '@d3-floorspec/worker/queue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PENDING } from '../../src/routes/exports.js';
import { Browser, reset, setupOperator, start, testDb, tokenFor, TEST_ENV, type Reply, type Running } from './helpers.js';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { projectWithDocument } from './drawings-support.js';
import { upload, type UploadedAsset } from './assets-support.js';
import { tilePng } from '../support/images.js';
import { contentHash } from '@floorspec/engine';

/** The Khronos glTF validator, as the worker's tests load it (a dev dependency of the worker). */
const { validateBytes } = createRequire(new URL('../../../worker/package.json', import.meta.url))('gltf-validator') as {
  validateBytes: (bytes: Uint8Array, options: Record<string, unknown>) => Promise<{ issues: { numErrors: number; numWarnings: number; messages: { code: string; message: string }[] } }>;
};

/** Core 0.3's tiled backsplash: a material with a photo texture (FLR-T-9.2 embeds it from the asset store). */
const BACKSPLASH = JSON.parse(
  readFileSync(new URL('../../../../packages/engine/standard/conformance/core/0.3/materials/008-tile-photo-on-the-backsplash/input.json', import.meta.url), 'utf8'),
) as Prisma.InputJsonObject;

/** The L-shaped stair and hip roof house (FLR-T-9.7): a roof plan sheet and file. */
const L_STAIR = JSON.parse(readFileSync(new URL('../../../web/e2e/fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8')) as Prisma.InputJsonObject;

/** Core 0.3's kitchen with two option sets: a design to choose (FLR-T-9.2). */
const KITCHEN_OPTIONS = JSON.parse(
  readFileSync(new URL('../../../../packages/engine/standard/conformance/core/0.3/examples/002-kitchen-options/input.json', import.meta.url), 'utf8'),
) as Prisma.InputJsonObject;

/**
 * FLR-T-9.3 end to end: an export is asked for over the API, queued on the Postgres job queue,
 * drained by the worker's drain (the same code the worker container runs), and downloaded — a PDF
 * with a sheet per level and a schedule sheet, and DXF drawings, one per level, in a ZIP.
 */

interface ExportView {
  id: string;
  kind: string;
  status: string;
  version: string;
  levels: string[] | null;
  page: string | null;
  design: Record<string, string> | null;
  error: string | null;
  result: {
    name: string;
    contentType: string;
    size: number;
    sha256: string;
    sheets?: { number: string; title: string }[];
    textures?: { embedded: string[]; omitted: { asset: string; reason: string }[] };
    files?: string[];
    design?: Record<string, string> | null;
    levels?: string[];
    elements?: number;
  } | null;
  download: string | null;
}

const db = testDb();
const view = (r: Reply): ExportView => (r.body as { export: ExportView }).export;

async function download(browser: Browser, url: string): Promise<{ status: number; type: string | null; disposition: string | null; bytes: Uint8Array }> {
  const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(url, { headers: { cookie } });
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** Local ZIP entries' names. */
function zipNames(zip: Uint8Array): string[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const names: string[] = [];
  let at = 0;
  while (v.getUint32(at, true) === 0x04034b50) {
    const size = v.getUint32(at + 18, true);
    const n = v.getUint16(at + 26, true);
    const extra = v.getUint16(at + 28, true);
    names.push(new TextDecoder().decode(zip.subarray(at + 30, at + 30 + n)));
    at += 30 + n + extra + size;
  }
  return names;
}

describe('drawing exports', () => {
  let running: Running;
  let drain: Drain;

  beforeAll(async () => {
    running = await start();
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
    drain = createDrain({ databaseUrl: TEST_ENV.DATABASE_URL, log: () => undefined });
  });
  afterEach(async () => {
    await drain.stop();
  });

  it('queues a PDF, drains it, and serves a sheet per level with a schedule sheet', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator);
    const asked = await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf' });
    expect(asked.status, asked.text).toBe(202);
    const queued = view(asked);
    expect(queued).toMatchObject({ kind: 'pdf', status: 'queued', version: hash, page: 'tabloid', download: null });
    expect(asked.headers.get('location')).toBe(`/api/projects/${id}/exports/${queued.id}`);

    // Not finished: the file is not there yet.
    expect((await operator.get(`/api/projects/${id}/exports/${queued.id}/file`)).status).toBe(409);

    expect(await drain.runOnce()).toBe(1);
    const done = view(await operator.get(`/api/projects/${id}/exports/${queued.id}`));
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.result?.sheets).toEqual([
      { number: 'A-101', title: 'Main floor plan' },
      { number: 'A-102', title: 'Upper floor plan' },
      { number: 'A-601', title: 'Door and window schedule' },
    ]);
    expect(done.download).toBe(`/api/projects/${id}/exports/${queued.id}/file`);

    const file = await download(operator, `${running.url}${done.download ?? ''}`);
    expect(file.status).toBe(200);
    expect(file.type).toBe('application/pdf');
    // No number on main (the head was seeded, not edited): the file is named by the hash.
    expect(file.disposition).toBe(`attachment; filename="two-storey-ranch-${hash.slice(0, 8)}-plans.pdf"`);
    const latin = Buffer.from(file.bytes).toString('latin1');
    expect(latin.startsWith('%PDF-1.7')).toBe(true);
    expect((latin.match(/\/Type \/Page\b/g) ?? []).length).toBe(3);
    expect(file.bytes.byteLength).toBe(done.result?.size);

    // The list shows it, newest first; the request was audited.
    const list = (await operator.get(`/api/projects/${id}/exports`)).body as { exports: ExportView[] };
    expect(list.exports.map((e) => e.id)).toEqual([queued.id]);
    expect(await db.auditLog.count({ where: { action: 'export.request', targetId: queued.id } })).toBe(1);
  });

  it('draws the same version to the same bytes, whenever it is drawn', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator);
    const a = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf', levels: ['MAIN'], page: 'letter' }));
    const b = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf', levels: ['MAIN'], page: 'letter' }));
    expect(await drain.runOnce()).toBe(2);
    const [ra, rb] = await Promise.all([a, b].map(async (j) => view(await operator.get(`/api/projects/${id}/exports/${j.id}`))));
    expect(ra?.result?.sha256).toBe(rb?.result?.sha256);
    expect(ra?.result?.sheets?.map((s) => s.number)).toEqual(['A-101', 'A-601']);
  });

  it('queues DXF drawings: a ZIP of one DXF per level, or one DXF for one level', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator);
    const all = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'dxf' }));
    const one = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'dxf', levels: ['UPPER'] }));
    expect(all.page).toBeNull();
    await drain.runOnce();

    const zipped = view(await operator.get(`/api/projects/${id}/exports/${all.id}`));
    expect(zipped.status, zipped.error ?? '').toBe('done');
    const zip = await download(operator, `${running.url}${zipped.download ?? ''}`);
    expect(zip.type).toBe('application/zip');
    expect(zipNames(zip.bytes)).toEqual(zipped.result?.files);
    expect(zipped.result?.files).toHaveLength(2);

    const single = view(await operator.get(`/api/projects/${id}/exports/${one.id}`));
    const dxf = await download(operator, `${running.url}${single.download ?? ''}`);
    expect(dxf.type).toBe('image/vnd.dxf');
    const text = new TextDecoder().decode(dxf.bytes);
    expect(text).toContain('AC1015');
    expect(text).toContain('\r\nA-WALL-EXTR\r\n');
    expect(text).toContain('\r\nE-POWR-DEVC\r\n');
    expect(text).toContain('FAMILY ROOM');
    expect(text.endsWith('  0\r\nEOF\r\n')).toBe(true);
  });

  it('queues glTF and USDZ of the 3D model, and serves a .glb and an aligned .usdz (FLR-T-9.2)', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator);
    const gltf = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'gltf' }));
    const usdz = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'usdz', levels: ['MAIN'] }));
    expect(gltf).toMatchObject({ kind: 'gltf', status: 'queued', page: null, design: null });
    expect(await drain.runOnce()).toBe(2);

    const g = view(await operator.get(`/api/projects/${id}/exports/${gltf.id}`));
    expect(g.status, g.error ?? '').toBe('done');
    expect(g.result).toMatchObject({ contentType: 'model/gltf-binary', design: null, levels: ['MAIN', 'UPPER'] });
    expect(g.result?.elements).toBeGreaterThan(50);
    const glb = await download(operator, `${running.url}${g.download ?? ''}`);
    expect(glb.type).toBe('model/gltf-binary');
    expect(glb.disposition).toBe(`attachment; filename="two-storey-ranch-${hash.slice(0, 8)}.glb"`);
    expect(new TextDecoder().decode(glb.bytes.subarray(0, 4))).toBe('glTF');
    const json = JSON.parse(new TextDecoder().decode(glb.bytes.subarray(20, 20 + new DataView(glb.bytes.buffer, glb.bytes.byteOffset).getUint32(12, true)))) as { asset: { extras: { floorspec: { version: string } } } };
    expect(json.asset.extras.floorspec.version).toBe(hash);

    const u = view(await operator.get(`/api/projects/${id}/exports/${usdz.id}`));
    expect(u.status, u.error ?? '').toBe('done');
    expect(u.result?.levels).toEqual(['MAIN']);
    const file = await download(operator, `${running.url}${u.download ?? ''}`);
    expect(file.type).toBe('model/vnd.usdz+zip');
    expect(zipNames(file.bytes)).toEqual(['model.usda']);
    // The root layer's data starts on a 64-byte boundary (the USDZ rule).
    const v = new DataView(file.bytes.buffer, file.bytes.byteOffset);
    expect((30 + v.getUint16(26, true) + v.getUint16(28, true)) % 64).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'export.request', targetId: { in: [gltf.id, usdz.id] } } })).toBe(2);
  });

  it('exports the design asked for, and refuses a design for an IFC export or one the model does not have', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator, KITCHEN_OPTIONS, 'Kitchen options');
    const primary = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'gltf' }));
    const chosen = await operator.post(`/api/projects/${id}/exports`, { kind: 'gltf', design: { KS: 'KB' } });
    expect(chosen.status, chosen.text).toBe(202);
    expect(view(chosen).design).toEqual({ KS: 'KB' });
    expect((await operator.post(`/api/projects/${id}/exports`, { kind: 'ifc', design: { KS: 'KB' } })).status).toBe(400);
    expect((await operator.post(`/api/projects/${id}/exports`, { kind: 'usdz', design: { KS: 'NOPE' } })).status).toBe(422);
    expect((await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf', design: { KS: 'NOPE' } })).status).toBe(422);
    await drain.runOnce();
    const a = view(await operator.get(`/api/projects/${id}/exports/${primary.id}`));
    const b = view(await operator.get(`/api/projects/${id}/exports/${view(chosen).id}`));
    expect(a.result?.design).toMatchObject({ KS: 'KA' });
    expect(b.result?.design).toMatchObject({ KS: 'KB' });
    expect(a.result?.sha256).not.toBe(b.result?.sha256);
  });

  it('draws PDF and DXF drawings in the design asked for, and the file says which (FLR-T-9.7)', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator, KITCHEN_OPTIONS, 'Kitchen options');
    const pdfA = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf' }));
    const pdfB = await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf', design: { KS: 'KB' } });
    expect(pdfB.status, pdfB.text).toBe(202);
    expect(view(pdfB)).toMatchObject({ kind: 'pdf', design: { KS: 'KB' } });
    const dxfB = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'dxf', design: { KS: 'KB' } }));
    expect(await drain.runOnce()).toBe(3);
    const state = async (j: ExportView): Promise<ExportView> => view(await operator.get(`/api/projects/${id}/exports/${j.id}`));
    const a = await state(pdfA);
    const b = await state(view(pdfB));
    const d = await state(dxfB);
    expect(a.status, a.error ?? '').toBe('done');
    expect(b.status, b.error ?? '').toBe('done');
    expect(d.status, d.error ?? '').toBe('done');
    expect(a.result?.design).toEqual({ DS: 'DA', KS: 'KA' });
    expect(b.result?.design).toEqual({ DS: 'DA', KS: 'KB' });
    expect(d.result?.design).toEqual({ DS: 'DA', KS: 'KB' });
    expect(a.result?.sha256).not.toBe(b.result?.sha256);
    const dxf = new TextDecoder().decode((await download(operator, `${running.url}${d.download ?? ''}`)).bytes);
    expect(dxf).toContain('DESIGN: Deck \\U+2014 Deck \\U+00B7 Kitchen \\U+2014 B: open');
  });

  it('draws stairs and a roof plan: a sheet and a DXF of their own (FLR-T-9.7)', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator, L_STAIR, 'Stair and hip roof house');
    const pdf = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf' }));
    const dxf = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'dxf' }));
    expect(await drain.runOnce()).toBe(2);
    const p = view(await operator.get(`/api/projects/${id}/exports/${pdf.id}`));
    expect(p.status, p.error ?? '').toBe('done');
    expect(p.result?.sheets).toEqual([
      { number: 'A-101', title: 'Level 1 floor plan' },
      { number: 'A-102', title: 'Level 2 floor plan' },
      { number: 'A-103', title: 'Roof plan' },
    ]);
    const file = await download(operator, `${running.url}${p.download ?? ''}`);
    // Every sheet's 3D view is a picture of the mesh, embedded.
    expect((Buffer.from(file.bytes).toString('latin1').match(/\/Subtype \/Image/g) ?? []).length).toBe(3);
    const x = view(await operator.get(`/api/projects/${id}/exports/${dxf.id}`));
    expect(x.result?.files).toEqual([expect.stringMatching(/-level-1\.dxf$/), expect.stringMatching(/-level-2\.dxf$/), expect.stringMatching(/-roof-plan\.dxf$/)]);
    expect(zipNames((await download(operator, `${running.url}${x.download ?? ''}`)).bytes)).toEqual(x.result?.files);
  });

  it('refuses what cannot be drawn before it is queued', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator);
    expect((await operator.post(`/api/projects/${id}/exports`, { kind: 'svg' })).status).toBe(400);
    expect((await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf', page: 'napkin' })).status).toBe(400);
    const level = await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf', levels: ['ATTIC'] });
    expect(level.status).toBe(400);
    expect(level.text).toContain('no level ATTIC');
    // A version this project never had.
    expect((await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf', version: 'a'.repeat(64) })).status).toBe(404);
    // A model with nothing to draw.
    const { id: empty } = (await operator.post('/api/projects', { name: 'Empty' })).body as { id: string };
    expect((await operator.post(`/api/projects/${empty}/exports`, { kind: 'pdf' })).status).toBe(422);
    expect(await db.job.count()).toBe(0);
  });

  it('holds a project to a few exports waiting at once', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator);
    for (let i = 0; i < MAX_PENDING; i++) expect((await operator.post(`/api/projects/${id}/exports`, { kind: 'dxf' })).status).toBe(202);
    const refused = await operator.post(`/api/projects/${id}/exports`, { kind: 'dxf' });
    expect(refused.status).toBe(429);
  });

  it('says why a job failed, and that an expired file is gone', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator);
    // A job the api would not have queued — a level that is not there — fails in the worker with its reason.
    const bad = await db.job.create({ data: { projectId: id, kind: 'export.pdf', params: { levels: ['ATTIC'], versionAt: new Date(0).toISOString() }, versionHash: hash } });
    await drain.runOnce();
    const failed = view(await operator.get(`/api/projects/${id}/exports/${bad.id}`));
    expect(failed).toMatchObject({ status: 'failed', error: 'the model has no level ATTIC', download: null });
    const refused = await operator.get(`/api/projects/${id}/exports/${bad.id}/file`);
    expect(refused.status).toBe(409);
    expect(refused.text).toContain('no level ATTIC');

    const ok = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'dxf', levels: ['MAIN'] }));
    await drain.runOnce();
    await db.jobOutput.delete({ where: { jobId: ok.id } });
    expect((await operator.get(`/api/projects/${id}/exports/${ok.id}/file`)).status).toBe(410);
  });

  it('takes a running job back from a worker that died, and gives up after three tries', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator);
    const stale = new Date(Date.now() - 11 * 60_000);
    const retried = await db.job.create({ data: { projectId: id, kind: 'export.dxf', status: 'running', attempts: 1, lockedBy: 'dead', lockedAt: stale, params: { levels: ['MAIN'], versionAt: stale.toISOString() }, versionHash: hash } });
    const abandoned = await db.job.create({ data: { projectId: id, kind: 'export.dxf', status: 'running', attempts: 3, lockedBy: 'dead', lockedAt: stale, params: { versionAt: stale.toISOString() }, versionHash: hash } });
    await drain.runOnce();
    expect(await db.job.findUniqueOrThrow({ where: { id: retried.id } })).toMatchObject({ status: 'done', attempts: 2 });
    expect(await db.job.findUniqueOrThrow({ where: { id: abandoned.id } })).toMatchObject({ status: 'failed', error: 'The export stopped part-way 3 times and was not tried again.' });
  });

  it('wakes on the queue’s notification, without waiting for a poll', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator);
    await drain.start();
    const job = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'dxf', levels: ['MAIN'] }));
    const deadline = Date.now() + 4_000;
    let status = job.status;
    while (status !== 'done' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      status = view(await operator.get(`/api/projects/${id}/exports/${job.id}`)).status;
    }
    expect(status).toBe('done');
  });

  it('lets a read token export and download', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator);
    const token = Browser.bearer(running.url, await tokenFor(operator, id, 'read'));
    const asked = await token.post(`/api/projects/${id}/exports`, { kind: 'dxf', levels: ['MAIN'] });
    expect(asked.status, asked.text).toBe(202);
    await drain.runOnce();
    expect((await token.get(`/api/projects/${id}/exports/${view(asked).id}/file`)).status).toBe(200);
  });
});

describe('path-traced stills (FLR-T-12.6)', () => {
  let running: Running;
  let drain: Drain;

  beforeAll(async () => {
    running = await start();
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
    drain = createDrain({ databaseUrl: TEST_ENV.DATABASE_URL, log: () => undefined });
  });
  afterEach(async () => {
    await drain.stop();
  });

  it('queues a still of a room, renders it on the queue with its passes, and serves the PNG', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator);
    const asked = await operator.post(`/api/projects/${id}/exports`, { kind: 'still', still: { room: 'Living room', size: 'small', quality: 'draft', sun: { azimuth: 200, altitude: 40 } } });
    expect(asked.status, asked.text).toBe(202);
    const queued = view(asked) as ExportView & { still: unknown; progress: unknown };
    expect(queued).toMatchObject({ kind: 'still', status: 'queued', version: hash, still: { room: 'Living room', camera: null, size: 'small', quality: 'draft', sun: { azimuth: 200, altitude: 40 } }, progress: null });

    // One still at a time per project.
    const second = await operator.post(`/api/projects/${id}/exports`, { kind: 'still' });
    expect(second.status, second.text).toBe(429);

    expect(await drain.runOnce()).toBe(1);
    const done = view(await operator.get(`/api/projects/${id}/exports/${queued.id}`)) as ExportView & { result: Record<string, unknown> | null; progress: unknown };
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.progress).toBeNull();
    expect(done.result).toMatchObject({ contentType: 'image/png', label: 'Offline path-traced render — approximate lighting', width: 640, height: 480, samples: 16, sun: { azimuth: 200, altitude: 40, source: 'yours' } });
    expect(String(done.result?.['camera'])).toMatch(/^Living room \(LIV\)/);
    const row = await db.job.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row.kind).toBe('export.still');
    const file = await download(operator, `${running.url}${String(done.download)}`);
    expect(file.status).toBe(200);
    expect(file.type).toBe('image/png');
    expect(Array.from(file.bytes.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
  }, 180_000);

  it('refuses work over the budget, a room or level the model does not have, and still options on another export', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator);
    const ask = (body: object) => operator.post(`/api/projects/${id}/exports`, body);
    expect((await ask({ kind: 'still', still: { size: 'large', quality: 'high' } })).status).toBe(400);
    expect((await ask({ kind: 'still', still: { room: 'Ballroom' } })).status).toBe(400);
    expect((await ask({ kind: 'still', still: { level: 'NOPE' } })).status).toBe(400);
    expect((await ask({ kind: 'still', still: { room: 'LIV', camera: 'sw' } })).status).toBe(400);
    expect((await ask({ kind: 'still', still: { sun: { azimuth: 90, altitude: 0 } } })).status).toBe(400);
    expect((await ask({ kind: 'pdf', still: { size: 'small' } })).status).toBe(400);
    expect((await ask({ kind: 'still', levels: ['MAIN'] })).status).toBe(400);
    expect(await db.job.count()).toBe(0);
  });
});

describe('3D exports embed the maps in the asset store (FLR-T-9.2)', () => {
  let running: Running;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flr-export-assets-'));
    running = await start({ env: { ASSET_DIR: dir } });
  });
  afterAll(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await reset(db);
  });

  it('reads an uploaded texture from the store by its SHA-256 and embeds it: a .glb with no validator errors', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator, BACKSPLASH, 'Backsplash tile');
    const up = await upload(running.url, operator, id, tilePng(64, 64, { tile: 16 }), { name: 'tile.png', contentType: 'image/png' });
    expect(up.status, up.text).toBe(201);
    const a = (up.body as { asset: UploadedAsset }).asset;
    // The model now names the uploaded file, as the editor's ops would put it there.
    const doc = { ...BACKSPLASH, assets: { 'TILE-PHOTO': { path: a.path, sha256: a.sha256, mediaType: a.mediaType, byteLength: a.byteLength } } } as Prisma.InputJsonObject;
    const hash = contentHash(doc);
    await db.version.upsert({ where: { hash }, create: { hash, document: doc }, update: {} });
    await db.head.update({ where: { projectId_name: { projectId: id, name: 'main' } }, data: { versionHash: hash } });
    const asked = await operator.post(`/api/projects/${id}/exports`, { kind: 'gltf' });
    expect(asked.status, asked.text).toBe(202);
    // Another project naming the same digest has not uploaded it: its export carries no map.
    const { id: other } = await projectWithDocument(db, operator, doc, 'Borrowed tile');
    const borrowed = view(await operator.post(`/api/projects/${other}/exports`, { kind: 'gltf' }));

    // The worker's drain, reading the same directory the api writes (the compose file mounts it read-only).
    const drain = createDrain({ databaseUrl: TEST_ENV.DATABASE_URL, assetDir: dir, log: () => undefined });
    try {
      expect(await drain.runOnce()).toBe(2);
    } finally {
      await drain.stop();
    }
    const done = view(await operator.get(`/api/projects/${id}/exports/${view(asked).id}`));
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.result?.textures).toEqual({ embedded: ['TILE-PHOTO'], omitted: [] });
    const glb = await download(operator, `${running.url}${done.download ?? ''}`);
    const report = await validateBytes(glb.bytes, { maxIssues: 0, writeTimestamp: false, format: 'glb' });
    expect(report.issues.numErrors, report.issues.messages.map((m) => `${m.code} ${m.message}`).join('\n')).toBe(0);
    const theirs = view(await operator.get(`/api/projects/${other}/exports/${borrowed.id}`));
    expect(theirs.result?.textures).toEqual({ embedded: [], omitted: [{ asset: 'TILE-PHOTO', reason: 'its bytes were not available to the exporter' }] });
  });
});
