/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Package, contentHash, validate } from '@floorspec/engine';
import { readPackage, readZip, writeZip, DEFAULT_LIMITS, type ZipEntry } from '@floorspec/package';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Browser, createProjectAs, inviteMember, reset, setupOperator, start, testDb, tokenFor, type Reply, type Running } from './helpers.js';
import { fetchBytes, upload, type UploadedAsset } from './assets-support.js';
import { shareOf } from './share-support.js';
import { jpegWithExif, tilePng } from '../support/images.js';

/**
 * The `.floorspec` package over HTTP (FLR-T-9.1; FLR-REQ-126, 135, 151).
 *
 * Export: model.json and every asset's file, byte for byte what the project serves, deterministic,
 * a valid package to the engine's package validator — and always available: on every state a
 * project can be in, to a session and to every kind of token, never refused over a missing file,
 * and never carrying a file the project cannot reach. Import: a document or a package of Core 0.1,
 * 0.2 or 0.3 becomes a new project by Ops, keeps its version, stores its files; anything that is not
 * valid is refused with the diagnostics and leaves nothing behind.
 */

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const enc = new TextEncoder();
const TILE = tilePng(64, 64, { tile: 16 });
const conformance = new URL('../../../../packages/engine/standard/conformance/core/', import.meta.url);
const doc = (path: string) => readFileSync(new URL(path, conformance));

function textureOps(a: Pick<UploadedAsset, 'path' | 'sha256' | 'mediaType' | 'byteLength'>, assetId = 'TILE-PHOTO', materialId = 'TILE') {
  return [
    { op: 'addElement', collection: 'assets', id: assetId, element: { path: a.path, sha256: a.sha256, mediaType: a.mediaType, byteLength: a.byteLength, name: 'tile.png' } },
    { op: 'addElement', collection: 'materials', id: materialId, element: { name: 'Tile', color: '#5ea6a0', texture: { asset: assetId, size: [390_144, 390_144] } } },
  ];
}

