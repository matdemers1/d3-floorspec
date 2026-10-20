import { createDrain, type Drain } from '@d3-floorspec/worker/queue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Browser, inviteMember, reset, setupOperator, start, testDb, TEST_ENV, type Reply, type Running } from './helpers.js';
import { projectWithDocument } from './drawings-support.js';
import { shareOf } from './share-support.js';

/**
 * FLR-T-14.3 end to end: a USDZ for AR Quick Look asked for over the API — at table scale, with the
 * site — queued, shared at once through an AR model's link (the model alone, revocable), made by the
 * drain, and fetched with no account as `model/vnd.usdz+zip`, inline, for a phone's `<a rel="ar">`;
 * the link reaching nothing else, a revoked link nothing at all; the owner's file inline when asked;
 * and the refusals.
 */

interface UsdzView {
  id: string;
  kind: string;
  status: string;
  error: string | null;
  ar: { scale: string; roofs: boolean; furniture: boolean; fixtures: boolean; site: boolean } | null;
  result: Record<string, unknown> | null;
  download: string | null;
}

const db = testDb();
const view = (r: Reply): UsdzView => (r.body as { export: UsdzView }).export;

async function fetchOf(url: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string | null; disposition: string | null; etag: string | null; bytes: Uint8Array }> {
  const res = await fetch(url, { headers });
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), etag: res.headers.get('etag'), bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** The stored ZIP's entries and where each one's data starts. */
function entries(zip: Uint8Array): { name: string; offset: number; bytes: Uint8Array }[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: { name: string; offset: number; bytes: Uint8Array }[] = [];
  let at = 0;
  while (at + 30 <= zip.byteLength && v.getUint32(at, true) === 0x04034b50) {
    const size = v.getUint32(at + 18, true);
    const n = v.getUint16(at + 26, true);
    const extra = v.getUint16(at + 28, true);
    const offset = at + 30 + n + extra;
    out.push({ name: new TextDecoder().decode(zip.subarray(at + 30, at + 30 + n)), offset, bytes: zip.subarray(offset, offset + size) });
    at = offset + size;
  }
  return out;
}

