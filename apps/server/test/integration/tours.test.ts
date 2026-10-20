import { createDrain, type Drain } from '@d3-floorspec/worker/queue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Browser, inviteMember, reset, setupOperator, start, testDb, TEST_ENV, type Reply, type Running } from './helpers.js';
import { projectWithDocument, WITH_VIEWS } from './drawings-support.js';
import { shareOf } from './share-support.js';

/**
 * FLR-T-14.2 end to end: a virtual tour asked for over the API — rooms in order, one seen from a
 * saved view — queued, shared at once through a tour's link (view only, the tour alone, revocable),
 * rendered by the drain into panoramas, plans and a manifest, and walked by somebody with no account;
 * the link reaching nothing else, a revoked link nothing at all; the tour's files kept while the link
 * lives; and the refusals.
 */

interface TourView {
  id: string;
  kind: string;
  status: string;
  error: string | null;
  cancelled: boolean;
  tour: { rooms: { id: string; name: string; view: string | null }[]; panos: number; size: string; quality: string; eyeHeight: number; at: string } | null;
  result: Record<string, unknown> | null;
  download: string | null;
}

interface Manifest {
  tour: number;
  project: string;
  start: string;
  width: number;
  height: number;
  rooms: { id: string; name: string; level: string; pano: string; eye: number[]; heading: number; stands: { at: string; view?: string }; hotspots: { to: string; label: string; via: string; yaw: number; pitch: number }[] }[];
  levels: { id: string; plan: { light: string; dark: string; width: number; height: number; frame: { x0: number; y0: number; s: number } } }[];
}

const db = testDb();
const view = (r: Reply): TourView => (r.body as { export: TourView }).export;

async function bytesOf(url: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string | null; bytes: Uint8Array; etag: string | null }> {
  const res = await fetch(url, { headers });
  return { status: res.status, type: res.headers.get('content-type'), bytes: new Uint8Array(await res.arrayBuffer()), etag: res.headers.get('etag') };
}

