import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Package, validate } from '@floorspec/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Browser, createProjectAs, inviteMember, reset, setupOperator, start, testDb, tokenFor, type Running } from './helpers.js';
import { fetchBytes, upload, type UploadedAsset } from './assets-support.js';
import { jpegWithExif, tilePng } from '../support/images.js';

/**
 * The asset store over HTTP (FLR-T-8.2, FLR-REQ-117, FLR-REQ-124): an upload is sniffed, stripped
 * of its metadata, stored once by its SHA-256 on ASSET_DIR and claimed by its project; its bytes are
 * served immutable to the project's owner and nobody else; and a model whose materials use them is
 * a valid package — `model.json` plus each asset at its path — to the engine's package validator.
 */

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const TILE = tilePng(64, 64, { tile: 16 });

/** The ops that put an uploaded image into a model, as the editor sends them: the asset and a material using it. */
function textureOps(a: UploadedAsset, assetId = 'TILE-PHOTO', materialId = 'TILE') {
  return [
    { op: 'addElement', collection: 'assets', id: assetId, element: { path: a.path, sha256: a.sha256, mediaType: a.mediaType, byteLength: a.byteLength, name: a.name ?? 'tile' } },
    { op: 'addElement', collection: 'materials', id: materialId, element: { name: 'Tile', color: '#5ea6a0', texture: { asset: assetId, size: [390_144, 390_144] } } },
  ];
}