describe('AR models (FLR-T-14.3)', () => {
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

  it('makes a USDZ at table scale, shares it before it is made, and serves it to a phone — and nothing else — until the link is revoked', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator);
    const asked = await operator.post(`/api/projects/${id}/exports`, { kind: 'usdz', ar: { scale: 'table', site: true, roofs: false } });
    expect(asked.status, asked.text).toBe(202);
    const queued = view(asked);
    expect(queued).toMatchObject({ kind: 'usdz', status: 'queued', ar: { scale: 'table', roofs: false, furniture: true, fixtures: true, site: true } });
    expect(await db.auditLog.count({ where: { action: 'export.request', targetId: queued.id } })).toBe(1);
    // A plain USDZ is true scale, everything but the site.
    expect(view(await operator.post(`/api/projects/${id}/exports`, { kind: 'usdz' })).ar).toEqual({ scale: 'true', roofs: true, furniture: true, fixtures: true, site: false });

    // Shared at once: the link names the model, shows it alone, and says it is being made.
    const made = await operator.post(`/api/projects/${id}/shares`, { ar: queued.id, expiresInDays: 30, label: 'AR model' });
    expect(made.status, made.text).toBe(201);
    const { url, token, link } = made.body as { url: string; token: string; link: { id: string; ar: string; tour: string | null; shows: unknown; comments: boolean } };
    expect(url).toBe(`${running.config.PUBLIC_URL}/s/${token}/ar`);
    expect(link).toMatchObject({ ar: queued.id, tour: null, shows: { plan: false, threeD: false, findings: false }, comments: false });
    const anon = new Browser(running.url);
    expect(((await anon.get(`/api/share/${token}`)).body as { shows: unknown }).shows).toEqual({ plan: false, threeD: false, findings: false, tour: false, ar: true });
    expect((await anon.get(`/api/share/${token}/ar`)).body).toEqual({ status: 'queued', scale: 'table', project: 'Two-storey ranch' });
    expect((await anon.get(`/api/share/${token}/ar.usdz`)).status).toBe(409);

    await drain.runOnce();
    const done = view(await operator.get(`/api/projects/${id}/exports/${queued.id}`));
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.result).toMatchObject({ contentType: 'model/vnd.usdz+zip', name: `two-storey-ranch-${hash.slice(0, 8)}-table.usdz`, ar: { scale: 'table', ratio: '1:50', roofs: false, site: true } });

    // Fetched with no account: what it is, then the file — inline, aligned, at 1:50.
    const ar = await anon.get(`/api/share/${token}/ar`);
    expect(ar.status, ar.text).toBe(200);
    expect(ar.headers.get('referrer-policy')).toBe('no-referrer');
    expect(ar.body).toMatchObject({ status: 'done', scale: 'table', name: `two-storey-ranch-${hash.slice(0, 8)}-table.usdz`, file: `/api/share/${token}/ar.usdz` });
    const file = await fetchOf(`${running.url}/api/share/${token}/ar.usdz`);
    expect(file.status).toBe(200);
    expect(file.type).toBe('model/vnd.usdz+zip');
    expect(file.disposition).toBe(`inline; filename="two-storey-ranch-${hash.slice(0, 8)}-table.usdz"`);
    expect((ar.body as { bytes: number }).bytes).toBe(file.bytes.byteLength);
    const files = entries(file.bytes);
    expect(files[0]?.name).toBe('model.usda');
    for (const e of files) expect(e.offset % 64, e.name).toBe(0);
    const usda = new TextDecoder().decode(files[0]?.bytes);
    expect(usda).toContain('string scale = "1:50"');
    expect(usda).toContain('float3 xformOp:scale = (0.02, 0.02, 0.02)');
    expect(usda).toContain('uniform token preliminary:planeAnchoring:alignment = "horizontal"');
    // Revalidated: a 304 when unchanged.
    expect((await fetchOf(`${running.url}/api/share/${token}/ar.usdz`, { 'if-none-match': file.etag ?? '' })).status).toBe(304);

    // The model alone: no model.json, findings, comments or tour through its link; an ordinary link has no AR model.
    for (const path of ['model.json', 'findings', 'coverage', 'comments', 'tour']) expect((await anon.get(`/api/share/${token}/${path}`)).status, path).toBe(404);
    const full = await shareOf(operator, id);
    for (const path of ['ar', 'ar.usdz']) expect((await anon.get(`/api/share/${full.token}/${path}`)).status, path).toBe(404);

    // The owner's file: a download, or inline for AR Quick Look when asked.
    const cookie = [...operator.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    expect((await fetchOf(`${running.url}${done.download ?? ''}`, { cookie })).disposition).toMatch(/^attachment; /);
    const inline = await fetchOf(`${running.url}${done.download ?? ''}?inline=1`, { cookie });
    expect(inline.disposition).toMatch(/^inline; /);
    expect(inline.type).toBe('model/vnd.usdz+zip');

    // Kept past the week while the link lives; gone once it is revoked.
    await db.$executeRaw`update job_outputs set created_at = now() - interval '8 days' where job_id = ${queued.id}::uuid`;
    await drain.runOnce();
    expect(await db.jobOutput.count({ where: { jobId: queued.id } })).toBe(1);
    expect((await operator.request('DELETE', `/api/projects/${id}/shares/${link.id}`)).status).toBe(204);
    for (const path of ['ar', 'ar.usdz']) expect((await anon.get(`/api/share/${token}/${path}`)).status, path).toBe(410);
    await drain.runOnce();
    expect(await db.jobOutput.count({ where: { jobId: queued.id } })).toBe(0);
  }, 300_000);

  it('refuses AR options on anything but a USDZ, and an AR link that shows more or names another export', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator);
    const ask = (body: unknown) => operator.post(`/api/projects/${id}/exports`, body);
    expect((await ask({ kind: 'gltf', ar: { scale: 'true' } })).status).toBe(400);
    expect((await ask({ kind: 'usdz', ar: { scale: '1:100' } })).status).toBe(400);
    expect((await ask({ kind: 'usdz', ar: { scale: 'true', lawn: true } })).status).toBe(400);

    const usdz = view(await ask({ kind: 'usdz', ar: { scale: 'true' } }));
    const share = (body: unknown) => operator.post(`/api/projects/${id}/shares`, body);
    expect((await share({ ar: usdz.id, shows: { plan: true, threeD: false, findings: false } })).status).toBe(400);
    expect((await share({ ar: usdz.id, comments: true })).status).toBe(400);
    expect((await share({ ar: usdz.id, tour: usdz.id })).status).toBe(400);
    expect((await share({ ar: 'not-a-job' })).status).toBe(400);
    // Another kind of export, or another project's model, is not this project's AR model.
    const pdf = view(await ask({ kind: 'pdf' }));
    expect((await share({ ar: pdf.id })).status).toBe(404);
    const bob = await inviteMember(running, operator, 'bob@example.test');
    const { id: bobs } = await projectWithDocument(db, bob, undefined, "Bob's ranch");
    expect((await bob.post(`/api/projects/${bobs}/shares`, { ar: usdz.id })).status).toBe(404);
    // The database holds the same line.
    expect((await share({ ar: usdz.id })).status).toBe(201);
    await expect(db.$executeRaw`update share_links set show_3d = true where ar_job_id is not null`).rejects.toThrow(/share_links_ar_alone/);
    // A model that was not made cannot be shared.
    expect((await operator.post(`/api/projects/${id}/exports/${usdz.id}/cancel`, {})).status).toBe(200);
    expect((await share({ ar: usdz.id })).status).toBe(409);
  });
});