describe('virtual tours (FLR-T-14.2)', () => {
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

  it('renders a tour, shares it before it is made, and lets anybody walk it — and nothing else — until the link is revoked', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator, WITH_VIEWS, 'Ranch with views');
    const asked = await operator.post(`/api/projects/${id}/exports`, { kind: 'tour', tour: { rooms: [{ room: 'living room', view: 'Living room' }, { room: 'KIT' }], size: 'small', quality: 'draft' } });
    expect(asked.status, asked.text).toBe(202);
    const queued = view(asked);
    expect(queued).toMatchObject({ kind: 'tour', status: 'queued', tour: { rooms: [{ id: 'LIV', name: 'Living room', view: 'SV2' }, { id: 'KIT', name: 'Kitchen', view: null }], panos: 2, size: 'small', quality: 'draft', eyeHeight: 63 * 32_512 } });
    expect(queued.tour?.at).toMatch(/^\d{4}-06-21T15:00$/);
    // One tour (or film, still, shot list or pair) renders at a time per project.
    expect((await operator.post(`/api/projects/${id}/exports`, { kind: 'tour' })).status).toBe(429);
    expect(await db.auditLog.count({ where: { action: 'export.request', targetId: queued.id } })).toBe(1);

    // Shared at once: the link names the tour, shows it alone, and says it is being made.
    const made = await operator.post(`/api/projects/${id}/shares`, { tour: queued.id, expiresInDays: 365 });
    expect(made.status, made.text).toBe(201);
    const { url, token, link } = made.body as { url: string; token: string; link: { tour: string; shows: unknown; comments: boolean } };
    expect(url).toBe(`${running.config.PUBLIC_URL}/s/${token}/tour`);
    expect(link).toMatchObject({ tour: queued.id, shows: { plan: false, threeD: false, findings: false }, comments: false });
    const anon = new Browser(running.url);
    expect(((await anon.get(`/api/share/${token}`)).body as { shows: unknown }).shows).toEqual({ plan: false, threeD: false, findings: false, tour: true, ar: false });
    expect((await anon.get(`/api/share/${token}/tour`)).body).toEqual({ status: 'queued', panos: 2, done: 0 });

    expect(await drain.runOnce()).toBe(1);
    const done = view(await operator.get(`/api/projects/${id}/exports/${queued.id}`));
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.result).toMatchObject({ contentType: 'application/json', name: `tour-two-bedroom-ranch-${hash.slice(0, 8)}.json`, panos: 2, width: 1024, height: 512, quality: 'draft', samples: 8 });

    // Walked with no account: the manifest, each panorama, each plan.
    const tour = await anon.get(`/api/share/${token}/tour`);
    expect(tour.status, tour.text).toBe(200);
    expect(tour.headers.get('referrer-policy')).toBe('no-referrer');
    const { manifest } = tour.body as { status: string; manifest: Manifest };
    expect(tour.body).toMatchObject({ status: 'done', panos: 2, done: 2 });
    expect(manifest).toMatchObject({ tour: 1, start: 'LIV', width: 1024, height: 512 });
    expect(manifest.rooms.map((r) => [r.id, r.stands.at])).toEqual([['LIV', 'view'], ['KIT', 'centre']]);
    expect(manifest.rooms[0]?.stands.view).toBe('Living room');
    // The living room and the kitchen open into each other: a hotspot each way, labelled with where it leads.
    expect(manifest.rooms[0]?.hotspots.map((h) => h.label)).toEqual(['Kitchen']);
    expect(manifest.rooms[1]?.hotspots.map((h) => h.label)).toEqual(['Living room']);
    expect(manifest.levels.map((l) => l.id)).toEqual(['MAIN']);
    for (const room of manifest.rooms) {
      const pano = await bytesOf(`${running.url}/api/share/${token}/tour/${room.pano}`);
      expect(pano.status, room.pano).toBe(200);
      expect(pano.type).toBe('image/jpeg');
      expect([...pano.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      // Revalidated, as the model is: a 304 when unchanged, and a revoked link stops at once.
      expect((await bytesOf(`${running.url}/api/share/${token}/tour/${room.pano}`, { 'if-none-match': pano.etag ?? '' })).status).toBe(304);
    }
    const plan = await bytesOf(`${running.url}/api/share/${token}/tour/${manifest.levels[0]?.plan.dark ?? ''}`);
    expect(plan.type).toBe('image/svg+xml');
    expect(new TextDecoder().decode(plan.bytes)).toMatch(/^<svg /);
    for (const name of ['tour.json', 'nothing.jpg', '..%2Fx.jpg', 'PANO.JPG']) expect((await anon.get(`/api/share/${token}/tour/${name}`)).status, name).toBe(404);

    // The tour alone: no model, findings or comments through its link.
    for (const path of ['model.json', 'findings', 'coverage', 'comments']) expect((await anon.get(`/api/share/${token}/${path}`)).status, path).toBe(404);
    // And an ordinary link has no tour.
    const full = await shareOf(operator, id);
    expect((await anon.get(`/api/share/${full.token}/tour`)).status).toBe(404);
    expect((await anon.get(`/api/share/${full.token}/tour/${manifest.rooms[0]?.pano ?? ''}`)).status).toBe(404);

    // The owner downloads the whole tour as a ZIP.
    const cookie = [...operator.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const zip = await bytesOf(`${running.url}${done.download ?? ''}`, { cookie });
    expect(zip.status).toBe(200);
    expect(zip.type).toBe('application/zip');
    const names = new TextDecoder('latin1').decode(zip.bytes);
    for (const name of ['tour.json', manifest.rooms[0]?.pano ?? '', manifest.levels[0]?.plan.light ?? '']) expect(names).toContain(name);

    // Kept past the week every other file is kept for while the link lives; gone once it is revoked.
    await db.$executeRaw`update job_outputs set created_at = now() - interval '8 days' where job_id = ${queued.id}::uuid`;
    await db.$executeRaw`update job_assets set created_at = now() - interval '8 days' where job_id = ${queued.id}::uuid`;
    await drain.runOnce();
    expect(await db.jobAsset.count({ where: { jobId: queued.id } })).toBe(4);
    const linkId = (made.body as { link: { id: string } }).link.id;
    expect((await operator.request('DELETE', `/api/projects/${id}/shares/${linkId}`)).status).toBe(204);
    for (const path of ['tour', `tour/${manifest.rooms[0]?.pano ?? ''}`]) expect((await anon.get(`/api/share/${token}/${path}`)).status, path).toBe(410);
    await drain.runOnce();
    expect(await db.jobAsset.count({ where: { jobId: queued.id } })).toBe(0);
    expect(await db.jobOutput.count({ where: { jobId: queued.id } })).toBe(0);
  }, 300_000);

  it('tours every room but garages, closets and the outdoors when none are named, entry first', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator);
    const queued = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'tour' }));
    expect(queued.tour).toMatchObject({ size: 'large', quality: 'standard', panos: 12 });
    expect(queued.tour?.rooms[0]?.id).toBe('BATH');
    // The main level's rooms first, then the upper level's.
    expect(queued.tour?.rooms.slice(0, 6).map((r) => r.id).sort()).toEqual(['BATH', 'BED1', 'BED2', 'HALL', 'KIT', 'LIV']);
    // Cancelled while queued: its link says so.
    const share = await operator.post(`/api/projects/${id}/shares`, { tour: queued.id });
    const token = (share.body as { token: string }).token;
    expect((await operator.post(`/api/projects/${id}/exports/${queued.id}/cancel`, {})).status).toBe(200);
    expect((await new Browser(running.url).get(`/api/share/${token}/tour`)).body).toEqual({ status: 'failed', panos: 12, cancelled: true });
    // A tour that was not made cannot be shared again.
    expect((await operator.post(`/api/projects/${id}/shares`, { tour: queued.id })).status).toBe(409);
  });

  it('refuses rooms and views the model lacks, a room twice, tour options elsewhere, and a tour link that shows more', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator, WITH_VIEWS, 'Ranch with views');
    const ask = (body: unknown) => operator.post(`/api/projects/${id}/exports`, body);
    const missing = await ask({ kind: 'tour', tour: { rooms: [{ room: 'Ballroom' }] } });
    expect(missing.status).toBe(400);
    expect((missing.body as { error: string }).error).toMatch(/no room Ballroom/);
    const noView = await ask({ kind: 'tour', tour: { rooms: [{ room: 'LIV', view: 'Garden' }] } });
    expect((noView.body as { error: string }).error).toMatch(/no saved view "Garden"; its views are "Front", "Living room"/);
    expect((await ask({ kind: 'tour', tour: { rooms: [{ room: 'LIV' }, { room: 'Living room' }] } })).status).toBe(400);
    expect((await ask({ kind: 'tour', tour: { rooms: [] } })).status).toBe(400);
    expect((await ask({ kind: 'tour', tour: { size: 'huge' } })).status).toBe(400);
    expect((await ask({ kind: 'tour', tour: { eyeHeight: 10 } })).status).toBe(400);
    expect((await ask({ kind: 'tour', levels: ['MAIN'] })).status).toBe(400);
    expect((await ask({ kind: 'pdf', tour: {} })).status).toBe(400);

    const queued = view(await ask({ kind: 'tour', tour: { rooms: [{ room: 'KIT' }], size: 'small', quality: 'draft' } }));
    const share = (body: unknown) => operator.post(`/api/projects/${id}/shares`, body);
    expect((await share({ tour: queued.id, shows: { plan: true, threeD: false, findings: false } })).status).toBe(400);
    expect((await share({ tour: queued.id, comments: true })).status).toBe(400);
    expect((await share({ tour: 'not-a-job' })).status).toBe(400);
    // Another project's tour, or another kind of export, is not this project's tour.
    const bob = await inviteMember(running, operator, 'bob@example.test');
    const { id: bobs } = await projectWithDocument(db, bob, WITH_VIEWS, "Bob's ranch");
    expect((await bob.post(`/api/projects/${bobs}/shares`, { tour: queued.id })).status).toBe(404);
    const pdf = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf' }));
    expect((await share({ tour: pdf.id })).status).toBe(404);
    // The database holds the same line.
    await expect(db.$executeRaw`update share_links set show_plan = true where tour_job_id is not null`).resolves.toBe(0);
    expect((await share({ tour: queued.id })).status).toBe(201);
    await expect(db.$executeRaw`update share_links set show_plan = true where tour_job_id is not null`).rejects.toThrow(/share_links_tour_alone/);
  });
});