/** POST the bytes of a file to the import route, as the editor sends them. */
async function importBytes(base: string, as: Browser, bytes: Uint8Array, headers: Record<string, string> = {}): Promise<Reply> {
  const cookie = [...as.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${base}/api/projects/import/floorspec`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...(cookie === '' ? {} : { cookie }), ...headers },
    body: Buffer.from(bytes),
    redirect: 'manual',
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text, headers: res.headers };
}

interface Imported {
  id: string;
  name: string;
  head: string;
  source: string;
  diagnostics: { code: string; severity: string }[];
  stored: string[];
  missing: string[];
  ignored: string[];
  stripped: { asset: string; from: string; to: string; removed: string[] }[];
}

describe('the .floorspec package', () => {
  const db = testDb();
  let running: Running;
  let dir: string;
  let alice: Browser;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flr-package-it-'));
    running = await start({ env: { ASSET_DIR: dir, ASSET_MAX_BYTES: String(256 * 1024) } });
  });
  afterAll(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await reset(db);
    alice = await setupOperator(running);
  });

  /** A project whose model has a textured material, its tile uploaded through the real route. */
  async function textured(owner: Browser = alice, name = 'Tiled kitchen'): Promise<{ id: string; asset: UploadedAsset; before: string; after: string }> {
    const { id, head: before } = await createProjectAs(owner, name);
    const asset = ((await upload(running.url, owner, id, TILE, { name: 'tile.png' })).body as { asset: UploadedAsset }).asset;
    const applied = await owner.post(`/api/projects/${id}/ops`, { batch: textureOps(asset) });
    expect(applied.status, applied.text).toBe(201);
    return { id, asset, before, after: (applied.body as { hash: string }).hash };
  }

  const exportOf = (as: Browser, id: string, query = '', headers: Record<string, string> = {}) => fetchBytes(running.url, as, `/api/projects/${id}/package${query}`, headers);

  describe('export', () => {
    it('is model.json and each asset at its path, byte for byte what the project serves, and a valid package', async () => {
      const { id, asset } = await textured();
      const res = await exportOf(alice, id);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/zip');
      expect(res.headers.get('content-disposition')).toContain('filename="tiled-kitchen.floorspec"');
      expect(res.headers.get('x-floorspec-missing-assets')).toBeNull();
      const { entries } = readZip(res.bytes, DEFAULT_LIMITS);
      expect(entries.map((e) => e.name)).toEqual(['model.json', asset.path]);
      const model = await fetchBytes(running.url, alice, `/api/projects/${id}/model.json`);
      expect(Buffer.from(entries[0]!.bytes).equals(Buffer.from(model.bytes))).toBe(true);
      expect(Buffer.from(entries[1]!.bytes).equals(Buffer.from(TILE))).toBe(true);
      expect(res.headers.get('x-floorspec-version')).toBe(model.headers.get('etag')?.replace(/"/g, ''));
      const opened = readPackage(res.bytes);
      const checked = validate(opened.document, { package: new Package(opened.files) });
      expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
    });

    it('gives the same bytes every time, and a 304 for the same ETag', async () => {
      const { id } = await textured();
      const a = await exportOf(alice, id);
      const b = await exportOf(alice, id);
      expect(sha(a.bytes)).toBe(sha(b.bytes));
      expect(a.headers.get('etag')).toBe(`"${sha(a.bytes)}"`);
      expect((await exportOf(alice, id, '', { 'if-none-match': a.headers.get('etag')! })).status).toBe(304);
    });

    it('packages any version the project has been at, and no other', async () => {
      const { id, before } = await textured();
      const old = await exportOf(alice, id, `?version=${before}`);
      expect(old.status).toBe(200);
      expect(readZip(old.bytes, DEFAULT_LIMITS).entries.map((e) => e.name)).toEqual(['model.json']);
      expect(old.headers.get('x-floorspec-version')).toBe(before);
      expect((await exportOf(alice, id, `?version=${'0'.repeat(64)}`)).status).toBe(404);
      expect((await exportOf(alice, id, '?version=nope')).status).toBe(404);
    });

    it('is always available, free: on a pending changeset, a share link, to a session and every kind of token', async () => {
      const { id } = await textured();
      const agentToken = await tokenFor(alice, id, 'agent');
      const agent = Browser.bearer(running.url, agentToken);
      const proposed = await agent.post(`/api/projects/${id}/ops`, { batch: [{ op: 'addElement', collection: 'buildings', id: 'B9', element: {} }] });
      expect(proposed.status, proposed.text).toBe(201);
      await shareOf(alice, id);
      const reference = sha((await exportOf(alice, id)).bytes);
      for (const kind of ['read', 'write', 'agent'] as const) {
        const token = kind === 'agent' ? agentToken : await tokenFor(alice, id, kind);
        const res = await fetch(`${running.url}/api/projects/${id}/package`, { headers: { authorization: `Bearer ${token}` } });
        expect(res.status, kind).toBe(200);
        // Main's head: the agent's changeset is not in it until a person accepts it.
        expect(sha(new Uint8Array(await res.arrayBuffer())), kind).toBe(reference);
      }
      // The changeset's version is a version this project has been at: exportable too.
      const pending = (proposed.body as { hash: string; changeset: { id: string } | null }).hash;
      expect((proposed.body as { changeset: unknown }).changeset).not.toBeNull();
      expect((await exportOf(alice, id, `?version=${pending}`)).status).toBe(200);
    });

    it('never refuses over a missing file: the model is exported and the asset named', async () => {
      const { id } = await createProjectAs(alice);
      const ghost = { path: `assets/${'c'.repeat(64)}.png`, sha256: 'c'.repeat(64), mediaType: 'image/png', byteLength: 10 };
      expect((await alice.post(`/api/projects/${id}/ops`, { batch: textureOps(ghost, 'GHOST', 'M') })).status).toBe(201);
      const res = await exportOf(alice, id);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-floorspec-missing-assets')).toBe('GHOST');
      expect(readZip(res.bytes, DEFAULT_LIMITS).entries.map((e) => e.name)).toEqual(['model.json']);
    });

    it("never carries a file the project cannot reach: another account's upload, named by digest", async () => {
      const { asset } = await textured();
      const bob = await inviteMember(running, alice, 'bob@example.test');
      const { id: bobs } = await createProjectAs(bob, "Bob's");
      expect((await bob.post(`/api/projects/${bobs}/ops`, { batch: textureOps(asset) })).status).toBe(201);
      const res = await exportOf(bob, bobs);
      expect(res.status).toBe(200);
      expect(readZip(res.bytes, DEFAULT_LIMITS).entries.map((e) => e.name)).toEqual(['model.json']);
      expect(res.headers.get('x-floorspec-missing-assets')).toBe('TILE-PHOTO');
    });
  });

  describe('import', () => {
    it('makes a new project from an exported package: the same model, the same file, by Ops', async () => {
      const { id, asset } = await textured();
      const exported = await exportOf(alice, id);
      const res = await importBytes(running.url, alice, exported.bytes);
      expect(res.status, res.text).toBe(201);
      const body = res.body as Imported;
      expect(body).toMatchObject({ name: 'Tiled kitchen', source: 'package', stored: ['TILE-PHOTO'], missing: [], ignored: [], stripped: [] });
      expect(body.id).not.toBe(id);
      // The same document, by content hash — so model.json is byte-identical.
      const original = await fetchBytes(running.url, alice, `/api/projects/${id}/model.json`);
      const copy = await fetchBytes(running.url, alice, `/api/projects/${body.id}/model.json`);
      expect(Buffer.from(copy.bytes).equals(Buffer.from(original.bytes))).toBe(true);
      expect(body.head).toBe(contentHash(JSON.parse(new TextDecoder().decode(original.bytes)) as object));
      // Its file is the new project's own, and the package it exports is the one it came from.
      const file = await fetchBytes(running.url, alice, `/api/projects/${body.id}/assets/${asset.sha256}`);
      expect(file.status).toBe(200);
      expect(Buffer.from(file.bytes).equals(Buffer.from(TILE))).toBe(true);
      expect(await db.projectAsset.count({ where: { projectId: body.id } })).toBe(1);
      expect(sha((await exportOf(alice, body.id)).bytes)).toBe(sha(exported.bytes));
      // Two ops: the project created blank, then the document as one batch; audited once.
      const ops = await db.opLog.findMany({ where: { projectId: body.id }, orderBy: { seq: 'asc' } });
      expect(ops.map((o) => o.kind)).toEqual(['create', 'apply']);
      const audit = await db.auditLog.findMany({ where: { action: 'project.import' } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ targetType: 'project', targetId: body.id });
      expect(audit[0]?.detail).toMatchObject({ source: 'package', assets: 1, version: body.head, route: 'POST /api/projects/import/floorspec' });
    });

    it('imports a .floorspec.json document, named by a header, and a document sent as JSON', async () => {
      const house = doc('0.3/examples/001-three-room-house/input.json');
      const res = await importBytes(running.url, alice, house, { 'x-project-name': encodeURIComponent('Ma maison / 2') });
      expect(res.status, res.text).toBe(201);
      const body = res.body as Imported;
      // Its oak texture is located by path, and a document alone brings no file: missing, and said so.
      expect(body).toMatchObject({ name: 'Ma maison / 2', source: 'document', stored: [], missing: ['OAKIMG'] });
      const model = JSON.parse(new TextDecoder().decode((await fetchBytes(running.url, alice, `/api/projects/${body.id}/model.json`)).bytes)) as { project: { name: string } };
      expect(model.project.name).toBe('Ma maison / 2');
      const asJson = await alice.post('/api/projects/import/floorspec', JSON.parse(house.toString('utf8')) as object);
      expect(asJson.status, asJson.text).toBe(201);
    });

    it('keeps the version a Core 0.1 or 0.2 document declares', async () => {
      for (const [version, path] of [['0.1', '0.1/examples/001-three-room-house/input.json'], ['0.2', '0.2/examples/001-three-room-house/input.json']] as const) {
        const res = await importBytes(running.url, alice, doc(path));
        expect(res.status, `${version}: ${res.text}`).toBe(201);
        const model = (await alice.get(`/api/projects/${(res.body as Imported).id}/model.json`)).body as { floorspec: string };
        expect(model.floorspec).toBe(version);
        expect(contentHash(model)).toBe(contentHash(JSON.parse(doc(path).toString('utf8')) as object));
      }
    });

    it('reads a person-zipped Core 18.4 folder: house.floorspec.json beside assets/, inside one folder', async () => {
      const dirDoc = doc('0.3/materials/008-tile-photo-on-the-backsplash/input.json');
      const tile = new Uint8Array(readFileSync(new URL('0.3/materials/008-tile-photo-on-the-backsplash/package/assets/tile-12in.png', conformance)));
      const zip = writeZip([
        { name: 'kitchen/house.floorspec.json', bytes: dirDoc },
        { name: 'kitchen/assets/tile-12in.png', bytes: tile },
        { name: 'kitchen/README.txt', bytes: enc.encode('notes') },
      ]);
      const res = await importBytes(running.url, alice, zip);
      expect(res.status, res.text).toBe(201);
      expect(res.body).toMatchObject({ stored: ['TILE-PHOTO'], ignored: ['kitchen/README.txt'] });
    });

    it('strips a texture’s camera metadata, as an upload does, and the document follows its new digest', async () => {
      const photo = jpegWithExif(32, 32);
      const document = {
        floorspec: '0.3',
        project: { name: 'Photo' },
        assets: { P: { path: `assets/${sha(photo)}.jpg`, sha256: sha(photo), mediaType: 'image/jpeg', byteLength: photo.length } },
        materials: { M: { name: 'Stone', texture: { asset: 'P', size: [128_000, 128_000] } } },
      };
      const zip = writeZip([{ name: 'model.json', bytes: enc.encode(JSON.stringify(document)) }, { name: `assets/${sha(photo)}.jpg`, bytes: photo }]);
      const res = await importBytes(running.url, alice, zip);
      expect(res.status, res.text).toBe(201);
      const body = res.body as Imported;
      expect(body.stripped).toHaveLength(1);
      expect(body.stripped[0]).toMatchObject({ asset: 'P', from: sha(photo) });
      expect(body.stripped[0]!.removed).toContain('APP1');
      const model = (await alice.get(`/api/projects/${body.id}/model.json`)).body as typeof document;
      const to = body.stripped[0]!.to;
      expect(model.assets.P).toMatchObject({ sha256: to, path: `assets/${to}.jpg` });
      const stored = await fetchBytes(running.url, alice, `/api/projects/${body.id}/assets/${to}`);
      expect(stored.status).toBe(200);
      expect(Buffer.from(stored.bytes).includes(Buffer.from('GPSLatitude'))).toBe(false);
      expect(model.assets.P.byteLength).toBe(stored.bytes.length);
    });

    it("a document alone finds the owner's files in their other projects: not missing, and drawn", async () => {
      const { id, asset } = await textured();
      const model = (await fetchBytes(running.url, alice, `/api/projects/${id}/model.json`)).bytes;
      const res = await importBytes(running.url, alice, model);
      expect(res.status, res.text).toBe(201);
      expect(res.body).toMatchObject({ source: 'document', missing: [], stored: [] });
      expect((await fetchBytes(running.url, alice, `/api/projects/${(res.body as Imported).id}/assets/${asset.sha256}`)).status).toBe(200);
      // Somebody else importing the same model.json gets no file of Alice's: it is missing.
      const bob = await inviteMember(running, alice, 'bob@example.test');
      const theirs = await importBytes(running.url, bob, model);
      expect(theirs.status).toBe(201);
      expect(theirs.body).toMatchObject({ missing: ['TILE-PHOTO'] });
      expect((await fetchBytes(running.url, bob, `/api/projects/${(theirs.body as Imported).id}/assets/${asset.sha256}`)).status).toBe(404);
    });

    describe('refuses, and leaves nothing behind', () => {
      const tile = new Uint8Array(readFileSync(new URL('0.3/materials/008-tile-photo-on-the-backsplash/package/assets/tile-12in.png', conformance)));
      const backsplash = doc('0.3/materials/008-tile-photo-on-the-backsplash/input.json');
      const pkg = (entries: ZipEntry[]) => writeZip(entries);

      const refusals: [string, () => Uint8Array, number, string, string?][] = [
        ['not JSON', () => enc.encode('{ this is not json'), 422, 'invalid-document'],
        ['an invalid document', () => enc.encode(JSON.stringify({ floorspec: '0.3', project: { name: 'x' }, walls: { W1: { level: 'NOPE', start: 'A', end: 'B' } } })), 422, 'invalid-document'],
        ['an unsupported version', () => enc.encode(JSON.stringify({ floorspec: '9.0', project: { name: 'x' } })), 422, 'invalid-document', 'FS-DOC-001'],
        ['a package missing a file', () => pkg([{ name: 'model.json', bytes: backsplash }]), 422, 'invalid-document', 'FS-INV-1005'],
        ['a package with the wrong file', () => pkg([{ name: 'model.json', bytes: backsplash }, { name: 'assets/tile-12in.png', bytes: tilePng(8, 8) }]), 422, 'invalid-document', 'FS-INV-1006'],
        ['a package with no model.json', () => pkg([{ name: 'assets/tile-12in.png', bytes: tile }]), 422, 'not-a-package'],
        ['a ZIP that is damaged', () => pkg([{ name: 'model.json', bytes: backsplash }]).subarray(0, 60), 422, 'not-a-package'],
        ['a texture that is not the image it says', () => {
          const d = JSON.parse(backsplash.toString('utf8')) as { assets: Record<string, { mediaType: string; path: string }> };
          d.assets['TILE-PHOTO']!.mediaType = 'image/jpeg';
          return pkg([{ name: 'model.json', bytes: enc.encode(JSON.stringify(d)) }, { name: 'assets/tile-12in.png', bytes: tile }]);
        }, 422, 'bad-asset'],
      ];

      it.each(refusals)('%s', async (_what, make, status, type, code) => {
        const res = await importBytes(running.url, alice, make());
        expect(res.status, res.text).toBe(status);
        const body = res.body as { type: string; diagnostics?: { code: string }[] };
        expect(body.type).toBe(`/problems/${type}`);
        if (code !== undefined) expect(body.diagnostics?.map((d) => d.code)).toContain(code);
        expect(await db.project.count()).toBe(0);
        expect(await db.projectAsset.count()).toBe(0);
        expect(await db.auditLog.count({ where: { action: 'project.import' } })).toBe(0);
      });

      it('zip-slip: an entry that climbs out of the package', async () => {
        // writeZip will not write one, so the archive is patched: same length, name rewritten.
        const zip = writeZip([{ name: 'model.json', bytes: backsplash }, { name: 'assets/tile-12in.png', bytes: tile }]);
        const evil = Buffer.from(zip);
        for (let at = evil.indexOf('assets/tile-12in.png'); at >= 0; at = evil.indexOf('assets/tile-12in.png', at + 1)) evil.write('../../../../etc/pwnd', at, 'latin1');
        const res = await importBytes(running.url, alice, new Uint8Array(evil));
        expect(res.status, res.text).toBe(422);
        expect(res.body).toMatchObject({ type: '/problems/not-a-package', code: 'unsafe-path' });
        expect(await db.project.count()).toBe(0);
      });

      it('a file larger than an upload may be, and a body past the import limit', async () => {
        const big = new Uint8Array(300 * 1024).fill(7);
        const d = { floorspec: '0.3', project: { name: 'x' }, assets: { B: { path: 'assets/big.bin', sha256: sha(big), mediaType: 'application/octet-stream' } } };
        const res = await importBytes(running.url, alice, writeZip([{ name: 'model.json', bytes: enc.encode(JSON.stringify(d)) }, { name: 'assets/big.bin', bytes: big }]));
        expect(res.status, res.text).toBe(413);
        expect(res.body).toMatchObject({ code: 'too-large' });
        const huge = await importBytes(running.url, alice, new Uint8Array(129 * 1024 * 1024));
        expect(huge.status).toBe(413);
        expect(await db.project.count()).toBe(0);
      });

      it('nobody signed in, or a token: a project is created by a person', async () => {
        expect((await importBytes(running.url, new Browser(running.url), backsplash)).status).toBe(401);
        const { id } = await createProjectAs(alice);
        const write = await tokenFor(alice, id, 'write');
        const res = await fetch(`${running.url}/api/projects/import/floorspec`, { method: 'POST', headers: { authorization: `Bearer ${write}`, 'content-type': 'application/octet-stream' }, body: backsplash });
        expect(res.status).toBe(403);
        expect(await db.project.count()).toBe(1);
      });
    });
  });
});