describe('the asset store', () => {
  const db = testDb();
  let running: Running;
  let dir: string;
  let alice: Browser;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flr-assets-it-'));
    running = await start({ env: { ASSET_DIR: dir, ASSET_MAX_BYTES: String(256 * 1024) } });
  });
  afterAll(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await reset(db);
    await rm(dir, { recursive: true, force: true });
    alice = await setupOperator(running);
  });

  const files = async () => (await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])).filter((e) => e.isFile()).map((e) => e.name);

  it('stores an upload by the SHA-256 of its bytes and answers the asset entry a document carries', async () => {
    const { id } = await createProjectAs(alice);
    const res = await upload(running.url, alice, id, TILE, { name: 'zellige seafoam.png', contentType: 'image/jpeg' });
    expect(res.status, res.text).toBe(201);
    const { asset, stored } = res.body as { asset: UploadedAsset; stored: string };
    // What it is comes from its bytes, not from the Content-Type the client sent.
    expect(asset).toMatchObject({ sha256: sha(TILE), mediaType: 'image/png', byteLength: TILE.length, width: 64, height: 64, name: 'zellige seafoam.png', path: `assets/${sha(TILE)}.png` });
    expect(asset.href).toBe(`/api/projects/${id}/assets/${sha(TILE)}`);
    expect(res.headers.get('location')).toBe(asset.href);
    expect(stored).toBe('new');
    expect(await files()).toEqual([sha(TILE)]);

    const audit = await db.auditLog.findMany({ where: { action: 'asset.upload' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ targetType: 'asset', targetId: sha(TILE) });
    expect(audit[0]?.detail).toMatchObject({ projectId: id, mediaType: 'image/png', created: true });
  });

  it('keeps one file for the same bytes, uploaded again or into another project', async () => {
    const a = await createProjectAs(alice, 'A');
    const b = await createProjectAs(alice, 'B');
    expect((await upload(running.url, alice, a.id, TILE)).status).toBe(201);
    const again = await upload(running.url, alice, a.id, TILE);
    expect((again.body as { stored: string }).stored).toBe('existing');
    expect((await upload(running.url, alice, b.id, TILE)).status).toBe(201);
    expect(await files()).toEqual([sha(TILE)]);
    expect(await db.projectAsset.count()).toBe(2);
    expect(await db.projectAsset.count({ where: { projectId: a.id } })).toBe(1);
  });

  it('refuses what is not a texture image, an empty upload, JSON and an upload over the limit', async () => {
    const { id } = await createProjectAs(alice);
    const svg = await upload(running.url, alice, id, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { contentType: 'image/png' });
    expect(svg.status).toBe(415);
    expect(svg.body).toEqual({ error: 'a texture must be a PNG, JPEG, WebP or KTX2 image' });
    expect((await upload(running.url, alice, id, new Uint8Array())).status).toBe(400);
    expect((await alice.post(`/api/projects/${id}/assets`, { image: 'base64…' })).status).toBe(415);
    const big = await upload(running.url, alice, id, new Uint8Array(300 * 1024));
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: 'an upload may be at most 256 KB' });
    expect(await files()).toEqual([]);
    expect(await db.projectAsset.count()).toBe(0);
  });

  it('strips a photo’s EXIF — its GPS position — before hashing, and serves the stripped bytes', async () => {
    const { id } = await createProjectAs(alice);
    const photo = jpegWithExif(2048, 2048);
    const res = await upload(running.url, alice, id, photo, { name: 'IMG_0412.jpg' });
    expect(res.status, res.text).toBe(201);
    const { asset, stripped } = res.body as { asset: UploadedAsset; stripped: string[] };
    expect(stripped).toEqual(['APP1', 'APP1', 'COM']);
    expect(asset.sha256).not.toBe(sha(photo));
    const served = await fetchBytes(running.url, alice, asset.href);
    expect(served.status).toBe(200);
    expect(sha(served.bytes)).toBe(asset.sha256);
    expect(served.bytes.length).toBe(asset.byteLength);
    expect(Buffer.from(served.bytes).includes(Buffer.from('GPSLatitude'))).toBe(false);
  });

  it('serves the bytes immutable, by digest, with their type, and never as something to run', async () => {
    const { id } = await createProjectAs(alice);
    const { asset } = (await upload(running.url, alice, id, TILE)).body as { asset: UploadedAsset };
    const res = await fetchBytes(running.url, alice, asset.href);
    expect(res.status).toBe(200);
    expect(res.bytes).toEqual(TILE);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('etag')).toBe(`"${sha(TILE)}"`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-disposition')).toBe(`inline; filename="${sha(TILE)}.png"`);
    expect((await fetchBytes(running.url, alice, asset.href, { 'if-none-match': `"${sha(TILE)}"` })).status).toBe(304);
    expect((await fetchBytes(running.url, alice, `${asset.href}?download`)).headers.get('content-disposition')).toBe(`attachment; filename="${sha(TILE)}.png"`);
    // Not a digest, or a digest nobody uploaded here: the same 404.
    expect((await alice.get(`/api/projects/${id}/assets/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await alice.get(`/api/projects/${id}/assets/${'0'.repeat(64)}`)).body).toEqual({ error: 'asset not found' });
  });

  it('serves a file only to a project that uploaded it, or whose model names one its owner uploaded', async () => {
    const mine = await createProjectAs(alice, 'Kitchen');
    const { asset } = (await upload(running.url, alice, mine.id, TILE)).body as { asset: UploadedAsset };

    // Another of Alice's projects: not until its model names the file.
    const next = await createProjectAs(alice, 'Next house');
    const nextHref = `/api/projects/${next.id}/assets/${asset.sha256}`;
    expect((await alice.get(nextHref)).status).toBe(404);
    expect((await alice.post(`/api/projects/${next.id}/ops`, { batch: textureOps(asset) })).status).toBe(201);
    expect((await fetchBytes(running.url, alice, nextHref)).bytes).toEqual(TILE);

    // Bob knows the digest and writes it into his own model: still 404, so the store never confirms
    // to him that it holds a file somebody else gave it.
    const bob = await inviteMember(running, alice, 'bob@example.test');
    const bobs = await createProjectAs(bob, "Bob's house");
    expect((await bob.post(`/api/projects/${bobs.id}/ops`, { batch: textureOps(asset) })).status).toBe(201);
    const denied = await bob.get(`/api/projects/${bobs.id}/assets/${asset.sha256}`);
    expect(denied.status).toBe(404);
    expect(denied.body).toEqual({ error: 'asset not found' });
    expect(((await bob.get(`/api/projects/${bobs.id}/assets`)).body as { assets: { href: string | null }[] }).assets[0]?.href).toBeNull();
    // And Alice's project itself is the usual 404 to him.
    expect((await bob.get(asset.href)).body).toEqual({ error: 'project not found' });

    // Bob uploading the same bytes himself is his own claim on them: then he reads them.
    expect((await upload(running.url, bob, bobs.id, TILE)).status).toBe(201);
    expect((await bob.get(`/api/projects/${bobs.id}/assets/${asset.sha256}`)).status).toBe(200);
    expect(await files()).toEqual([sha(TILE)]);
  });

  it('takes uploads from write and agent tokens and serves reads to read tokens of the project', async () => {
    const { id } = await createProjectAs(alice);
    const reader = await tokenFor(alice, id, 'read');
    const agent = await tokenFor(alice, id, 'agent');
    expect((await upload(running.url, { bearer: reader }, id, TILE)).status).toBe(403);
    const res = await upload(running.url, { bearer: agent }, id, TILE);
    expect(res.status, res.text).toBe(201);
    const row = await db.projectAsset.findFirstOrThrow({ where: { projectId: id } });
    expect(row.uploadedByTokenId).not.toBeNull();
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'asset.upload' } });
    expect(audit.actor).toMatch(/^agent:/);
    const got = await Browser.bearer(running.url, reader).get(`/api/projects/${id}/assets/${sha(TILE)}`);
    expect(got.status).toBe(200);
  });

  it('lists the model’s assets, each with where its bytes are, and the project’s uploads', async () => {
    const { id } = await createProjectAs(alice);
    const { asset } = (await upload(running.url, alice, id, TILE, { name: 'tile.png' })).body as { asset: UploadedAsset };
    await upload(running.url, alice, id, tilePng(32, 32, { colour: [180, 90, 60] }), { name: 'brick.png' });
    await alice.post(`/api/projects/${id}/ops`, { batch: textureOps(asset) });
    const list = (await alice.get(`/api/projects/${id}/assets`)).body as { assets: { id: string; path: string; href: string; sha256: string }[]; uploads: UploadedAsset[] };
    expect(list.assets).toEqual([{ id: 'TILE-PHOTO', path: asset.path, uri: null, sha256: asset.sha256, mediaType: 'image/png', byteLength: TILE.length, href: asset.href }]);
    expect(list.uploads.map((u) => u.name).sort()).toEqual(['brick.png', 'tile.png']);
  });

  it('makes a model whose texture is stored a valid package: model.json and its assets at their paths', async () => {
    const { id } = await createProjectAs(alice);
    const { asset } = (await upload(running.url, alice, id, jpegWithExif(512, 512), { name: 'tile.jpg' })).body as { asset: UploadedAsset };
    const applied = await alice.post(`/api/projects/${id}/ops`, { batch: textureOps(asset) });
    expect(applied.status, applied.text).toBe(201);

    const model = await fetchBytes(running.url, alice, `/api/projects/${id}/model.json`);
    const list = (await alice.get(`/api/projects/${id}/assets`)).body as { assets: { path: string; href: string }[] };
    const files: Record<string, Uint8Array> = {};
    for (const a of list.assets) files[a.path] = (await fetchBytes(running.url, alice, `${a.href}?download`)).bytes;
    const result = validate(model.bytes, { package: new Package(files) });
    expect(result.valid, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.diagnostics.filter((d) => /^FS-INV-100[5-7]$/.test(d.code))).toEqual([]);

    // The package validator does check: a file that is not the one the model names is reported.
    const tampered = validate(model.bytes, { package: new Package({ [asset.path]: TILE }) });
    expect(tampered.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(['FS-INV-1006', 'FS-INV-1007']));
    expect(validate(model.bytes, { package: new Package({}) }).diagnostics.map((d) => d.code)).toContain('FS-INV-1005');
  });
});

describe('an instance without an asset store', () => {
  const db = testDb();
  let running: Running;
  beforeAll(async () => {
    running = await start({ env: { NODE_ENV: 'production' } });
  });
  afterAll(async () => {
    await running.close();
  });

  it('refuses an upload, saying what to set, rather than keeping it in memory', async () => {
    await reset(db);
    const alice = await setupOperator(running);
    const { id } = await createProjectAs(alice);
    const res = await upload(running.url, alice, id, TILE);
    expect(res.status).toBe(503);
    const body = res.body as { error: string; detail: string };
    expect(body.error).toBe('this instance has no asset store');
    expect(body.detail).toContain('ASSET_DIR');
    expect(await db.projectAsset.count()).toBe(0);
  });
});
